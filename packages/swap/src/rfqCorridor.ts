/**
 * Per-corridor persistence, kept out of the record.
 *
 * The record itself is corridor-agnostic: identity, manager state, the pointer
 * to the lockup's contract row, and one opaque `profile` it never interprets.
 * Everything a corridor needs beyond that — the receive leg's value gate, the
 * onchain leg's L1 contract — lives in its own handler.
 *
 * This mirrors the contract layer's `contractHandlers` registry, deliberately:
 * that solved the same problem for VTXO scripts, and adding a contract type
 * there is a new file plus one `register()` call rather than an edit to a
 * shared type. Adding a corridor here should cost the same. Nothing in
 * `rfqRecord.ts`, `repository.ts` or `indexedDbRepository.ts` names a corridor,
 * so a new one changes no stored schema and no shared switch.
 *
 * The `profile` is plain JSON by contract. It rides in the same record the
 * repository writes whole, so a backend that mangles unknown keys would lose a
 * corridor's half without saying so — which is why `serialize` returns a flat
 * object rather than anything class-shaped.
 *
 * **A seam for this package, not for consumers**, and none of it is exported
 * from the index. `RfqSwapManager` branches on `RfqSwap["kind"]` to decide what
 * it drives — `driveReceiveClaim`, `driveOnchain`, `traderClaimTxid` — so a
 * corridor registered from outside would persist and restore correctly and then
 * sit unmonitored, which is worse than not being storable at all. `kind` is
 * typed to the manager's union to keep the two in step: a corridor becomes
 * storable in the same change that makes it drivable, or not at all. What a
 * consumer needs is the profile types, so those are exported and this is not.
 */
import type { VHTLC } from "@arkade-os/sdk";
import type { RfqSwap } from "./swapManager";
import type { RfqClaimSecretProjection } from "./rfqProfileParts";

/**
 * How one corridor persists and restores its own half.
 *
 * `serialize` is given the live swap and returns the corridor's `profile`.
 * `hydrate` is given the stored profile plus the rebuilt lockup covenant and
 * returns the corridor-specific fields to merge onto the live record.
 *
 * Both are pure. A handler must not reach for a wallet, an indexer or a
 * network: everything it needs is either on the profile it wrote or on the
 * covenant it is handed.
 */
export interface RfqCorridorHandler<P extends Record<string, unknown> = Record<string, unknown>> {
    /** The swap kind this handles. The manager's own union, so a handler can
     * only ever exist for a corridor the manager can drive. */
    readonly kind: RfqSwap["kind"];

    /**
     * The parts of the profile the MANAGER can change, projected off the live
     * swap. Merged over the profile the caller wrote at creation.
     *
     * Deliberately not the whole profile: half of what a corridor persists is
     * only in the request result and never reaches an `RfqSwap` — the onchain
     * leg's L1 keys are the clearest case, since `OnchainHtlc` exposes only
     * derived values. So the caller supplies the profile once and this keeps it
     * current.
     *
     * Return `{}` for a corridor with nothing mutable of its own.
     *
     * **Never return `signer` or `hashlock`.** The profile merges SHALLOWLY, so
     * returning even `{ hashlock: { paymentHash } }` replaces the whole subtree
     * and deletes the preimage salt on the first write after creation — an
     * unclaimable lockup, discovered at claim time. Nothing needs it: the
     * descriptor and the salt exist only in the request result, never on a live
     * `RfqSwap`.
     */
    project(swap: RfqSwap): Partial<P>;

    /**
     * The claim inputs off this corridor's profile, when this leg is one WE
     * claim — typically `{ ...profile.signer, ...profile.hashlock }`.
     *
     * Omitted by a corridor that only refunds (`lightning_send`) or has no
     * hashlock at all, so `rfqClaimSecretOf` answers `undefined` and a caller
     * that would have derived a preimage learns so instead of deriving a wrong
     * one.
     */
    claimSecret?(profile: P): RfqClaimSecretProjection;

    /**
     * The corridor's own transaction ids off its profile — the ones that are
     * this leg's alone, like the receive leg's `claimArkTxid` or the onchain
     * leg's L1 `claimTxid`. Whatever the record's common half already carries
     * (`fundingArkTxid`, `refundArkTxid`) is read there, not here.
     *
     * Answered by the handler rather than by a kind switch in `activity.ts`,
     * so a corridor added later contributes its txids without any edit
     * outside this file. Omit it for a corridor with none.
     */
    activityTxids?(profile: P): readonly string[];

    /**
     * Rebuild the corridor's live fields from what was stored.
     *
     * Throw rather than defaulting when something required is missing: a swap
     * restored without the half that drives it is worse than one that refuses
     * to restore, because it looks monitored while a deadline passes.
     */
    hydrate(profile: P, context: RfqCorridorContext): Record<string, unknown>;
}

/** What a handler may read beyond its own profile: the rebuilt lockup covenant.
 * The payment hash is not here — it belongs to a corridor's own `hashlock`, and
 * a corridor that has none would have had to be handed a fake. */
export interface RfqCorridorContext {
    lockup: InstanceType<typeof VHTLC.ScriptV2>;
}

/**
 * Registry of corridor handlers, keyed by `kind`.
 *
 * Same contract as `contractHandlers`: registering a duplicate throws rather
 * than silently replacing, because two handlers for one kind would make which
 * of them restores a swap depend on import order.
 */
class RfqCorridorRegistry {
    private handlers = new Map<string, RfqCorridorHandler>();

    register(handler: RfqCorridorHandler): void {
        if (this.handlers.has(handler.kind)) {
            throw new Error(
                `RFQ corridor handler for kind '${handler.kind}' is already registered`,
            );
        }
        this.handlers.set(handler.kind, handler as RfqCorridorHandler);
    }

    /** Takes a bare `string`, deliberately, where {@link RfqCorridorHandler.kind}
     * is the manager's union: a lookup key comes off a record a backend handed
     * back, and that it typechecks as a `kind` is a claim about the type, not
     * about what was stored. Narrowing this would read as a check already made. */
    get(kind: string): RfqCorridorHandler | undefined {
        return this.handlers.get(kind);
    }

    /**
     * The handler for a kind, or a loud failure.
     *
     * A record whose corridor is not registered cannot be restored, and
     * guessing would monitor a swap with no idea how to drive it. Names the
     * registered kinds so a missing `register()` call is obvious.
     */
    getOrThrow(kind: string): RfqCorridorHandler {
        const handler = this.get(kind);
        if (!handler) {
            throw new Error(
                `no RFQ corridor handler registered for kind '${kind}'; registered: ` +
                    `${this.registeredKinds().join(", ") || "none"}`,
            );
        }
        return handler;
    }

    has(kind: string): boolean {
        return this.handlers.has(kind);
    }

    registeredKinds(): string[] {
        return [...this.handlers.keys()];
    }

    /** Test seam, mirroring the contract registry's. */
    unregister(kind: string): boolean {
        return this.handlers.delete(kind);
    }
}

export const rfqCorridorHandlers = new RfqCorridorRegistry();
