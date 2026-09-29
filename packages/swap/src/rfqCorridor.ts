/**
 * Per-corridor persistence, kept out of the corridor-agnostic record, mirroring the contract
 * layer's `contractHandlers`: a new corridor changes no stored schema and no shared switch. The
 * `profile` is plain JSON because the repository writes the record whole, and a backend that
 * mangles unknown keys would silently lose a corridor's half.
 *
 * **Internal, not exported.** `RfqSwapManager` branches on `RfqSwap["kind"]` to decide what it
 * drives, so an externally registered corridor would persist and restore and then sit
 * unmonitored. `kind` is typed to the manager's union to keep storable and drivable in step.
 */
import type { VHTLC } from "@arkade-os/sdk";
import type { RfqSwap } from "./swapManager";
import type { RfqClaimSecretProjection } from "./rfqProfileParts";

/**
 * How one corridor persists and restores its own half. Both `project` and `hydrate` are pure: no
 * wallet, indexer or network, only the stored profile and the covenant handed in.
 */
export interface RfqCorridorHandler<P extends Record<string, unknown> = Record<string, unknown>> {
    /** The swap kind this handles. The manager's own union, so a handler can
     * only ever exist for a corridor the manager can drive. */
    readonly kind: RfqSwap["kind"];

    /**
     * The parts of the profile the MANAGER can change, projected off the live swap and merged
     * over the profile written at creation. Not the whole profile: some of it (e.g. the onchain
     * leg's L1 keys) exists only in the request result. Return `{}` if nothing is mutable.
     *
     * **Never return `signer` or `hashlock`.** The merge is SHALLOW, so even
     * `{ hashlock: { paymentHash } }` deletes the preimage salt on the first write after
     * creation — an unclaimable lockup, discovered at claim time.
     */
    project(swap: RfqSwap): Partial<P>;

    /**
     * The claim inputs off this corridor's profile when this leg is one WE claim — typically
     * `{ ...profile.signer, ...profile.hashlock }`. Omitted for refund-only legs
     * (`lightning_send`) so `rfqClaimSecretOf` answers `undefined` instead of a wrong preimage.
     */
    claimSecret?(profile: P): RfqClaimSecretProjection;

    /**
     * Where this corridor's claim pays, off its own profile; omitted alongside
     * {@link claimSecret}. Returns what was STORED, unvalidated — `rfqClaimDestinationOf`
     * checks it, since a backend row's declared `string` is a claim about the type only.
     */
    claimDestination?(profile: P): string;

    /**
     * This leg's own transaction ids (e.g. the receive or L1 `claimTxid`); common ones like
     * `fundingTxid`/`refundTxid` are read off the record. Omit for a corridor with none.
     */
    activityTxids?(profile: P): readonly string[];

    /**
     * Rebuild the corridor's live fields from what was stored. Throw rather than default when
     * something required is missing: a half-restored swap looks monitored while a deadline passes.
     */
    hydrate(profile: P, context: RfqCorridorContext): Record<string, unknown>;
}

/** What a handler may read beyond its own profile: the rebuilt lockup covenant.
 * The payment hash is not here — it belongs to a corridor's own `hashlock`, and
 * a corridor that has none would have had to be handed a fake. */
interface RfqCorridorContext {
    lockup: InstanceType<typeof VHTLC.ScriptV2>;
}

/**
 * Registry of corridor handlers, keyed by `kind`. A duplicate throws rather than replacing, or
 * which handler restores a swap would depend on import order.
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

    /** A bare `string` on purpose: the key comes off a stored record, and narrowing it to the
     * `kind` union would read as a check already made. */
    get(kind: string): RfqCorridorHandler | undefined {
        return this.handlers.get(kind);
    }

    /** The handler for a kind, or a loud failure naming the registered kinds. */
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

    registeredKinds(): string[] {
        return [...this.handlers.keys()];
    }

    /** Test seam, mirroring the contract registry's. */
    unregister(kind: string): boolean {
        return this.handlers.delete(kind);
    }
}

export const rfqCorridorHandlers = new RfqCorridorRegistry();
