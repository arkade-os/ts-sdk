/**
 * Choosing which solver to negotiate with. Both send corridors pick a card the
 * same way and differ only in the payout-side corridor they look for.
 */
import { marketCorridor, sideLimits, type DiscoveredMarket } from "@arkade-os/solver-discovery";
import { hex } from "@scure/base";

const XONLY_HEX = /^[0-9a-f]{64}$/;

/** Where to reach a solver. Bounds are indicative — the quote binds. */
export interface SolverRendezvous {
    solverPubkey: string;
    transports: { nostr: { relays: string[] } };
    emulatorPubkey: string;
    minSats: number;
    maxSats: number;
}

/** The card's own `emulator_pubkey` wins; an absent one falls back to the pin,
 *  a malformed one fails closed, and a disagreement is skipped not resolved. */
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

    // Bounds are what the solver PAYS OUT, so a send leg is bounded by the
    // quote side. `sideLimits` reads a disabled side (max "0") as null, which
    // keeps it from surfacing as "amount outside solver bounds".
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

/** The size check is not a courtesy: quoting outside a card's advertised range
 *  burns a negotiation, tells a third party what the user is about to do, and
 *  is refused anyway. A card that serves the corridor but not the size is
 *  skipped, not fatal — another may take it. */
export const solverRendezvous = (
    markets: DiscoveredMarket[],
    payoutCorridor: "onchain" | "lightning",
    amountSats: number,
    fallbackEmulatorPubkey?: Uint8Array,
): SolverRendezvous | undefined => {
    // A 33-byte compressed key encodes to 66 hex and would otherwise pass as
    // x-only. Neither rail re-derives the pin, so this is the only place both
    // fail closed.
    const encoded = fallbackEmulatorPubkey ? hex.encode(fallbackEmulatorPubkey) : undefined;
    if (encoded !== undefined && !XONLY_HEX.test(encoded)) return undefined;
    const pinned = encoded;

    for (const market of markets) {
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
