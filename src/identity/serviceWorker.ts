import { Identity } from "./index";
import { SignerSession } from "../tree/signingSession";
import { Transaction } from "@scure/btc-signer";
import { Request } from "../wallet/serviceWorker/request";
import { Response } from "../wallet/serviceWorker/response";

function getRandomId(): string {
    return (
        Math.random().toString(36).substring(2, 15) +
        Math.random().toString(36).substring(2, 15)
    );
}

export class ServiceWorkerIdentity implements Identity {
    private serviceWorker: ServiceWorker;

    constructor(serviceWorker: ServiceWorker) {
        this.serviceWorker = serviceWorker;
    }

    private async sendMessage<T extends Response.Base>(
        message: Request.Base
    ): Promise<T> {
        return new Promise((resolve, reject) => {
            const handleMessage = (event: Event) => {
                const messageEvent = event as MessageEvent;
                const response = messageEvent.data as Response.Base;

                if (response.id === message.id) {
                    this.serviceWorker.removeEventListener(
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

            this.serviceWorker.addEventListener("message", handleMessage);
            this.serviceWorker.postMessage(message);

            // Timeout after 10 seconds
            setTimeout(() => {
                this.serviceWorker.removeEventListener(
                    "message",
                    handleMessage
                );
                reject(
                    new Error("Timeout waiting for service worker response")
                );
            }, 10000);
        });
    }

    async xOnlyPublicKey(): Promise<Uint8Array> {
        const message: Request.GetXOnlyPublicKey = {
            type: "GET_XONLY_PUBLIC_KEY",
            id: getRandomId(),
        };

        const response =
            await this.sendMessage<Response.XOnlyPublicKey>(message);
        return new Uint8Array(response.publicKey);
    }

    async sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction> {
        const message: Request.SignTransaction = {
            type: "SIGN_TRANSACTION",
            id: getRandomId(),
            transaction: Array.from(tx.toPSBT()),
            inputIndexes,
        };

        const response =
            await this.sendMessage<Response.TransactionSigned>(message);
        return Transaction.fromPSBT(new Uint8Array(response.transaction));
    }

    signerSession(): SignerSession {
        throw new Error(
            "SignerSession not supported in ServiceWorker context. Use async methods instead."
        );
    }
}
