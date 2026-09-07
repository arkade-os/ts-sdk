import { hex } from "@scure/base";
import { Transaction } from "@arkade-os/sdk";
import { BrowserWalletIdentity } from "../base";
import type { BatchSignableIdentity, SignRequest, UnisatProvider } from "../types";

/**
 * Identity implementation for the UniSat browser wallet extension.
 *
 * UniSat injects `window.unisat` and supports both single and batch PSBT signing.
 * PSBTs are exchanged as hex-encoded strings.
 *
 * Implements `BatchSignableIdentity` — the SDK will call `signMultiple()` to batch
 * all checkpoint + main tx signatures into a single wallet popup.
 *
 * @example
 * ```typescript
 * const accounts = await window.unisat.requestAccounts();
 * const pubkeyHex = await window.unisat.getPublicKey();
 * const identity = new UnisatIdentity(hex.decode(pubkeyHex), accounts[0], window.unisat);
 * const wallet = await Wallet.create({ identity, ... });
 * ```
 */
export class UnisatIdentity extends BrowserWalletIdentity implements BatchSignableIdentity {
    private readonly provider: UnisatProvider;

    constructor(publicKey: Uint8Array, address: string, provider: UnisatProvider) {
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

export { UnisatIdentity as default };
