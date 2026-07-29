import { Transaction } from "@arkade-os/sdk";
import { BrowserWalletIdentity } from "../base";
import type { PhantomBitcoinProvider } from "../types";

/**
 * Identity implementation for the Phantom browser wallet extension.
 *
 * Phantom injects `window.phantom.bitcoin` and exchanges PSBTs as raw Uint8Array bytes.
 *
 * Phantom does **not** support batch PSBT signing and its PSBT support is reportedly
 * partial — errors are handled gracefully. Only implements `Identity`, not `BatchSignableIdentity`.
 *
 * @example
 * ```typescript
 * const accounts = await window.phantom.bitcoin.requestAccounts();
 * const p2tr = accounts.find(a => a.addressType === "p2tr");
 * const identity = new PhantomIdentity(
 *   hex.decode(p2tr.publicKey),
 *   p2tr.address,
 *   window.phantom.bitcoin
 * );
 * const wallet = await Wallet.create({ identity, ... });
 * ```
 */
export class PhantomIdentity extends BrowserWalletIdentity {
    private readonly provider: PhantomBitcoinProvider;

    constructor(publicKey: Uint8Array, address: string, provider: PhantomBitcoinProvider) {
        super(publicKey, address);
        this.provider = provider;
    }

    async sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction> {
        const psbtBytes = tx.toPSBT();
        const indexes = this.allInputIndexes(tx, inputIndexes);

        const signedBytes = await this.provider.signPSBT(psbtBytes, {
            inputsToSign: [
                {
                    address: this.address,
                    signingIndexes: indexes,
                },
            ],
        });

        return this.mergeSignedPsbt(tx, signedBytes);
    }
}

export { PhantomIdentity as default };
