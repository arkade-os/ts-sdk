import { Intent } from "../intent";
import { SignedIntent } from "./ark";

export interface DelegateInfo {
    pubkey: string;
    fee: string;
    delegatorAddress: string;
}

export interface DelegatorProvider {
    delegate(
        intent: SignedIntent<Intent.RegisterMessage>,
        forfeits: string[]
    ): Promise<void>;
    getDelegateInfo(): Promise<DelegateInfo>;
}

/**
 * REST-based Delegator provider implementation.
 * @example
 * ```typescript
 * const provider = new RestDelegatorProvider('https://delegator.example.com');
 * const info = await provider.getDelegateInfo();
 * await provider.delegate(intent, forfeits);
 * ```
 */
export class RestDelegatorProvider implements DelegatorProvider {
    constructor(public url: string) {}

    async delegate(
        intent: SignedIntent<Intent.RegisterMessage>,
        forfeits: string[]
    ): Promise<void> {
        const url = `${this.url}/api/v1/delegate`;
        try {
            const response = await fetch(url, {
                method: "POST",
                mode: "cors",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    intent: {
                        proof: intent.proof,
                        message: Intent.encodeMessage(intent.message),
                    },
                    forfeits,
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Failed to delegate: ${errorText}`);
            }
        } catch (error) {
            if (error instanceof TypeError && error.message.includes("fetch")) {
                throw new Error(
                    `CORS error: The delegator server at ${this.url} does not allow requests from this origin. Please ensure the server has CORS headers configured.`
                );
            }
            throw error;
        }
    }

    async getDelegateInfo(): Promise<DelegateInfo> {
        const url = `${this.url}/api/v1/delegate/info`;
        try {
            const response = await fetch(url, {
                mode: "cors",
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Failed to get delegate info: ${errorText}`);
            }

            const data = await response.json();
            if (!isDelegateInfo(data)) {
                throw new Error("Invalid delegate info");
            }
            return data;
        } catch (error) {
            if (error instanceof TypeError && error.message.includes("fetch")) {
                throw new Error(
                    `CORS error: The delegator server at ${this.url} does not allow requests from this origin. Please ensure the server has CORS headers configured.`
                );
            }
            throw error;
        }
    }
}

function isDelegateInfo(data: any): data is DelegateInfo {
    return (
        data &&
        typeof data === "object" &&
        "pubkey" in data &&
        "fee" in data &&
        "delegatorAddress" in data &&
        typeof data.pubkey === "string" &&
        typeof data.fee === "string" &&
        typeof data.delegatorAddress === "string" &&
        data.pubkey !== "" &&
        data.fee !== "" &&
        data.delegatorAddress !== ""
    );
}
