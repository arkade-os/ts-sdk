import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import type { Identity } from "../identity";
import { getNetwork, type NetworkName } from "../networks";
import { DelegateVtxo } from "../script/delegate";
import { isDelegateeVtxoOptions } from "../script/delegatee";
import { toXOnly } from "../utils/keys";
import { DelegateeNotFoundError } from "../providers/delegatee";
import type { DelegateeDelegation, DelegateeInfo, DelegateeProvider } from "../providers/delegatee";

export interface IDelegateeManager {
    getInfo(): Promise<DelegateeInfo>;
    register(script: DelegateVtxo.Script): Promise<DelegateeDelegation>;
    revoke(address: string, timestamp?: number): Promise<void>;
}

/** Client-side registration and revocation flow for delegatee. */
export class DelegateeManagerImpl implements IDelegateeManager {
    constructor(
        readonly delegateeProvider: DelegateeProvider,
        readonly identity: Identity,
    ) {}

    getInfo(): Promise<DelegateeInfo> {
        return this.delegateeProvider.getInfo();
    }

    async register(script: DelegateVtxo.Script): Promise<DelegateeDelegation> {
        if (!isDelegateeVtxoOptions(script.options)) {
            throw new Error("unable to register delegatee: script is a legacy delegate script");
        }
        const { renewalWindow, maxFee } = script.options;
        const info = await this.delegateeProvider.getInfo({ renewalWindow, maxFee });
        const address = script
            .address(
                getNetwork(info.network as NetworkName).hrp,
                toXOnly(hex.decode(info.serverPubkey), "delegatee server key"),
            )
            .encode();
        try {
            const existing = await this.delegateeProvider.getDelegation(address);
            if (
                typeof existing === "object" &&
                existing !== null &&
                "delegation" in existing &&
                typeof existing.delegation === "object" &&
                existing.delegation !== null
            ) {
                return existing.delegation as DelegateeDelegation;
            }
            throw new Error("Invalid delegatee delegation response");
        } catch (error) {
            if (!(error instanceof DelegateeNotFoundError)) throw error;
        }
        return this.delegateeProvider.registerDelegation(
            script.scripts.map((leaf) => hex.encode(leaf)),
            { renewalWindow, maxFee },
        );
    }

    async revoke(address: string, timestamp = Math.floor(Date.now() / 1000)): Promise<void> {
        if (!Number.isSafeInteger(timestamp)) {
            throw new Error("delegatee revocation timestamp must be an integer");
        }
        const message = schnorr.utils.taggedHash(
            "delegatee/revoke",
            new TextEncoder().encode(`${address}:${timestamp}`),
        );
        const signature = await this.identity.signMessage(message, "schnorr");
        const pubkey = await this.identity.xOnlyPublicKey();
        await this.delegateeProvider.revokeDelegation({
            address,
            pubkey: hex.encode(pubkey),
            signature: hex.encode(signature),
            timestamp,
        });
    }
}
