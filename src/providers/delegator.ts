import { Intent } from "../intent";
import { SignedIntent } from "./ark";

export interface DelegateInfo {
    pubkey: string;
    fee: string;
    delegatorAddress: string;
}

export interface DelegatorProvider {
    delegate(
        intent: SignedIntent<Intent.Message>,
        forfeit: string
    ): Promise<void>;
    getDelegateInfo(): Promise<DelegateInfo>;
}

/**
 * REST-based Delegator provider implementation.
 * @example
 * ```typescript
 * const provider = new RestDelegatorProvider('https://delegator.example.com');
 * const info = await provider.getDelegateInfo();
 * await provider.delegate(intent, forfeit);
 * ```
 */
export class RestDelegatorProvider implements DelegatorProvider {
    constructor(public url: string) {}

    async delegate(
        intent: SignedIntent<Intent.RegisterMessage>,
        forfeit: string
    ): Promise<void> {
        const url = `${this.url}/api/v1/delegate`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                intent: {
                    proof: intent.proof,
                    message: Intent.encodeMessage(intent.message),
                },
                forfeit,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to delegate: ${errorText}`);
        }
    }

    async getDelegateInfo(): Promise<DelegateInfo> {
        const url = `${this.url}/api/v1/delegate/info`;
        const response = await fetch(url);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to get delegate info: ${errorText}`);
        }

        const data = await response.json();
        return {
            pubkey: data.pubkey ?? "",
            fee: data.fee ?? "",
            delegatorAddress: data.delegatorAddress ?? "",
        };
    }
}
