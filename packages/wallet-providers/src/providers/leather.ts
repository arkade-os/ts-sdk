import { hex } from "@scure/base";
import { Transaction } from "@arkade-os/sdk";
import { BrowserWalletIdentity } from "../base";
import type { LeatherProvider } from "../types";

/**
 * Identity implementation for the Leather browser wallet extension.
 *
 * Leather injects `window.LeatherProvider` and uses a request/response pattern.
 * PSBTs are exchanged as hex-encoded strings.
 *
 * Leather does **not** support batch PSBT signing — each checkpoint requires
 * a separate confirmation popup. Only implements `Identity`, not `BatchSignableIdentity`.
 *
 * @example
 * ```typescript
 * const resp = await window.LeatherProvider.request("getAddresses");
 * const p2trAddress = resp.result.addresses.find(a => a.type === "p2tr");
 * const identity = new LeatherIdentity(
 *   hex.decode(p2trAddress.publicKey),
 *   p2trAddress.address,
 *   window.LeatherProvider
 * );
 * const wallet = await Wallet.create({ identity, ... });
 * ```
 */
export class LeatherIdentity extends BrowserWalletIdentity {
    private readonly provider: LeatherProvider;

    constructor(publicKey: Uint8Array, address: string, provider: LeatherProvider) {
        super(publicKey, address);
        this.provider = provider;
    }

    async sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction> {
        const psbtHex = this.psbtToHex(tx);
        const indexes = this.allInputIndexes(tx, inputIndexes);

        const response = await this.provider.request("signPsbt", {
            hex: psbtHex,
            signAtIndex: indexes,
        });

        if (response.error) {
            throw new Error(
                `Leather signing failed: ${response.error.code} - ${response.error.message}`,
            );
        }

        const signedHex = response.result?.hex;
        if (!signedHex) {
            throw new Error("No signed PSBT returned from Leather wallet");
        }

        return this.mergeSignedPsbt(tx, hex.decode(signedHex));
    }
}

export { LeatherIdentity as default };
