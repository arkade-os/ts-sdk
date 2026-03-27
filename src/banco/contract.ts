import * as arkade from "../arkade";
import {
    CLTVMultisigTapscript,
    CSVMultisigTapscript,
    MultisigTapscript,
} from "../script/tapscript";
import type { RelativeTimelock } from "../script/tapscript";
import * as asset from "../extension/asset";

const { ArkadeScript, ArkadeVtxoScript } = arkade;

export interface BancoSwapParams {
    /** Amount the maker wants to receive. */
    wantAmount: bigint;
    /** Asset the maker wants: `"btc"` or an `AssetId`. */
    want: "btc" | asset.AssetId;
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

    /**
     * Returns the arkade script for the fulfill path.
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

        return ArkadeScript.encode([
            0,
            this.params.want.txid,
            Number(this.params.want.groupIndex),
            "INSPECTOUTASSETLOOKUP",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            Number(this.params.wantAmount),
            "SCRIPTNUMTOLE64",
            "GREATERTHANOREQUAL64",
            "VERIFY",
            ...scriptPubKeyCheck,
        ]);
    }

    partialFillScript(): Uint8Array {
        // TODO
        throw new Error("not implemented");
    }

    /** Builds the full VTXO taptree (fulfill + optional cancel + exit). */
    vtxoScript(): arkade.ArkadeVtxoScript {
        const leaves: arkade.ArkadeVtxoInput[] = [
            {
                arkadeScript: this.fulfillScript(),
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
