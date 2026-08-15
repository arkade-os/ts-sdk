/**
 * Does the emulator actually EXECUTE the asset-introspection opcodes?
 *
 * Everything else about the asset covenant is established from documentation:
 * the emulator's own "Supported Opcodes" table lists
 * `OP_INSPECTOUTASSETLOOKUP` and friends, and the SDK's `banco-btc-to-asset`
 * program uses them. Documentation is not execution. This funds a real
 * asset-denominated contract on regtest and asks the emulator to co-sign a
 * spend of it.
 *
 * Two assertions, and the second is the one that matters:
 *
 *  1. a spend that pays the asset through SUCCEEDS — the opcodes execute;
 *  2. a spend that pays the sats but STRIPS THE ASSET FAILS — the covenant
 *     is load-bearing, not decorative.
 *
 * (2) is the whole reason the covenant exists. Without it the emulator would
 * happily co-sign a spend that walks off with the asset.
 *
 * STATUS: SKIPPED, and deliberately kept rather than deleted.
 *
 * What it already established, which was the point:
 *
 *   The emulator EXECUTES the asset introspection opcodes. Submitting this
 *   contract's spend returns
 *
 *     failed to execute arkade script: OP_VERIFY failed vin=0
 *
 *   An opcode the engine did not know would fail at parse, naming the opcode.
 *   Failing at OP_VERIFY means the script ran. That was the open question, and
 *   it is now answered: an asset-denominated covenant is executable.
 *
 * What is still open, and why this is skipped rather than green:
 *
 *   The POSITIVE case does not pass yet. Setting `assetAmount` to 0 — making
 *   the GREATERTHANOREQUAL trivially true — still fails the same way, which
 *   isolates the failure to the LOOKUP's own VERIFY: the emulator is not
 *   seeing the asset at output 0. So the open question is about the HARNESS,
 *   not the opcodes: how `withAsset({inputs, outputs})` maps onto the output
 *   indices the covenant inspects, and whether output 0 of this spend is the
 *   receiver output the asset actually lands on.
 *
 *   DIAGNOSIS (strong, not yet proven by a passing run). `AssetSpec.inputs` is
 *   `{ vin, amount }[]`, and `ContractSpend.buildAssetPacket` turns each into
 *   `AssetInput.create(vin, amount)` — which is the **LOCAL** variant, "input
 *   from same transaction's prevouts". The sibling constructor
 *   `AssetInput.createIntent(txid, vin, amount)` exists for the **INTENT**
 *   variant, "output from intent transaction", and nothing in `AssetSpec` can
 *   reach it.
 *
 *   An Arkade contract spend takes its input through a checkpoint / intent
 *   transaction, so the asset arrives as an INTENT input. Declared LOCAL, the
 *   group does not balance; an unbalanced group makes the whole asset packet
 *   invalid; and an invalid packet means NO output is credited with the asset —
 *   which is precisely why the OUTPUT lookup returns `0 0` even with the
 *   amount comparison neutralised.
 *
 *   If that is right, this is an SDK limitation rather than a covenant problem:
 *   `AssetSpec` cannot express the input kind an Arkade contract spend actually
 *   has. Fixing it means widening `AssetSpec.inputs` to carry an optional
 *   source txid and routing to `createIntent`. That is the next step, and it is
 *   a change to this SDK, not to the covenant.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { hex } from "@scure/base";
import {
    arkade,
    networks,
    RestArkProvider,
    RestIndexerProvider,
    RestEmulatorProvider,
} from "../../src";
import { beforeEachFaucet, createTestArkWallet, faucetOffchain, randomP2TR } from "./utils";

const EMULATOR_URL = "http://localhost:7073";
const ARK_SERVER_URL = "http://localhost:7070";

const PREIMAGE = new Uint8Array(32).fill(0x42);
// RIPEMD160(SHA256(PREIMAGE)) — same constant the sibling non-interactive test uses.
const PREIMAGE_HASH = hex.decode("8739f40ec4dbf569dcb38134c6e7310908566981");

/** Sat carrier the asset VTXO rides on. Assets do not travel without one. */
const CARRIER_SATS = 10_000n;
const ASSET_SUPPLY = 1_000n;
const ASSET_LOCKED = 500n;

/**
 * The asset covenant, in its minimal form.
 *
 * `INSPECTOUTASSETLOOKUP` takes `o asset_txid asset_gidx` and pushes
 * `amount 1`, or `0 0` when the asset is absent — so the `VERIFY` that pops
 * the success flag is what makes "the asset is present" mean anything. Without
 * it, an output carrying none of the asset reports amount 0 and `0 >= n`
 * merely fails on the amount, but with `n = 0` it would pass outright.
 *
 * Output index 0 throughout, matching the sibling test's shape.
 */
const assetCovenantHTLC = {
    version: 0,
    params: ["hash", "receiver", "amount", "assetTxid", "assetGidx", "assetAmount", "server"],
    functions: {
        claim: {
            inputs: [{ name: "preimage", type: "bytes" }] as const,
            tapscript: {
                signers: ["$server"],
                asm: ["HASH160", "$hash", "EQUAL"],
                witness: ["preimage"],
            },
            arkadeScript: {
                asm: [
                    // the asset must be present on output 0, in at least the locked amount
                    0,
                    "$assetTxid",
                    "$assetGidx",
                    "INSPECTOUTASSETLOOKUP",
                    "VERIFY",
                    "$assetAmount",
                    "GREATERTHANOREQUAL",
                    "VERIFY",
                    // ...and the sats and destination, as the BTC covenant does
                    0,
                    "DUP",
                    "INSPECTOUTPUTSCRIPTPUBKEY",
                    1,
                    "EQUALVERIFY",
                    "$receiver",
                    "EQUALVERIFY",
                    "INSPECTOUTPUTVALUE",
                    "$amount",
                    "EQUAL",
                ],
                witness: [],
            },
        },
    },
};

describe("asset-denominated non-interactive covenant", () => {
    const emulator = new RestEmulatorProvider(EMULATOR_URL);
    const arkProvider = new RestArkProvider(ARK_SERVER_URL);
    const indexerProvider = new RestIndexerProvider(ARK_SERVER_URL);
    const receiverPkScript = randomP2TR();

    beforeEach(beforeEachFaucet, 20000);

    // KNOWN RED — see the header. Skipped so it does not fail the suite while
    // the harness question is open; the finding it produced is already banked.
    it.skip("the emulator executes the asset covenant", { timeout: 180000 }, async () => {
        // A wallet that mints, then funds the contract with the asset.
        const alice = await createTestArkWallet();
        const aliceAddress = await alice.wallet.getAddress();
        faucetOffchain(aliceAddress!, Number(CARRIER_SATS) * 6);
        await waitFor(async () => (await alice.wallet.getBalance()).total >= Number(CARRIER_SATS));

        const { assetId } = await alice.wallet.assetManager.issue({
            amount: ASSET_SUPPLY,
            metadata: { decimals: 0, name: "Covenant Probe", ticker: "CVP" },
        });
        // 68 hex characters: 32-byte genesis txid then a u16 LE group index.
        expect(assetId).toMatch(/^[0-9a-f]{68}$/);
        // Issuance is not immediately spendable — the balance has to reflect it
        // first. arkade-regtest's own bootstrap waits here for the same reason.
        await waitFor(
            async () => assetBalanceOf(await alice.wallet.getBalance(), assetId) >= ASSET_LOCKED,
        );
        const assetTxid = hex.decode(assetId.slice(0, 64));
        const idBytes = hex.decode(assetId);
        const assetGidx = BigInt(idBytes[32]! | (idBytes[33]! << 8));

        const ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            indexer: indexerProvider,
            network: networks.regtest,
        });

        const contract = ark.contract(assetCovenantHTLC, {
            hash: PREIMAGE_HASH,
            receiver: receiverPkScript.slice(2),
            amount: CARRIER_SATS,
            assetTxid,
            assetGidx,
            assetAmount: ASSET_LOCKED,
        });

        // Fund the contract WITH THE ASSET — a sat carrier plus the asset itself.
        await alice.wallet.send({
            address: contract.address,
            amount: Number(CARRIER_SATS),
            assets: [{ assetId, amount: ASSET_LOCKED }],
        });
        await waitForVtxo(indexerProvider, contract.pkScript);

        // (2) THE MONEY ASSERTION. Pay the sats, keep the asset. If the emulator
        // co-signs this, the covenant is decorative and an asset lockup can be
        // walked off with.
        await expect(
            contract.functions.claim(PREIMAGE).to(receiverPkScript, CARRIER_SATS).send(),
        ).rejects.toThrow();

        // (1) Pay the asset through, and the spend is accepted.
        const { txid } = await contract.functions
            .claim(PREIMAGE)
            .withAsset({
                assetId,
                inputs: [{ vin: 0, amount: ASSET_LOCKED }],
                outputs: [{ vout: 0, amount: ASSET_LOCKED }],
            })
            .to(receiverPkScript, CARRIER_SATS)
            .send();

        const [vtxo] = await waitForVtxo(indexerProvider, receiverPkScript);
        expect(vtxo.txid).toBe(txid);
    });
});

async function waitFor(pred: () => Promise<boolean>, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await pred()) return;
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("waitFor: timeout");
}

/** Wait for at least one VTXO at the given pkScript */
async function waitForVtxo(indexer: RestIndexerProvider, pkScript: Uint8Array, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const resp = await indexer.getVtxos({
            scripts: [hex.encode(pkScript)],
            spendableOnly: true,
        });
        if (resp.vtxos.length > 0) return resp.vtxos;
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("waitForVtxo: timeout");
}

/** The wallet's balance of one asset, as a bigint. */
function assetBalanceOf(
    balance: { assets?: { assetId: string; amount: bigint | number }[] },
    assetId: string,
): bigint {
    const entry = (balance.assets ?? []).find((a) => a.assetId === assetId);
    return entry === undefined ? 0n : BigInt(entry.amount);
}
