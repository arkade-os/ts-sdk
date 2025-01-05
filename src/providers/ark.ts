import {
    BaseArkProvider,
    EventType,
    Input,
    Output,
    SettlementEvent,
} from "./base";
import type { VirtualCoin } from "../types/wallet";
import { VtxoTree } from "../core/vtxoTree";

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

// ProtoTypes namespace defines unexported types representing the raw data received from the server
namespace ProtoTypes {
    interface Node {
        txid: string;
        tx: string;
        parent_txid: string;
    }
    interface TreeLevel {
        nodes: Node[];
    }
    export interface Tree {
        levels: TreeLevel[];
    }

    // this interface is used to parse the event data received from the server
    // it is not exported because it has to be parsed to the associated SettlementEvent
    export interface EventData {
        id: string;
        round_tx?: string;
        vtxo_tree?: Tree;
        connectors?: string[];
        min_relay_fee_rate?: string;
        round_txid?: string;
        reason?: string;
        cosigners_pubkeys?: string[];
        unsigned_vtxo_tree?: Tree;
        unsigned_round_tx?: string;
        tree_nonces?: string;
    }
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

    async *getEventStream(): AsyncIterableIterator<SettlementEvent> {
        const url = `${this.serverUrl}/v1/events`;
        const eventSource = new EventSource(url);

        try {
            while (true) {
                const event = await new Promise<SettlementEvent>(
                    (resolve, reject) => {
                        eventSource.onmessage = (e) => {
                            try {
                                const data = JSON.parse(e.data);
                                const event = this.parseSettlementEvent(data);
                                if (event) {
                                    resolve(event);
                                }
                            } catch (err) {
                                console.error("Failed to parse event:", err);
                            }
                        };

                        eventSource.onerror = (err) => {
                            reject(err);
                        };
                    }
                );

                yield event;
            }
        } finally {
            eventSource.close();
        }
    }

    private toVtxoTree(t: ProtoTypes.Tree): VtxoTree {
        // collect the parent txids to determine later if a node is a leaf
        const parentTxids = new Set<string>();
        t.levels.forEach((level) =>
            level.nodes.forEach((node) => {
                if (node.parent_txid) {
                    parentTxids.add(node.parent_txid);
                }
            })
        );

        return new VtxoTree(
            t.levels.map((level) =>
                level.nodes.map((node) => ({
                    txid: node.txid,
                    tx: node.tx,
                    parentTxid: node.parent_txid,
                    leaf: !parentTxids.has(node.txid),
                }))
            )
        );
    }

    private parseSettlementEvent(
        data: ProtoTypes.EventData
    ): SettlementEvent | null {
        if (!data || typeof data !== "object" || !data.id) {
            console.warn("Invalid event data:", data);
            return null;
        }

        // Check for Finalization event
        if (
            data.round_tx &&
            data.vtxo_tree &&
            data.connectors &&
            data.min_relay_fee_rate
        ) {
            return {
                type: EventType.Finalization,
                id: data.id,
                roundTx: data.round_tx,
                vtxoTree: this.toVtxoTree(data.vtxo_tree),
                connectors: data.connectors,
                minRelayFeeRate: BigInt(data.min_relay_fee_rate),
            };
        }

        // Check for Finalized event
        if (data.round_txid) {
            return {
                type: EventType.Finalized,
                id: data.id,
                roundTxid: data.round_txid,
            };
        }

        // Check for Failed event
        if (data.reason) {
            return {
                type: EventType.Failed,
                id: data.id,
                reason: data.reason,
            };
        }

        // Check for Signing event
        if (
            data.cosigners_pubkeys &&
            data.unsigned_vtxo_tree &&
            data.unsigned_round_tx
        ) {
            return {
                type: EventType.Signing,
                id: data.id,
                cosignersPublicKeys: data.cosigners_pubkeys,
                unsignedVtxoTree: this.toVtxoTree(data.unsigned_vtxo_tree),
                unsignedRoundTx: data.unsigned_round_tx,
            };
        }

        // Check for SigningNoncesGenerated event
        if (data.tree_nonces) {
            return {
                type: EventType.SigningNoncesGenerated,
                id: data.id,
                treeNonces: data.tree_nonces,
            };
        }

        console.warn("Unknown event structure:", data);
        return null;
    }
}
