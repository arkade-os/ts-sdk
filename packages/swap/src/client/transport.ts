/**
 * The transport seam, and the attestation the responder check runs on.
 *
 * §4 makes the transport an inference: the card names the rendezvous — its
 * relays and its discovery key — and the client opens it, where v1 had the
 * caller hand-build `nostrRfqTransport({relays, solverPubkey})`. What the card
 * cannot say is whether the transport that gets built authenticates anybody, and
 * that is the whole of G2: the production Nostr transport does, through its
 * `authors` filter and the per-solver conversation key, while `httpTransport`
 * and `relayTransport` attest nobody and route on `rfq_id` alone.
 *
 * So the attestation is a property of the transport and is declared by whoever
 * built it. A transport that filters replies to one author sets
 * {@link AttestingRfqTransport.attestedResponder} to that author; anything else
 * leaves it absent and fails the `responder` check. That is deliberately the
 * fail-closed default: the two dev transports do not authenticate, and a client
 * that quoted over them as though they did would be verifying nothing while
 * reporting that it verified four things.
 *
 * The default factory reaches `./nostr` through a dynamic import, which is what
 * keeps `nostr-tools` an optional peer dependency: a consumer doing HTTP-only
 * swaps against its own transport never loads the subpath, exactly as importing
 * it directly never loaded it for them.
 */
import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import type { RfqTransport } from "../rfq";
import type { Pubkey } from "./primitives";

/**
 * An {@link RfqTransport} that can prove who answered.
 *
 * Optional rather than required, because the interface has three
 * implementations today and only one of them can fill it. Absent means "attests
 * nobody", which the responder check refuses — a transport is never trusted for
 * a claim it did not make.
 */
export interface AttestingRfqTransport extends RfqTransport {
    /**
     * The key every reply on this transport is proven to come from.
     *
     * x-only hex, and it must be a claim the transport ENFORCES — a filter that
     * only this author's events satisfy, plus a conversation key only this
     * author can decrypt to. Setting it without that is worse than leaving it
     * absent: it turns a check into a decoration.
     */
    readonly attestedResponder?: Pubkey;
}

/** What a factory is told about the card it is opening a rendezvous to. */
export interface RfqRendezvous {
    readonly card: DiscoveredMarket;
    /** The card's `discovery_pubkey` — who the request is addressed to. */
    readonly solverPubkey: Pubkey;
    /** The card's relays. */
    readonly relays: readonly string[];
}

export type RfqTransportFactory = (
    rendezvous: RfqRendezvous,
) => AttestingRfqTransport | Promise<AttestingRfqTransport>;

/** Declare that `transport` proves every reply came from `responder`. */
export const attesting = <T extends RfqTransport>(
    transport: T,
    responder: Pubkey,
): AttestingRfqTransport => Object.assign(transport, { attestedResponder: responder });

/**
 * The default: the card's own Nostr rendezvous.
 *
 * It attests the card's discovery key because `nostrRfqTransport` subscribes
 * with `authors: [solverPubkey]` and decrypts with the conversation key derived
 * against that same key — a reply from anyone else is either filtered out by the
 * relay or fails to decrypt into anything with an `rfq_id`.
 */
export const nostrTransportFactory: RfqTransportFactory = async (rendezvous) => {
    const { nostrRfqTransport } = await import("../nostr");
    return attesting(
        nostrRfqTransport({
            relays: [...rendezvous.relays],
            solverPubkey: rendezvous.solverPubkey,
        }),
        rendezvous.solverPubkey,
    );
};
