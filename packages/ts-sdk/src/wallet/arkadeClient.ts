/**
 * Open the Arkade contract client a wallet already owns.
 *
 * The wallet holds the operator, the indexer, and the one contract manager
 * that writes its repositories. This binds a client to those, so a covenant
 * does not construct a second indexer or a second manager.
 */

import type { IContractManager } from "../contracts/contractManager";
import { isSigningIdentity, type ReadonlyIdentity } from "../identity";
import type { Network } from "../networks";
import type { ArkProvider } from "../providers/ark";
import type { EmulatorProvider } from "../providers/emulator";
import type { IndexerProvider } from "../providers/indexer";

/** Per-call overrides for {@link IReadonlyWallet.arkade}. */
export interface WalletArkadeOptions {
    /** Co-signer URL. Omit when the wallet was created with one, or pass `emulator`. */
    emulatorUrl?: string;
    /** Co-signer client. Takes precedence over `emulatorUrl`. */
    emulator?: EmulatorProvider;
    /**
     * Co-sign with this emulator key (33-byte compressed hex) instead of the
     * one pinned for the network.
     */
    emulatorPubkey?: string;
    /**
     * Network for address derivation. Defaults to the wallet's network, which
     * overrides whatever the server reports.
     */
    network?: Network;
}

export interface ArkadeClientSource {
    identity: ReadonlyIdentity;
    network?: Network;
    getContractManager(): Promise<IContractManager>;
    arkProvider?: Pick<ArkProvider, "getInfo" | "submitTx" | "finalizeTx">;
    indexerProvider?: Pick<IndexerProvider, "getVtxos" | "getVirtualTxs">;
    serverUrl?: string;
    indexerUrl?: string;
    emulator?: EmulatorProvider;
    emulatorUrl?: string;
    emulatorPubkey?: string;
}

export async function openArkadeClient(
    source: ArkadeClientSource,
    options: WalletArkadeOptions = {},
): Promise<import("../arkade/contract").Arkade> {
    const { Arkade } = await import("../arkade/contract");
    const emulator = options.emulator ?? source.emulator;
    const emulatorUrl = emulator ? undefined : (options.emulatorUrl ?? source.emulatorUrl);
    const identity = isSigningIdentity(source.identity) ? source.identity : undefined;
    return Arkade.connect({
        ...(source.arkProvider ? { arkade: source.arkProvider } : { serverUrl: source.serverUrl }),
        ...(source.indexerProvider
            ? { indexer: source.indexerProvider }
            : source.indexerUrl
              ? { indexerUrl: source.indexerUrl }
              : {}),
        ...(emulator ? { emulator } : {}),
        ...(emulatorUrl ? { emulatorUrl } : {}),
        emulatorPubkey: options.emulatorPubkey ?? source.emulatorPubkey,
        identity,
        network: options.network ?? source.network,
        contractManager: await source.getContractManager(),
    });
}
