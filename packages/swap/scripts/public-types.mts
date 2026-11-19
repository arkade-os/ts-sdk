import * as swap from "@arkade-os/swap";
import * as advanced from "@arkade-os/swap/advanced";
import * as nostr from "@arkade-os/swap/nostr";
import * as protocol from "@arkade-os/swap/protocol";
import * as rfqContract from "@arkade-os/swap/rfq-contract";
import * as node from "@arkade-os/swap/node";
import * as sqlite from "@arkade-os/swap/repositories/sqlite";
import * as realm from "@arkade-os/swap/repositories/realm";

export const publicSurfaces = {
    swap,
    advanced,
    nostr,
    protocol,
    rfqContract,
    node,
    sqlite,
    realm,
};

export const sharedPoolFactory = (
    pool: ReturnType<typeof nostr.createNostrPool>,
): swap.RfqTransportFactory => advanced.createNostrTransportFactory(pool);
