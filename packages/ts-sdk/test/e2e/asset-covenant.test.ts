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
 * RESULT: PASSES. Both assertions hold, so the covenant is spendable AND
 * protective — the emulator co-signs a spend that pays the asset through, and
 * refuses one that keeps the sats and strips the asset.
 *
 * Three things had to be right, and each was established by elimination
 * against a passing BTC-only control (`non-interactive-htlc.test.ts`):
 *
 *  1. The asset input must be declared LOCAL, not INTENT. Declaring it intent
 *     is rejected upstream by arkd itself:
 *       ASSET_INPUT_INVALID (35): unexpected asset input type: intent
 *
 *  2. Issuance is not immediately spendable. The wallet balance has to reflect
 *     it before the asset can be sent, which is why the mint is followed by a
 *     wait here, as arkade-regtest's own bootstrap does.
 *
 *  3. THE TXID PUSHED BY THE SCRIPT IS REVERSED relative to the serialized
 *     Asset ID. `assetId.slice(0, 64)` is the id's leading 32 bytes; the
 *     opcode matches only against those bytes REVERSED. With them un-reversed
 *     the lookup returns `0 0` and the covenant's VERIFY fails — and it fails
 *     identically whatever the amount comparison says, which is what isolated
 *     it.
 *
 * (3) is the trap worth remembering: nothing about it is visible in the error,
 * which says only `OP_VERIFY failed vin=0`.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import type { TransactionOutput } from "@scure/btc-signer/psbt.js";
import {
    arkade,
    VHTLC,
    asset as assetExt,
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

/**
 * Filler for the covenant suite's refund destination. The byte-equality proofs
 * below read only `nonInteractiveClaimArkadeScript`, which is a function of
 * `receiverPkScript` alone — but the suite is all-or-nothing, so a valid P2TR
 * `senderPkScript` must be present for the group to build at all.
 */
const FILLER_SENDER_PK_SCRIPT = Uint8Array.from([
    0x51,
    0x20,
    ...schnorr.getPublicKey(new Uint8Array(32).fill(6)),
]);

/** Sat carrier the asset VTXO rides on. Assets do not travel without one. */
const CARRIER_SATS = 10_000n;
const ASSET_SUPPLY = 1_000n;
const ASSET_LOCKED = 500n;
/** What a shortchanging spend tries to forward instead of the whole amount. */
const ASSET_SKIMMED = 100n;
/** A second asset funded alongside the bound one — what the count bound refuses. */
const ASSET_TAGALONG = 7n;
/** Room for a second output, so a misdirection spend is constructable at all. */
const DUST_SATS = 330n;

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
    params: ["hash", "receiver", "amount", "assetTxid", "assetGidx", "server"],
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
                    // THE ASSET CLAUSE, INPUT-RELATIVE — mirroring what
                    // `VHTLC.ScriptV2` actually builds rather than a simplified
                    // stand-in. Two of these opcodes had never been executed by
                    // anything in this repo: `INSPECTINASSETLOOKUP`, which is
                    // what makes the comparison relative to what was locked
                    // rather than to a constant baked into the script, and
                    // `INSPECTOUTASSETCOUNT`, which stops a spend injecting
                    // further assets alongside the bound one. A stack-order or
                    // counting quirk in either would make every ScriptV2 asset
                    // contract unspendable on its covenant leaves, and byte-
                    // pinning unit tests cannot find that — they passed for the
                    // pre-flip txid too.
                    //
                    // Index `0` where ScriptV2 writes `PUSHCURRENTINPUTINDEX`.
                    // Equivalent for this spend, which has one contract input at
                    // 0 paying output 0, and the same self-send alignment the sat
                    // clause below already relies on.
                    0,
                    "$assetTxid",
                    "$assetGidx",
                    "INSPECTOUTASSETLOOKUP",
                    "VERIFY", // PRESENT on the output, not merely "zero of it"
                    0,
                    "$assetTxid",
                    "$assetGidx",
                    "INSPECTINASSETLOOKUP",
                    "VERIFY", // ...and on the input, so the comparison means something
                    "GREATERTHANOREQUAL",
                    "VERIFY",
                    // Exactly one asset out: nothing injected alongside the bound one.
                    0,
                    "INSPECTOUTASSETCOUNT",
                    1,
                    "EQUALVERIFY",
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

/**
 * The SAME contract shape, with the arkadeScript written to match
 * `VHTLC.ScriptV2`'s own covenant token for token.
 *
 * The artifact above is a probe: literal `0` for the output index, `$amount
 * EQUAL` for the sats. Convenient — it keeps the misdirection cases
 * constructable — and it means the emulator never executes the exact bytes a
 * consumer locks funds to. This one closes that, and the test PROVES the match
 * with `resolveAsm` rather than asserting it by eye.
 */
const scriptV2Shaped = {
    version: 0,
    params: ["hash", "receiver", "assetTxid", "assetGidx", "server"],
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
                    "PUSHCURRENTINPUTINDEX",
                    "$assetTxid",
                    "$assetGidx",
                    "INSPECTOUTASSETLOOKUP",
                    "VERIFY",
                    "PUSHCURRENTINPUTINDEX",
                    "$assetTxid",
                    "$assetGidx",
                    "INSPECTINASSETLOOKUP",
                    "VERIFY",
                    "GREATERTHANOREQUAL",
                    "VERIFY",
                    "PUSHCURRENTINPUTINDEX",
                    "INSPECTOUTASSETCOUNT",
                    1,
                    "EQUALVERIFY",
                    "PUSHCURRENTINPUTINDEX",
                    "DUP",
                    "INSPECTOUTPUTSCRIPTPUBKEY",
                    1,
                    "EQUALVERIFY",
                    "$receiver",
                    "EQUALVERIFY",
                    "INSPECTOUTPUTVALUE",
                    "PUSHCURRENTINPUTINDEX",
                    "INSPECTINPUTVALUE",
                    "GREATERTHANOREQUAL",
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

    it("the emulator executes the asset covenant", { timeout: 180000 }, async () => {
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
        // A SECOND asset, so `INSPECTOUTASSETCOUNT` has something to refuse.
        // Without one, deleting that bound entirely goes unnoticed: every spend
        // here carries a single asset, so the count is 1 whether or not anything
        // checks it.
        const { assetId: otherId } = await alice.wallet.assetManager.issue({
            amount: ASSET_SUPPLY,
            metadata: { decimals: 0, name: "Covenant Probe Two", ticker: "CVP2" },
        });
        await waitFor(
            async () => assetBalanceOf(await alice.wallet.getBalance(), otherId) >= ASSET_TAGALONG,
        );

        // Reversed HERE because this probe pushes the id into a raw artifact.
        // `VHTLC.ScriptV2` does the same flip internally, so a contract built
        // through the SDK takes the id in canonical order and callers do not think
        // about it; this test is the layer below that.
        // Namespaced: the entry point re-exports this module as `export * as
        // asset`, so the class is `asset.AssetId` and a bare `AssetId` import
        // type-checks (the TYPE is re-exported) and is undefined at runtime.
        const parsed = assetExt.AssetId.fromString(assetId);
        const assetTxid = Uint8Array.from(parsed.txid).reverse();
        const assetGidx = BigInt(parsed.groupIndex);

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
        });

        // Fund the contract WITH THE ASSET — a sat carrier plus the asset itself.
        await alice.wallet.send({
            address: contract.address,
            // CARRIER_SATS plus a dust output's worth. The sat clause pins output
            // 0 to exactly CARRIER_SATS, so without this surplus a spend could
            // not build a SECOND output at all — and the misdirection cases
            // below, which are the only ones the asset clause alone refuses,
            // would be unconstructable.
            amount: Number(CARRIER_SATS + DUST_SATS),
            // BOTH assets, which is the shape the caveat on `VHTLC.Options.asset`
            // warns about: only the bound one is protected.
            assets: [
                { assetId, amount: ASSET_LOCKED },
                { assetId: otherId, amount: ASSET_TAGALONG },
            ],
        });
        // Funded and visible — the value is not needed, only the arrival.
        await waitForVtxo(indexerProvider, contract.pkScript);

        // (2) THE MONEY ASSERTIONS — the spends only this covenant refuses.
        //
        // WHAT IS DELIBERATELY NOT ASSERTED HERE, because it proves nothing: a
        // spend carrying NO asset packet at all. That is refused whatever the
        // covenant says — the emulator stops at `vm.assetPacket == nil` before
        // reaching an asset opcode, and arkd's own `ValidateAssetTransaction`
        // rejects it upstream regardless. Stripping-by-omission is a protocol
        // invariant of any asset VTXO. Asserting it reads like a covenant test
        // and is one for free; a covenant of `INSPECTOUTASSETLOOKUP VERIFY DROP`
        // passes it, and so does a purely decorative one.
        //
        // Both cases below balance: asset in equals asset out, so arkd's
        // conservation check is satisfied and the ONLY thing left to refuse
        // them is the covenant.
        const elsewhere = randomP2TR();
        /** Route the tag-along to one output — it must go somewhere for conservation. */
        const tagAlongTo = (vout: number) => ({
            assetId: otherId,
            inputs: [{ vin: 0, amount: ASSET_TAGALONG }],
            outputs: [{ vout, amount: ASSET_TAGALONG }],
        });
        const payTwo = (): TransactionOutput[] => [
            { script: receiverPkScript, amount: CARRIER_SATS },
            { script: elsewhere, amount: DUST_SATS },
        ];

        // (2a) MISDIRECTION. The sats go exactly where the covenant demands, and
        // the asset goes somewhere else entirely. Refused by the output lookup's
        // VERIFY: an output carrying none of the asset reports `0 0`, and the
        // flag is what the VERIFY pops.
        await expect(
            contract.functions
                .claim(PREIMAGE)
                .withAsset({
                    assetId,
                    inputs: [{ vin: 0, amount: ASSET_LOCKED }],
                    outputs: [{ vout: 1, amount: ASSET_LOCKED }],
                })
                .withAsset(tagAlongTo(1))
                .to(payTwo())
                .send(),
        ).rejects.toThrow();

        // (2b) SHORTCHANGING, and this is the one that discriminates. The asset
        // IS on output 0, so the presence VERIFY passes and a covenant that only
        // checked presence would co-sign — but most of it has been skimmed to
        // another output. Only the input-relative amount comparison
        // (`INSPECTINASSETLOOKUP ... GREATERTHANOREQUAL`) refuses this, which is
        // exactly the clause a decorative covenant drops.
        await expect(
            contract.functions
                .claim(PREIMAGE)
                .withAsset({
                    assetId,
                    inputs: [{ vin: 0, amount: ASSET_LOCKED }],
                    outputs: [
                        { vout: 0, amount: ASSET_SKIMMED },
                        { vout: 1, amount: ASSET_LOCKED - ASSET_SKIMMED },
                    ],
                })
                .withAsset(tagAlongTo(1))
                .to(payTwo())
                .send(),
        ).rejects.toThrow();

        // (2c) INJECTION. The bound asset is forwarded in full — presence and
        // amount both satisfied — and the tag-along is dumped onto the SAME
        // output. Only `INSPECTOUTASSETCOUNT == 1` refuses this, and until there
        // were two assets in play nothing could tell whether that bound existed.
        await expect(
            contract.functions
                .claim(PREIMAGE)
                .withAsset({
                    assetId,
                    inputs: [{ vin: 0, amount: ASSET_LOCKED }],
                    outputs: [{ vout: 0, amount: ASSET_LOCKED }],
                })
                .withAsset(tagAlongTo(0))
                .to(payTwo())
                .send(),
        ).rejects.toThrow();

        // (1) Pay the asset through, and the spend is accepted.
        const { txid } = await contract.functions
            .claim(PREIMAGE)
            .withAsset({
                assetId,
                inputs: [{ vin: 0, amount: ASSET_LOCKED }],
                outputs: [{ vout: 0, amount: ASSET_LOCKED }],
            })
            // THE CAVEAT, MADE CONCRETE. The tag-along has to go somewhere, and
            // the covenant says nothing about where: the spender picks. Here it
            // goes to `elsewhere` — an address the contract never named — and the
            // spend is ACCEPTED. That is what "only the bound asset is protected"
            // means in practice, and why an asset contract should be funded with
            // the asset it names and nothing else.
            .withAsset(tagAlongTo(1))
            .to(payTwo())
            .send();

        const [vtxo] = await waitForVtxo(indexerProvider, receiverPkScript);
        expect(vtxo.txid).toBe(txid);
    });

    it("spends a covenant PROVEN byte-identical to VHTLC.ScriptV2's own", {
        timeout: 180000,
    }, async () => {
        // THE GAP THIS CLOSES. Every other test here runs a probe artifact, so
        // the emulator had never executed the byte sequence `ScriptV2` actually
        // builds — the one a consumer locks funds to. A stack-order or counting
        // quirk in it would leave every asset contract unspendable on its
        // covenant leaves, and no test would say so.
        // A receiver of this test's own: the module-level one is already paid
        // by the test above, so waiting on it returns THAT spend's vtxo and
        // the txid assertion below compares two unrelated transactions.
        const payee = randomP2TR();
        const alice = await createTestArkWallet();
        const aliceAddress = await alice.wallet.getAddress();
        faucetOffchain(aliceAddress!, Number(CARRIER_SATS) * 6);
        await waitFor(async () => (await alice.wallet.getBalance()).total >= Number(CARRIER_SATS));

        const { assetId } = await alice.wallet.assetManager.issue({
            amount: ASSET_SUPPLY,
            metadata: { decimals: 0, name: "ScriptV2 Shaped", ticker: "SV2" },
        });
        await waitFor(
            async () => assetBalanceOf(await alice.wallet.getBalance(), assetId) >= ASSET_LOCKED,
        );
        const parsed = assetExt.AssetId.fromString(assetId);
        const assetTxid = Uint8Array.from(parsed.txid).reverse();
        const assetGidx = BigInt(parsed.groupIndex);

        // THE PROOF, and the reason this is worth more than the spend below.
        // `resolveAsm` binds the artifact's placeholders exactly as the compiler
        // does, so this compares the bytes the emulator is about to run against
        // the bytes `ScriptV2` emits for the same asset and destination. Equal
        // means the spend exercises ScriptV2's covenant, not a lookalike.
        const fromSdk = new VHTLC.ScriptV2({
            preimageHash: PREIMAGE_HASH,
            sender: schnorr.getPublicKey(new Uint8Array(32).fill(1)),
            receiver: schnorr.getPublicKey(new Uint8Array(32).fill(2)),
            server: schnorr.getPublicKey(new Uint8Array(32).fill(3)),
            refundLocktime: 1_800_000_000n,
            unilateralClaimDelay: { type: "seconds", value: 512n },
            unilateralRefundDelay: { type: "seconds", value: 1024n },
            unilateralRefundWithoutReceiverDelay: { type: "seconds", value: 1536n },
            nonInteractiveParameters: {
                receiverPkScript: payee,
                senderPkScript: FILLER_SENDER_PK_SCRIPT,
                emulatorPubkey: schnorr.getPublicKey(new Uint8Array(32).fill(5)),
            },
            asset: { txid: parsed.txid, groupIndex: parsed.groupIndex },
        }).nonInteractiveClaimArkadeScript!;
        const fromArtifact = arkade.resolveAsm(
            scriptV2Shaped.functions.claim.arkadeScript.asm as never,
            {
                hash: PREIMAGE_HASH,
                receiver: payee.slice(2),
                assetTxid,
                assetGidx,
            },
        );
        expect(hex.encode(fromArtifact)).toBe(hex.encode(fromSdk));

        const ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            indexer: indexerProvider,
            identity: alice.identity,
            emulator,
            network: networks.regtest,
        });
        const contract = ark.contract(scriptV2Shaped, {
            hash: PREIMAGE_HASH,
            receiver: payee.slice(2),
            assetTxid,
            assetGidx,
        });

        await alice.wallet.send({
            address: contract.address,
            amount: Number(CARRIER_SATS),
            assets: [{ assetId, amount: ASSET_LOCKED }],
        });
        await waitForVtxo(indexerProvider, contract.pkScript);

        // Everything through to output 0. Input-relative on both quantities, so
        // the whole input must arrive — no second output, and none needed: the
        // misdirection cases live on the probe artifact, which differs from this
        // only in the index literal and the sat clause form.
        const { txid } = await contract.functions
            .claim(PREIMAGE)
            .withAsset({
                assetId,
                inputs: [{ vin: 0, amount: ASSET_LOCKED }],
                outputs: [{ vout: 0, amount: ASSET_LOCKED }],
            })
            .to(payee, CARRIER_SATS)
            .send();

        const [vtxo] = await waitForVtxo(indexerProvider, payee);
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
