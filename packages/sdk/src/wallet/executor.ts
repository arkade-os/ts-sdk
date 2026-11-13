import { hex } from "@scure/base";
import type { IWallet } from ".";
import type {
    ExecutorContractKeys,
    ExecutorDelegation,
    ExecutorInfo,
    ExecutorProvider,
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
import { timelockToSequence } from "../utils/timelock";

/** Metadata key: the service's status of a delegated watch. */
export const DELEGATION_STATUS_KEY = "delegationStatus";
/** Metadata key: the watch's expiry, in unix seconds; 0 or absent when it has none. */
export const DELEGATION_EXPIRES_KEY = "delegationExpiresAt";
/** Metadata key: the address the service knows the watch by. */
export const DELEGATION_ADDRESS_KEY = "delegationAddress";
/**
 * The status of a contract row the SDK watches but did not register with the service: the local
 * companion of a registration, such as the renewal contract a boarding watch boards into.
 */
export const DELEGATION_LOCAL_STATUS = "local";

/** How a delegated watch was registered, persisted on its contract row. */
export interface ExecutorWatchMetadata {
    /** The template the service registered. */
    template: ExecutorDefault;
    /** The service's status of the watch. */
    status: string;
    /** The watch's expiry, in unix seconds; 0 or absent when it has none. */
    expiresAt?: number;
    /** The address the service knows the watch by. */
    address?: string;
}

/** A watch both sides derived: the address to fund and what restores it. */
export interface ExecutorWatchRegistration {
    /** An address for renewal, an onchain address for boarding. */
    address: string;
    templateId: string;
    /** The template's variables, canonical hex. */
    variables: Record<string, string>;
    /** The Executor's keys the wallet's delegated contracts are derived from. */
    keys: ExecutorContractKeys;
    delegation: ExecutorDelegation;
}

/**
 * The parameters a caller chooses. The exit delays default to the operator's, as BIP 68
 * sequences.
 */
export type DelegationOptions = Pick<DelegationParams, "renewalWindow" | "maxFee"> &
    Partial<Pick<DelegationParams, "exitDelay" | "boardingExitDelay">>;

/** What the manager needs of a wallet: its key, its operator and its contracts. */
export type DelegatedWallet = Pick<
    IWallet,
    "identity" | "getAddress" | "getContractManager" | "getOperatorInfo"
>;

/**
 * Make the wallet's contract manager watch, as its own, the renewal contract of its key and, when
 * params has a boarding exit delay, its boarding contract: derived locally from the key, the
 * params and the service's keys, so a restored wallet finds its delegated coins without asking
 * the service. Idempotent.
 *
 * `registered` carries the service's answer for the template it registered: that row becomes the
 * live delegation, the others stay local companions of it (watched, never delegated to). Without
 * it (a restore) the rows carry no status.
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
                label: template === "renewal" ? "Delegated renewal" : "Delegated boarding",
                metadata: metadataFor(template, registered),
            }),
        );
    }
    return contracts;
}

function metadataFor(
    template: ExecutorDefault,
    registered?: ExecutorWatchMetadata,
): Record<string, string | number> | undefined {
    if (registered === undefined) return undefined;
    if (registered.template !== template) {
        return { [DELEGATION_STATUS_KEY]: DELEGATION_LOCAL_STATUS };
    }
    return statusMetadata({}, registered.status, registered.expiresAt, registered.address);
}

/** `updateContract` replaces metadata, so the previous expiry must not outlive a status without one. */
function statusMetadata(
    metadata: Record<string, unknown>,
    status: string,
    expiresAt: number | undefined,
    address: string | undefined,
): Record<string, string | number> {
    const { [DELEGATION_EXPIRES_KEY]: _stale, ...rest } = metadata;
    return {
        ...(rest as Record<string, string | number>),
        [DELEGATION_STATUS_KEY]: status,
        ...(expiresAt !== undefined ? { [DELEGATION_EXPIRES_KEY]: expiresAt } : {}),
        ...(address !== undefined ? { [DELEGATION_ADDRESS_KEY]: address } : {}),
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

/** An operator delay as a BIP 68 sequence: below 512 it counts blocks, else seconds. */
function delaySequence(delay: bigint): number {
    return Number(timelockToSequence({ value: delay, type: delay < 512n ? "blocks" : "seconds" }));
}

export interface IExecutorManager {
    getInfo(): Promise<ExecutorInfo>;
    /** The default template ids; throws unless the service lists them as active. */
    defaultTemplates(): Promise<Record<ExecutorDefault, string>>;
    /** Watch the renewal address of this wallet's key, and make the wallet watch it too. */
    registerRenewal(
        params: DelegationOptions,
        options?: { expiresAt?: number },
    ): Promise<ExecutorWatchRegistration>;
    /**
     * Watch the boarding address of this wallet's key: the Executor boards every deposit there
     * into the wallet's renewal contract, a virtual output the wallet spends and renews as its
     * own. The wallet watches both contracts. Without `expiresAt` the watch does not expire;
     * registering again returns the existing watch unchanged.
     */
    registerBoarding(
        params: DelegationOptions,
        options?: { expiresAt?: number },
    ): Promise<ExecutorWatchRegistration>;
}

/** Client-side watch registration with the Executor. */
export class ExecutorManagerImpl implements IExecutorManager {
    constructor(
        readonly executorProvider: ExecutorProvider,
        readonly wallet: DelegatedWallet,
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
                `Executor does not list the default templates ${missing.map(([n, id]) => `${n} ${id}`).join(", ")}`,
            );
        }
        return ids;
    }

    registerRenewal(
        params: DelegationOptions,
        options: { expiresAt?: number } = {},
    ): Promise<ExecutorWatchRegistration> {
        return this.register("renewal", params, options);
    }

    registerBoarding(
        params: DelegationOptions,
        options: { expiresAt?: number } = {},
    ): Promise<ExecutorWatchRegistration> {
        return this.register("boarding", params, options);
    }

    private async register(
        kind: ExecutorDefault,
        options: DelegationOptions,
        { expiresAt }: { expiresAt?: number },
    ): Promise<ExecutorWatchRegistration> {
        const [info, operator, address, owner] = await Promise.all([
            this.executorProvider.getInfo(),
            this.wallet.getOperatorInfo({ requireLive: true }),
            this.wallet.getAddress(),
            this.wallet.identity.compressedPublicKey(),
        ]);
        if (info.network !== operator.network) {
            throw new Error(
                `Executor runs on ${info.network}, the wallet's operator on ${operator.network}`,
            );
        }
        // the watch address commits to the service's operator key, so it must be the wallet's
        const { hrp, serverPubKey } = ArkAddress.decode(address);
        const server = hex.encode(serverPubKey);
        if (info.serverPubkey.slice(2).toLowerCase() !== server) {
            throw new Error(
                `Executor's operator key ${info.serverPubkey} is not the wallet's operator ${server}`,
            );
        }
        const params: DelegationParams = {
            renewalWindow: options.renewalWindow,
            maxFee: options.maxFee,
            exitDelay: options.exitDelay ?? delaySequence(operator.unilateralExitDelay),
            ...(kind === "boarding"
                ? {
                      boardingExitDelay:
                          options.boardingExitDelay ?? delaySequence(operator.boardingExitDelay),
                  }
                : {}),
        };
        const keys: ExecutorContractKeys = {
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
                ? script.onchainAddress(getNetwork(operator.network as NetworkName))
                : script.address(hrp, serverPubKey).encode();
        const templateId = DEFAULT_TEMPLATE_IDS[kind];
        // Registration is idempotent on the service: repeating it returns the existing watch.
        const delegation = await this.executorProvider.registerDelegation(templateId, variables, {
            expiresAt,
        });
        // The service fills <COSIGNER_KEY> with its key: the same address proves it is GetInfo's,
        // and commits to the same tapscripts. Checked before anything is persisted.
        if (delegation.address !== watchAddress) {
            throw new Error(
                `Executor derived a different address: expected ${watchAddress}, got ${delegation.address}`,
            );
        }
        const registered: ExecutorWatchMetadata = {
            template: kind,
            status: delegation.status,
            expiresAt: delegation.expiresAt,
            address: delegation.address,
        };
        const contracts = await watchExecutorContracts(this.wallet, keys, params, registered);
        // The row may predate this registration (the service is idempotent, the repository is
        // not): make it carry what the service just said, ended or not, so an ended watch stops
        // being advertised.
        const row = contracts.find((c) => c.params.template === kind);
        if (row) {
            const manager = await this.wallet.getContractManager();
            await manager.updateContract(row.script, {
                metadata: statusMetadata(
                    row.metadata ?? {},
                    delegation.status,
                    delegation.expiresAt,
                    delegation.address,
                ),
            });
        }
        if (delegation.status !== "active") {
            throw new Error(`Executor watch ${delegation.address} is ${delegation.status}`);
        }
        return { address: watchAddress, templateId, variables, keys, delegation };
    }
}
