import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { base64, hex } from "@scure/base";
import { Script } from "@scure/btc-signer";
import {
    arkade,
    ArkAddress,
    buildOffchainTx,
    CLTVMultisigTapscript,
    ConditionMultisigTapscript,
    CSVMultisigTapscript,
    MultisigTapscript,
    networks,
    RestArkProvider,
    RestIndexerProvider,
    RestEmulatorProvider,
    setArkPsbtField,
    ConditionWitness,
    Transaction,
    VtxoScript,
} from "../../src";
import {
    addEmulatorPacket,
    beforeEachFaucet,
    createTestArkWallet,
    enforcePayTo,
    faucetOffchain,
    randomP2TR,
} from "./utils";

const EMULATOR_URL = "http://localhost:7073";
const ARK_SERVER_URL = "http://localhost:7070";

const HTLC_PREIMAGE = new Uint8Array(32).fill(0x42);
// HASH160 = RIPEMD160(SHA256(HTLC_PREIMAGE))
const HTLC_PREIMAGE_HASH = hex.decode("8739f40ec4dbf569dcb38134c6e7310908566981");
const CONTRACT_AMOUNT = 10_000n;

describe("arkade HTLC (covenant)", () => {
    const emulator = new RestEmulatorProvider(EMULATOR_URL);
    const arkProvider = new RestArkProvider(ARK_SERVER_URL);
    const indexerProvider = new RestIndexerProvider(ARK_SERVER_URL);

    let serverXOnlyPubkey: Uint8Array;
    let emulatorPubkey: Uint8Array;
    let checkpointUnrollClosure: CSVMultisigTapscript.Type;

    beforeAll(async () => {
        const arkInfo = await arkProvider.getInfo();
        serverXOnlyPubkey = hex.decode(arkInfo.signerPubkey).slice(1);
        checkpointUnrollClosure = CSVMultisigTapscript.decode(
            hex.decode(arkInfo.checkpointTapscript),
        );

        const introInfo = await emulator.getInfo();
        emulatorPubkey = hex.decode(introInfo.signerPubkey);
    });

    beforeEach(beforeEachFaucet, 20000);

    /** Wait for at least one VTXO at the given pkScript */
    async function waitForVtxo(pkScript: Uint8Array, timeoutMs = 15000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const resp = await indexerProvider.getVtxos({
                scripts: [hex.encode(pkScript)],
                spendableOnly: true,
            });
            if (resp.vtxos.length > 0) return resp.vtxos;
            await new Promise((r) => setTimeout(r, 1000));
        }
        throw new Error("waitForVtxo: timeout");
    }

    it(
        "claim: emulator signs only when preimage + arkade script pass",
        { timeout: 60000 },
        async () => {
            await createTestArkWallet();

            const receiverPkScript = randomP2TR();
            const arkadeScript = enforcePayTo(receiverPkScript, CONTRACT_AMOUNT);

            const preimageCondition = Script.encode(["HASH160", HTLC_PREIMAGE_HASH, "EQUAL"]);

            const vtxoScript = new VtxoScript([
                ConditionMultisigTapscript.encode({
                    conditionScript: preimageCondition,
                    pubkeys: [
                        serverXOnlyPubkey,
                        arkade.computeArkadeScriptPublicKey(emulatorPubkey, arkadeScript),
                    ],
                }).script,
            ]);

            const contractAddress = vtxoScript
                .address(networks.regtest.hrp, serverXOnlyPubkey)
                .encode();

            // Fund.
            faucetOffchain(contractAddress, Number(CONTRACT_AMOUNT));
            const [vtxo] = await waitForVtxo(vtxoScript.pkScript);

            // Find the multisig (with arkade-tweaked emulator) leaf.
            const arkadeLeaf = ConditionMultisigTapscript.encode({
                conditionScript: preimageCondition,
                pubkeys: [
                    serverXOnlyPubkey,
                    arkade.computeArkadeScriptPublicKey(emulatorPubkey, arkadeScript),
                ],
            });
            const tapLeafScript = vtxoScript.findLeaf(hex.encode(arkadeLeaf.script));
            const tapTree = vtxoScript.encode();

            // enforcePayTo starts with DUP INSPECTOUTPUTSCRIPTPUBKEY — DUP
            // duplicates the top stack item (output_index). So the witness
            // must push 0 (output index 0). Empty bytes encode as OP_0 in
            // Bitcoin script. Serialized witness: varint(1) element,
            // each element length-prefixed: [0x01, 0x00] means 1 element of
            // length 0 (empty bytes = 0 in script numeric context).
            const arkadeWitnessBytes = new Uint8Array([0x01, 0x00]);

            const buildClaim = (outputs: { script: Uint8Array; amount: bigint }[]) => {
                const { arkTx, checkpoints } = buildOffchainTx(
                    [{ ...vtxo, tapLeafScript, tapTree }],
                    outputs,
                    checkpointUnrollClosure,
                );
                // ConditionWitness: pass preimage on ark tx input 0 and each
                // checkpoint input 0.
                setArkPsbtField(arkTx, 0, ConditionWitness, [HTLC_PREIMAGE]);
                for (const cp of checkpoints) {
                    setArkPsbtField(cp, 0, ConditionWitness, [HTLC_PREIMAGE]);
                }
                // Arkade emulator packet: output_index=0 pushed as empty
                // bytes (OP_0) for the DUP in enforcePayTo.
                addEmulatorPacket(arkTx, [
                    {
                        vin: 0,
                        script: arkadeScript,
                        witness: arkadeWitnessBytes,
                    },
                ]);
                return { arkTx, checkpoints };
            };

            const submitAndExpectFailure = async (
                outputs: { script: Uint8Array; amount: bigint }[],
            ) => {
                const { arkTx, checkpoints } = buildClaim(outputs);
                await expect(
                    emulator.submitTx(
                        base64.encode(arkTx.toPSBT()),
                        checkpoints.map((c) => base64.encode(c.toPSBT())),
                    ),
                ).rejects.toThrow();
            };

            // Negative case 1: wrong output script (OP_RETURN).
            await submitAndExpectFailure([
                { script: new Uint8Array([0x6a]), amount: CONTRACT_AMOUNT },
            ]);

            // Negative case 2: right script but wrong amount (split outputs).
            await submitAndExpectFailure([
                { script: receiverPkScript, amount: CONTRACT_AMOUNT - 1n },
                { script: randomP2TR(), amount: 1n },
            ]);

            // Valid: right output and amount.
            const { arkTx: validTx, checkpoints: validCps } = buildClaim([
                { script: receiverPkScript, amount: CONTRACT_AMOUNT },
            ]);
            const introResult = await emulator.submitTx(
                base64.encode(validTx.toPSBT()),
                validCps.map((c) => base64.encode(c.toPSBT())),
            );

            // In this HTLC closure the emulator is the last (non-arkd)
            // signer, so it acts as finalizer and internally submits + finalizes
            // with arkd before returning. We must NOT call arkProvider.submitTx
            // again — that would produce "duplicated offchain tx".
            //
            // Verify success by extracting the txid from the returned ark tx.
            const finalTx = Transaction.fromPSBT(base64.decode(introResult.signedArkTx));
            const arkTxid = finalTx.id;
            expect(arkTxid).toBeTruthy();
        },
    );

    it(
        "refund: emulator signs only when CLTV satisfied + arkade script passes",
        { timeout: 60000 },
        async () => {
            const _alice = await createTestArkWallet();

            const senderPkScript = randomP2TR();
            const arkadeScript = enforcePayTo(senderPkScript, CONTRACT_AMOUNT);

            const REFUND_LOCKTIME = 500_000_000n; // genesis-relative, always satisfied

            const vtxoScript = new VtxoScript([
                CLTVMultisigTapscript.encode({
                    absoluteTimelock: REFUND_LOCKTIME,
                    pubkeys: [
                        serverXOnlyPubkey,
                        arkade.computeArkadeScriptPublicKey(emulatorPubkey, arkadeScript),
                    ],
                }).script,
            ]);
            const contractAddress = vtxoScript
                .address(networks.regtest.hrp, serverXOnlyPubkey)
                .encode();

            faucetOffchain(contractAddress, Number(CONTRACT_AMOUNT));
            const [vtxo] = await waitForVtxo(vtxoScript.pkScript);

            // Find the leaf with the emulator's tweaked key.
            const arkadeLeaf = CLTVMultisigTapscript.encode({
                absoluteTimelock: REFUND_LOCKTIME,
                pubkeys: [
                    serverXOnlyPubkey,
                    arkade.computeArkadeScriptPublicKey(emulatorPubkey, arkadeScript),
                ],
            });
            const tapLeafScript = vtxoScript.findLeaf(hex.encode(arkadeLeaf.script));
            const tapTree = vtxoScript.encode();

            // Same witness encoding as the claim test: a 1-element witness pushing
            // empty bytes (= 0). enforcePayTo's first opcode DUP requires
            // output_index already on the stack.
            const emulatorWitness = new Uint8Array([0x01, 0x00]);

            const buildRefund = (outputs: { script: Uint8Array; amount: bigint }[]) => {
                const { arkTx, checkpoints } = buildOffchainTx(
                    [{ ...vtxo, tapLeafScript, tapTree }],
                    outputs,
                    checkpointUnrollClosure,
                );
                addEmulatorPacket(arkTx, [
                    {
                        vin: 0,
                        script: arkadeScript,
                        witness: emulatorWitness,
                    },
                ]);
                return { arkTx, checkpoints };
            };

            const submitAndExpectFailure = async (
                outputs: { script: Uint8Array; amount: bigint }[],
            ) => {
                const { arkTx, checkpoints } = buildRefund(outputs);
                await expect(
                    emulator.submitTx(
                        base64.encode(arkTx.toPSBT()),
                        checkpoints.map((c) => base64.encode(c.toPSBT())),
                    ),
                ).rejects.toThrow();
            };

            // Negative: wrong destination.
            await submitAndExpectFailure([
                { script: new Uint8Array([0x6a]), amount: CONTRACT_AMOUNT },
            ]);
            // Negative: wrong amount.
            await submitAndExpectFailure([
                { script: senderPkScript, amount: CONTRACT_AMOUNT - 1n },
                { script: randomP2TR(), amount: 1n },
            ]);

            // Valid: right output and amount.
            const { arkTx, checkpoints } = buildRefund([
                { script: senderPkScript, amount: CONTRACT_AMOUNT },
            ]);
            const result = await emulator.submitTx(
                base64.encode(arkTx.toPSBT()),
                checkpoints.map((c) => base64.encode(c.toPSBT())),
            );

            // Emulator is the last non-arkd signer (multisig is [server,
            // emulator_tweaked], no user), so it auto-finalizes via arkd.
            // Do NOT call arkProvider.submitTx again — it would error with
            // "duplicated offchain tx".
            expect(result.signedArkTx).toBeTruthy();
        },
    );
});
