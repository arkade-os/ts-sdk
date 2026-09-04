/**
 * Choosing which solver to negotiate with, shared by every send rail.
 *
 * A market card commits a solver to a corridor and a size range. Both send
 * corridors — `arkade:BTC -> onchain:BTC` and `arkade:BTC -> lightning:BTC` —
 * pick a card the same way and differ only in which corridor they look for on
 * the payout side, so the selection lives here and each rail names its own.
 */
import { marketCorridor, sideLimits, type DiscoveredMarket } from "@arkade-os/solver-discovery";
import { hex } from "@scure/base";

/** 64 lowercase hex chars — the solver registry's own `emulator_pubkey` pattern. */
const XONLY_HEX = /^[0-9a-f]{64}$/;

/**
 * Where to reach a solver, and the bounds its card advertises on the payout
 * side. Indicative only: the quote is what binds.
 */
export interface SolverRendezvous {
    solverPubkey: string;
    transports: { nostr: { relays: string[] } };
    /** The card's `emulator_pubkey`, x-only hex — the covenant cannot be
     *  derived without it. */
    emulatorPubkey: string;
    /** Card bounds on the payout side, sats. */
    minSats: number;
    maxSats: number;
}

/**
 * What a card must carry before it can be a rendezvous: the card's own
 * `emulator_pubkey` wins, an absent one falls back to the pinned per-network
 * key, a malformed one fails closed even with a pin, and a disagreement
 * between the two is skipped rather than resolved.
 */
const rendezvousOf = (market: DiscoveredMarket, pinned?: string): SolverRendezvous | undefined => {
    const transports = { nostr: { relays: market.transports?.nostr?.relays ?? [] } };
    if (!market.discovery_pubkey || !transports.nostr.relays.length) return undefined;

    const advertised = (market as { emulator_pubkey?: unknown }).emulator_pubkey;
    const emulatorPubkey =
        advertised === undefined || advertised === null || advertised === ""
            ? pinned
            : typeof advertised === "string" && XONLY_HEX.test(advertised)
              ? advertised
              : undefined;
    if (!emulatorPubkey) return undefined;
    if (pinned && emulatorPubkey !== pinned) return undefined;

    // A side's bounds are what the SOLVER pays out on it, so a send leg —
    // arkade in, something else out — is bounded by the quote side.
    // `sideLimits` is the registry's own parser and reads a disabled side
    // (max "0") or a malformed bound as null, which is what keeps a disabled
    // corridor from reaching the user as "amount outside solver bounds".
    const bounds = sideLimits(market, "quote");
    if (!bounds) return undefined;

    return {
        solverPubkey: market.discovery_pubkey,
        transports,
        emulatorPubkey,
        minSats: Number(bounds.min),
        maxSats: Number(bounds.max),
    };
};

/**
 * Pick the rendezvous for a send of THIS size onto `payoutCorridor`.
 *
 * The size check is not a courtesy. A card advertises the range its solver can
 * actually fill; quoting outside it burns a negotiation, tells a third party
 * what the user is about to do, and comes back as `amount_out_of_range`
 * anyway. A card that serves the corridor but not the size is skipped rather
 * than fatal — another card may take it.
 */
export const solverRendezvous = (
    markets: DiscoveredMarket[],
    payoutCorridor: "onchain" | "lightning",
    amountSats: number,
    fallbackEmulatorPubkey?: Uint8Array,
): SolverRendezvous | undefined => {
    // The pin is held to the same shape a card's own key is. A 33-byte
    // compressed key encodes to 66 hex and would otherwise be adopted verbatim
    // for any card that advertises none — reaching `connect` as a
    // `SolverRendezvous.emulatorPubkey` this type documents as x-only. Failing
    // closed on the pin is the only way both rails fail closed, since neither
    // re-derives it.
    const encoded = fallbackEmulatorPubkey ? hex.encode(fallbackEmulatorPubkey) : undefined;
    if (encoded !== undefined && !XONLY_HEX.test(encoded)) return undefined;
    const pinned = encoded;

    for (const market of markets) {
        // A send leg goes arkade -> elsewhere: anything else on the base side
        // is a corridor this wallet cannot fund from, and the receive
        // direction lives on the other side of the same market.
        if (marketCorridor(market, "base") !== "arkade") continue;
        if (marketCorridor(market, "quote") !== payoutCorridor) continue;

        const rendezvous = rendezvousOf(market, pinned);
        if (!rendezvous) continue;
        if (amountSats >= rendezvous.minSats && amountSats <= rendezvous.maxSats) {
            return rendezvous;
        }
    }
    return undefined;
};
