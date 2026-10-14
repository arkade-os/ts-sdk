/**
 * Arkade service resolution — one spelling of "which Arkade deployment", shared by
 * {@link Arkade.connect} and `Wallet.create`, so the two cannot drift.
 *
 * @module arkade/service
 */

import {
    DEFAULT_ARKADE_EMULATOR_URL,
    DEFAULT_ARKADE_SERVER_URL,
    type NetworkName,
} from "../networks";
import { type ArkadeInfo, type ArkProvider, RestArkProvider } from "../providers/ark";
import { type EmulatorProvider, RestEmulatorProvider } from "../providers/emulator";
import { type IndexerProvider, RestIndexerProvider } from "../providers/indexer";
import { ESPLORA_URL, EsploraProvider, type OnchainProvider } from "../providers/onchain";

/**
 * The Arkade deployment to talk to.
 *
 * - `{ network: "bitcoin" }` — the hosted mainnet deployment, including its covenant co-signer
 *   ({@link DEFAULT_ARKADE_EMULATOR_URL}). Mainnet is the only network with a one-liner.
 * - `{ serverUrl, emulatorUrl? }` — a specific server. A custom server does not imply the default
 *   emulator: without `emulatorUrl`, covenant (`arkadeScript`) paths stay disabled.
 */
export type ArkadeService = { network: "bitcoin" } | { serverUrl: string; emulatorUrl?: string };

/** The providers and server info an {@link ArkadeService} resolves to. */
export interface ResolvedArkadeService {
    arkProvider: ArkProvider;
    indexerProvider: IndexerProvider;
    onchainProvider: OnchainProvider;
    /** The covenant co-signer; absent for a `serverUrl` service without `emulatorUrl`. */
    emulator?: EmulatorProvider;
    info: ArkadeInfo;
}

/** The Arkade server URL a service names. */
export function arkadeServiceUrl(service: ArkadeService): string {
    return "serverUrl" in service ? service.serverUrl : DEFAULT_ARKADE_SERVER_URL;
}

/**
 * Resolve a service into providers and the server's info.
 *
 * Pass `opts.arkProvider`/`opts.info` to reuse what the caller already holds (no second
 * `getInfo`). A `network` service whose server reports another network throws: the caller named
 * the deployment, and silently using another one is the expensive failure.
 */
export async function resolveArkadeService(
    service: ArkadeService,
    opts: { arkProvider?: ArkProvider; info?: ArkadeInfo } = {},
): Promise<ResolvedArkadeService> {
    const serverUrl = arkadeServiceUrl(service);
    const arkProvider = opts.arkProvider ?? new RestArkProvider(serverUrl);
    const info = opts.info ?? (await arkProvider.getInfo());

    if ("network" in service && service.network !== info.network) {
        throw new Error(
            `Arkade service network mismatch: requested '${service.network}' but the server at ${serverUrl} reports '${info.network}'`,
        );
    }

    const esploraUrl = ESPLORA_URL[info.network as NetworkName];
    if (!esploraUrl) {
        throw new Error(`Arkade service: no default esplora URL for network '${info.network}'`);
    }

    let emulator: EmulatorProvider | undefined;
    if ("network" in service) {
        emulator = new RestEmulatorProvider(DEFAULT_ARKADE_EMULATOR_URL);
    } else if (service.emulatorUrl) {
        emulator = new RestEmulatorProvider(service.emulatorUrl);
    }

    return {
        arkProvider,
        indexerProvider: new RestIndexerProvider(serverUrl),
        onchainProvider: new EsploraProvider(esploraUrl),
        emulator,
        info,
    };
}
