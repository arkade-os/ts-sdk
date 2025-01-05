import { BaseArkProvider, Input, Output } from "./base";
import type { VirtualCoin } from "../types/wallet";

// Define event types
export interface ArkEvent {
    type: "vtxo_created" | "vtxo_spent" | "vtxo_swept" | "vtxo_expired";
    data: {
        txid?: string;
        address?: string;
        amount?: number;
        roundTxid?: string;
        expireAt?: number;
    };
}

export class ArkProvider extends BaseArkProvider {
    async getInfo() {
        const url = `${this.serverUrl}/v1/info`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(
                `Failed to get server info: ${response.statusText}`
            );
        }
        return response.json();
    }

    async getVirtualCoins(address: string): Promise<VirtualCoin[]> {
        const url = `${this.serverUrl}/v1/vtxos/${address}`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch VTXOs: ${response.statusText}`);
        }
        const data = await response.json();

        // Convert from server format to our internal VTXO format
        return [...(data.spendableVtxos || []), ...(data.spentVtxos || [])].map(
            (vtxo) => ({
                txid: vtxo.outpoint.txid,
                vout: vtxo.outpoint.vout,
                value: Number(vtxo.amount),
                status: {
                    confirmed: !!vtxo.roundTxid,
                },
                virtualStatus: {
                    state: vtxo.spent
                        ? "spent"
                        : vtxo.swept
                          ? "swept"
                          : vtxo.isPending
                            ? "pending"
                            : "settled",
                    batchTxID: vtxo.roundTxid,
                    batchExpiry: vtxo.expireAt
                        ? Number(vtxo.expireAt)
                        : undefined,
                },
            })
        );
    }

    async submitVirtualTx(psbtBase64: string): Promise<string> {
        const url = `${this.serverUrl}/v1/redeem-tx`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                redeem_tx: psbtBase64,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            try {
                const grpcError = JSON.parse(errorText);
                // gRPC errors usually have a message and code field
                throw new Error(
                    `Failed to submit virtual transaction: ${grpcError.message || grpcError.error || errorText}`
                );
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
            } catch (_) {
                // If JSON parse fails, use the raw error text
                throw new Error(
                    `Failed to submit virtual transaction: ${errorText}`
                );
            }
        }

        const data = await response.json();
        return data.txid;
    }

    async subscribeToEvents(
        callback: (event: ArkEvent) => void
    ): Promise<() => void> {
        const url = `${this.serverUrl}/v1/events`;
        const eventSource = new EventSource(url);

        eventSource.onmessage = (event) => {
            const data = JSON.parse(event.data) as ArkEvent;
            callback(data);
        };

        eventSource.onerror = () => {
            // Error handling is done by the callback
        };

        // Return unsubscribe function
        return () => eventSource.close();
    }

    async registerInputsForNextRound(
        inputs: Input[],
        vtxoTreeSigningPublicKey: string
    ): Promise<{ paymentID: string }> {
        const url = `${this.serverUrl}/v1/round/registerInputs`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                inputs,
                ephemeral_pubkey: vtxoTreeSigningPublicKey,
            }),
        });

        if (!response.ok) {
            throw new Error(
                `Failed to register inputs: ${response.statusText}`
            );
        }

        const data = await response.json();
        return { paymentID: data.request_id };
    }

    async registerOutputsForNextRound(
        paymentID: string,
        outputs: Output[]
    ): Promise<void> {
        const url = `${this.serverUrl}/v1/round/registerOutputs`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                request_id: paymentID,
                outputs,
            }),
        });

        if (!response.ok) {
            throw new Error(
                `Failed to register outputs: ${response.statusText}`
            );
        }
    }

    async submitTreeNonces(
        settlementID: string,
        pubkey: string,
        nonces: string
    ): Promise<void> {
        const url = `${this.serverUrl}/v1/round/tree/submitNonces`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                round_id: settlementID,
                pubkey,
                tree_nonces: nonces,
            }),
        });

        if (!response.ok) {
            throw new Error(
                `Failed to submit tree nonces: ${response.statusText}`
            );
        }
    }

    async submitTreeSignatures(
        settlementID: string,
        pubkey: string,
        signatures: string
    ): Promise<void> {
        const url = `${this.serverUrl}/v1/round/tree/submitSignatures`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                round_id: settlementID,
                pubkey,
                tree_signatures: signatures,
            }),
        });

        if (!response.ok) {
            throw new Error(
                `Failed to submit tree signatures: ${response.statusText}`
            );
        }
    }

    async submitSignedForfeitTxs(
        signedForfeitTxs: string[],
        signedRoundTx?: string
    ): Promise<void> {
        const url = `${this.serverUrl}/v1/round/submitForfeitTxs`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                signed_forfeit_txs: signedForfeitTxs,
                signed_round_tx: signedRoundTx,
            }),
        });

        if (!response.ok) {
            throw new Error(
                `Failed to submit forfeit transactions: ${response.statusText}`
            );
        }
    }

    async ping(paymentID: string): Promise<void> {
        const url = `${this.serverUrl}/v1/round/ping/${paymentID}`;
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`Ping failed: ${response.statusText}`);
        }
    }
}
