import { hex } from "@scure/base";
import { equalBytes } from "@scure/btc-signer/utils.js";
import type { IWallet } from ".";
import {
    ExecutorRequestError,
    type ExecutorContractKeys,
    type ExecutorDelegation,
    type ExecutorInfo,
    type ExecutorProvider,
} from "../providers/executor";
import type { Contract } from "../contracts/types";
import type { ContractFilter } from "../repositories/contractRepository";
import {
    evenOwnerKey,
    ExecutorContractHandler,
    executorContractParams,
    executorKeysOf,
} from "../contracts/handlers/executor";
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
import { isVtxoSpent } from "./vtxo";

/**
 * Bounds a registration or a refresh's status read, neither with a `fetch` deadline of its own;
 * the local setup after the service answers is not covered.
 */
export const EXECUTOR_REQUEST_TIMEOUT_MS = 30_000;

/** Metadata key: the service's status of a delegated watch. */
export const DELEGATION_STATUS_KEY = "delegationStatus";
/** Metadata key: the watch's expiry, in unix seconds; 0 or absent when it has none. */
export const DELEGATION_EXPIRES_KEY = "delegationExpiresAt";
/** Metadata key: when the watch was last registered, in unix milliseconds. */
export const DELEGATION_REGISTERED_KEY = "delegationRegisteredAt";
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
    /** The delegated address: onchain for boarding, an Arkade address for renewal. */
    address: string;
    templateId: string;
    /** The template's variables, canonical hex. */
    variables: Record<string, string>;
    /** The executor's keys the wallet's delegated contracts are derived from. */
    keys: ExecutorContractKeys;
    /** The parameters the contracts were derived from, exit delays resolved. */
    params: DelegationParams;
    /** The service's answer; absent when the stored watch answered and the service was not asked. */
    delegation?: ExecutorDelegation;
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

/**
 * What the manager needs of a wallet: its key, its operator and its contracts. Its hrp and
 * operator key come from `getOwnAddress()`: `getAddress()` reads the rows a registration is about
 * to write. A wallet without it answers from `getAddress()`.
 */
export type DelegatedWallet = Pick<
    IWallet,
    "identity" | "getAddress" | "getOwnAddress" | "getContractManager" | "getOperatorInfo"
> & {
    /** The displayed receive tapscript, whose key a refresh keeps alive. */
    readonly offchainTapscript?: { readonly options: { readonly pubKey: Uint8Array } };
};

async function ownAddress(wallet: Pick<DelegatedWallet, "getOwnAddress" | "getAddress">) {
    return ArkAddress.decode(await (wallet.getOwnAddress?.() ?? wallet.getAddress()));
}

export interface DelegatedContractWatch {
    contract: Contract;
    owner: string;
    script: ReturnType<typeof ExecutorContractHandler.createScript>;
    signer: string;
    live: boolean;
}

/** A read of the wallet's contract rows: repositories, never the manager's indexer sync. */
export type ContractReader = (filter?: ContractFilter) => Promise<Contract[]>;

// Building a script takes milliseconds and every poll reads all watches, rotated-off keys included.
// Capped first-in first-out: it spans every wallet in the process, and an HD wallet adds a row per
// receipt.
const SCRIPT_CACHE_LIMIT = 512;
const scriptCache = new Map<string, DelegatedContractWatch["script"]>();

function cachedScript(params: Record<string, string>): DelegatedContractWatch["script"] {
    const key = JSON.stringify(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1)));
    let script = scriptCache.get(key);
    if (!script) {
        script = ExecutorContractHandler.createScript(params);
        if (scriptCache.size >= SCRIPT_CACHE_LIMIT) {
            scriptCache.delete(scriptCache.keys().next().value!);
        }
        scriptCache.set(key, script);
    }
    return script;
}

/** Rows that predate the registration time, or were restored, order by when they were created. */
function registeredAt(contract: Contract): number {
    const at = contract.metadata?.[DELEGATION_REGISTERED_KEY];
    return typeof at === "number" ? at : contract.createdAt;
}

/**
 * The wallet-owned executor watches of one template, most recently registered first. A watch is
 * the wallet's when its owner is the identity key, or one the row's `signingDescriptor` derives;
 * it is live while the service reported it active and it has not expired.
 */
export async function delegatedContracts(
    identity: Pick<IWallet["identity"], "xOnlyPublicKey">,
    getContracts: ContractReader,
    template: ExecutorDefault,
): Promise<DelegatedContractWatch[]> {
    const rows = (await getContracts({ type: ["executor"] }))
        .filter((c) => c.params.template === template)
        .sort((a, b) => registeredAt(b) - registeredAt(a));
    // Before the identity read, which can be a round trip for a remote signer.
    if (rows.length === 0) return [];
    const identityKey = hex.encode(await identity.xOnlyPublicKey());
    const now = Math.floor(Date.now() / 1000);
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
            const watch = watchOf(contract, owner, now);
            if (watch) watches.push(watch);
        } catch (e) {
            console.warn("Skipping malformed delegated contract", contract.script, e);
        }
    }
    return watches;
}

/** `contract` as a watch of `owner`, or undefined when its script is not the one its params derive. */
function watchOf(
    contract: Contract,
    owner: string,
    now: number,
): DelegatedContractWatch | undefined {
    const script = cachedScript(contract.params);
    if (hex.encode(script.pkScript) !== contract.script) return undefined;
    const expiresAt = contract.metadata?.[DELEGATION_EXPIRES_KEY];
    return {
        contract,
        owner,
        script,
        signer: toXOnlySignerHex(contract.params.serverPubKey),
        live:
            contract.metadata?.[DELEGATION_STATUS_KEY] === "active" &&
            !(typeof expiresAt === "number" && expiresAt > 0 && expiresAt <= now),
    };
}

// Capped like the script cache: it spans every wallet in the process.
const warnedStatusless = new Set<string>();

/**
 * The delegated twin of a receive key: its renewal watch under `signer` while the service holds
 * it, the most recently registered when there are several. Both keys are x-only hex.
 *
 * Takes no identity: a watch is the key's own when its owner is the key. Rows are filtered by
 * owner before any script is built, so keys the wallet rotated off cost nothing. Read on every
 * call, as the page and the service worker both write rows.
 */
export async function receiveTwin(
    getContracts: ContractReader,
    owner: string,
    signer: string,
): Promise<DelegatedContractWatch | undefined> {
    const rows = (await getContracts({ type: ["executor"] }))
        .filter(
            (c) =>
                c.params.template === "renewal" &&
                c.params.owner?.slice(2).toLowerCase() === owner &&
                c.params.serverPubKey !== undefined &&
                toXOnlySignerHex(c.params.serverPubKey) === signer,
        )
        .sort((a, b) => registeredAt(b) - registeredAt(a));
    const now = Math.floor(Date.now() / 1000);
    for (const contract of rows) {
        const watch = watchOf(contract, owner, now);
        if (watch?.live) return watch;
        if (contract.metadata?.[DELEGATION_STATUS_KEY] === undefined) warnStatusless(contract);
    }
    return undefined;
}

/** A restored watch has no status, so the wallet cannot tell the service still holds it. */
function warnStatusless(contract: Contract): void {
    if (warnedStatusless.has(contract.script)) return;
    if (warnedStatusless.size >= SCRIPT_CACHE_LIMIT) {
        warnedStatusless.delete(warnedStatusless.values().next().value!);
    }
    warnedStatusless.add(contract.script);
    console.warn(
        `executor renewal watch ${contract.address} has no delegation status, as after a restore: the wallet shows its own address until registerRenewal() confirms it`,
    );
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
    wallet: Pick<
        DelegatedWallet,
        "identity" | "getAddress" | "getOwnAddress" | "getContractManager"
    >,
    keys: ExecutorContractKeys,
    params: DelegationParams,
    registered?: ExecutorWatchMetadata,
    descriptor?: string,
): Promise<Contract[]> {
    const [owner, { hrp, serverPubKey }, manager] = await Promise.all([
        descriptor === undefined
            ? wallet.identity.compressedPublicKey()
            : ownerKey(wallet.identity, descriptor),
        ownAddress(wallet),
        wallet.getContractManager(),
    ]);
    // the identity's key needs no descriptor to sign
    const signing =
        descriptor === undefined ||
        equalBytes(owner.subarray(1), await wallet.identity.xOnlyPublicKey())
            ? undefined
            : descriptor;
    const templates: ExecutorDefault[] =
        params.boardingExitDelay === undefined ? ["renewal"] : ["renewal", "boarding"];
    const contracts: Contract[] = [];
    for (const template of templates) {
        const serialized = executorContractParams(template, owner, keys, params);
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
    return equalBytes(own.subarray(1), xOnly) ? own : evenOwnerKey(xOnly);
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
    registeredAtMs: number = Date.now(),
): Record<string, string | number> {
    const { [DELEGATION_EXPIRES_KEY]: _stale, ...rest } = metadata;
    return {
        ...(rest as Record<string, string | number>),
        [DELEGATION_STATUS_KEY]: status,
        [DELEGATION_REGISTERED_KEY]: registeredAtMs,
        ...(expiresAt !== undefined ? { [DELEGATION_EXPIRES_KEY]: expiresAt } : {}),
    };
}

/**
 * What registering `watch` again takes: its own params and expiry, and its own emulator key,
 * checked against the pin or approved when first registered, so registering refuses an executor
 * that no longer holds it.
 */
export function reRegistrationOf(watch: DelegatedContractWatch): {
    options: DelegationOptions;
    registration: RegistrationOptions;
} {
    const p = ExecutorContractHandler.deserializeParams(watch.contract.params);
    const expiresAt = watch.contract.metadata?.[DELEGATION_EXPIRES_KEY];
    return {
        options: {
            renewalWindow: p.renewalWindow,
            maxFee: p.maxFee,
            exitDelay: p.exitDelay,
            boardingExitDelay: p.boardingExitDelay,
        },
        registration: {
            expiresAt: typeof expiresAt === "number" && expiresAt > 0 ? expiresAt : undefined,
            emulatorPubkey: hex.encode(p.emulatorPubKey),
        },
    };
}

/** Whether two watches register with the same options and emulator key, whatever their owners. */
export function sameDelegation(a: DelegatedContractWatch, b: DelegatedContractWatch): boolean {
    const p = ExecutorContractHandler.deserializeParams(a.contract.params);
    const q = ExecutorContractHandler.deserializeParams(b.contract.params);
    return (
        p.renewalWindow === q.renewalWindow &&
        p.maxFee === q.maxFee &&
        p.exitDelay === q.exitDelay &&
        p.boardingExitDelay === q.boardingExitDelay &&
        equalBytes(p.emulatorPubKey, q.emulatorPubKey)
    );
}

/** The script of `owner`'s renewal contract under `keys` and `params`. */
function renewalScript(
    owner: Uint8Array,
    keys: ExecutorContractKeys,
    params: DelegationParams,
): string {
    const script = ExecutorContractHandler.createScript(
        executorContractParams("renewal", owner, keys, params),
    );
    return hex.encode(script.pkScript);
}

/**
 * The wallet steps in at half the window (vtxo-manager's deferToExecutor), which must leave a
 * 60s settlement poll plus a batch round of about 30s; a shorter window is swept before it acts.
 */
const MIN_RENEWAL_WINDOW = 180;

/**
 * Why a window is unusable, if it is. One as long as the coin's life makes every renewed coin due
 * again at once, each round paying up to maxFee. Block-typed expiries (regtest only) have no
 * fixed duration.
 */
function renewalWindowFault(
    renewalWindow: number,
    lifetime: bigint | undefined,
): string | undefined {
    if (!(renewalWindow >= MIN_RENEWAL_WINDOW)) return `must be at least ${MIN_RENEWAL_WINDOW}s`;
    if (lifetime !== undefined && lifetime >= 512n && renewalWindow >= lifetime) {
        return `must be shorter than the operator's VTXO expiry of ${lifetime}s`;
    }
    return undefined;
}

/** An operator delay as a BIP 68 sequence: below 512 it counts blocks, else seconds. */
function delaySequence(delay: bigint): number {
    return Number(timelockToSequence({ value: delay, type: delay < 512n ? "blocks" : "seconds" }));
}

/** `options` with the exit delays it leaves out set to the operator's. */
function resolveParams(
    options: DelegationOptions,
    operator: Pick<RegistrationContext["operator"], "unilateralExitDelay" | "boardingExitDelay">,
    template: ExecutorDefault,
): DelegationParams {
    return {
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
}

/**
 * Registers executor watches. Renewal keeps renewal-contract coins alive while the wallet is
 * offline; boarding moves onchain deposits into the corresponding renewal contract.
 */
export interface IExecutorManager {
    getInfo(): Promise<ExecutorInfo>;
    /** The default template ids; throws unless the service lists them as active. */
    defaultTemplates(): Promise<Record<ExecutorDefault, string>>;
    /**
     * Watch the displayed boarding address's key: the executor boards every deposit there
     * into the wallet's renewal contract, a virtual output the wallet spends and renews as its
     * own. The wallet watches both contracts. Without `expiresAt` the watch has no deadline of
     * its own, but the executor expires one that never receives a coin after an idle window: the
     * wallet registers it again while it is online. Registering again returns the existing watch
     * unchanged, from the stored row when it is the key's newest live watch under the same params:
     * the executor is not asked, and `delegation` is absent. An HD wallet registers a new watch
     * each time it rotates the boarding address.
     *
     * The address derives from the key, `params`, the operator's exit delays when `params` omits
     * them, and the executor's keys: registering again on a restored wallet finds the same watch
     * only while none of them changed. The returned `keys` and `params` restore it regardless,
     * through {@link watchExecutorContracts}.
     *
     * Params may change between calls: the new ones register a new watch, and the earlier watches
     * stay live and keep boarding the deposits already sent to them. The boarding address follows
     * the most recently registered watch, so registering older params again moves it back.
     *
     * A boarding watch pays into the renewal contract of its own params. While renewal is on, that
     * is, while the wallet has any live renewal watch under the current operator, this also
     * registers renewal under `params` and `options`, unless that contract already has one. That registration is best-effort: a failure is logged and never
     * undoes the boarding watch. {@link registerRenewal} retries it.
     */
    registerBoarding(
        params: DelegationOptions,
        options?: RegistrationOptions,
    ): Promise<ExecutorWatchRegistration>;
    /**
     * Register the renewal watch, like {@link registerBoarding} idempotent, so apps call it at
     * startup. `params` is the displayed boarding key's: that registration comes first, is
     * returned, and its failure throws at once, before any other key is tried.
     *
     * It then covers every live boarding watch under the current operator, each under its own
     * params, which is where its coins sit: the displayed key's earlier watches, and each earlier
     * rotated key's. A key whose renewal watch is already live, as stored, is not asked again.
     * A watch under another emulator key than the executor's, or with a window under 180s or not
     * shorter than the operator's VTXO expiry, cannot be registered: it is skipped with a warning,
     * and the wallet renews its coins itself. The others are all tried before a failure is thrown,
     * and the error names the keys that failed, so a retry covers the rest.
     * `expiresAt` applies to every watch registered.
     *
     * This is the opt-in to receiving under delegation. While the displayed receive key's renewal
     * watch is live, `getAddress()` answers that contract, the key's delegated twin, so the
     * executor renews what lands there while the wallet is offline: payments, change, `settle()`
     * outputs, renewals and swap payouts and refunds all follow it. The wallet's own address
     * answers when there is no live twin. The address changes once, the first time a twin is live:
     * apps that store the output of `getAddress()` must not keep it. An HD wallet registers one
     * twin per receive key; an older twin stays live, so a payment to an address the wallet showed
     * earlier is still renewed. Look-ahead addresses and `getNewAddresses` are not delegated, and
     * are covered from the wallet's own first renewal of what lands there.
     *
     * The executor sees the amount and time of every receipt at a twin, and with an HD wallet it
     * can link the addresses of one wallet. It can delay a renewal, not spend.
     *
     * A send's change returns to the live renewal contract of its first delegated input, else goes
     * to `getAddress()`. The wallet's own renewals pay to `getAddress()`, unless the amount is
     * `maxFee + dust` or less. A renewal spending a coin at a live renewal contract pays to the
     * wallet's own address instead: the executor missed that coin, so paying it back repeats the
     * miss. A renewal of a coin that carries assets is the exception to both: `settle()` places
     * assets only at `getAddress()`, so it pays that address, whatever the amount and wherever the
     * coin sat. Under an executor that keeps failing, a coin alternates: one fallback renewal out,
     * one ordinary renewal back in.
     */
    registerRenewal(
        params: DelegationOptions,
        options?: RegistrationOptions,
    ): Promise<ExecutorWatchRegistration>;
}

/** What a public call reads once, however many keys it registers. */
interface RegistrationContext {
    info: ExecutorInfo;
    operator: Awaited<ReturnType<DelegatedWallet["getOperatorInfo"]>>;
    network: ReturnType<typeof networkFromOperatorInfo>;
    hrp: string;
    serverPubKey: Uint8Array;
    /** The wallet's operator key, x-only hex. */
    server: string;
}

/** Client-side watch registration with an executor. */
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
                `executor does not list the default templates ${missing.map(([n, id]) => `${n} ${id}`).join(", ")}`,
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
        registration: RegistrationOptions = {},
    ): Promise<ExecutorWatchRegistration> {
        // Resolved once: a rotation during the call must not change which key is the displayed one.
        const displayed = await this.displayedDescriptor();
        const context = this.lazyContext();
        const first =
            (await this.storedWatch(displayed, options, registration, "renewal")) ??
            (await this.registerAt(await context(), displayed, options, registration, "renewal"));
        const [server, { vtxoTreeExpiry }] = await Promise.all([
            this.operatorSigner(),
            this.wallet.getOperatorInfo(),
        ]);
        const registered = new Set([
            renewalScript(hex.decode(first.variables.owner), first.keys, first.params),
        ]);
        // A live one needs no registration: the refresh revives it if the service let it lapse.
        const live = new Set(
            (await this.heldWatches("renewal"))
                .filter((w) => w.live && w.signer === server)
                .map((w) => w.contract.script),
        );
        const failed = new Set<string>();
        for (const watch of await this.heldWatches("boarding")) {
            if (!watch.live || watch.signer !== server) continue;
            try {
                // Its coins sit in the contract its own params and keys derive.
                const p = ExecutorContractHandler.deserializeParams(watch.contract.params);
                const keys = executorKeysOf(p);
                // Never registrable, and a held boarding watch ends only once it lapses: failing
                // would repeat at every startup. The wallet renews the coins itself.
                if (keys.emulatorPubkey !== first.keys.emulatorPubkey.toLowerCase()) {
                    console.warn(
                        `Skipping the held key ${watch.owner}: its watch uses another emulator key than the executor's`,
                    );
                    continue;
                }
                const fault = renewalWindowFault(p.renewalWindow, vtxoTreeExpiry);
                if (fault) {
                    console.warn(
                        `Skipping the held key ${watch.owner}: its watch's renewalWindow ${p.renewalWindow}s ${fault}`,
                    );
                    continue;
                }
                const contract = renewalScript(p.owner, keys, p);
                if (registered.has(contract) || live.has(contract)) continue;
                registered.add(contract);
                await this.registerAt(
                    await context(),
                    await watchDescriptor(watch, this.wallet.identity),
                    reRegistrationOf(watch).options,
                    { expiresAt: registration.expiresAt, emulatorPubkey: keys.emulatorPubkey },
                    "renewal",
                );
            } catch (e) {
                console.warn(`Renewal watch for the held key ${watch.owner} failed`, e);
                failed.add(watch.owner);
            }
        }
        if (failed.size > 0) {
            throw new Error(
                `executor renewal registration failed for the keys ${[...failed].join(", ")}`,
            );
        }
        return first;
    }

    /** @internal The renewal watch of `descriptor`'s key alone, under the params of `options`. */
    async registerRenewalAt(
        descriptor: string,
        options: DelegationOptions,
        registration: RegistrationOptions = {},
    ): Promise<ExecutorWatchRegistration> {
        const context = this.lazyContext();
        return (
            (await this.storedWatch(descriptor, options, registration, "renewal")) ??
            (await this.registerAt(await context(), descriptor, options, registration, "renewal"))
        );
    }

    /** @internal {@link registerBoarding} for `descriptor`'s key; the displayed one by default. */
    async registerBoardingAt(
        descriptor: string | undefined,
        options: DelegationOptions,
        registration: RegistrationOptions = {},
    ): Promise<ExecutorWatchRegistration> {
        const key = descriptor ?? (await this.displayedDescriptor());
        const context = this.lazyContext();
        const boarding =
            (await this.storedWatch(key, options, registration, "boarding")) ??
            (await this.registerAt(await context(), key, options, registration, "boarding"));
        try {
            await this.pairRenewal(context, key, boarding, options, registration);
        } catch (e) {
            console.warn("Failed to register the executor renewal watch paired with boarding", e);
        }
        return boarding;
    }

    /**
     * Register again the live watches the executor no longer holds. It expires a client delegation
     * that never held a coin after an idle window, and reports no deadline for it: the row stays
     * live, and the wallet keeps advertising an address nobody watches. Registering an expired
     * watch again revives it at the same address, keeping its registration time: only an explicit
     * registration moves the boarding address. One that cannot be revived stops being live, and
     * the wallet boards its deposits itself. A failing watch leaves the others to be tried.
     *
     * Only a watch the wallet still needs is revived: the displayed boarding and receive keys', the
     * most recently registered other key's, and a renewal watch whose contract holds an unspent
     * coin, which the executor must keep renewing while the wallet is offline. A lapsed watch of
     * any other key ends instead: it never held a coin, or none is left, and reviving it would
     * repeat for every rotation, forever.
     *
     * The status reads run as called; only the writes go through `write`, so a caller that orders
     * them with its rotations holds those back for one write, never for the whole refresh.
     * `stopped` ends the refresh between watches, and turns a write still queued into a no-op.
     *
     * Throws when a live watch is held and the executor or the operator cannot be reached; a
     * wallet with none reaches neither.
     * @internal
     */
    async refreshWatches({
        write = (task) => task(),
        stopped = () => false,
    }: {
        write?: (task: () => Promise<void>) => Promise<void>;
        stopped?: () => boolean;
    } = {}): Promise<void> {
        const held = {
            boarding: (await this.heldWatches("boarding")).filter((w) => w.live),
            renewal: (await this.heldWatches("renewal")).filter((w) => w.live),
        };
        if (!held.boarding.length && !held.renewal.length) return;
        const context = await this.registrationContext();
        for (const template of ["boarding", "renewal"] as const) {
            for (const watch of held[template]) {
                if (stopped()) return;
                if (watch.signer !== context.server) continue;
                try {
                    const status = await this.serviceStatus(context, template, watch);
                    if (status === "active") continue;
                    await write(async () => {
                        if (!stopped()) await this.settleLapsed(context, template, watch, status);
                    });
                } catch (e) {
                    console.warn(
                        `Failed to refresh the executor ${template} watch`,
                        watch.owner,
                        e,
                    );
                }
            }
        }
    }

    /** What the executor says of `watch`; an unknown watch is a lost one, so "expired". */
    private async serviceStatus(
        context: RegistrationContext,
        template: ExecutorDefault,
        watch: DelegatedContractWatch,
    ): Promise<string> {
        const address =
            template === "boarding"
                ? watch.script.onchainAddress(context.network)
                : watch.script.address(context.hrp, context.serverPubKey).encode();
        try {
            const details = await this.executorProvider.getDelegation(address, {
                signal: timeoutSignal(EXECUTOR_REQUEST_TIMEOUT_MS),
            });
            return details.delegation.status;
        } catch (e) {
            // Any other failure says nothing of the watch.
            if (!(e instanceof ExecutorRequestError) || e.status !== 404) throw e;
            return "expired";
        }
    }

    /** Revive a lapsed watch, or end it when its key is no longer in use. */
    private async settleLapsed(
        context: RegistrationContext,
        template: ExecutorDefault,
        lapsed: DelegatedContractWatch,
        status: string,
    ): Promise<void> {
        // Re-read: a rotation may have run while the service was asked.
        const watch = (await this.heldWatches(template)).find(
            (w) => w.contract.script === lapsed.contract.script,
        );
        if (!watch?.live) return;
        if (
            !(await this.keyInUse(watch.owner, context.server)) &&
            !(template === "renewal" && (await this.holdsCoin(watch.contract)))
        ) {
            await this.endWatch(watch, status);
            return;
        }
        const { options, registration } = reRegistrationOf(watch);
        try {
            await this.registerAt(
                context,
                await watchDescriptor(watch, this.wallet.identity),
                options,
                registration,
                template,
                true,
            );
        } catch (e) {
            // Whatever failed, the service said it no longer holds the watch: stop advertising it.
            await this.endWatch(watch, status);
            throw e;
        }
    }

    /** Record the service's `status`, so the watch stops being live and is no longer shown. */
    private async endWatch(watch: DelegatedContractWatch, status: string): Promise<void> {
        const manager = await this.wallet.getContractManager();
        await manager.updateContract(watch.contract.script, {
            metadata: statusMetadata(
                watch.contract.metadata ?? {},
                status,
                undefined,
                registeredAt(watch.contract),
            ),
        });
    }

    /** Whether `contract` holds an unspent, unswept coin, as stored. */
    private async holdsCoin(contract: Contract): Promise<boolean> {
        const manager = await this.wallet.getContractManager();
        const [stored] = await manager.getStoredContractsWithVtxos({ script: contract.script });
        return (stored?.vtxos ?? []).some((v) => !isVtxoSpent(v) && !v.isSwept);
    }

    /**
     * The displayed boarding key, the displayed receive key, and the most recently registered
     * other key with a live watch, whose params a rotation copies when the displayed key has no
     * watch.
     */
    private async keyInUse(owner: string, server: string): Promise<boolean> {
        const displayed = await ownerKey(this.wallet.identity, await this.displayedDescriptor());
        const displayedOwner = hex.encode(displayed.subarray(1));
        const receiveOwner = this.wallet.offchainTapscript
            ? hex.encode(this.wallet.offchainTapscript.options.pubKey)
            : undefined;
        if (owner === displayedOwner || owner === receiveOwner) return true;
        const others = [
            ...(await this.heldWatches("boarding")),
            ...(await this.heldWatches("renewal")),
        ]
            .filter(
                (w) =>
                    w.live &&
                    w.signer === server &&
                    w.owner !== displayedOwner &&
                    w.owner !== receiveOwner,
            )
            .sort((a, b) => registeredAt(b.contract) - registeredAt(a.contract));
        return others[0]?.owner === owner;
    }

    /**
     * A boarding watch pays into the renewal contract of its own params, so while renewal is on,
     * meaning any live renewal watch under the operator, that contract needs one too, or its
     * boarded coins fall back to the wallet.
     */
    private async pairRenewal(
        context: () => Promise<RegistrationContext>,
        descriptor: string,
        boarding: ExecutorWatchRegistration,
        options: DelegationOptions,
        registration: RegistrationOptions,
    ): Promise<void> {
        const contract = renewalScript(
            hex.decode(boarding.variables.owner),
            boarding.keys,
            boarding.params,
        );
        const server = await this.operatorSigner();
        const renewals = (await this.heldWatches("renewal")).filter(
            (w) => w.live && w.signer === server,
        );
        if (renewals.length === 0 || renewals.some((w) => w.contract.script === contract)) return;
        await this.registerAt(await context(), descriptor, options, registration, "renewal");
    }

    /**
     * What registering `descriptor`'s key would return, read from the stored watch: the key's
     * newest live one of `template` under the current operator, when it has the same params and
     * emulator key. The service would answer with it unchanged; a lapsed watch is the refresh's to
     * find. Undefined when the service must be asked: a first registration, a restored row, new
     * params, or older ones registered again to move the boarding address back.
     */
    private async storedWatch(
        descriptor: string,
        options: DelegationOptions,
        { emulatorPubkey }: RegistrationOptions,
        template: ExecutorDefault,
    ): Promise<ExecutorWatchRegistration | undefined> {
        const [{ hrp, serverPubKey }, owner] = await Promise.all([
            ownAddress(this.wallet),
            ownerKey(this.wallet.identity, descriptor),
        ]);
        const server = hex.encode(serverPubKey);
        const xOnlyOwner = hex.encode(owner.subarray(1));
        const watch = (await this.heldWatches(template)).find(
            (w) => w.live && w.signer === server && w.owner === xOnlyOwner,
        );
        if (!watch) return undefined;
        const operator = await this.wallet.getOperatorInfo();
        const network = networkFromOperatorInfo(operator);
        const params = resolveParams(options, operator, template);
        const p = ExecutorContractHandler.deserializeParams(watch.contract.params);
        if (
            hex.encode(p.emulatorPubKey) !== resolveEmulatorPubkey(network, emulatorPubkey) ||
            p.renewalWindow !== params.renewalWindow ||
            p.maxFee !== params.maxFee ||
            p.exitDelay !== params.exitDelay ||
            p.boardingExitDelay !== params.boardingExitDelay ||
            renewalWindowFault(params.renewalWindow, operator.vtxoTreeExpiry) !== undefined
        ) {
            return undefined;
        }
        return {
            address:
                template === "boarding"
                    ? watch.script.onchainAddress(network)
                    : watch.script.address(hrp, serverPubKey).encode(),
            templateId: DEFAULT_TEMPLATE_IDS[template],
            variables: defaultVariables(template, owner, params),
            keys: executorKeysOf(p),
            params,
        };
    }

    /** {@link registrationContext}, read once, and only when the service is asked. */
    private lazyContext(): () => Promise<RegistrationContext> {
        let context: Promise<RegistrationContext> | undefined;
        return () => (context ??= this.registrationContext());
    }

    /** The wallet's operator key, x-only hex: the signer a live watch is registered under. */
    private async operatorSigner(): Promise<string> {
        return hex.encode((await ownAddress(this.wallet)).serverPubKey);
    }

    /**
     * Both templates register the displayed boarding key: boarding moves its deposits in, renewal
     * keeps the renewal contract that receives them alive. It falls back to the identity's, so a
     * static wallet registers its identity key.
     */
    private async displayedDescriptor(): Promise<string> {
        return boardingDescriptor(this.wallet, await this.operatorSigner());
    }

    /** The wallet's watches of `template`, from the repository rows. */
    private heldWatches(template: ExecutorDefault): Promise<DelegatedContractWatch[]> {
        return delegatedContracts(
            this.wallet.identity,
            async (filter) => (await this.wallet.getContractManager()).getContracts(filter),
            template,
        );
    }

    private async registrationContext(): Promise<RegistrationContext> {
        const [info, operator] = await Promise.all([
            this.executorProvider.getInfo(),
            this.wallet.getOperatorInfo({ requireLive: true }),
        ]);
        if (info.network !== operator.network) {
            throw new Error(
                `executor runs on ${info.network}, the wallet's operator on ${operator.network}`,
            );
        }
        // the watch address commits to the service's operator key, so it must be the wallet's
        const { hrp, serverPubKey } = await ownAddress(this.wallet);
        const server = hex.encode(serverPubKey);
        if (info.operatorPubkey.slice(2).toLowerCase() !== server) {
            throw new Error(
                `executor's operator key ${info.operatorPubkey} is not the wallet's operator ${server}`,
            );
        }
        return {
            info,
            operator,
            network: networkFromOperatorInfo(operator),
            hrp,
            serverPubKey,
            server,
        };
    }

    private async registerAt(
        { info, operator, network, hrp, serverPubKey }: RegistrationContext,
        descriptor: string,
        options: DelegationOptions,
        { expiresAt, emulatorPubkey }: RegistrationOptions = {},
        template: ExecutorDefault,
        /** A refresh keeps the row's registration time, which picks the boarding address. */
        refresh = false,
    ): Promise<ExecutorWatchRegistration> {
        // Pinned, as in Arkade.connect: holding the emulator key, the executor could sign for the
        // function with Arkade Script itself, past its covenant. Matching addresses cannot show it.
        const emulator = resolveEmulatorPubkey(network, emulatorPubkey);
        if (info.emulatorPubkey.toLowerCase() !== emulator) {
            throw new Error(
                `executor's emulator key ${info.emulatorPubkey} is not the trusted ${emulator}`,
            );
        }
        const fault = renewalWindowFault(options.renewalWindow, operator.vtxoTreeExpiry);
        if (fault) throw new Error(`renewalWindow ${options.renewalWindow}s ${fault}`);
        const owner = await ownerKey(this.wallet.identity, descriptor);
        const params = resolveParams(options, operator, template);
        const keys: ExecutorContractKeys = {
            batchCosignerPubkey: info.batchCosignerPubkey,
            operatorPubkey: info.operatorPubkey,
            emulatorPubkey: info.emulatorPubkey,
        };
        const variables = defaultVariables(template, owner, params);
        const watchScript = ExecutorContractHandler.createScript(
            executorContractParams(template, owner, keys, params),
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
            signal: timeoutSignal(EXECUTOR_REQUEST_TIMEOUT_MS),
        });
        // The scripts derive from the owner, the params and the operator and emulator keys, not the
        // batch cosigner key: a matching address proves those and commits to the same tapscripts,
        // and says nothing of the batch cosigner key. That is safe while the batch cosigner key is
        // in no leaf; a template that gives it one must check it here. Checked before anything is
        // persisted.
        const [input] = delegation.inputs;
        if (
            delegation.inputs.length !== 1 ||
            !input ||
            (template === "boarding" ? !input.onchain : input.onchain)
        ) {
            throw new Error(
                `executor's ${template} delegation has ${delegation.inputs.length} inputs, expected one ${template === "boarding" ? "onchain" : "offchain"} input`,
            );
        }
        // bech32 is case-insensitive, and the service may answer in upper case
        if (input.address.toLowerCase() !== watchAddress) {
            throw new Error(
                `executor derived a different address: expected ${watchAddress}, got ${input.address}`,
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
                    refresh ? registeredAt(row) : undefined,
                ),
            });
        }
        if (delegation.status !== "active") {
            throw new Error(`executor watch ${watchAddress} is ${delegation.status}`);
        }
        return { address: watchAddress, templateId, variables, keys, params, delegation };
    }
}
