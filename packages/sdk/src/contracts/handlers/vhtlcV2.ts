import { hex } from "@scure/base";
import { VHTLC } from "../../script/vhtlc";
import { RelativeTimelock } from "../../script/tapscript";
import {
    Contract,
    ContractHandler,
    DerivedContractTapscripts,
    PathContext,
    PathSelection,
    TapscriptDeriving,
} from "../types";
import {
    assertVhtlcSpendableNow,
    deriveVhtlcTapscripts,
    selectVhtlcPath,
    vhtlcAllSpendingPaths,
    vhtlcSpendablePaths,
} from "./helpers";
import { sequenceToTimelock, timelockToSequence } from "../../utils/timelock";

/**
 * Parse the stored `assetGroupIndex` canonically. Bare `Number()` is the trap: `Number("")` and
 * `Number(" ")` are 0, a valid index naming a DIFFERENT asset, which derives a different script
 * and dies at `upsertContractRow` with an opaque `Script mismatch`. Only the shape this
 * handler's `serializeParams` writes is accepted back.
 */
const parseGroupIndex = (raw: string): number => {
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
        throw new Error(
            `assetGroupIndex must be a canonical decimal integer, got ${JSON.stringify(raw)}`,
        );
    }
    return Number(raw);
};

/**
 * Typed parameters for {@link VHTLC.ScriptV2} contracts: `VHTLCContractParams` verbatim (both
 * versions take the same {@link VHTLC.Options}), plus the asset and emulator covenant suite the
 * swap corridor's lockup carries.
 */
export interface VHTLCV2ContractParams {
    sender: Uint8Array;
    receiver: Uint8Array;
    server: Uint8Array;
    preimageHash: Uint8Array;
    refundLocktime: bigint;
    unilateralClaimDelay: RelativeTimelock;
    unilateralRefundDelay: RelativeTimelock;
    unilateralRefundWithoutReceiverDelay: RelativeTimelock;
    /**
     * The Arkade asset the covenant leaves bind, if any.
     *
     * @see VHTLC.Options.asset
     */
    asset?: {
        /** The asset's genesis txid, 32 bytes, canonical order — as the serialized Asset ID carries it. */
        txid: Uint8Array;
        /** The asset group index within that genesis transaction. */
        groupIndex: number;
    };
    /**
     * The emulator covenant suite, all or nothing — mirrors {@link
     * VHTLC.Options.nonInteractiveParameters}, including `legacy: "preTimelockedRefund"` for
     * eight-leaf rows funded before the timelocked refund leaf shipped.
     */
    nonInteractiveParameters?: {
        receiverPkScript: Uint8Array;
        emulatorPubkey: Uint8Array;
        senderPkScript: Uint8Array;
        /** @see VHTLC.Options.nonInteractiveParameters.legacy */
        legacy?: "preTimelockedRefund";
    };
}

/**
 * Both halves of an optional covenant leaf, or neither. A half pair would derive a script with the
 * leaf dropped and fail as an opaque `Script mismatch`; this names the cause. Diagnostic only:
 * `upsertContractRow`'s mismatch check is the real boundary.
 */
function decodeCovenantLeaf<K extends string>(
    params: Record<string, string>,
    destinationKey: K,
    emulatorKey: string,
    label: string,
): { destination: Uint8Array; emulatorPubkey: Uint8Array } | undefined {
    const destination = params[destinationKey];
    const emulator = params[emulatorKey];
    if (!destination && !emulator) return undefined;
    if (!destination || !emulator) {
        throw new Error(`${label} needs both '${destinationKey}' and '${emulatorKey}', or neither`);
    }
    return { destination: hex.decode(destination), emulatorPubkey: hex.decode(emulator) };
}

/**
 * Handler for {@link VHTLC.ScriptV2} — the VHTLC whose preimage leaves add `OP_SIZE 32
 * OP_EQUALVERIFY`, built by the RFQ swap corridor (`@arkade-os/swap`'s `lightningSendContract`).
 *
 * A separate type rather than a flag on `vhtlc`: V1 and V2 derive different pkScripts for the same
 * keys and `upsertContractRow` rejects a row whose script doesn't match its params, so one type
 * can't serve both (and they can never collide). A use-named type (`swap-lockup`) loses because
 * contracts are keyed by script: a second use of the same ScriptV2 would fight over one row.
 *
 * Only the four leaves a single-key wallet can sign are offered: `claim`/`unilateralClaim` to the
 * receiver, `refundWithoutReceiver` (CLTV)/`unilateralRefundWithoutReceiver` to the sender.
 * `refund`/`unilateralRefund` need the counterparty's signature and no protocol message asks for
 * one; the three `nonInteractive*` leaves are the emulator's. CSV leaves are offered only in the
 * non-collaborative context. Selection matches the `vhtlc` handler rung-for-rung, pinned by
 * `test/contracts/vhtlcV2-handler.test.ts`.
 */
export const VHTLCV2ContractHandler: ContractHandler<VHTLCV2ContractParams, VHTLC.ScriptV2> &
    TapscriptDeriving<VHTLC.ScriptV2> = {
    type: "vhtlc-v2",

    createScript(params: Record<string, string>): VHTLC.ScriptV2 {
        const typed = this.deserializeParams(params);
        return new VHTLC.ScriptV2(typed);
    },

    serializeParams(params: VHTLCV2ContractParams): Record<string, string> {
        const covenants = params.nonInteractiveParameters;
        return {
            sender: hex.encode(params.sender),
            receiver: hex.encode(params.receiver),
            server: hex.encode(params.server),
            hash: hex.encode(params.preimageHash),
            refundLocktime: params.refundLocktime.toString(),
            claimDelay: timelockToSequence(params.unilateralClaimDelay).toString(),
            refundDelay: timelockToSequence(params.unilateralRefundDelay).toString(),
            refundNoReceiverDelay: timelockToSequence(
                params.unilateralRefundWithoutReceiverDelay,
            ).toString(),
            // Per-leaf on-disk keys predate the grouped param and older rows carry exactly these;
            // both emulator columns hold the same key. Spread, not `undefined`, so a repository
            // round-trip never gains "undefined" string values.
            ...(covenants && {
                nonInteractiveClaimReceiverPkScript: hex.encode(covenants.receiverPkScript),
                nonInteractiveClaimEmulatorPubkey: hex.encode(covenants.emulatorPubkey),
                nonInteractiveRefundSenderPkScript: hex.encode(covenants.senderPkScript),
                nonInteractiveRefundEmulatorPubkey: hex.encode(covenants.emulatorPubkey),
                // The legacy (eight-leaf) marker is this key's ABSENCE, as older SDKs wrote it.
                ...(covenants.legacy === undefined && {
                    nonInteractiveRefundWithoutReceiver: "1",
                }),
            }),
            // Must round-trip: dropping the asset re-derives the sat-only script and registration
            // dies at `upsertContractRow` with an opaque `Script mismatch`.
            ...(params.asset && {
                assetTxid: hex.encode(params.asset.txid),
                assetGroupIndex: params.asset.groupIndex.toString(),
            }),
        };
    },

    deserializeParams(params: Record<string, string>): VHTLCV2ContractParams {
        const claim = decodeCovenantLeaf(
            params,
            "nonInteractiveClaimReceiverPkScript",
            "nonInteractiveClaimEmulatorPubkey",
            "nonInteractiveClaim",
        );
        const refund = decodeCovenantLeaf(
            params,
            "nonInteractiveRefundSenderPkScript",
            "nonInteractiveRefundEmulatorPubkey",
            "nonInteractiveRefund",
        );
        // An older-SDK row may name one leaf's pair without the other's; it has no group
        // representation, so refuse it rather than silently drop a leaf.
        if ((claim === undefined) !== (refund === undefined)) {
            throw new Error(
                "emulator covenant params are all-or-nothing: the claim keys " +
                    "(nonInteractiveClaim*) and the refund keys (nonInteractiveRefund*) must " +
                    "both be present or both absent — a row carrying one side was written " +
                    "for a leaf subset this handler no longer derives",
            );
        }
        // Two different emulator keys were legal for older SDKs but are unrepresentable now;
        // rebuilding with either would move the pkScript.
        if (
            claim &&
            refund &&
            hex.encode(claim.emulatorPubkey) !== hex.encode(refund.emulatorPubkey)
        ) {
            throw new Error(
                "emulator covenant params name two different emulator pubkeys: the suite " +
                    "derives both covenant cosigners from ONE key, so this row cannot be " +
                    "rebuilt as a group",
            );
        }
        // Either half alone is corrupt; reading it as asset-less re-derives the sat-only script.
        if ((params.assetTxid === undefined) !== (params.assetGroupIndex === undefined)) {
            throw new Error(
                "asset params are incomplete: assetTxid and assetGroupIndex must both be present or both absent",
            );
        }
        // 0.4.65-0.4.67 rows compile a strict bound into the claim leaf that can't be re-derived
        // here; reading them as non-strict would rebuild a different pkScript. The throw is
        // permanent for such a row, so the message itself must carry the way out.
        if (params.strictClaimAmount !== undefined || params.strictClaimAssetAmount !== undefined) {
            throw new Error(
                "strict claim params on a stored row: the strict claim bound was removed in " +
                    "0.4.68, so this row — written by 0.4.65-0.4.67 — locks to a script this " +
                    "build cannot re-derive. To clear it: claim or refund the swap on 0.4.67, " +
                    "then drop the settled row here with " +
                    "`contractManager.deleteContract(script)`. Do not delete it first — any " +
                    "balance it still holds is only reachable from 0.4.67.",
            );
        }
        // Read as "not set", this flag without its suite would re-derive a script missing the leaf.
        if (params.nonInteractiveRefundWithoutReceiver !== undefined && !refund) {
            throw new Error(
                "nonInteractiveRefundWithoutReceiver without the emulator covenant keys it " +
                    "extends: reading this as 'not set' would re-derive a script without the leaf",
            );
        }
        if (
            params.nonInteractiveRefundWithoutReceiver !== undefined &&
            params.nonInteractiveRefundWithoutReceiver !== "1"
        ) {
            throw new Error(
                `nonInteractiveRefundWithoutReceiver must be "1" when present, got ` +
                    JSON.stringify(params.nonInteractiveRefundWithoutReceiver),
            );
        }
        const asset =
            params.assetTxid !== undefined && params.assetGroupIndex !== undefined
                ? {
                      txid: hex.decode(params.assetTxid),
                      groupIndex: parseGroupIndex(params.assetGroupIndex),
                  }
                : undefined;
        return {
            sender: hex.decode(params.sender),
            receiver: hex.decode(params.receiver),
            server: hex.decode(params.server),
            preimageHash: hex.decode(params.hash),
            refundLocktime: BigInt(params.refundLocktime),
            ...(asset && { asset }),
            unilateralClaimDelay: sequenceToTimelock(Number(params.claimDelay)),
            unilateralRefundDelay: sequenceToTimelock(Number(params.refundDelay)),
            unilateralRefundWithoutReceiverDelay: sequenceToTimelock(
                Number(params.refundNoReceiverDelay),
            ),
            ...(claim &&
                refund && {
                    nonInteractiveParameters: {
                        receiverPkScript: claim.destination,
                        senderPkScript: refund.destination,
                        emulatorPubkey: claim.emulatorPubkey,
                        ...(params.nonInteractiveRefundWithoutReceiver !== "1" && {
                            legacy: "preTimelockedRefund" as const,
                        }),
                    },
                }),
        };
    },

    /**
     * Select spending path based on context. Role comes from `context.role` or by matching
     * `context.walletDescriptor` against sender/receiver.
     */
    selectPath(
        script: VHTLC.ScriptV2,
        contract: Contract,
        context: PathContext,
    ): PathSelection | null {
        return selectVhtlcPath(script, contract, context);
    },

    /** Get all possible spending paths (no timelock checks); role resolved as in `selectPath`. */
    getAllSpendingPaths(
        script: VHTLC.ScriptV2,
        contract: Contract,
        context: PathContext,
    ): PathSelection[] {
        return vhtlcAllSpendingPaths(script, contract, context);
    },

    getSpendablePaths(
        script: VHTLC.ScriptV2,
        contract: Contract,
        context: PathContext,
    ): PathSelection[] {
        return vhtlcSpendablePaths(script, contract, context);
    },

    /**
     * Refuse an explicit spend of a lockup whose refund path has not opened.
     * @see assertVhtlcSpendableNow for why this is the one certain case.
     */
    assertSpendableNow(_script: VHTLC.ScriptV2, contract: Contract, context: PathContext): void {
        assertVhtlcSpendableNow(contract, context);
    },

    /**
     * Never. A live VHTLC is escrow with the counterparty's claim leaf armed; generic selection
     * (send, settle, renewal, offboard) would move it out from under the swap or race a claim.
     * Recovery isn't covered by this gate: `recoverVtxos` filters on {@link assertSpendableNow},
     * dropping a lockup only while its refund path is shut. Explicit routes (`settle({ inputs })`,
     * `pushRefundWithoutReceiver`) are unaffected.
     */
    isGenericallySpendable: () => false,

    /**
     * The annotation leaf stamped onto every VTXO locked to this contract.
     *
     * Required, not an optimization: without {@link TapscriptDeriving} the fallback calls
     * `script.forfeit()`, which no VHTLC version has, so the VTXOs are silently dropped before
     * persisting and `getSyncState()` stays `degraded`.
     *
     * `refundWithoutReceiver` is used (in step with `selectPath`) as the only collaborative leaf
     * the sender can satisfy. It carries a CLTV: settling on it before `refundLocktime` matures is
     * rejected, and this handler has no clock, so `recoverVtxos` filters on
     * {@link assertSpendableNow}. Role-blind: a receiver's row gets the same leaf and fails at
     * intent registration.
     */
    deriveTapscripts(script: VHTLC.ScriptV2): DerivedContractTapscripts {
        return deriveVhtlcTapscripts(script);
    },
};
