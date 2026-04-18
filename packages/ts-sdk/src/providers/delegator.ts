import { Intent } from "../intent";
import { SignedIntent } from "./ark";

/**
 * Delegate identity and fee information returned by `getDelegateInfo`.
 */
export interface DelegateInfo {
    /** Delegate public key. */
    pubkey: string;
    /** Delegate fee amount or expression returned by the delegation service. */
    fee: string;
    /**
     * Address controlled by the delegation service.
     * Naming is confusing: should be thought of as a "delegate address".
     */
    delegatorAddress: string;
}

/**
 * Optional delegate behavior flags.
 */
export interface DelegateOptions {
    /**
     * Instruct the delegate not to replace an existing delegation
     * (meaning a signed register intent and its forfeit transactions)
     * that already includes at least one virtual output from this request.
     *
     * @defaultValue `false`
     */
    rejectReplace?: boolean;
}

/**
 * Provider interface for remote delegation services.
 */
export interface DelegatorProvider {
    /**
     * Request delegation for a signed register intent and its forfeit transactions.
     *
     * @param intent - Signed register intent to delegate
     * @param forfeitTxs - Forfeit transactions associated with the delegation request
     * @param options - Optional delegate behavior flags
     */
    delegate(
        intent: SignedIntent<Intent.RegisterMessage>,
        forfeitTxs: string[],
        options?: DelegateOptions
    ): Promise<void>;

    /**
     * Fetch delegate metadata such as pubkey, fee, and delegate address.
     *
     * @returns Delegate identity and fee information
     */
    getDelegateInfo(): Promise<DelegateInfo>;
}

/**
 * REST-based delegation provider implementation.
 * @example
 * ```typescript
 * const provider = new RestDelegatorProvider('https://delegator.example.com');
 * const info = await provider.getDelegateInfo();
 * await provider.delegate(intent, forfeitTxs);
 * ```
 */
export class RestDelegatorProvider implements DelegatorProvider {
    /**
     * Create a REST delegation provider targeting the given base URL.
     *
     * @param url - Base URL of the delegation service
     */
    constructor(public url: string) {}

    /**
     * Submit a delegation request to the remote delegation service.
     *
     * @param intent - Signed register intent to delegate
     * @param forfeitTxs - Forfeit transactions associated with the delegation request
     * @param options - Optional delegate behavior flags
     * @throws Error if the remote service rejects the request
     */
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

    /**
     * Fetch delegate metadata exposed by the remote delegation service.
     *
     * @returns Delegate identity and fee information
     * @throws Error if the remote service returns invalid data
     */
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
