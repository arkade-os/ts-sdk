import { Intent } from "../intent";
import { SignedIntent } from "./ark";

export interface DelegateInfo {
    pubkey: string;
    fee: string;
    delegatorAddress: string;
}

export interface DelegateOptions {
    /** If true, instruct the delegator to not replace an existing delegate that includes at least one VTXO from this request */
    rejectReplace?: boolean;
}

export interface DelegatorProvider {
    delegate(
        intent: SignedIntent<Intent.RegisterMessage>,
        forfeitTxs: string[],
        options?: DelegateOptions
    ): Promise<void>;
    getDelegateInfo(): Promise<DelegateInfo>;
}

/**
 * REST-based Delegator provider implementation.
 * @example
 * ```typescript
 * const provider = new RestDelegatorProvider('https://delegator.example.com');
 * const info = await provider.getDelegateInfo();
 * await provider.delegate(intent, forfeitTxs);
 * ```
 */
export class RestDelegatorProvider implements DelegatorProvider {
    constructor(public url: string) {}

    async delegate(
        intent: SignedIntent<Intent.RegisterMessage>,
        forfeitTxs: string[],
        options?: DelegateOptions
    ): Promise<void> {
        const url = `${this.url}/v1/delegate`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                intent: {
                    message: Intent.encodeMessage(intent.message),
                    proof: intent.proof,
                },
                forfeit_txs: forfeitTxs,
                reject_replace: options?.rejectReplace ?? false,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to delegate: ${errorText}`);
        }
    }

    async getDelegateInfo(): Promise<DelegateInfo> {
        const url = `${this.url}/v1/delegator/info`;
        const response = await fetch(url);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to get delegate info: ${errorText}`);
        }

        const data = await response.json();
        if (!isDelegateInfo(data)) {
            throw new Error("Invalid delegate info");
        }
        return data;
    }
}

function isDelegateInfo(data: unknown): data is DelegateInfo {
    return (
        !!data &&
        typeof data === "object" &&
        "pubkey" in data &&
        "fee" in data &&
        "delegatorAddress" in data &&
        typeof (data as DelegateInfo).pubkey === "string" &&
        typeof (data as DelegateInfo).fee === "string" &&
        typeof (data as DelegateInfo).delegatorAddress === "string" &&
        (data as DelegateInfo).pubkey !== "" &&
        (data as DelegateInfo).fee !== "" &&
        (data as DelegateInfo).delegatorAddress !== ""
    );
}
