import { hex } from "@scure/base";
import type { Asset, IWallet } from ".";
import type { DelegateeDelegation, DelegateeInfo, DelegateeProvider } from "../providers/delegatee";
import type { Contract } from "../contracts/types";
import { DelegateeContractHandler } from "../contracts/handlers/delegatee";
import { ArkAddress } from "../script/address";
import {
    boardingWatch,
    type DelegateeDefault,
    type DelegationParams,
    defaultTemplateIds,
    renewalWatch,
} from "../script/delegateeTemplate";

/** A watch both sides derived: the address to fund and what restores it. */
export interface DelegateeWatchRegistration {
    /** An Ark address for renewal, a bitcoin address for boarding. */
    address: string;
    templateId: string;
    /** The template's variables, canonical hex. */
    variables: Record<string, string>;
    /** The service's keys the wallet's delegatee contracts are derived from. */
    keys: DelegateeContractKeys;
    delegation: DelegateeDelegation;
}

export type DelegateeContractKeys = Pick<
    DelegateeInfo,
    "delegatePubkey" | "serverPubkey" | "emulatorPubkey"
>;

/** What the manager needs of a wallet: its key, its server, its coins and a way to send. */
export type DelegateeWallet = Pick<
    IWallet,
    "identity" | "getAddress" | "getSpendableVtxos" | "send" | "getContractManager"
>;

/**
 * Make the wallet's contract manager watch, as its own, the renewal contract of its key and, when
 * params has a boarding exit delay, its boarding contract: derived locally from the key, the
 * params and the service's keys, so a restored wallet finds its delegated coins without asking
 * the service. Idempotent.
 */
export async function watchDelegateeContracts(
    wallet: Pick<IWallet, "identity" | "getAddress" | "getContractManager">,
    keys: DelegateeContractKeys,
    params: DelegationParams,
): Promise<Contract[]> {
    const [owner, address, manager] = await Promise.all([
        wallet.identity.compressedPublicKey(),
        wallet.getAddress(),
        wallet.getContractManager(),
    ]);
    const { hrp, serverPubKey } = ArkAddress.decode(address);
    const templates: DelegateeDefault[] =
        params.boardingExitDelay === undefined ? ["renewal"] : ["renewal", "boarding"];
    const contracts: Contract[] = [];
    for (const template of templates) {
        const serialized = DelegateeContractHandler.serializeParams({
            template,
            owner,
            exitDelay: params.exitDelay,
            renewalWindow: params.renewalWindow,
            maxFee: params.maxFee,
            ...(template === "boarding" ? { boardingExitDelay: params.boardingExitDelay } : {}),
            delegatePubKey: hex.decode(keys.delegatePubkey),
            serverPubKey: hex.decode(keys.serverPubkey),
            emulatorPubKey: hex.decode(keys.emulatorPubkey),
        });
        const script = DelegateeContractHandler.createScript(serialized);
        contracts.push(
            await manager.createContract({
                type: DelegateeContractHandler.type,
                params: serialized,
                script: hex.encode(script.pkScript),
                address: script.address(hrp, serverPubKey).encode(),
                label: template === "renewal" ? "Delegatee renewal" : "Delegatee boarding",
            }),
        );
    }
    return contracts;
}

export interface IDelegateeManager {
    getInfo(): Promise<DelegateeInfo>;
    /** The default template ids; throws unless the service lists them as active. */
    defaultTemplates(): Promise<Record<DelegateeDefault, string>>;
    /** Watch the renewal address of this wallet's key, and make the wallet watch it too. */
    registerRenewal(
        params: DelegationParams,
        options?: { expiresAt?: number },
    ): Promise<DelegateeWatchRegistration>;
    /**
     * Watch the boarding address of this wallet's key (params needs boardingExitDelay), and make
     * the wallet watch its boarding and renewal contracts.
     */
    registerBoarding(
        params: DelegationParams,
        options?: { expiresAt?: number },
    ): Promise<DelegateeWatchRegistration>;
    /**
     * Migrate the wallet to the delegatee: register the renewal watch, send its generically
     * spendable VTXOs, with their assets, to the renewal address and retire its own receive
     * contracts (inactive, still watched). txid is absent when there was nothing to send.
     * Idempotent: run it again to move coins that reach a retired address later.
     */
    delegateVtxos(
        params: DelegationParams,
        options?: { expiresAt?: number },
    ): Promise<DelegateeWatchRegistration & { txid?: string }>;
}

/** Client-side watch registration with the delegatee service. */
export class DelegateeManagerImpl implements IDelegateeManager {
    constructor(
        readonly delegateeProvider: DelegateeProvider,
        readonly wallet: DelegateeWallet,
    ) {}

    getInfo(): Promise<DelegateeInfo> {
        return this.delegateeProvider.getInfo();
    }

    async defaultTemplates(): Promise<Record<DelegateeDefault, string>> {
        const ids = defaultTemplateIds();
        const templates = await this.delegateeProvider.listTemplates();
        const active = new Set(templates.filter((t) => t.status === "active").map((t) => t.id));
        const missing = Object.entries(ids).filter(([, id]) => !active.has(id));
        if (missing.length > 0) {
            throw new Error(
                `delegatee does not list the default templates ${missing.map(([n, id]) => `${n} ${id}`).join(", ")}`,
            );
        }
        return ids;
    }

    registerRenewal(
        params: DelegationParams,
        options: { expiresAt?: number } = {},
    ): Promise<DelegateeWatchRegistration> {
        return this.register("renewal", { ...params, boardingExitDelay: undefined }, options);
    }

    registerBoarding(
        params: DelegationParams,
        options: { expiresAt?: number } = {},
    ): Promise<DelegateeWatchRegistration> {
        return this.register("boarding", params, options);
    }

    async delegateVtxos(
        params: DelegationParams,
        options: { expiresAt?: number } = {},
    ): Promise<DelegateeWatchRegistration & { txid?: string }> {
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
        kind: DelegateeDefault,
        params: DelegationParams,
        options: { expiresAt?: number },
    ): Promise<DelegateeWatchRegistration> {
        const [info, address, owner] = await Promise.all([
            this.delegateeProvider.getInfo(),
            this.wallet.getAddress(),
            this.wallet.identity.compressedPublicKey(),
        ]);
        // the watch address commits to the service's server key, so it must be the wallet's
        const server = hex.encode(ArkAddress.decode(address).serverPubKey);
        if (info.serverPubkey.slice(2).toLowerCase() !== server) {
            throw new Error(
                `delegatee server key ${info.serverPubkey} is not the wallet's server ${server}`,
            );
        }
        const id = defaultTemplateIds()[kind];
        const watch = (kind === "renewal" ? renewalWatch : boardingWatch)(info, owner, params);
        // Registration is idempotent on the service: repeating it returns the existing watch.
        const delegation = await this.delegateeProvider.registerDelegation(
            id,
            watch.variables,
            options,
        );
        // the service fills <DELEGATE_KEY> with its key: the same address proves it is GetInfo's
        if (delegation.address !== watch.address) {
            throw new Error(
                `delegatee derived a different address: expected ${watch.address}, got ${delegation.address}`,
            );
        }
        const remote = delegation.slots[0]?.tapscripts ?? [];
        const local = watch.tapscripts.map((s) => hex.encode(s));
        if (remote.length !== local.length || remote.some((s, i) => s !== local[i])) {
            throw new Error("delegatee derived different tapscripts");
        }
        const keys = {
            delegatePubkey: info.delegatePubkey,
            serverPubkey: info.serverPubkey,
            emulatorPubkey: info.emulatorPubkey,
        };
        await watchDelegateeContracts(this.wallet, keys, params);
        return {
            address: watch.address,
            templateId: id,
            variables: watch.variables,
            keys,
            delegation,
        };
    }
}
