import { hex } from "@scure/base";
import type { Asset, IWallet } from ".";
import {
    ExecutorRequestError,
    type ExecutorContractKeys,
    type ExecutorDelegation,
    type ExecutorInfo,
    type ExecutorProvider,
} from "../providers/executor";
import type { Contract } from "../contracts/types";
import { ExecutorContractHandler } from "../contracts/handlers/executor";
import { getNetwork, type NetworkName } from "../networks";
import { ArkAddress } from "../script/address";
import {
    DEFAULT_TEMPLATE_IDS,
    type ExecutorDefault,
    type DelegationParams,
    defaultVariables,
} from "../script/executor/executorTemplate";
import { toXOnlySignerHex } from "./signerRotation";

export type { ExecutorContractKeys };

/** Metadata key: the service's status of a delegated watch. */
export const DELEGATION_STATUS_KEY = "delegationStatus";
/** Metadata key: the watch's expiry, in unix seconds. */
export const DELEGATION_EXPIRES_KEY = "delegationExpiresAt";
/** Metadata key: the address the service knows the watch by. */
export const DELEGATION_ADDRESS_KEY = "delegationAddress";

/**
 * The status of a contract row the SDK watches but never registered with the service: the local
 * companion of a registration (the renewal contract of a boarding watch, the boarding contract of
 * a renewal watch). Never a live delegation.
 */
export const DELEGATION_LOCAL_STATUS = "local";
/**
 * The status of a watch the service does not know anymore: it was registered, but the service
 * dropped it. Never a live delegation.
 */
export const DELEGATION_GONE_STATUS = "gone";
/**
 * The status of a watch the service could not be asked about, and that carries no status of its
 * own. Informational only: it is never persisted.
 */
export const DELEGATION_UNKNOWN_STATUS = "unknown";

/** How a delegated watch was registered, persisted on its contract row. */
export interface ExecutorWatchMetadata {
    /** The template the service registered. */
    template: ExecutorDefault;
    /** The service's status of the watch. */
    status: string;
    /** The watch's expiry, in unix seconds. */
    expiresAt?: number;
    /** The address the service knows the watch by. */
    address?: string;
}

/** The service's answer for one delegated watch. */
export interface ExecutorStatusRefresh {
    /** The delegated contract row's script. */
    script: string;
    /** The address the service knows the watch by. */
    address: string;
    /** The status the row carries now: the service's, or the one it already had. */
    status: string;
    /** The watch's expiry, in unix seconds. */
    expiresAt?: number;
    /** Set when the service could not be asked; the row keeps the status it had. */
    error?: string;
}

/** A watch both sides derived: the address to fund and what restores it. */
export interface ExecutorWatchRegistration {
    /** An Ark address for renewal, a bitcoin address for boarding. */
    address: string;
    templateId: string;
    /** The template's variables, canonical hex. */
    variables: Record<string, string>;
    /** The service's keys the wallet's executor contracts are derived from. */
    keys: ExecutorContractKeys;
    delegation: ExecutorDelegation;
}

/** What the manager needs of a wallet: its key, its server, its coins and a way to send. */
export type ExecutorWallet = Pick<
    IWallet,
    "identity" | "getAddress" | "getSpendableVtxos" | "send" | "getContractManager"
>;

/**
 * Make the wallet's contract manager watch, as its own, the renewal contract of its key and, when
 * params has a boarding exit delay, its boarding contract: derived locally from the key, the
 * params and the service's keys, so a restored wallet finds its delegated coins without asking
 * the service. Idempotent.
 *
 * `registered` carries the service's answer for the template it registered: that row becomes the
 * live delegation, the others stay local companions of it (watched, never delegated to). Without
 * it (a restore) the rows carry no status: the SDK cannot tell a companion from a registered
 * watch, so it claims neither, and {@link IExecutorManager.refreshStatus} asks the service.
 */
export async function watchExecutorContracts(
    wallet: Pick<IWallet, "identity" | "getAddress" | "getContractManager">,
    keys: ExecutorContractKeys,
    params: DelegationParams,
    registered?: ExecutorWatchMetadata,
): Promise<Contract[]> {
    const [owner, address, manager] = await Promise.all([
        wallet.identity.compressedPublicKey(),
        wallet.getAddress(),
        wallet.getContractManager(),
    ]);
    const { hrp, serverPubKey } = ArkAddress.decode(address);
    const templates: ExecutorDefault[] =
        params.boardingExitDelay === undefined ? ["renewal"] : ["renewal", "boarding"];
    const contracts: Contract[] = [];
    for (const template of templates) {
        const serialized = contractParams(template, owner, keys, params);
        const script = ExecutorContractHandler.createScript(serialized);
        contracts.push(
            await manager.createContract({
                type: ExecutorContractHandler.type,
                params: serialized,
                script: hex.encode(script.pkScript),
                address: script.address(hrp, serverPubKey).encode(),
                label: template === "renewal" ? "Executor renewal" : "Executor boarding",
                metadata: metadataFor(template, registered),
            }),
        );
    }
    return contracts;
}

/**
 * The metadata a delegated contract row carries: the service's answer, the local marker, or
 * nothing when no registration is known.
 */
function metadataFor(
    template: ExecutorDefault,
    registered?: ExecutorWatchMetadata,
): Record<string, string | number> | undefined {
    // A restore: whether the service watches this row is the service's to say.
    if (registered === undefined) return undefined;
    if (registered.template !== template) {
        // Not the template the service registered: watched, but never delegated to.
        return { [DELEGATION_STATUS_KEY]: DELEGATION_LOCAL_STATUS };
    }
    return {
        [DELEGATION_STATUS_KEY]: registered.status,
        ...(registered.expiresAt !== undefined
            ? { [DELEGATION_EXPIRES_KEY]: registered.expiresAt }
            : {}),
        ...(registered.address !== undefined
            ? { [DELEGATION_ADDRESS_KEY]: registered.address }
            : {}),
    };
}

function contractParams(
    template: ExecutorDefault,
    owner: Uint8Array,
    keys: ExecutorContractKeys,
    params: DelegationParams,
): Record<string, string> {
    return ExecutorContractHandler.serializeParams({
        template,
        owner,
        exitDelay: params.exitDelay,
        renewalWindow: params.renewalWindow,
        maxFee: params.maxFee,
        ...(template === "boarding" ? { boardingExitDelay: params.boardingExitDelay } : {}),
        cosignerPubKey: hex.decode(keys.cosignerPubkey),
        serverPubKey: hex.decode(keys.serverPubkey),
        emulatorPubKey: hex.decode(keys.emulatorPubkey),
    });
}

export interface IExecutorManager {
    getInfo(): Promise<ExecutorInfo>;
    /** The default template ids; throws unless the service lists them as active. */
    defaultTemplates(): Promise<Record<ExecutorDefault, string>>;
    /** Watch the renewal address of this wallet's key, and make the wallet watch it too. */
    registerRenewal(
        params: DelegationParams,
        options?: { expiresAt?: number },
    ): Promise<ExecutorWatchRegistration>;
    /**
     * Watch the boarding address of this wallet's key (params needs boardingExitDelay), and make
     * the wallet watch its boarding and renewal contracts.
     */
    registerBoarding(
        params: DelegationParams,
        options?: { expiresAt?: number },
    ): Promise<ExecutorWatchRegistration>;
    /**
     * Migrate the wallet to the executor: register the renewal watch, send its generically
     * spendable VTXOs, with their assets, to the renewal address and retire its own receive
     * contracts (inactive, still watched). txid is absent when there was nothing to send.
     * Idempotent: run it again to move coins that reach a retired address later.
     */
    delegateVtxos(
        params: DelegationParams,
        options?: { expiresAt?: number },
    ): Promise<ExecutorWatchRegistration & { txid?: string }>;
    /**
     * Re-read the service's view of this wallet's delegated watches and persist it on the
     * contract rows. A watch the service ended stops being advertised as soon as the service
     * says so; a watch the service does not know anymore is over, whatever it was.
     *
     * A watch the service cannot be asked about (it is down, or the request failed) keeps the
     * status it had: a network failure never moves the wallet's addresses, and the watch's
     * expiry is the hard bound.
     */
    refreshStatus(): Promise<ExecutorStatusRefresh[]>;
}

/** Client-side watch registration with the executor service. */
export class ExecutorManagerImpl implements IExecutorManager {
    constructor(
        readonly executorProvider: ExecutorProvider,
        readonly wallet: ExecutorWallet,
    ) {}

    getInfo(): Promise<ExecutorInfo> {
        return this.executorProvider.getInfo();
    }

    async defaultTemplates(): Promise<Record<ExecutorDefault, string>> {
        const ids = { ...DEFAULT_TEMPLATE_IDS };
        const templates = await this.executorProvider.listTemplates();
        const active = new Set(templates.filter((t) => t.status === "active").map((t) => t.id));
        const missing = Object.entries(ids).filter(([, id]) => !active.has(id));
        if (missing.length > 0) {
            throw new Error(
                `executor does not list the default templates ${missing.map(([n, id]) => `${n} ${id}`).join(", ")}`,
            );
        }
        return ids;
    }

    registerRenewal(
        params: DelegationParams,
        options: { expiresAt?: number } = {},
    ): Promise<ExecutorWatchRegistration> {
        return this.register("renewal", { ...params, boardingExitDelay: undefined }, options);
    }

    registerBoarding(
        params: DelegationParams,
        options: { expiresAt?: number } = {},
    ): Promise<ExecutorWatchRegistration> {
        return this.register("boarding", params, options);
    }

    async delegateVtxos(
        params: DelegationParams,
        options: { expiresAt?: number } = {},
    ): Promise<ExecutorWatchRegistration & { txid?: string }> {
        const watch = await this.registerRenewal(params, options);
        // coins already at the renewal address stay there; gated ones (e.g. VHTLCs) are not ours
        // to move
        const renewal = hex.encode(ArkAddress.decode(watch.address).pkScript);
        const vtxos = (
            await this.wallet.getSpendableVtxos({
                withRecoverable: false,
                genericallySpendableOnly: true,
            })
        ).filter((v) => v.script !== renewal);
        let txid: string | undefined;
        if (vtxos.length > 0) {
            const assets = new Map<string, bigint>();
            for (const vtxo of vtxos) {
                for (const a of vtxo.assets ?? []) {
                    assets.set(a.assetId, (assets.get(a.assetId) ?? 0n) + a.amount);
                }
            }
            txid = await this.wallet.send({
                recipients: [
                    {
                        address: watch.address,
                        amount: vtxos.reduce((sum, v) => sum + v.value, 0),
                        assets:
                            assets.size > 0
                                ? [...assets].map(
                                      ([assetId, amount]): Asset => ({ assetId, amount }),
                                  )
                                : undefined,
                    },
                ],
                selectedVtxos: vtxos,
            });
        }
        // Retire the wallet's own receive contracts: still watched, so a late payment to an old
        // address is seen and the next call moves it.
        const manager = await this.wallet.getContractManager();
        for (const c of await manager.getContracts({
            type: ["default", "delegate"],
            state: "active",
        })) {
            await manager.setContractState(c.script, "inactive");
        }
        return { ...watch, txid };
    }

    private async register(
        kind: ExecutorDefault,
        params: DelegationParams,
        options: { expiresAt?: number },
    ): Promise<ExecutorWatchRegistration> {
        const [info, address, owner] = await Promise.all([
            this.executorProvider.getInfo(),
            this.wallet.getAddress(),
            this.wallet.identity.compressedPublicKey(),
        ]);
        // the watch address commits to the service's server key, so it must be the wallet's
        const { hrp, serverPubKey } = ArkAddress.decode(address);
        const server = hex.encode(serverPubKey);
        if (info.serverPubkey.slice(2).toLowerCase() !== server) {
            throw new Error(
                `executor server key ${info.serverPubkey} is not the wallet's server ${server}`,
            );
        }
        const keys = {
            cosignerPubkey: info.cosignerPubkey,
            serverPubkey: info.serverPubkey,
            emulatorPubkey: info.emulatorPubkey,
        };
        const variables = defaultVariables(kind, owner, params);
        const script = ExecutorContractHandler.createScript(
            contractParams(kind, owner, keys, params),
        );
        const watchAddress =
            kind === "boarding"
                ? script.onchainAddress(getNetwork(info.network as NetworkName))
                : script.address(hrp, serverPubKey).encode();
        const templateId = DEFAULT_TEMPLATE_IDS[kind];
        // Registration is idempotent on the service: repeating it returns the existing watch.
        const delegation = await this.executorProvider.registerDelegation(
            templateId,
            variables,
            options,
        );
        // The service fills <COSIGNER_KEY> with its key: the same address proves it is GetInfo's,
        // and commits to the same tapscripts. Checked before anything is persisted, so a row never
        // carries an address that does not derive from its script.
        if (delegation.address !== watchAddress) {
            throw new Error(
                `executor derived a different address: expected ${watchAddress}, got ${delegation.address}`,
            );
        }
        if (delegation.status !== "active") {
            // The service ended the watch: watch the contracts anyway, carrying that status, so
            // the wallet stops advertising the address it delegated to.
            const ended = await watchExecutorContracts(this.wallet, keys, params, {
                template: kind,
                status: delegation.status,
                expiresAt: delegation.expiresAt,
                address: delegation.address,
            });
            await this.persistStatus(
                ended,
                kind,
                delegation.status,
                delegation.expiresAt,
                delegation.address,
            );
            throw new Error(`executor watch ${delegation.address} is ${delegation.status}`);
        }
        const contracts = await watchExecutorContracts(this.wallet, keys, params, {
            template: kind,
            status: delegation.status,
            expiresAt: delegation.expiresAt,
            address: delegation.address,
        });
        // The row may predate this registration (the service is idempotent, the repository is
        // not): make sure it carries what the service just said.
        await this.persistStatus(
            contracts,
            kind,
            delegation.status,
            delegation.expiresAt,
            delegation.address,
        );
        return { address: watchAddress, templateId, variables, keys, delegation };
    }

    /**
     * Write the service's answer for a watch on its contract row. The wallet's default addresses
     * follow the persisted status, so this is what stops a delegated address from being
     * advertised once the service ended it.
     */
    private async persistStatus(
        contracts: Contract[],
        template: ExecutorDefault,
        status: string,
        expiresAt: number | undefined,
        address: string,
    ): Promise<void> {
        const row = contracts.find((c) => c.params.template === template);
        if (!row) return;
        const manager = await this.wallet.getContractManager();
        await manager.updateContract(row.script, {
            metadata: {
                ...row.metadata,
                [DELEGATION_STATUS_KEY]: status,
                ...(expiresAt !== undefined ? { [DELEGATION_EXPIRES_KEY]: expiresAt } : {}),
                [DELEGATION_ADDRESS_KEY]: address,
            },
        });
    }

    /**
     * Re-read the service's view of this wallet's delegated watches and persist it on the
     * contract rows. A watch the service ended stops being advertised as soon as the service says
     * so; a watch the service does not know anymore is over, whatever it was.
     *
     * A watch the service cannot be asked about (it is down, or the request failed) keeps the
     * status it had: a network failure never moves the wallet's addresses, and the watch's expiry
     * is the hard bound.
     */
    async refreshStatus(): Promise<ExecutorStatusRefresh[]> {
        const manager = await this.wallet.getContractManager();
        const rows = await manager.getContracts({ type: [ExecutorContractHandler.type] });
        const refreshed: ExecutorStatusRefresh[] = [];
        for (const row of rows) {
            const template = row.params.template;
            if (template !== "renewal" && template !== "boarding") continue;
            const persisted = row.metadata?.[DELEGATION_STATUS_KEY];
            // Watched but never registered with the service: nothing to ask about.
            if (persisted === DELEGATION_LOCAL_STATUS) continue;
            let address: string;
            try {
                address = await this.watchAddress(row, template);
            } catch (e) {
                refreshed.push({
                    script: row.script,
                    address: "",
                    status: typeof persisted === "string" ? persisted : DELEGATION_UNKNOWN_STATUS,
                    error: errorMessage(e),
                });
                continue;
            }
            try {
                const { delegation } = await this.executorProvider.getDelegation(address);
                await manager.updateContract(row.script, {
                    metadata: {
                        ...row.metadata,
                        [DELEGATION_STATUS_KEY]: delegation.status,
                        ...(delegation.expiresAt !== undefined
                            ? { [DELEGATION_EXPIRES_KEY]: delegation.expiresAt }
                            : {}),
                        [DELEGATION_ADDRESS_KEY]: address,
                    },
                });
                refreshed.push({
                    script: row.script,
                    address,
                    status: delegation.status,
                    ...(delegation.expiresAt !== undefined
                        ? { expiresAt: delegation.expiresAt }
                        : {}),
                });
            } catch (e) {
                if (e instanceof ExecutorRequestError && e.status === 404) {
                    // The service does not know this watch: it is over, whatever it was.
                    await manager.updateContract(row.script, {
                        metadata: {
                            ...row.metadata,
                            [DELEGATION_STATUS_KEY]: DELEGATION_GONE_STATUS,
                            [DELEGATION_ADDRESS_KEY]: address,
                        },
                    });
                    refreshed.push({ script: row.script, address, status: DELEGATION_GONE_STATUS });
                    continue;
                }
                refreshed.push({
                    script: row.script,
                    address,
                    status: typeof persisted === "string" ? persisted : DELEGATION_UNKNOWN_STATUS,
                    error: errorMessage(e),
                });
            }
        }
        return refreshed;
    }

    /**
     * The address the service knows a watch by: the address of a renewal watch, the onchain
     * address of a boarding one. Persisted on the row when the watch was registered, recomputed
     * for rows written before it was.
     */
    private async watchAddress(row: Contract, template: ExecutorDefault): Promise<string> {
        const persisted = row.metadata?.[DELEGATION_ADDRESS_KEY];
        if (typeof persisted === "string" && persisted.length > 0) return persisted;
        const script = ExecutorContractHandler.createScript(row.params);
        if (template === "renewal") {
            const { hrp } = ArkAddress.decode(await this.wallet.getAddress());
            return script
                .address(hrp, hex.decode(toXOnlySignerHex(row.params.serverPubKey)))
                .encode();
        }
        const info = await this.executorProvider.getInfo();
        return script.onchainAddress(getNetwork(info.network as NetworkName));
    }
}

function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
