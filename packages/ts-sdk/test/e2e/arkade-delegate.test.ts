import { describe, it, expect, beforeEach } from "vitest";
import { base64, hex } from "@scure/base";
import { Address, OutScript, SigHash } from "@scure/btc-signer";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { sha256 } from "@scure/btc-signer/utils.js";
import {
    arkade,
    Batch,
    CSVMultisigTapscript,
    Intent,
    networks,
    PrevArkTxField,
    RestArkProvider,
    RestIndexerProvider,
    RestEmulatorProvider,
    setArkPsbtField,
    SingleKey,
    VtxoScript,
} from "../../src";
import { Transaction } from "../../src/utils/transaction";
import { buildForfeitTx } from "../../src/forfeit";
import type { ConnectorTreeNode } from "../../src/providers/emulator";
import { addEmulatorPacket, beforeEachFaucet, faucetOffchain, randomP2TR } from "./utils";

const EMULATOR_URL = "http://localhost:7073";
const ARK_SERVER_URL = "http://localhost:7070";
const DELEGATE_AMOUNT = 10_000;
const DELEGATE_EXIT_DELAY = 512;

// Arkade self-send covenant (token form of the `enforceSelfSend` helper): the
// spend must keep version 2, send output 0 to this same input's scriptPubKey,
// and preserve its value — i.e. refresh in place.
const selfSend = [
    "INSPECTVERSION",
    new Uint8Array([0x02, 0x00, 0x00, 0x00]),
    "EQUALVERIFY",
    0,
    "INSPECTOUTPUTSCRIPTPUBKEY",
    1,
    "EQUALVERIFY",
    "PUSHCURRENTINPUTINDEX",
    "INSPECTINPUTSCRIPTPUBKEY",
    1,
    "EQUALVERIFY",
    "EQUALVERIFY",
    0,
    "INSPECTOUTPUTVALUE",
    "PUSHCURRENTINPUTINDEX",
    "INSPECTINPUTVALUE",
    "EQUAL",
] satisfies arkade.AsmToken[];

// Delegate contract: a server + arkade-tweaked-emulator forfeit closure (no user
// key), plus an alice-only CSV exit. Mirrors the hand-built VtxoScript.
const delegateProgram = {
    functions: {
        forfeit: {
            tapscript: { signers: ["server"] },
            arkadeScript: { asm: selfSend },
        },
        exit: {
            tapscript: {
                signers: ["user"],
                csv: { type: "seconds", value: BigInt(DELEGATE_EXIT_DELAY) },
            },
        },
    },
} satisfies arkade.Program;

describe("arkade delegate (covenant batch refresh) — intent submission", () => {
    const emulator = new RestEmulatorProvider(EMULATOR_URL);
    const arkProvider = new RestArkProvider(ARK_SERVER_URL);
    const indexerProvider = new RestIndexerProvider(ARK_SERVER_URL);

    beforeEach(beforeEachFaucet, 20000);

    it(
        "registerIntent succeeds when self-send covenant + arkade script pass",
        { timeout: 180000 },
        async () => {
            const aliceIdentity = SingleKey.fromRandomBytes();

            // Derive the delegate contract (forfeit covenant + alice CSV exit)
            // from the program. Alice is the `"user"` signer of the exit leaf.
            const ark = await arkade.Arkade.connect({
                arkade: arkProvider,
                emulator,
                indexer: indexerProvider,
                identity: aliceIdentity,
                network: networks.regtest,
            });
            const contract = ark.contract(delegateProgram, {});
            const arkadeScript = arkade.resolveAsm(selfSend, {});

            const delegatePkScript = contract.pkScript;
            const contractAddress = contract.address;

            // Fund the delegate VTXO via the arkd CLI faucet.
            faucetOffchain(contractAddress, DELEGATE_AMOUNT);
            await new Promise((r) => setTimeout(r, 1000));

            // Poll the indexer until the VTXO appears.
            let vtxo: any = null;
            const deadline = Date.now() + 15_000;
            while (Date.now() < deadline) {
                const resp = await indexerProvider.getVtxos({
                    scripts: [hex.encode(delegatePkScript)],
                    spendableOnly: true,
                });
                if (resp.vtxos.length > 0) {
                    vtxo = resp.vtxos[0];
                    break;
                }
                await new Promise((r) => setTimeout(r, 1000));
            }
            expect(vtxo).not.toBeNull();

            // Retrieve the funding virtual tx so we can attach PrevArkTxField.
            const { txs: virtualTxs } = await indexerProvider.getVirtualTxs([vtxo.txid]);
            expect(virtualTxs).toHaveLength(1);
            const fundingTx = Transaction.fromPSBT(base64.decode(virtualTxs[0]));
            const fundingTxRaw = fundingTx.toBytes();

            // The arkade forfeit leaf (server + intro_tweaked) is leaf 0.
            const arkadeLeaf = contract.leafScript(0);
            const tapTree = contract.tapTree;

            // A solver session pubkey is required in cosigners_public_keys.
            const solverIdentity = SingleKey.fromRandomBytes();
            const session = solverIdentity.signerSession();
            const sessionPubKey = hex.encode(await session.getPublicKey());

            const message: Intent.RegisterMessage = {
                type: "register",
                onchain_output_indexes: [],
                valid_at: 0,
                expire_at: 0,
                cosigners_public_keys: [sessionPubKey],
            };

            // Construct the extended coin shape that Intent.create expects.
            const coin = {
                txid: vtxo.txid,
                vout: vtxo.vout,
                value: vtxo.value,
                tapTree,
                forfeitTapLeafScript: arkadeLeaf,
                intentTapLeafScript: arkadeLeaf,
                status: vtxo.status,
                isSpent: vtxo.isSpent,
                virtualStatus: vtxo.virtualStatus,
            };

            /**
             * Build an intent proof for the given outputs, then attach the
             * emulator packet and PrevArkTxField required by the covenant.
             */
            const buildIntent = (
                outputs: { script: Uint8Array; amount: bigint }[],
            ): Transaction => {
                const proof = Intent.create(message, [coin], outputs);
                // Input 1 is the VTXO input. Attach the arkade script so the
                // emulator knows which covenant to execute.
                addEmulatorPacket(proof, [
                    {
                        vin: 1,
                        script: arkadeScript,
                        witness: new Uint8Array(0),
                    },
                ]);
                // OP_INSPECTINPUTSCRIPTPUBKEY needs to resolve the prevout
                // pkScript for input 1, provided via PrevArkTxField.
                setArkPsbtField(proof, 1, PrevArkTxField, fundingTxRaw);
                return proof;
            };

            // Negative test: wrong destination — emulator must reject.
            const badDestProof = buildIntent([
                { script: randomP2TR(), amount: BigInt(DELEGATE_AMOUNT) },
            ]);
            await expect(
                emulator.submitIntent({
                    proof: base64.encode(badDestProof.toPSBT()),
                    message,
                }),
            ).rejects.toThrow();

            // Negative test: wrong amount — emulator must reject.
            const badAmtProof = buildIntent([
                {
                    script: delegatePkScript,
                    amount: BigInt(DELEGATE_AMOUNT - 1),
                },
            ]);
            await expect(
                emulator.submitIntent({
                    proof: base64.encode(badAmtProof.toPSBT()),
                    message,
                }),
            ).rejects.toThrow();

            // Happy path: self-send to the same pkScript with the same amount.
            const validProof = buildIntent([
                {
                    script: delegatePkScript,
                    amount: BigInt(DELEGATE_AMOUNT),
                },
            ]);
            const signedProof = await emulator.submitIntent({
                proof: base64.encode(validProof.toPSBT()),
                message,
            });

            // Server accepts the emulator-co-signed proof.
            const intentId = await arkProvider.registerIntent({
                proof: signedProof,
                message,
            });
            expect(intentId).toBeTruthy();

            // === Drive the batch session ===

            const handler = buildDelegateHandler({
                intentId,
                signedProof,
                message,
                coin,
                session,
            });

            const topics = [sessionPubKey, `${vtxo.txid}:${vtxo.vout}`];
            const abortController = new AbortController();
            let commitmentTxid: string;
            try {
                const stream = arkProvider.getEventStream(abortController.signal, topics);
                commitmentTxid = await Batch.join(stream, handler, {
                    abortController,
                });
            } finally {
                abortController.abort();
            }
            expect(commitmentTxid!).toBeTruthy();

            // The refreshed VTXO must show up at the same delegate pkScript with
            // the same value, as a batch leaf (not preconfirmed).
            const start = Date.now();
            let foundRefreshed = false;
            while (Date.now() - start < 60_000) {
                const resp = await indexerProvider.getVtxos({
                    scripts: [hex.encode(delegatePkScript)],
                    spendableOnly: true,
                });
                const refreshed = resp.vtxos.find(
                    (v) => v.value === DELEGATE_AMOUNT && v.virtualStatus?.state !== "preconfirmed",
                );
                if (refreshed) {
                    foundRefreshed = true;
                    break;
                }
                await new Promise((r) => setTimeout(r, 1000));
            }
            expect(foundRefreshed).toBe(true);
        },
    );
});

/**
 * Custom Batch.Handler for the delegate flow.
 *
 * In the delegate flow, the forfeit closure is [server, emulator_tweaked]
 * (NO user key). Instead of signing the forfeit with the user identity, we
 * submit it unsigned to the emulator via `submitFinalization`, which adds
 * the server + tweaked-emulator co-signatures.
 */
function buildDelegateHandler(opts: {
    intentId: string;
    signedProof: string;
    message: Intent.RegisterMessage;
    coin: {
        txid: string;
        vout: number;
        value: number;
        tapTree: Uint8Array;
        forfeitTapLeafScript: any;
    };
    session: any;
}): Batch.Handler {
    const emulator = new RestEmulatorProvider(EMULATOR_URL);
    const arkProvider = new RestArkProvider(ARK_SERVER_URL);

    let batchId: string;
    let sweepTapLeaf: Uint8Array;

    return {
        async onBatchStarted(event) {
            const intentIdHash = hex.encode(sha256(new TextEncoder().encode(opts.intentId)));
            if (!event.intentIdHashes.includes(intentIdHash)) {
                return { skip: true };
            }
            await arkProvider.confirmRegistration(opts.intentId);
            batchId = event.id;

            const sweepTapscript = CSVMultisigTapscript.encode({
                timelock: {
                    value: event.batchExpiry,
                    type: event.batchExpiry >= 512n ? "seconds" : "blocks",
                },
                pubkeys: [hex.decode((await arkProvider.getInfo()).forfeitPubkey).subarray(1)],
            }).script;
            sweepTapLeaf = tapLeafHash(sweepTapscript);

            return { skip: false };
        },

        async onTreeSigningStarted(event, vtxoTree) {
            const signerPubKey = await opts.session.getPublicKey();
            const xonlySignerPubKey = signerPubKey.subarray(1);
            const xOnlyPubkeys = event.cosignersPublicKeys.map((k: string) => k.slice(2));

            if (!xOnlyPubkeys.includes(hex.encode(xonlySignerPubKey))) {
                return { skip: true };
            }

            const commitment = Transaction.fromPSBT(base64.decode(event.unsignedCommitmentTx));
            const shared = commitment.getOutput(0);
            if (!shared?.amount) throw new Error("missing shared output amount");

            await opts.session.init(vtxoTree, sweepTapLeaf, shared.amount);
            await arkProvider.submitTreeNonces(
                batchId,
                hex.encode(await opts.session.getPublicKey()),
                await opts.session.getNonces(),
            );
            return { skip: false };
        },

        async onTreeNonces(event) {
            const { hasAllNonces } = await opts.session.aggregatedNonces(event.txid, event.nonces);
            if (!hasAllNonces) return { fullySigned: false };
            await arkProvider.submitTreeSignatures(
                batchId,
                hex.encode(await opts.session.getPublicKey()),
                await opts.session.sign(),
            );
            return { fullySigned: true };
        },

        async onBatchFinalization(event, _vtxoTree, connectorTree) {
            if (!connectorTree) throw new Error("missing connector tree");
            const info = await arkProvider.getInfo();
            const forfeitOutputScript = OutScript.encode(
                Address(networks.regtest).decode(info.forfeitAddress),
            );

            const leaves = connectorTree.leaves();
            if (leaves.length < 1) throw new Error("no connectors");
            const connectorLeaf = leaves[0];
            const connectorOutput = connectorLeaf.getOutput(0);
            if (!connectorOutput?.amount || !connectorOutput?.script) {
                throw new Error("invalid connector leaf output");
            }

            const forfeitTx = buildForfeitTx(
                [
                    {
                        txid: opts.coin.txid,
                        index: opts.coin.vout,
                        witnessUtxo: {
                            amount: BigInt(opts.coin.value),
                            script: VtxoScript.decode(opts.coin.tapTree).pkScript,
                        },
                        sighashType: SigHash.DEFAULT,
                        tapLeafScript: [opts.coin.forfeitTapLeafScript],
                    },
                    {
                        txid: connectorLeaf.id,
                        index: 0,
                        witnessUtxo: {
                            amount: connectorOutput.amount,
                            script: connectorOutput.script,
                        },
                    },
                ],
                forfeitOutputScript,
            );

            // Build connector tree nodes for the emulator.
            const connectorNodes: ConnectorTreeNode[] = [];
            for (const sub of connectorTree.iterator()) {
                const children: Record<string, string> = {};
                for (const [vout, child] of sub.children) {
                    children[String(vout)] = child.txid;
                }
                connectorNodes.push({
                    txid: sub.txid,
                    tx: base64.encode(sub.root.toPSBT()),
                    children,
                });
            }

            const result = await emulator.submitFinalization(
                { proof: opts.signedProof, message: opts.message },
                [base64.encode(forfeitTx.toPSBT())],
                connectorNodes,
                event.commitmentTx,
            );

            await arkProvider.submitSignedForfeitTxs(
                result.signedForfeits,
                result.signedCommitmentTx,
            );
        },
    };
}
