/**
 * Arkade service resolution — one spelling of "which Arkade deployment", shared by
 * {@link Arkade.connect} and `Wallet.create`, so the two cannot drift.
 *
 * @module arkade/service
 */

import { DEFAULT_ARKADE_SERVER_URL, type NetworkName } from "../networks";
import { type OperatorInfo, type OperatorProvider, RestOperatorProvider } from "../providers/ark";
import { type EmulatorProvider, RestEmulatorProvider } from "../providers/emulator";
import { type IndexerProvider, RestIndexerProvider } from "../providers/indexer";
import { ESPLORA_URL, EsploraProvider, type OnchainProvider } from "../providers/onchain";

/**
 * The Arkade deployment to talk to.
 *
 * - `{ network: "bitcoin" }`: the hosted mainnet deployment, whose arkd co-signs Arkade Script
 *   itself. Mainnet is the only network with a one-liner.
 * - `{ operatorUrl, emulatorUrl? }`: a specific operator. `emulatorUrl` is needed only to spend
 *   covenants on a co-signer key arkd does not hold.
 */
export type ArkadeService = { network: "bitcoin" } | { operatorUrl: string; emulatorUrl?: string };

/** The providers and operator info an {@link ArkadeService} resolves to. */
export interface ResolvedArkadeService {
    arkProvider: OperatorProvider;
    indexerProvider: IndexerProvider;
    onchainProvider: OnchainProvider;
    /** A cosigner that emulates Arkade Script; present only when the service names `emulatorUrl`. */
    emulator?: EmulatorProvider;
    info: OperatorInfo;
}

/** The operator URL a service names. */
export function arkadeServiceUrl(service: ArkadeService): string {
    return "operatorUrl" in service ? service.operatorUrl : DEFAULT_ARKADE_SERVER_URL;
}

/**
 * Resolve a service into providers and the operator's info.
 *
 * Pass `opts.arkProvider`/`opts.info` to reuse what the caller already holds (no second
 * `getInfo`). A `network` service whose operator reports another network throws: the caller named
 * the deployment, and silently using another one is the expensive failure.
 */
export async function resolveArkadeService(
    service: ArkadeService,
    opts: { arkProvider?: OperatorProvider; info?: OperatorInfo } = {},
): Promise<ResolvedArkadeService> {
    const operatorUrl = arkadeServiceUrl(service);
    const arkProvider = opts.arkProvider ?? new RestOperatorProvider(operatorUrl);
    const info = opts.info ?? (await arkProvider.getInfo());

    if ("network" in service && service.network !== info.network) {
        throw new Error(
            `Arkade service network mismatch: requested '${service.network}' but the operator at ${operatorUrl} reports '${info.network}'`,
        );
    }

    const esploraUrl = ESPLORA_URL[info.network as NetworkName];
    if (!esploraUrl) {
        throw new Error(`Arkade service: no default esplora URL for network '${info.network}'`);
    }

    const emulator =
        "emulatorUrl" in service && service.emulatorUrl
            ? new RestEmulatorProvider(service.emulatorUrl)
            : undefined;

    return {
        arkProvider,
        indexerProvider: new RestIndexerProvider(operatorUrl),
        onchainProvider: new EsploraProvider(esploraUrl),
        emulator,
        info,
    };
}
