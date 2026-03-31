import * as arkade from "../arkade";
import type { ArkadeScriptType } from "../arkade";
import {
    CLTVMultisigTapscript,
    CSVMultisigTapscript,
    MultisigTapscript,
} from "../script/tapscript";
import type { RelativeTimelock } from "../script/tapscript";
import * as asset from "../extension/asset";
import type { Offer } from "./offer";

const { ArkadeScript, ArkadeVtxoScript } = arkade;

/** Encode a bigint as an 8-byte signed little-endian buffer. */
function bigintToLE64(n: bigint): Uint8Array {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigInt64(0, n, true);
    return buf;
}

export interface BancoSwapParams {
    /** Amount the maker wants to receive. */
    wantAmount: bigint;
    /** Asset the maker wants: `"btc"` or an `AssetId`. */
    want: "btc" | asset.AssetId;
    /** Asset the maker offers (locked in the VTXO). Defaults to `"btc"`. */
    offer?: "btc" | asset.AssetId;
    /** LE64 numerator for the partial-fill exchange ratio. */
    ratioNum?: bigint;
    /** LE64 denominator for the partial-fill exchange ratio. */
    ratioDen?: bigint;
    /** Optional CLTV timestamp for the cancel path. */
    cltvCancelTimelock?: bigint;
    /** Relative timelock for the exit (maker + server) path. */
    exitTimelock: RelativeTimelock;
    /** Maker's full taproot scriptPubKey (OP_1 ‖ PUSH32 ‖ 32-byte output key). */
    makerPkScript: Uint8Array;
    /** Maker's x-only taproot internal key used in cancel/exit multisig leaves. */
    makerPublicKey: Uint8Array;
}

/**
 * Banco swap contract.
 *
 * Builds the arkade scripts and VTXO taptree for a peer-to-peer atomic swap.
 * The taptree contains up to three leaves:
 *   - **fulfill**: arkade-script-guarded path (server + introspector)
 *   - **cancel**: optional CLTV-locked maker + server multisig
 *   - **exit**: CSV-locked maker + server multisig
 */
export class BancoSwap {
    constructor(
        readonly params: BancoSwapParams,
        readonly serverPubkey: Uint8Array,
        readonly introspectors: Uint8Array[]
    ) {}

    /** Construct a BancoSwap from a decoded offer and server context. */
    static fromOffer(
        offer: Offer.Data,
        serverPubKey: Uint8Array,
        exitTimelock: RelativeTimelock
    ): BancoSwap {
        return new BancoSwap(
            {
                wantAmount: offer.wantAmount,
                want: offer.wantAsset ?? "btc",
                offer: offer.offerAsset ?? "btc",
                ratioNum: offer.ratioNum,
                ratioDen: offer.ratioDen,
                cltvCancelTimelock: offer.cancelDelay,
                exitTimelock,
                makerPkScript: offer.makerPkScript,
                makerPublicKey: offer.makerPublicKey,
            },
            serverPubKey,
            [offer.introspectorPubkey]
        );
    }

    /** Whether this swap uses a partial-fill covenant (ratio-based). */
    isPartialFill(): boolean {
        return (
            this.params.ratioNum !== undefined &&
            this.params.ratioDen !== undefined
        );
    }

    /**
     * Returns the covenant script for the fulfill leaf.
     *
     * Selects `partialFillScript` when ratio params are present,
     * otherwise falls back to `fulfillScript`.
     */
    covenantScript(): Uint8Array {
        return this.isPartialFill()
            ? this.partialFillScript()
            : this.fulfillScript();
    }

    /**
     * Returns the arkade script for the full-fill-only path.
     *
     * The script checks that output 0 pays at least `wantAmount` to the
     * maker's taproot address. For asset swaps it additionally verifies
     * the asset transfer via INSPECTOUTASSETLOOKUP.
     */
    fulfillScript(): Uint8Array {
        const makerWitnessProgram = this.params.makerPkScript.subarray(2);

        const scriptPubKeyCheck = [
            0,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            1,
            "EQUALVERIFY",
            makerWitnessProgram,
            "EQUAL",
        ] as const;

        const valueCheck = [
            0,
            "INSPECTOUTPUTVALUE",
            Number(this.params.wantAmount),
            "SCRIPTNUMTOLE64",
            "GREATERTHANOREQUAL64",
            "VERIFY",
        ] as const;

        if (this.params.want === "btc") {
            return ArkadeScript.encode([...valueCheck, ...scriptPubKeyCheck]);
        }

        // INSPECTOUTASSETLOOKUP takes (gidx, txid, output_index) from the stack.
        // The txid must be in internal byte order (little-endian) to match
        // chainhash.Hash used by the introspector.
        const txidInternalOrder = this.params.want.txid.slice().reverse();

        return ArkadeScript.encode([
            0, // group index in the asset packet
            txidInternalOrder,
            0, // output index: maker output is always at index 0 in the fulfill tx
            "INSPECTOUTASSETLOOKUP",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            "SCRIPTNUMTOLE64", // convert looked-up amount to 8-byte LE
            Number(this.params.wantAmount),
            "SCRIPTNUMTOLE64",
            "GREATERTHANOREQUAL64",
            "VERIFY",
            ...scriptPubKeyCheck,
        ]);
    }

    /**
     * Returns the arkade script for the partial-fill covenant.
     *
     * Dispatches to a direction-specific script builder:
     *   - **BTC → asset**: offer="btc", want=AssetId
     *   - **asset → BTC**: offer=AssetId, want="btc"
     *   - **asset → asset**: offer=AssetId, want=AssetId
     */
    partialFillScript(): Uint8Array {
        const { want, ratioNum, ratioDen } = this.params;
        const offer = this.params.offer ?? "btc";

        if (ratioNum === undefined || ratioDen === undefined) {
            throw new Error("partialFillScript requires ratioNum and ratioDen");
        }
        if (want === "btc" && offer === "btc") {
            throw new Error(
                "partialFillScript: offer and want cannot both be BTC"
            );
        }

        if (offer === "btc") {
            return this.btcForAssetScript();
        } else if (want === "btc") {
            return this.assetForBtcScript();
        } else {
            return this.assetForAssetScript();
        }
    }

    /** BTC → asset partial fill script. */
    private btcForAssetScript(): Uint8Array {
        const want = this.params.want as asset.AssetId;
        const makerWP = this.params.makerPkScript.subarray(2);
        const ratioNumLE = bigintToLE64(this.params.ratioNum!);
        const ratioDenLE = bigintToLE64(this.params.ratioDen!);
        const zeroLE64 = new Uint8Array(8);
        const wantTxid = want.txid.slice().reverse();

        return ArkadeScript.encode([
            // Step 0
            "PUSHCURRENTINPUTINDEX",
            0,
            "EQUALVERIFY",
            // Step 1
            1,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            1,
            "EQUALVERIFY",
            makerWP,
            "EQUALVERIFY",
            // Step 2 — resolve want asset group, cache txid
            wantTxid,
            "DUP",
            "TOALTSTACK",
            want.groupIndex,
            "FINDASSETGROUPBYASSETID",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            // Step 3 — read want asset from output 1
            1,
            "SWAP",
            "FROMALTSTACK",
            "SWAP",
            "INSPECTOUTASSETLOOKUP",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            // Step 4 — received > 0
            "SCRIPTNUMTOLE64",
            "DUP",
            zeroLE64,
            "GREATERTHAN64",
            "VERIFY",
            // Step 5 — consumed = floor(received * ratioNum / ratioDen)
            ratioNumLE,
            "MUL64",
            "VERIFY",
            ratioDenLE,
            "DIV64",
            "VERIFY",
            "NIP",
            // Step 6 — read input BTC
            "PUSHCURRENTINPUTINDEX",
            "INSPECTINPUTVALUE",
            // Step 7 — branch
            "2DUP",
            "SWAP",
            "LESSTHANOREQUAL64",
            "IF",
            "2DROP",
            1,
            "ELSE",
            "SWAP",
            "SUB64",
            "VERIFY",
            0,
            "INSPECTOUTPUTVALUE",
            "EQUALVERIFY",
            "PUSHCURRENTINPUTINDEX",
            "INSPECTINPUTSCRIPTPUBKEY",
            0,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            "ROT",
            "EQUALVERIFY",
            "EQUAL",
            "ENDIF",
        ]);
    }

    /** asset → BTC partial fill script. */
    private assetForBtcScript(): Uint8Array {
        const offer = this.params.offer as asset.AssetId;
        const makerWP = this.params.makerPkScript.subarray(2);
        const ratioNumLE = bigintToLE64(this.params.ratioNum!);
        const ratioDenLE = bigintToLE64(this.params.ratioDen!);
        const zeroLE64 = new Uint8Array(8);
        const offerTxid = offer.txid.slice().reverse();

        return ArkadeScript.encode([
            // Step 0
            "PUSHCURRENTINPUTINDEX",
            0,
            "EQUALVERIFY",
            // Step 1
            1,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            1,
            "EQUALVERIFY",
            makerWP,
            "EQUALVERIFY",
            // Step 2 — read BTC from output 1, require > 0
            1,
            "INSPECTOUTPUTVALUE",
            "DUP",
            zeroLE64,
            "GREATERTHAN64",
            "VERIFY",
            // Step 3 — resolve offer group, save 2 txid copies
            offerTxid,
            "DUP",
            "DUP",
            "TOALTSTACK",
            "TOALTSTACK",
            offer.groupIndex,
            "FINDASSETGROUPBYASSETID",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            // Step 4 — read offer asset from current input
            "PUSHCURRENTINPUTINDEX",
            "SWAP",
            "FROMALTSTACK",
            "SWAP",
            "INSPECTINASSETLOOKUP",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            "SCRIPTNUMTOLE64",
            // Step 5 — save inputAsset, compute consumed on receivedBtc, restore
            "TOALTSTACK",
            ratioNumLE,
            "MUL64",
            "VERIFY",
            ratioDenLE,
            "DIV64",
            "VERIFY",
            "NIP",
            "FROMALTSTACK",
            // Step 6 — branch
            "2DUP",
            "SWAP",
            "LESSTHANOREQUAL64",
            "IF",
            "2DROP",
            // Full fill: output 0 returns BTC carrier to maker
            0,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            1,
            "EQUALVERIFY",
            makerWP,
            "EQUALVERIFY",
            "PUSHCURRENTINPUTINDEX",
            "INSPECTINPUTVALUE",
            0,
            "INSPECTOUTPUTVALUE",
            "EQUALVERIFY",
            1,
            "ELSE",
            "SWAP",
            "SUB64",
            "VERIFY",
            // scriptPubKey match
            "PUSHCURRENTINPUTINDEX",
            "INSPECTINPUTSCRIPTPUBKEY",
            0,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            "ROT",
            "EQUALVERIFY",
            "EQUALVERIFY",
            // BTC value preserved
            "PUSHCURRENTINPUTINDEX",
            "INSPECTINPUTVALUE",
            0,
            "INSPECTOUTPUTVALUE",
            "EQUALVERIFY",
            // asset change: re-resolve group, use last altstack copy
            offerTxid,
            offer.groupIndex,
            "FINDASSETGROUPBYASSETID",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            0,
            "SWAP",
            "FROMALTSTACK",
            "SWAP",
            "INSPECTOUTASSETLOOKUP",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            "SCRIPTNUMTOLE64",
            "EQUAL",
            "ENDIF",
        ]);
    }

    /** asset → asset partial fill script. */
    private assetForAssetScript(): Uint8Array {
        const want = this.params.want as asset.AssetId;
        const offer = this.params.offer as asset.AssetId;
        const makerWP = this.params.makerPkScript.subarray(2);
        const ratioNumLE = bigintToLE64(this.params.ratioNum!);
        const ratioDenLE = bigintToLE64(this.params.ratioDen!);
        const zeroLE64 = new Uint8Array(8);
        const wantTxid = want.txid.slice().reverse();
        const offerTxid = offer.txid.slice().reverse();

        return ArkadeScript.encode([
            // Step 0
            "PUSHCURRENTINPUTINDEX",
            0,
            "EQUALVERIFY",
            // Step 1
            1,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            1,
            "EQUALVERIFY",
            makerWP,
            "EQUALVERIFY",
            // Step 2 — resolve want asset group, cache txid
            wantTxid,
            "DUP",
            "TOALTSTACK",
            want.groupIndex,
            "FINDASSETGROUPBYASSETID",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            // Step 3 — read want asset from output 1, require > 0
            1,
            "SWAP",
            "FROMALTSTACK",
            "SWAP",
            "INSPECTOUTASSETLOOKUP",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            "SCRIPTNUMTOLE64",
            "DUP",
            zeroLE64,
            "GREATERTHAN64",
            "VERIFY",
            // Step 4 — resolve offer group, save 2 txid copies
            offerTxid,
            "DUP",
            "DUP",
            "TOALTSTACK",
            "TOALTSTACK",
            offer.groupIndex,
            "FINDASSETGROUPBYASSETID",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            // Step 5 — read offer asset from current input
            "PUSHCURRENTINPUTINDEX",
            "SWAP",
            "FROMALTSTACK",
            "SWAP",
            "INSPECTINASSETLOOKUP",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            "SCRIPTNUMTOLE64",
            // Step 6 — save inputA, compute consumed on receivedB, restore
            "TOALTSTACK",
            ratioNumLE,
            "MUL64",
            "VERIFY",
            ratioDenLE,
            "DIV64",
            "VERIFY",
            "NIP",
            "FROMALTSTACK",
            // Step 7 — branch (same as assetForBtc)
            "2DUP",
            "SWAP",
            "LESSTHANOREQUAL64",
            "IF",
            "2DROP",
            0,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            1,
            "EQUALVERIFY",
            makerWP,
            "EQUALVERIFY",
            "PUSHCURRENTINPUTINDEX",
            "INSPECTINPUTVALUE",
            0,
            "INSPECTOUTPUTVALUE",
            "EQUALVERIFY",
            1,
            "ELSE",
            "SWAP",
            "SUB64",
            "VERIFY",
            "PUSHCURRENTINPUTINDEX",
            "INSPECTINPUTSCRIPTPUBKEY",
            0,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            "ROT",
            "EQUALVERIFY",
            "EQUALVERIFY",
            "PUSHCURRENTINPUTINDEX",
            "INSPECTINPUTVALUE",
            0,
            "INSPECTOUTPUTVALUE",
            "EQUALVERIFY",
            offerTxid,
            offer.groupIndex,
            "FINDASSETGROUPBYASSETID",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            0,
            "SWAP",
            "FROMALTSTACK",
            "SWAP",
            "INSPECTOUTASSETLOOKUP",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            "SCRIPTNUMTOLE64",
            "EQUAL",
            "ENDIF",
        ]);
    }

    /** Builds the full VTXO taptree (fulfill + optional cancel + exit). */
    vtxoScript(): arkade.ArkadeVtxoScript {
        const leaves: arkade.ArkadeVtxoInput[] = [
            {
                arkadeScript: this.covenantScript(),
                introspectors: this.introspectors,
                tapscript: MultisigTapscript.encode({
                    pubkeys: [this.serverPubkey],
                }),
            },
        ];

        if (this.params.cltvCancelTimelock !== undefined) {
            leaves.push(
                CLTVMultisigTapscript.encode({
                    pubkeys: [this.params.makerPublicKey, this.serverPubkey],
                    absoluteTimelock: this.params.cltvCancelTimelock,
                }).script
            );
        }

        leaves.push(
            CSVMultisigTapscript.encode({
                pubkeys: [this.params.makerPublicKey, this.serverPubkey],
                timelock: this.params.exitTimelock,
            }).script
        );

        return new ArkadeVtxoScript(leaves);
    }
}
