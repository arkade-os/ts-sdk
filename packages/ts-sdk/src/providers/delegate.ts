import { Intent } from "../intent";
import { SignedIntent } from "./ark";

/**
 * Delegate identity and fee information returned by `getDelegateInfo`.
 */
export interface DelegateInfo {
    /** Delegate public key. */
    pubkey: string;
    /** Delegate fee amount or expression returned by the delegate. */
    fee: string;
    /** Address for delegate fee collection. Sourced from `delegatorAddress` in Fulmine response, for now. */
    delegateAddress: string;
    /** @deprecated alias for @see DelegateInfo.delegateAddress */
    delegatorAddress?: string;
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
 * Provider interface for remote delegation service.
 */
export interface DelegateProvider {
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
        options?: DelegateOptions,
    ): Promise<void>;

    /**
     * Fetch delegate metadata such as pubkey, fee, and delegate address.
     *
     * @returns Delegate identity and fee information
     */
    getDelegateInfo(): Promise<DelegateInfo>;
}

/** @deprecated alias for @see DelegateProvider */
export type DelegatorProvider = DelegateProvider;

/**
 * REST-based delegate provider implementation.
 * @example
 * ```typescript
 * const provider = new RestDelegateProvider('https://delegate.example.com');
 * const info = await provider.getDelegateInfo();
 * await provider.delegate(intent, forfeitTxs);
 * ```
 */
export class RestDelegateProvider implements DelegateProvider {
    /**
     * Create a REST delegate provider targeting the given base URL.
     *
     * @param url - Base URL of the remote delegation service.
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
        options?: DelegateOptions,
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
        /** TODO: Update later once Fulmine URL changed */
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
        // Select by type, not truthiness: isDelegateInfo only guarantees that one
        // of the two is a non-empty string, so `a || b` could surface a non-string
        // value when the preferred field is present but not a string.
        const delegateAddress =
            typeof data.delegateAddress === "string" && data.delegateAddress !== ""
                ? data.delegateAddress
                : typeof data.delegatorAddress === "string" && data.delegatorAddress !== ""
                  ? data.delegatorAddress
                  : "";
        return { ...data, delegateAddress };
    }
}

/** @deprecated alias for @see RestDelegateProvider */
export const RestDelegatorProvider = RestDelegateProvider;
export type RestDelegatorProvider = RestDelegateProvider;

/**
 * Validates the raw delegate-info payload. `delegateAddress` is preferred and
 * `delegatorAddress` is its deprecated alias, so at least one must be a
 * non-empty string (Fulmine currently returns only `delegatorAddress`).
 */
function isDelegateInfo(data: unknown): data is DelegateInfo {
    return (
        !!data &&
        typeof data === "object" &&
        "pubkey" in data &&
        "fee" in data &&
        typeof (data as DelegateInfo).pubkey === "string" &&
        typeof (data as DelegateInfo).fee === "string" &&
        (data as DelegateInfo).pubkey !== "" &&
        (data as DelegateInfo).fee !== "" &&
        ((typeof (data as DelegateInfo).delegateAddress === "string" &&
            (data as DelegateInfo).delegateAddress !== "") ||
            (typeof (data as DelegateInfo).delegatorAddress === "string" &&
                (data as DelegateInfo).delegatorAddress !== ""))
    );
}
