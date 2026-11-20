import { hex } from "@scure/base";
import { equalBytes } from "@scure/btc-signer/utils.js";
import type { IWallet } from ".";
import type {
    ExecutorContractKeys,
    ExecutorDelegation,
    ExecutorInfo,
    ExecutorProvider,
} from "../providers/executor";
import type { Contract } from "../contracts/types";
import type { ContractFilter } from "../repositories/contractRepository";
import { ExecutorContractHandler } from "../contracts/handlers/executor";
import { deriveDescriptorLeafPubKey, identityDescriptor } from "../identity/descriptor";
import { networkFromOperatorInfo, resolveEmulatorPubkey } from "../networks";
import { ArkAddress } from "../script/address";
import {
    DEFAULT_TEMPLATE_IDS,
    type ExecutorDefault,
    type DelegationParams,
    defaultVariables,
} from "../script/executor/executorTemplate";
import { timeoutSignal } from "../utils/fetch";
import { timelockToSequence } from "../utils/timelock";
import { newestWalletReceiveContract } from "./walletReceiveRotator";
import { toXOnlySignerHex } from "./signerRotation";

/** Bounds a registration: a write has no `fetch` deadline of its own. */
export const REGISTRATION_TIMEOUT_MS = 30_000;

/** Metadata key: the service's status of a delegated watch. */
export const DELEGATION_STATUS_KEY = "delegationStatus";
/** Metadata key: the watch's expiry, in unix seconds; 0 or absent when it has none. */
export const DELEGATION_EXPIRES_KEY = "delegationExpiresAt";
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
}

/** A watch both sides derived: the address to fund and what restores it. */
export interface ExecutorWatchRegistration {
    /** The delegated boarding address, onchain. */
    address: string;
    templateId: string;
    /** The template's variables, canonical hex. */
    variables: Record<string, string>;
    /** The Executor's keys the wallet's delegated contracts are derived from. */
    keys: ExecutorContractKeys;
    /** The parameters the contracts were derived from, exit delays resolved. */
    params: DelegationParams;
    delegation: ExecutorDelegation;
}

/**
 * The parameters a caller chooses. The exit delays default to the operator's, as BIP 68
 * sequences.
 */
export type DelegationOptions = Pick<DelegationParams, "renewalWindow" | "maxFee"> &
    Partial<Pick<DelegationParams, "exitDelay" | "boardingExitDelay">>;

export interface RegistrationOptions {
    /** The watch's expiry, in unix seconds. */
    expiresAt?: number;
    /**
     * The emulator key to accept in place of the network's pinned one, for a private emulator or
     * a network with none. Its holder, with the operator, can move the delegated coins.
     */
    emulatorPubkey?: string;
}

/** What the manager needs of a wallet: its key, its operator and its contracts. */
export type DelegatedWallet = Pick<
    IWallet,
    "identity" | "getAddress" | "getContractManager" | "getOperatorInfo"
>;

export interface DelegatedContractWatch {
    contract: Contract;
    owner: string;
    script: ReturnType<typeof ExecutorContractHandler.createScript>;
    signer: string;
    live: boolean;
}

/** A read of the wallet's contract rows: repositories, never the manager's indexer sync. */
export type ContractReader = (filter?: ContractFilter) => Promise<Contract[]>;

/**
 * The wallet-owned Executor watches of one template, newest first. A watch is the wallet's when
 * its owner is the identity key, or one the row's `signingDescriptor` derives; it is live while
 * the service reported it active and it has not expired.
 */
export async function delegatedContracts(
    identity: Pick<IWallet["identity"], "xOnlyPublicKey">,
    getContracts: ContractReader,
    template: ExecutorDefault,
): Promise<DelegatedContractWatch[]> {
    const identityKey = hex.encode(await identity.xOnlyPublicKey());
    const now = Math.floor(Date.now() / 1000);
    const rows = (await getContracts({ type: ["executor"] }))
        .filter((c) => c.params.template === template)
        .sort((a, b) => b.createdAt - a.createdAt);
    const watches: DelegatedContractWatch[] = [];
    for (const contract of rows) {
        try {
            const owner = contract.params.owner?.slice(2).toLowerCase();
            const descriptor = contract.metadata?.signingDescriptor;
            const held =
                owner === identityKey ||
                (typeof descriptor === "string" &&
                    hex.encode(deriveDescriptorLeafPubKey(descriptor)) === owner);
            if (!held || owner === undefined) continue;
            const script = ExecutorContractHandler.createScript(contract.params);
            if (hex.encode(script.pkScript) !== contract.script) continue;
            const expiresAt = contract.metadata?.[DELEGATION_EXPIRES_KEY];
            watches.push({
                contract,
                owner,
                script,
                signer: toXOnlySignerHex(contract.params.serverPubKey),
                live:
                    contract.metadata?.[DELEGATION_STATUS_KEY] === "active" &&
                    !(typeof expiresAt === "number" && expiresAt > 0 && expiresAt <= now),
            });
        } catch (e) {
            console.warn("Skipping malformed delegated contract", contract.script, e);
        }
    }
    return watches;
}

/**
 * Make the wallet's contract manager watch, as its own, the renewal contract of its key and, when
 * params has a boarding exit delay, its boarding contract: derived locally from the key, the
 * params and the service's keys, so a restored wallet finds its delegated coins without asking
 * the service. Idempotent.
 *
 * `descriptor` names the owner key, the identity's by default. Called before `restore()`, it
 * also lets an HD wallet find the watches of its rotated keys.
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
    descriptor?: string,
): Promise<Contract[]> {
    const [owner, address, manager] = await Promise.all([
        descriptor === undefined
            ? wallet.identity.compressedPublicKey()
            : ownerKey(wallet.identity, descriptor),
        wallet.getAddress(),
        wallet.getContractManager(),
    ]);
    // the identity's key needs no descriptor to sign
    const signing =
        descriptor === undefined ||
        equalBytes(owner.subarray(1), await wallet.identity.xOnlyPublicKey())
            ? undefined
            : descriptor;
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
                // boarding deposits are onchain coins, stored by the onchain sync
                scope: template === "boarding" ? "onchain" : "offchain",
                label: template === "renewal" ? "Delegated renewal" : "Delegated boarding",
                metadata: metadataFor(template, registered, signing),
            }),
        );
    }
    return contracts;
}

function metadataFor(
    template: ExecutorDefault,
    registered: ExecutorWatchMetadata | undefined,
    signingDescriptor: string | undefined,
): Record<string, string | number> | undefined {
    const signing: Record<string, string> =
        signingDescriptor === undefined ? {} : { signingDescriptor };
    if (registered === undefined) {
        return signingDescriptor === undefined ? undefined : signing;
    }
    if (registered.template !== template) {
        return { ...signing, [DELEGATION_STATUS_KEY]: DELEGATION_LOCAL_STATUS };
    }
    return statusMetadata(signing, registered.status, registered.expiresAt);
}

/**
 * The compressed owner key of `descriptor`. The identity's keeps its own parity, so its rows and
 * the service's registration stay the ones made before descriptors; the scripts take the x-only
 * key, so any other parity derives the same address.
 */
export async function ownerKey(
    identity: Pick<IWallet["identity"], "compressedPublicKey">,
    descriptor: string,
): Promise<Uint8Array> {
    const xOnly = deriveDescriptorLeafPubKey(descriptor);
    const own = await identity.compressedPublicKey();
    if (equalBytes(own.subarray(1), xOnly)) return own;
    const key = new Uint8Array(33);
    key[0] = 2;
    key.set(xOnly, 1);
    return key;
}

/**
 * The descriptor of the displayed boarding address: the newest one the wallet rotated to, as
 * boot resolves it, else the identity's.
 */
async function boardingDescriptor(
    wallet: Pick<IWallet, "identity" | "getContractManager">,
    serverPubKey: string,
): Promise<string> {
    const manager = await wallet.getContractManager();
    const rows = await manager.getContracts({ type: "boarding", state: "active" });
    const descriptor = newestWalletReceiveContract(rows, serverPubKey)?.metadata?.signingDescriptor;
    return typeof descriptor === "string" ? descriptor : identityDescriptor(wallet.identity);
}

/**
 * The key a held watch's row is registered under: its row's descriptor, else the identity's —
 * a held row without one is the identity key's.
 */
function watchDescriptor(
    watch: DelegatedContractWatch,
    identity: Pick<IWallet["identity"], "xOnlyPublicKey">,
): Promise<string> {
    const descriptor = watch.contract.metadata?.signingDescriptor;
    return typeof descriptor === "string"
        ? Promise.resolve(descriptor)
        : identityDescriptor(identity);
}

/** `updateContract` replaces metadata, so the previous expiry must not outlive a status without one. */
function statusMetadata(
    metadata: Record<string, unknown>,
    status: string,
    expiresAt: number | undefined,
): Record<string, string | number> {
    const { [DELEGATION_EXPIRES_KEY]: _stale, ...rest } = metadata;
    return {
        ...(rest as Record<string, string | number>),
        [DELEGATION_STATUS_KEY]: status,
        ...(expiresAt !== undefined ? { [DELEGATION_EXPIRES_KEY]: expiresAt } : {}),
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

/**
 * Registers Executor watches. Renewal keeps renewal-contract coins alive while the wallet is
 * offline; boarding moves onchain deposits into the corresponding renewal contract.
 */
export interface IExecutorManager {
    getInfo(): Promise<ExecutorInfo>;
    /** The default template ids; throws unless the service lists them as active. */
    defaultTemplates(): Promise<Record<ExecutorDefault, string>>;
    /**
     * Watch the displayed boarding address's key: the Executor boards every deposit there
     * into the wallet's renewal contract, a virtual output the wallet spends and renews as its
     * own. The wallet watches both contracts. Without `expiresAt` the watch does not expire;
     * registering again returns the existing watch unchanged. An HD wallet registers a new watch
     * each time it rotates the boarding address.
     *
     * The address derives from the key, `params`, the operator's exit delays when `params` omits
     * them, and the Executor's keys: registering again on a restored wallet finds the same watch
     * only while none of them changed. The returned `keys` and `params` restore it regardless,
     * through {@link watchExecutorContracts}.
     */
    registerBoarding(
        params: DelegationOptions,
        options?: RegistrationOptions,
    ): Promise<ExecutorWatchRegistration>;
    /**
     * Register the renewal watch, with the same params as {@link registerBoarding} (a key whose
     * rows were registered with other params is refused) and like it idempotent, so apps call it
     * at startup. It covers every key that holds a live boarding watch under the current
     * operator: the displayed boarding key first, whose registration is returned, then each
     * earlier rotated key that still has one. Every key is tried before a failure is thrown, and
     * the error names the keys that failed, so a retry covers the rest.
     *
     * Until the wallet's address becomes its renewal contract, coins received at `getAddress()`,
     * a send's change and the fallback renewals are not covered: they land at the wallet's own
     * address, which the wallet renews itself.
     */
    registerRenewal(
        params: DelegationOptions,
        options?: RegistrationOptions,
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

    registerBoarding(
        options: DelegationOptions,
        registration?: RegistrationOptions,
    ): Promise<ExecutorWatchRegistration> {
        return this.registerBoardingAt(undefined, options, registration);
    }

    async registerRenewal(
        options: DelegationOptions,
        registration?: RegistrationOptions,
    ): Promise<ExecutorWatchRegistration> {
        const first = await this.registerAt(undefined, options, registration, "renewal");
        const server = hex.encode(ArkAddress.decode(await this.wallet.getAddress()).serverPubKey);
        const displayed = hex.encode(
            (
                await ownerKey(this.wallet.identity, await boardingDescriptor(this.wallet, server))
            ).subarray(1),
        );
        const reader: ContractReader = async (filter) =>
            (await this.wallet.getContractManager()).getContracts(filter);
        const held = await delegatedContracts(this.wallet.identity, reader, "boarding");
        const failed: string[] = [];
        for (const watch of held) {
            // the displayed key's watch is `first`'s registration
            if (!watch.live || watch.signer !== server || watch.owner === displayed) continue;
            try {
                await this.registerAt(
                    await watchDescriptor(watch, this.wallet.identity),
                    options,
                    registration,
                    "renewal",
                );
            } catch (e) {
                console.warn(`Renewal watch for the held key ${watch.owner} failed`, e);
                failed.push(watch.owner);
            }
        }
        if (failed.length > 0) {
            throw new Error(
                `Executor renewal registration failed for the keys ${failed.join(", ")}`,
            );
        }
        return first;
    }

    /** @internal {@link registerBoarding} for `descriptor`'s key; the displayed one by default. */
    async registerBoardingAt(
        descriptor: string | undefined,
        options: DelegationOptions,
        registration: RegistrationOptions = {},
    ): Promise<ExecutorWatchRegistration> {
        return this.registerAt(descriptor, options, registration, "boarding");
    }

    /** @internal Register the renewal watch for `descriptor`'s key. */
    async registerRenewalAt(
        descriptor: string | undefined,
        options: DelegationOptions,
        registration?: RegistrationOptions,
    ): Promise<ExecutorWatchRegistration> {
        return this.registerAt(descriptor, options, registration, "renewal");
    }

    private async registerAt(
        descriptor: string | undefined,
        options: DelegationOptions,
        { expiresAt, emulatorPubkey }: RegistrationOptions = {},
        template: ExecutorDefault,
    ): Promise<ExecutorWatchRegistration> {
        const [info, operator] = await Promise.all([
            this.executorProvider.getInfo(),
            this.wallet.getOperatorInfo({ requireLive: true }),
        ]);
        if (info.network !== operator.network) {
            throw new Error(
                `Executor runs on ${info.network}, the wallet's operator on ${operator.network}`,
            );
        }
        // the watch address commits to the service's operator key, so it must be the wallet's
        const { hrp, serverPubKey } = ArkAddress.decode(await this.wallet.getAddress());
        const server = hex.encode(serverPubKey);
        if (info.serverPubkey.slice(2).toLowerCase() !== server) {
            throw new Error(
                `Executor's operator key ${info.serverPubkey} is not the wallet's operator ${server}`,
            );
        }
        const network = networkFromOperatorInfo(operator);
        // Pinned, as in Arkade.connect: holding the emulator key, the Executor could sign the
        // emulator-enforced leaf itself, past its covenant. Matching addresses cannot show it.
        const emulator = resolveEmulatorPubkey(network, emulatorPubkey);
        if (info.emulatorPubkey.toLowerCase() !== emulator) {
            throw new Error(
                `Executor's emulator key ${info.emulatorPubkey} is not the trusted ${emulator}`,
            );
        }
        // A window as long as the coin's life makes every renewed coin due again at once, each
        // round paying up to maxFee. Block-typed expiries (regtest only) have no fixed duration.
        const lifetime = operator.vtxoTreeExpiry;
        if (lifetime !== undefined && lifetime >= 512n && options.renewalWindow >= lifetime) {
            throw new Error(
                `renewalWindow ${options.renewalWindow}s must be shorter than the operator's VTXO expiry of ${lifetime}s`,
            );
        }
        // Both templates register the displayed boarding key's: boarding moves its deposits in,
        // renewal keeps the renewal contract that receives them alive. boardingDescriptor falls
        // back to the identity's, so a static wallet registers its identity key, as before.
        descriptor ??= await boardingDescriptor(this.wallet, server);
        const owner = await ownerKey(this.wallet.identity, descriptor);
        const params: DelegationParams = {
            renewalWindow: options.renewalWindow,
            maxFee: options.maxFee,
            exitDelay: options.exitDelay ?? delaySequence(operator.unilateralExitDelay),
            ...(template === "boarding"
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
        const existing = await (await this.wallet.getContractManager()).getContracts({
            type: ["executor"],
        });
        const ownerHex = hex.encode(owner.subarray(1));
        const mismatches = new Set<string>();
        for (const row of existing) {
            if (
                row.params.owner?.slice(2).toLowerCase() !== ownerHex ||
                row.params.serverPubKey?.toLowerCase() !== info.serverPubkey.toLowerCase()
            ) {
                continue;
            }
            for (const name of ["renewalWindow", "maxFee", "exitDelay"] as const) {
                if (row.params[name] !== String(params[name])) mismatches.add(name);
            }
            if (template === "boarding" && row.params.template === "boarding") {
                if (row.params.boardingExitDelay !== String(params.boardingExitDelay)) {
                    mismatches.add("boardingExitDelay");
                }
            }
        }
        if (mismatches.size > 0) {
            throw new Error(
                `Executor registration parameters differ: ${[...mismatches].join(", ")}`,
            );
        }
        const variables = defaultVariables(template, owner, params);
        const watchScript = ExecutorContractHandler.createScript(
            contractParams(template, owner, keys, params),
        );
        const watchAddress =
            template === "boarding"
                ? watchScript.onchainAddress(network)
                : watchScript.address(hrp, serverPubKey).encode();
        const templateId = DEFAULT_TEMPLATE_IDS[template];
        // Idempotent on the service (repeating returns the existing watch), so a call aborted
        // with its outcome unknown is safe to repeat.
        const delegation = await this.executorProvider.registerDelegation(templateId, variables, {
            expiresAt,
            signal: timeoutSignal(REGISTRATION_TIMEOUT_MS),
        });
        // The service fills <COSIGNER_KEY> with its key: the same address proves it is GetInfo's,
        // and commits to the same tapscripts. Checked before anything is persisted.
        const [input] = delegation.inputs;
        if (
            delegation.inputs.length !== 1 ||
            !input ||
            (template === "boarding" ? !input.onchain : input.onchain)
        ) {
            throw new Error(
                `Executor's ${template} delegation has ${delegation.inputs.length} inputs, expected one ${template === "boarding" ? "onchain" : "offchain"} input`,
            );
        }
        if (input.address !== watchAddress) {
            throw new Error(
                `Executor derived a different address: expected ${watchAddress}, got ${input.address}`,
            );
        }
        const registered: ExecutorWatchMetadata = {
            template,
            status: delegation.status,
            expiresAt: delegation.expiresAt,
        };
        const contracts = await watchExecutorContracts(
            this.wallet,
            keys,
            params,
            registered,
            descriptor,
        );
        // The row may predate this registration (the service is idempotent, the repository is
        // not): make it carry what the service just said, ended or not, so an ended watch stops
        // being advertised.
        const row = contracts.find((c) => c.params.template === template);
        if (row) {
            const manager = await this.wallet.getContractManager();
            await manager.updateContract(row.script, {
                metadata: statusMetadata(
                    row.metadata ?? {},
                    delegation.status,
                    delegation.expiresAt,
                ),
            });
        }
        if (delegation.status !== "active") {
            throw new Error(`Executor watch ${watchAddress} is ${delegation.status}`);
        }
        return { address: watchAddress, templateId, variables, keys, params, delegation };
    }
}
