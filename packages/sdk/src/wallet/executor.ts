import { hex } from "@scure/base";
import type { Asset, IWallet } from ".";
import type {
    DelegatedContractKeys,
    ExecutorDelegation,
    ExecutorInfo,
    ExecutorProvider,
} from "../providers/executor";
import type { Contract } from "../contracts/types";
import { DelegatedContractHandler } from "../contracts/handlers/delegated";
import { getNetwork, type NetworkName } from "../networks";
import { ArkAddress } from "../script/address";
import {
    DEFAULT_TEMPLATE_IDS,
    type ExecutorDefault,
    type DelegationParams,
    defaultVariables,
} from "../script/executor/executorTemplate";

export type { DelegatedContractKeys };

/** A watch both sides derived: the address to fund and what restores it. */
export interface ExecutorWatchRegistration {
    /** An address for renewal, an onchain address for boarding. */
    address: string;
    templateId: string;
    /** The template's variables, canonical hex. */
    variables: Record<string, string>;
    /** The executor's keys the wallet's delegated contracts are derived from. */
    keys: DelegatedContractKeys;
    delegation: ExecutorDelegation;
}

/** What the manager needs of a wallet: its key, its operator, its coins and a way to send. */
export type DelegatedWallet = Pick<
    IWallet,
    "identity" | "getAddress" | "getSpendableVtxos" | "send" | "getContractManager"
>;

/**
 * Make the wallet's contract manager watch, as its own, the renewal contract of its key and, when
 * params has a boarding exit delay, its boarding contract: derived locally from the key, the
 * params and the service's keys, so a restored wallet finds its delegated coins without asking
 * the service. Idempotent.
 */
export async function watchDelegatedContracts(
    wallet: Pick<IWallet, "identity" | "getAddress" | "getContractManager">,
    keys: DelegatedContractKeys,
    params: DelegationParams,
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
        const script = DelegatedContractHandler.createScript(serialized);
        contracts.push(
            await manager.createContract({
                type: DelegatedContractHandler.type,
                params: serialized,
                script: hex.encode(script.pkScript),
                address: script.address(hrp, serverPubKey).encode(),
                label: template === "renewal" ? "Delegated renewal" : "Delegated boarding",
            }),
        );
    }
    return contracts;
}

function contractParams(
    template: ExecutorDefault,
    owner: Uint8Array,
    keys: DelegatedContractKeys,
    params: DelegationParams,
): Record<string, string> {
    return DelegatedContractHandler.serializeParams({
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
     * spendable virtual outputs, with their assets, to the renewal address and retire its own receive
     * contracts (inactive, still watched). txid is absent when there was nothing to send.
     * Idempotent: run it again to move coins that reach a retired address later.
     */
    delegateWalletOutputs(
        params: DelegationParams,
        options?: { expiresAt?: number },
    ): Promise<ExecutorWatchRegistration & { txid?: string }>;
}

/** Client-side watch registration with the executor. */
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

    async delegateWalletOutputs(
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
        // the watch address commits to the service's operator key, so it must be the wallet's
        const { hrp, serverPubKey } = ArkAddress.decode(address);
        const operator = hex.encode(serverPubKey);
        if (info.serverPubkey.slice(2).toLowerCase() !== operator) {
            throw new Error(
                `executor's operator key ${info.serverPubkey} is not the wallet's operator ${operator}`,
            );
        }
        const keys = {
            cosignerPubkey: info.cosignerPubkey,
            serverPubkey: info.serverPubkey,
            emulatorPubkey: info.emulatorPubkey,
        };
        const variables = defaultVariables(kind, owner, params);
        const script = DelegatedContractHandler.createScript(
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
        // The same address proves the service resolved the template under GetInfo's keys and
        // commits to the same tapscripts.
        if (delegation.status !== "active") {
            throw new Error(`executor watch ${delegation.address} is ${delegation.status}`);
        }
        if (delegation.address !== watchAddress) {
            throw new Error(
                `executor derived a different address: expected ${watchAddress}, got ${delegation.address}`,
            );
        }
        const contracts = await watchDelegatedContracts(this.wallet, keys, params);
        const row = contracts.find((c) => c.params.template === kind);
        if (row) {
            const manager = await this.wallet.getContractManager();
            await manager.updateContract(row.script, {
                metadata: {
                    ...row.metadata,
                    delegationStatus: delegation.status,
                    delegationExpiresAt: delegation.expiresAt,
                },
            });
        }
        return { address: watchAddress, templateId, variables, keys, delegation };
    }
}
