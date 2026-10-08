/**
 * The transport seam, and the attestation the responder check runs on.
 *
 * The card names the rendezvous (relays and discovery key) and the client opens it. What the card
 * cannot say is whether the built transport authenticates anybody: the production Nostr transport
 * does (its `authors` filter and per-solver conversation key); `httpTransport` and `relayTransport`
 * route on `rfq_id` alone. So attestation is declared by whoever built the transport, and absent
 * means the `responder` check fails — fail closed, rather than "verifying" over an unauthenticated
 * wire.
 *
 * The default factory dynamically imports `./nostr`, keeping `nostr-tools` an optional peer.
 */
import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import type { RfqTransport } from "../rfq";
import type { Pubkey } from "./primitives";

/** An {@link RfqTransport} that can prove who answered. Absent means "attests nobody". */
export interface AttestingRfqTransport extends RfqTransport {
    /**
     * The x-only key every reply on this transport is proven to come from. Must be a claim the
     * transport ENFORCES (an author filter plus a conversation key only that author can decrypt
     * to); setting it otherwise turns a check into a decoration.
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
 * The default: the card's own Nostr rendezvous. It attests the discovery key because
 * `nostrRfqTransport` subscribes with `authors: [solverPubkey]` and decrypts against that key — any
 * other reply is filtered by the relay or fails to decrypt.
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
