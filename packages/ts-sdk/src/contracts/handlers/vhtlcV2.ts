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
import { assertVhtlcSpendableNow, isCltvSatisfied, isCsvSpendable, resolveRole } from "./helpers";
import { sequenceToTimelock, timelockToSequence } from "../../utils/timelock";

/**
 * The stored `assetGroupIndex`, as a number, or a throw naming the row.
 *
 * `Number()` alone is not enough here, and it fails in exactly one direction
 * that matters. `VHTLC.ScriptV2` already refuses a non-integer, a negative or
 * anything past `0xffff`, so `"abc"`, `"1.5"` and `"-1"` die one frame down with
 * a clear message. What survives is `Number("")`, `Number(" ")` and
 * `Number("\t")` — all of which are **0**, a perfectly valid group index.
 *
 * A blank field therefore does not fail: it silently names group 0 of the same
 * genesis transaction, which is a DIFFERENT asset. The contract then derives a
 * different script from the one the row was written against, and registration
 * dies at `upsertContractRow` with an opaque `Script mismatch` — the same
 * silent-drop class the both-halves-or-neither check above exists to close, one
 * value further in.
 *
 * Anchored and canonical: no sign, no point, no exponent, no leading zero, so a
 * row that round-tripped through this handler's own `serializeParams` is the
 * only shape accepted back.
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
 * Typed parameters for {@link VHTLC.ScriptV2} contracts.
 *
 * The eight mandatory fields are `VHTLCContractParams` verbatim — the two
 * script versions take the same {@link VHTLC.Options}, so a divergent shape
 * here would be a difference with no cause. What V1's handler has no field for
 * is the two optional covenant leaves, and those are exactly what the swap
 * corridor's lockup carries, so leaving them out would make this handler unable
 * to round-trip the contract it exists to serve.
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
    /** @see VHTLC.Options.nonInteractiveClaim */
    nonInteractiveClaim?: {
        receiverPkScript: Uint8Array;
        emulatorPubkey: Uint8Array;
        /** @see VHTLC.Options.nonInteractiveClaim.strict */
        strict?: { amount: bigint; assetAmount?: bigint };
    };
    /** @see VHTLC.Options.nonInteractiveRefund */
    nonInteractiveRefund?: {
        senderPkScript: Uint8Array;
        emulatorPubkey: Uint8Array;
        /** @see VHTLC.Options.nonInteractiveRefund.withoutReceiver */
        withoutReceiver?: boolean;
    };
}

/**
 * Both halves of an optional covenant leaf, or neither.
 *
 * A row carrying one half of the pair would derive a script with that leaf
 * DROPPED — a different taproot tree, a different pkScript, and so a
 * `Script mismatch` from `upsertContractRow` naming two hex strings and no
 * cause. Rejecting the half-specified pair here names it instead. It is a
 * diagnostic, not a safety boundary: the mismatch check is what actually stops
 * a wrong script from being persisted, and it stops this case too.
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
 * Handler for {@link VHTLC.ScriptV2} — the VHTLC whose preimage leaves carry an
 * explicit `OP_SIZE 32 OP_EQUALVERIFY` before the hash check, and which the RFQ
 * swap corridor builds (`@arkade-os/swap`'s `lightningSendContract`).
 *
 * **Why a separate type string rather than a flag on `vhtlc`.** A handler's
 * `type` names the script class it derives, the way every other registered type
 * does (`default` → `DefaultVtxo.Script`, `vhtlc` → `VHTLC.Script`, `boarding`,
 * `arkade`). V1 and V2 produce different script bytes — and so different
 * pkScripts — for identical participant keys, and `upsertContractRow` derives
 * the script from `params` and refuses any row whose supplied `script` does not
 * match. One type cannot serve both. `vhtlc-v2` also cannot COLLIDE with
 * `vhtlc`: a colliding row needs one pkScript claimed by two types, and the two
 * versions' preimage conditions differ in every tree, so no parameters make
 * them equal. A use-named type (`swap-lockup`) was the alternative and is
 * worse: contracts are keyed by script, so the moment a second use registered
 * the same ScriptV2 the two uses would fight over one row.
 *
 * **Which leaves this offers, and why the set is smaller than the ladder.**
 * ScriptV2 has nine leaves; a wallet holding ONE of the two participant keys
 * can satisfy four of them, and offering a leaf whose signature the caller
 * cannot produce is worse than offering fewer — it turns a refusal into a
 * transaction that gets built and then rejected.
 *
 * | leaf                                  | needs                          | offered |
 * |---------------------------------------|--------------------------------|---------|
 * | `claim`                               | receiver + server, preimage    | yes, to the receiver |
 * | `refund`                              | sender + receiver + server     | no — needs the counterparty live |
 * | `refundWithoutReceiver`               | sender + server, CLTV          | yes, to the sender |
 * | `unilateralClaim`                     | receiver, CSV                  | yes, to the receiver |
 * | `unilateralRefund`                    | sender + receiver, CSV         | no — needs the counterparty live |
 * | `unilateralRefundWithoutReceiver`     | sender, CSV                    | yes, to the sender |
 * | `nonInteractiveClaim`                 | server + emulator              | no — the wallet holds neither key |
 * | `nonInteractiveRefund`                | server + receiver + emulator   | no — the wallet holds neither key |
 * | `nonInteractiveRefundWithoutReceiver` | server + emulator, CLTV        | no — the wallet holds neither key |
 *
 * The two omitted interactive leaves are the same two the `vhtlc` handler
 * omits, for the same reason: `refund` and `unilateralRefund` both need the
 * OTHER party's signature, and this protocol has no message that asks for one
 * (see `@arkade-os/swap`'s `refund.ts` module doc). The two covenant leaves are
 * pushed by the emulator on the counterparty's behalf and are not this wallet's
 * to build at all.
 *
 * So `refundWithoutReceiver` is the sender's only collaborative way out, gated
 * on the CLTV the quote committed to — which is exactly the leaf
 * `pushRefundWithoutReceiver` builds. The CSV leaves are offered only in the
 * non-collaborative context, where the caller has already accepted that
 * spending them means a real unilateral exit first.
 *
 * The selection discipline is deliberately identical to the `vhtlc` handler's,
 * and `test/contracts/vhtlcV2-handler.test.ts` pins the two against each other
 * rung-for-rung across every role and timelock context so they cannot drift.
 */
export const VHTLCV2ContractHandler: ContractHandler<VHTLCV2ContractParams, VHTLC.ScriptV2> &
    TapscriptDeriving<VHTLC.ScriptV2> = {
    type: "vhtlc-v2",

    createScript(params: Record<string, string>): VHTLC.ScriptV2 {
        const typed = this.deserializeParams(params);
        return new VHTLC.ScriptV2(typed);
    },

    serializeParams(params: VHTLCV2ContractParams): Record<string, string> {
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
            // Spread rather than written as `undefined`: a `Record<string,
            // string>` round-tripped through a repository must not gain keys
            // whose value is the string "undefined".
            ...(params.nonInteractiveClaim && {
                nonInteractiveClaimReceiverPkScript: hex.encode(
                    params.nonInteractiveClaim.receiverPkScript,
                ),
                nonInteractiveClaimEmulatorPubkey: hex.encode(
                    params.nonInteractiveClaim.emulatorPubkey,
                ),
                // The opt-in quoted bound. Dropping it re-derives the DEFAULT
                // claim covenant — a strictly weaker one — and registration dies
                // at `upsertContractRow` with an opaque `Script mismatch`. Same
                // silent-drop class as the asset keys above.
                ...(params.nonInteractiveClaim.strict && {
                    strictClaimAmount: params.nonInteractiveClaim.strict.amount.toString(),
                    ...(params.nonInteractiveClaim.strict.assetAmount !== undefined && {
                        strictClaimAssetAmount:
                            params.nonInteractiveClaim.strict.assetAmount.toString(),
                    }),
                }),
            }),
            ...(params.nonInteractiveRefund && {
                nonInteractiveRefundSenderPkScript: hex.encode(
                    params.nonInteractiveRefund.senderPkScript,
                ),
                nonInteractiveRefundEmulatorPubkey: hex.encode(
                    params.nonInteractiveRefund.emulatorPubkey,
                ),
                // Spread rather than a "false"/"undefined" string: a dropped
                // flag re-derives the EIGHT-leaf script, a different pkScript,
                // and registration dies at `upsertContractRow` with an opaque
                // `Script mismatch`. Same silent-drop class as the asset keys.
                ...(params.nonInteractiveRefund.withoutReceiver && {
                    nonInteractiveRefundWithoutReceiver: "1",
                }),
            }),
            // The asset must round-trip, and its absence here used to be silent
            // in the worst way. `ContractManager` re-derives a contract from
            // these params; dropping the asset derives the SAT-ONLY script, so
            // registration died at `upsertContractRow` with a `Script mismatch`
            // naming two hex strings and no cause. Same silent-drop class
            // `validateOptions` refuses one layer up.
            //
            // Two keys rather than one blob, mirroring the script's own view of
            // an Asset ID as a (txid, groupIndex) pair.
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
        // Both halves or neither: a txid without its group index names no asset,
        // and an index without a txid names nothing at all. Either alone is a
        // corrupt row rather than a contract that happens to lack an asset, and
        // reading it as the latter re-derives the sat-only script — the exact
        // silent drop this round-trip exists to close.
        if ((params.assetTxid === undefined) !== (params.assetGroupIndex === undefined)) {
            throw new Error(
                "asset params are incomplete: assetTxid and assetGroupIndex must both be present or both absent",
            );
        }
        if (params.strictClaimAssetAmount !== undefined && params.strictClaimAmount === undefined) {
            throw new Error(
                "strictClaimAssetAmount without strictClaimAmount: reading this as 'not strict' " +
                    "would re-derive the default claim covenant, which is weaker than the row asked for",
            );
        }
        // Same silent-drop shape as the two checks above, one flag further in:
        // a row naming this flag without the leaf it extends, or read as "not
        // set", would re-derive a script missing this leaf.
        if (params.nonInteractiveRefundWithoutReceiver !== undefined && !refund) {
            throw new Error(
                "nonInteractiveRefundWithoutReceiver without the nonInteractiveRefund keys it " +
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
            ...(claim && {
                nonInteractiveClaim: {
                    receiverPkScript: claim.destination,
                    emulatorPubkey: claim.emulatorPubkey,
                    ...(params.strictClaimAmount !== undefined && {
                        strict: {
                            amount: BigInt(params.strictClaimAmount),
                            ...(params.strictClaimAssetAmount !== undefined && {
                                assetAmount: BigInt(params.strictClaimAssetAmount),
                            }),
                        },
                    }),
                },
            }),
            ...(refund && {
                nonInteractiveRefund: {
                    senderPkScript: refund.destination,
                    emulatorPubkey: refund.emulatorPubkey,
                    ...(params.nonInteractiveRefundWithoutReceiver === "1" && {
                        withoutReceiver: true,
                    }),
                },
            }),
        };
    },

    /**
     * Select spending path based on context.
     *
     * Role is determined from `context.role` or by matching
     * `context.walletDescriptor` (preferred) / `context.walletPubKey`
     * against sender/receiver in contract params.
     */
    selectPath(
        script: VHTLC.ScriptV2,
        contract: Contract,
        context: PathContext,
    ): PathSelection | null {
        const role = resolveRole(contract, context);
        const preimage = contract.params?.preimage;
        const refundLocktime = BigInt(contract.params.refundLocktime);

        if (!role) {
            return null;
        }

        if (context.collaborative) {
            if (role === "receiver" && preimage) {
                return {
                    leaf: script.claim(),
                    extraWitness: [hex.decode(preimage)],
                };
            }

            if (role === "sender" && isCltvSatisfied(context, refundLocktime)) {
                return {
                    leaf: script.refundWithoutReceiver(),
                };
            }

            return null;
        }

        // Unilateral paths
        if (role === "receiver" && preimage) {
            const sequence = Number(contract.params.claimDelay);
            if (!isCsvSpendable(context, sequence)) return null;
            return {
                leaf: script.unilateralClaim(),
                extraWitness: [hex.decode(preimage)],
                sequence,
            };
        }

        if (role === "sender") {
            const sequence = Number(contract.params.refundNoReceiverDelay);
            if (!isCsvSpendable(context, sequence)) return null;
            return {
                leaf: script.unilateralRefundWithoutReceiver(),
                sequence,
            };
        }

        return null;
    },

    /**
     * Get all possible spending paths (no timelock checks).
     *
     * Role is determined from `context.role` or by matching
     * `context.walletDescriptor` (preferred) / `context.walletPubKey`
     * against sender/receiver in contract params.
     */
    getAllSpendingPaths(
        script: VHTLC.ScriptV2,
        contract: Contract,
        context: PathContext,
    ): PathSelection[] {
        const role = resolveRole(contract, context);
        const paths: PathSelection[] = [];

        if (!role) {
            return paths;
        }

        const preimage = contract.params?.preimage;

        if (context.collaborative) {
            // Collaborative paths (no timelock checks)
            if (role === "receiver" && preimage) {
                paths.push({
                    leaf: script.claim(),
                    extraWitness: [hex.decode(preimage)],
                });
            }
            if (role === "sender") {
                paths.push({
                    leaf: script.refundWithoutReceiver(),
                });
            }
        } else {
            // Unilateral paths (no timelock checks)
            if (role === "receiver" && preimage) {
                const sequence = Number(contract.params.claimDelay);
                paths.push({
                    leaf: script.unilateralClaim(),
                    extraWitness: [hex.decode(preimage)],
                    sequence,
                });
            }
            if (role === "sender") {
                const sequence = Number(contract.params.refundNoReceiverDelay);
                paths.push({
                    leaf: script.unilateralRefundWithoutReceiver(),
                    sequence,
                });
            }
        }

        return paths;
    },

    getSpendablePaths(
        script: VHTLC.ScriptV2,
        contract: Contract,
        context: PathContext,
    ): PathSelection[] {
        const role = resolveRole(contract, context);
        const paths: PathSelection[] = [];

        if (!role) {
            return paths;
        }

        const preimage = contract.params?.preimage;
        const refundLocktime = BigInt(contract.params.refundLocktime);

        if (context.collaborative) {
            if (role === "receiver" && preimage) {
                paths.push({
                    leaf: script.claim(),
                    extraWitness: [hex.decode(preimage)],
                });
            }
            if (role === "sender" && isCltvSatisfied(context, refundLocktime)) {
                paths.push({
                    leaf: script.refundWithoutReceiver(),
                });
            }
            return paths;
        }

        if (role === "receiver" && preimage) {
            const sequence = Number(contract.params.claimDelay);
            if (isCsvSpendable(context, sequence)) {
                paths.push({
                    leaf: script.unilateralClaim(),
                    extraWitness: [hex.decode(preimage)],
                    sequence,
                });
            }
        }
        if (role === "sender") {
            const sequence = Number(contract.params.refundNoReceiverDelay);
            if (isCsvSpendable(context, sequence)) {
                paths.push({
                    leaf: script.unilateralRefundWithoutReceiver(),
                    sequence,
                });
            }
        }

        return paths;
    },

    /**
     * Refuse an explicit spend of a lockup whose refund path has not opened.
     * @see assertVhtlcSpendableNow for why this is the one certain case.
     */
    assertSpendableNow(_script: VHTLC.ScriptV2, contract: Contract, context: PathContext): void {
        assertVhtlcSpendableNow(contract, context);
    },

    /**
     * Never. A live VHTLC is escrow: the counterparty's claim leaf is armed,
     * and generic selection — send, settle, RENEWAL, offboard — would move the
     * lockup out from under a swap the counterparty is still entitled to
     * complete, or race a claim already in flight. The `vhtlc` handler now
     * answers the same, for the same reason.
     *
     * The gate covers `available` and renewal. Recovery is generic and names
     * nothing, so it is not covered here: `recoverVtxos` filters on
     * {@link assertSpendableNow} instead, which drops a lockup only while its
     * refund path is shut rather than forever. The explicit routes out —
     * `settle({ inputs })`, or `@arkade-os/swap`'s `pushRefundWithoutReceiver`
     * over `findLockupVtxos`' outpoints — are unaffected either way.
     */
    isGenericallySpendable: () => false,

    /**
     * The annotation leaf stamped onto every VTXO locked to this contract.
     *
     * **Without this the contract is unusable, not merely unoptimized.**
     * `deriveContractTapscripts` falls back to `script.forfeit()` for any
     * handler that does not implement {@link TapscriptDeriving}, and no VHTLC
     * script version has a `forfeit()` — `VtxoScript` does not define one and
     * `VHTLC.BaseScript` does not add one. The fallback therefore throws
     * `legacy.forfeit is not a function`, `annotatableIn` catches it, and
     * `fetchContractVtxosBulk` drops this contract's VTXOs before they are
     * persisted. The row would exist and be watched while its balance stayed
     * permanently invisible, and `getSyncState()` would report `degraded`
     * forever. (The `vhtlc` handler had the same gap and now closes it the same
     * way; nothing registers V1 rows through `ContractManager` in this repo, so
     * it was never hit here.)
     *
     * `refundWithoutReceiver` is the leaf, for both roles the annotation
     * serves, because it is the only collaborative path this wallet can
     * actually satisfy as the sender — the same conclusion `selectPath`
     * reaches, kept in step with it deliberately. The claim leaves belong to
     * the receiver and need a preimage the sender does not have; `refund` and
     * `unilateralRefund` need the counterparty; the covenant leaves are the
     * emulator's.
     *
     * **It carries a CLTV, and callers must respect it.** A settlement built on
     * this leaf is only valid once `refundLocktime` has matured, so a recovery
     * round that sweeps this VTXO early is rejected by the server. Nothing in
     * this handler can enforce it, because the annotation is derived per
     * contract and knows no clock. `recoverVtxos` filters on
     * {@link assertSpendableNow} for it.
     *
     * **Role-blind.** A receiver's row gets the same leaf, which names keys that
     * wallet does not hold, so it is satisfiable only by the wallet holding the
     * lockup's `sender` key and fails at intent registration for anyone else.
     */
    deriveTapscripts(script: VHTLC.ScriptV2): DerivedContractTapscripts {
        const leaf = script.refundWithoutReceiver();
        return {
            forfeitTapLeafScript: leaf,
            intentTapLeafScript: leaf,
            tapTree: script.encode(),
        };
    },
};
