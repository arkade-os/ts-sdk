import { describe, it, expect, beforeAll } from "vitest";
import { base64, hex } from "@scure/base";
import { p2tr, SigHash } from "@scure/btc-signer";
import {
    arkade,
    EsploraProvider,
    MultisigTapscript,
    networks,
    PrevoutTxField,
    RestArkProvider,
    RestIntrospectorProvider,
    setArkPsbtField,
    SingleKey,
} from "../../src";
import { Transaction } from "../../src/utils/transaction";
import {
    addIntrospectorPacket,
    enforcePayTo,
    execCommand,
    waitForUtxo,
} from "./utils";

const INTROSPECTOR_URL = "http://localhost:7073";
const ARK_SERVER_URL = "http://localhost:7070";
const ESPLORA_URL = "http://localhost:3000";
const FUNDING_BTC = "0.01";
const FUNDING_AMOUNT = 1_000_000n;
const FEE_AMOUNT = 500n;
const SPEND_AMOUNT = FUNDING_AMOUNT - FEE_AMOUNT;

async function fetchTxHex(txid: string): Promise<string> {
    const resp = await fetch(`${ESPLORA_URL}/tx/${txid}/hex`);
    if (!resp.ok) {
        throw new Error(`fetchTxHex failed: ${resp.statusText}`);
    }
    return resp.text();
}

describe("arkade SubmitOnchainTx", () => {
    const introspector = new RestIntrospectorProvider(INTROSPECTOR_URL);
    const arkProvider = new RestArkProvider(ARK_SERVER_URL);
    const explorer = new EsploraProvider(ESPLORA_URL);

    let introspectorPubkey: Uint8Array;

    beforeAll(async () => {
        introspectorPubkey = hex.decode(
            (await introspector.getInfo()).signerPubkey
        );
    });

    /**
     * Builds an unsigned 1-in/1-out spend PSBT with all required arkade fields.
     * `arkadeScript: null` means "no introspector packet" — tests the rejection path.
     */
    function buildOnchainSpendTx(opts: {
        fundingTxid: string;
        fundingVout: number;
        fundingValue: bigint;
        fundingPkScript: Uint8Array;
        rawFundingTx: Uint8Array;
        spendOutputScript: Uint8Array;
        spendOutputValue: bigint;
        tapLeafScript: ReturnType<
            InstanceType<typeof arkade.ArkadeVtxoScript>["findLeaf"]
        >;
        arkadeScript: Uint8Array | null;
    }): Transaction {
        const txid = hex.decode(opts.fundingTxid);
        const tx = new Transaction({ version: 2 });
        tx.addInput({
            txid,
            index: opts.fundingVout,
            sequence: 0xffffffff,
            witnessUtxo: {
                amount: opts.fundingValue,
                script: opts.fundingPkScript,
            },
            tapLeafScript: [opts.tapLeafScript],
            sighashType: SigHash.DEFAULT,
        });
        tx.addOutput({
            script: opts.spendOutputScript,
            amount: opts.spendOutputValue,
        });

        setArkPsbtField(tx, 0, PrevoutTxField, opts.rawFundingTx);

        if (opts.arkadeScript) {
            addIntrospectorPacket(tx, [
                {
                    vin: 0,
                    script: opts.arkadeScript,
                    // single empty push for output_index = 0
                    witness: new Uint8Array([0x01, 0x00]),
                },
            ]);
        }
        return tx;
    }

    /**
     * Sets up the funded contract address shared by most subtests.
     * 3-of-3 multisig [bobX, aliceX, introspector_tweaked] with arkade closure.
     */
    async function setupFundedContract() {
        const bob = SingleKey.fromRandomBytes();
        const alice = SingleKey.fromRandomBytes();
        const bobX = await bob.xOnlyPublicKey();
        const aliceX = await alice.xOnlyPublicKey();
        const bobP2TR = p2tr(bobX, undefined, networks.regtest).script;

        const arkadeScript = enforcePayTo(bobP2TR, SPEND_AMOUNT);
        const tweakedIntro = arkade.computeArkadeScriptPublicKey(
            introspectorPubkey,
            arkadeScript
        );

        const vtxoScript = new arkade.ArkadeVtxoScript([
            {
                arkadeScript,
                introspectors: [introspectorPubkey],
                tapscript: MultisigTapscript.encode({
                    pubkeys: [bobX, aliceX],
                }),
            },
        ]);

        const arkadeLeafScript = MultisigTapscript.encode({
            pubkeys: [bobX, aliceX, tweakedIntro],
        });
        const tapLeafScript = vtxoScript.findLeaf(
            hex.encode(arkadeLeafScript.script)
        );

        const contractAddress = vtxoScript.onchainAddress(networks.regtest);

        execCommand(`nigiri faucet ${contractAddress} ${FUNDING_BTC}`);
        execCommand(`nigiri rpc -generate 1`);

        const utxo = await waitForUtxo(contractAddress);
        const rawHex = await fetchTxHex(utxo.txid);
        const rawFundingTx = hex.decode(rawHex);

        return {
            bob,
            alice,
            bobP2TR,
            arkadeScript,
            vtxoScript,
            tapLeafScript,
            utxo,
            rawFundingTx,
        };
    }

    it(
        "valid: introspector co-signs and the tx broadcasts after the third sig",
        { timeout: 120000 },
        async () => {
            const ctx = await setupFundedContract();

            const tx = buildOnchainSpendTx({
                fundingTxid: ctx.utxo.txid,
                fundingVout: ctx.utxo.vout,
                fundingValue: FUNDING_AMOUNT,
                fundingPkScript: ctx.vtxoScript.pkScript,
                rawFundingTx: ctx.rawFundingTx,
                spendOutputScript: ctx.bobP2TR,
                spendOutputValue: SPEND_AMOUNT,
                tapLeafScript: ctx.tapLeafScript,
                arkadeScript: ctx.arkadeScript,
            });

            const bobSigned = await ctx.bob.sign(tx, [0]);
            const result = await introspector.submitOnchainTx(
                base64.encode(bobSigned.toPSBT())
            );

            const parsed = Transaction.fromPSBT(base64.decode(result.signedTx));
            const input0 = parsed.getInput(0);
            const sigs = input0?.tapScriptSig ?? [];
            expect(sigs.length).toBeGreaterThanOrEqual(2);

            // Add Alice's signature to complete the 3-of-3 multisig.
            const aliceSigned = await ctx.alice.sign(parsed, [0]);
            aliceSigned.finalize();
            const txHex = hex.encode(aliceSigned.extract());

            const broadcastTxid = await explorer.broadcastTransaction(txHex);
            expect(broadcastTxid).toBeTruthy();
        }
    );

    it(
        "rejects when no introspector packet is present",
        { timeout: 60000 },
        async () => {
            const ctx = await setupFundedContract();

            const tx = buildOnchainSpendTx({
                fundingTxid: ctx.utxo.txid,
                fundingVout: ctx.utxo.vout,
                fundingValue: FUNDING_AMOUNT,
                fundingPkScript: ctx.vtxoScript.pkScript,
                rawFundingTx: ctx.rawFundingTx,
                spendOutputScript: ctx.bobP2TR,
                spendOutputValue: SPEND_AMOUNT,
                tapLeafScript: ctx.tapLeafScript,
                arkadeScript: null,
            });

            const bobSigned = await ctx.bob.sign(tx, [0]);
            await expect(
                introspector.submitOnchainTx(base64.encode(bobSigned.toPSBT()))
            ).rejects.toThrow();
        }
    );

    it(
        "rejects when PrevoutTxField points at the wrong tx",
        { timeout: 60000 },
        async () => {
            const ctx = await setupFundedContract();

            const bogus = new Transaction({ version: 2 });
            bogus.addOutput({ script: new Uint8Array([0x6a]), amount: 1n });
            const bogusRaw = bogus.toBytes();

            const tx = buildOnchainSpendTx({
                fundingTxid: ctx.utxo.txid,
                fundingVout: ctx.utxo.vout,
                fundingValue: FUNDING_AMOUNT,
                fundingPkScript: ctx.vtxoScript.pkScript,
                rawFundingTx: bogusRaw,
                spendOutputScript: ctx.bobP2TR,
                spendOutputValue: SPEND_AMOUNT,
                tapLeafScript: ctx.tapLeafScript,
                arkadeScript: ctx.arkadeScript,
            });

            const bobSigned = await ctx.bob.sign(tx, [0]);
            await expect(
                introspector.submitOnchainTx(base64.encode(bobSigned.toPSBT()))
            ).rejects.toThrow();
        }
    );

    it(
        "rejects when the arkade script fails (wrong amount)",
        { timeout: 60000 },
        async () => {
            const ctx = await setupFundedContract();

            const tx = buildOnchainSpendTx({
                fundingTxid: ctx.utxo.txid,
                fundingVout: ctx.utxo.vout,
                fundingValue: FUNDING_AMOUNT,
                fundingPkScript: ctx.vtxoScript.pkScript,
                rawFundingTx: ctx.rawFundingTx,
                spendOutputScript: ctx.bobP2TR,
                spendOutputValue: SPEND_AMOUNT - 1n, // off by one → arkade script fails
                tapLeafScript: ctx.tapLeafScript,
                arkadeScript: ctx.arkadeScript,
            });

            const bobSigned = await ctx.bob.sign(tx, [0]);
            await expect(
                introspector.submitOnchainTx(base64.encode(bobSigned.toPSBT()))
            ).rejects.toThrow();
        }
    );

    it(
        "rejects a tapscript that includes arkd's signer pubkey",
        { timeout: 60000 },
        async () => {
            const arkdInfo = await arkProvider.getInfo();
            // signerPubkey is a 33-byte compressed pubkey hex; strip the prefix byte for x-only
            const arkdFull = hex.decode(arkdInfo.signerPubkey);
            const arkdX = arkdFull.slice(1); // x-only (32 bytes)

            const bob = SingleKey.fromRandomBytes();
            const bobX = await bob.xOnlyPublicKey();
            const bobP2TR = p2tr(bobX, undefined, networks.regtest).script;
            const arkadeScript = enforcePayTo(bobP2TR, SPEND_AMOUNT);

            const vtxoScript = new arkade.ArkadeVtxoScript([
                {
                    arkadeScript,
                    introspectors: [introspectorPubkey],
                    tapscript: MultisigTapscript.encode({
                        pubkeys: [bobX, arkdX], // arkd as a cosigner — must be rejected
                    }),
                },
            ]);

            const arkadeLeaf = MultisigTapscript.encode({
                pubkeys: [
                    bobX,
                    arkdX,
                    arkade.computeArkadeScriptPublicKey(
                        introspectorPubkey,
                        arkadeScript
                    ),
                ],
            });
            const tapLeafScript = vtxoScript.findLeaf(
                hex.encode(arkadeLeaf.script)
            );

            // The introspector's rejection check runs before script execution,
            // so the funding txid / prevout tx contents don't matter here.
            const tx = buildOnchainSpendTx({
                fundingTxid: "00".repeat(32),
                fundingVout: 0,
                fundingValue: FUNDING_AMOUNT,
                fundingPkScript: vtxoScript.pkScript,
                rawFundingTx: new Uint8Array([
                    0x02,
                    0,
                    0,
                    0, // version
                    0x00, // input count = 0
                    0x00, // output count = 0
                    0,
                    0,
                    0,
                    0, // locktime
                ]),
                spendOutputScript: bobP2TR,
                spendOutputValue: SPEND_AMOUNT,
                tapLeafScript,
                arkadeScript,
            });

            await expect(
                introspector.submitOnchainTx(base64.encode(tx.toPSBT()))
            ).rejects.toThrow();
        }
    );
});
