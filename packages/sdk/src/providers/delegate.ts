import { Intent } from "../intent";
import { SignedIntent } from "./ark";
import { baseFetch } from "../utils/fetch";
import { rateGate } from "./rateGate";

/** Delegate identity and fee information returned by `getDelegateInfo`. */
export interface DelegateInfo {
    /** Delegate public key. */
    pubkey: string;
    /** Delegate fee amount or expression returned by the delegate. */
    fee: string;
    /** Address for delegate fee collection. */
    delegateAddress: string;
}

/** Optional delegate behavior flags. */
export interface DelegateOptions {
    /**
     * Tell the delegate not to replace an existing delegation (signed register intent + its
     * forfeits) that already includes at least one virtual output from this request.
     *
     * @defaultValue `false`
     */
    rejectReplace?: boolean;
}

/** Provider interface for a remote delegation service. */
export interface DelegateProvider {
    /**
     * Request delegation for a signed register intent and its forfeit transactions.
     *
     * @param forfeitTxs - Forfeit transactions associated with the delegation request
     */
    delegate(
        intent: SignedIntent<Intent.RegisterMessage>,
        forfeitTxs: string[],
        options?: DelegateOptions,
    ): Promise<void>;

    /** Fetch delegate metadata: pubkey, fee, and delegate address. */
    getDelegateInfo(): Promise<DelegateInfo>;
}

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
    /** @param url - Base URL of the remote delegation service. */
    constructor(public url: string) {}

    /**
     * Submit a delegation request to the remote delegation service.
     *
     * @throws Error if the remote service rejects the request
     */
    async delegate(
        intent: SignedIntent<Intent.RegisterMessage>,
        forfeitTxs: string[],
        options?: DelegateOptions,
    ): Promise<void> {
        const url = `${this.url}/v1/delegate`;
        const response = await baseFetch(url, {
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
     * @throws Error if the remote service returns invalid data
     */
    async getDelegateInfo(): Promise<DelegateInfo> {
        /** TODO: Update later once Fulmine URL changed */
        const url = `${this.url}/v1/delegator/info`;
        // rateGate is origin-keyed: a delegate on its own host is throttled apart from arkd.
        const response = await rateGate.runHttp(url, () => baseFetch(url));

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

/** Validates the raw delegate-info payload. */
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
        typeof (data as DelegateInfo).delegateAddress === "string" &&
        (data as DelegateInfo).delegateAddress !== ""
    );
}
