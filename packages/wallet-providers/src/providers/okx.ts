import { hex } from "@scure/base";
import { Transaction } from "@arkade-os/sdk";
import { BrowserWalletIdentity } from "../base";
import type { BatchSignableIdentity, SignRequest, OkxBitcoinProvider } from "../types";

/**
 * Identity implementation for the OKX Wallet browser extension.
 *
 * OKX injects `window.okxwallet.bitcoin` and supports both single and batch PSBT signing.
 * PSBTs are exchanged as hex-encoded strings.
 *
 * Implements `BatchSignableIdentity` — the SDK will call `signMultiple()` to batch
 * all checkpoint + main tx signatures into a single wallet popup.
 *
 * @example
 * ```typescript
 * const { address, publicKey } = await window.okxwallet.bitcoin.connect();
 * const identity = new OkxIdentity(hex.decode(publicKey), address, window.okxwallet.bitcoin);
 * const wallet = await Wallet.create({ identity, ... });
 * ```
 */
export class OkxIdentity extends BrowserWalletIdentity implements BatchSignableIdentity {
    private readonly provider: OkxBitcoinProvider;

    constructor(publicKey: Uint8Array, address: string, provider: OkxBitcoinProvider) {
        super(publicKey, address);
        this.provider = provider;
    }

    async sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction> {
        const psbtHex = this.psbtToHex(tx);
        const indexes = this.allInputIndexes(tx, inputIndexes);

        const signedHex = await this.provider.signPsbt(psbtHex, {
            autoFinalized: false,
            toSignInputs: indexes.map((index) => ({
                index,
                address: this.address,
            })),
        });

        return this.mergeSignedPsbt(tx, hex.decode(signedHex));
    }

    async signMultiple(requests: SignRequest[]): Promise<Transaction[]> {
        const psbtHexs: string[] = [];
        const optionsArray: Array<{
            autoFinalized: boolean;
            toSignInputs: Array<{ index: number; address: string }>;
        }> = [];

        for (const req of requests) {
            psbtHexs.push(this.psbtToHex(req.tx));
            const indexes = this.allInputIndexes(req.tx, req.inputIndexes);
            optionsArray.push({
                autoFinalized: false,
                toSignInputs: indexes.map((index) => ({
                    index,
                    address: this.address,
                })),
            });
        }

        const signedHexs = await this.provider.signPsbts(psbtHexs, optionsArray);

        return requests.map((req, i) => this.mergeSignedPsbt(req.tx, hex.decode(signedHexs[i])));
    }
}

export { OkxIdentity as default };
