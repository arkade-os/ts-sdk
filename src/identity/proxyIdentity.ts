import { Transaction } from "@scure/btc-signer";
import { SignerSession } from "../tree/signingSession";
import { Request } from "../wallet/serviceWorker/request";
import { Response } from "../wallet/serviceWorker/response";
import { Identity } from "./index";

/**
 * ProxyIdentity forwards identity operations to a service worker.
 *
 * This class implements the Identity interface by proxying calls to a service worker,
 * enabling secure key operations in a separate context while maintaining the same API.
 */
export class ProxyIdentity implements Identity {
    private serviceWorker: ServiceWorker;
    private publicKeyCache?: Uint8Array;

    constructor(serviceWorker: ServiceWorker) {
        this.serviceWorker = serviceWorker;
    }

    /**
     * Sends a message to the service worker and waits for a response.
     */
    private async sendMessage<T extends Response.Base>(
        message: Request.Base
    ): Promise<T> {
        // Ensure service worker is active
        if (this.serviceWorker.state !== "activated") {
            throw new Error(
                `Service Worker is not active. Current state: ${this.serviceWorker.state}`
            );
        }

        return new Promise((resolve, reject) => {
            let timeoutId: ReturnType<typeof setTimeout>;

            const handleMessage = (event: Event) => {
                const messageEvent = event as MessageEvent;
                const response = messageEvent.data as Response.Base;

                if (response.id === message.id) {
                    // Clear the timeout since we received a response
                    clearTimeout(timeoutId);

                    navigator.serviceWorker.removeEventListener(
                        "message",
                        handleMessage
                    );

                    if (response.success) {
                        resolve(response as T);
                    } else {
                        reject(new Error((response as Response.Error).message));
                    }
                }
            };

            navigator.serviceWorker.addEventListener("message", handleMessage);
            this.serviceWorker.postMessage(message);

            // Timeout after 10 seconds
            timeoutId = setTimeout(() => {
                navigator.serviceWorker.removeEventListener(
                    "message",
                    handleMessage
                );
                reject(
                    new Error("Timeout waiting for service worker response")
                );
            }, 10000);
        });
    }

    /**
     * Gets the x-only public key, caching it after the first fetch.
     */
    async xOnlyPublicKey(): Promise<Uint8Array> {
        // Return cached value if available
        if (this.publicKeyCache) {
            return new Uint8Array(this.publicKeyCache);
        }

        const message: Request.GetXOnlyPublicKey = {
            type: "GET_XONLY_PUBLIC_KEY",
            id: this.generateId(),
        };

        const response =
            await this.sendMessage<Response.XOnlyPublicKey>(message);
        this.publicKeyCache = new Uint8Array(response.publicKey);
        return new Uint8Array(this.publicKeyCache);
    }

    /**
     * Signs a transaction using the service worker.
     * No caching for security - each signing request goes to the service worker.
     */
    async sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction> {
        const message: Request.SignTransaction = {
            type: "SIGN_TRANSACTION",
            id: this.generateId(),
            transaction: Array.from(tx.toPSBT()),
            inputIndexes,
        };

        const response =
            await this.sendMessage<Response.TransactionSigned>(message);
        return Transaction.fromPSBT(new Uint8Array(response.transaction));
    }

    /**
     * SignerSession is not supported in proxy context as it requires direct access to private keys.
     */
    signerSession(): SignerSession {
        throw new Error(
            "SignerSession not supported in ServiceWorker proxy context. Use async methods instead."
        );
    }

    /**
     * Generates a random ID for message correlation.
     */
    private generateId(): string {
        return (
            Math.random().toString(36).substring(2, 15) +
            Math.random().toString(36).substring(2, 15)
        );
    }

    /**
     * Clears the cached public key. Useful when the identity might change.
     */
    clearCache(): void {
        this.publicKeyCache = undefined;
    }
}
