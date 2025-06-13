import { TxTree } from "../tree/vtxoTree";
import { VirtualCoin } from "../wallet";
import { ProtoTypes, Round } from "./ark";

type IndexerGetVirtualCoinsVtxoResponse = {
    outpoint: {
        txid: string;
        vout: number;
    };
    createdAt: string;
    expiresAt: string;
    amount: string;
    script: string;
    isLeaf: boolean;
    isSwept: boolean;
    isSpent: boolean;
    spentBy: string;
    commitmentTxid: string;
};

type IndexerGetVirtualCoinsResponse = {
    vtxos: IndexerGetVirtualCoinsVtxoResponse[];
    page: number;
};

export interface IndexerProvider {
    GetCommitmentTx(txid: string): Promise<Round>;
    getVirtualCoins(address: string): Promise<{
        spendableVtxos: VirtualCoin[];
        spentVtxos: VirtualCoin[];
    }>;
    subscribeForScripts(
        scripts: string[],
        abortSignal: AbortSignal
    ): AsyncIterableIterator<{
        newVtxos: VirtualCoin[];
        spentVtxos: VirtualCoin[];
    }>;
}

export class RestIndexerProvider implements IndexerProvider {
    constructor(public serverUrl: string) {}

    async getVirtualCoins(address: string): Promise<{
        spendableVtxos: VirtualCoin[];
        spentVtxos: VirtualCoin[];
    }> {
        const url = `${this.serverUrl}/v1/getVtxos/${address}`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch VTXOs: ${response.statusText}`);
        }
        const data = (await response.json()) as IndexerGetVirtualCoinsResponse;

        return {
            spendableVtxos: [...(data.vtxos || [])]
                .filter((v) => !v.isSpent)
                .map(convertVtxo),
            spentVtxos: [...(data.vtxos || [])]
                .filter((v) => v.isSpent)
                .map(convertVtxo),
        };
    }

    async GetCommitmentTx(txid: string): Promise<Round> {
        const url = `${this.serverUrl}/v1/commitmentTx/${txid}`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch round: ${response.statusText}`);
        }

        const data = (await response.json()) as { round: ProtoTypes.Round };
        const round = data.round;

        return {
            id: round.id,
            start: new Date(Number(round.start) * 1000), // Convert from Unix timestamp to Date
            end: new Date(Number(round.end) * 1000), // Convert from Unix timestamp to Date
            vtxoTree: this.toTxTree(round.vtxoTree),
            forfeitTxs: round.forfeitTxs || [],
            connectors: this.toTxTree(round.connectors),
        };
    }

    async *subscribeForScripts(
        scripts: string[],
        abortSignal: AbortSignal
    ): AsyncIterableIterator<{
        newVtxos: VirtualCoin[];
        spentVtxos: VirtualCoin[];
    }> {
        const response = await fetch(`${this.serverUrl}/v1/script/subscribe`, {
            headers: {
                Accept: "application/json",
            },
            method: "POST",
            body: JSON.stringify({ scripts }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to subscribe to scripts: ${errorText}`);
        }

        const { subscriptionId } = await response.json();
        if (!subscriptionId) throw new Error(`Subscription ID not found`);

        const url = `${this.serverUrl}/v1/script/subscription/${subscriptionId}`;

        while (!abortSignal.aborted) {
            try {
                const response = await fetch(url, {
                    headers: {
                        Accept: "application/json",
                    },
                });

                if (!response.ok) {
                    throw new Error(
                        `Unexpected status ${response.status} when subscribing to address updates`
                    );
                }

                if (!response.body) {
                    throw new Error("Response body is null");
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";

                while (!abortSignal.aborted) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");

                    for (let i = 0; i < lines.length - 1; i++) {
                        const line = lines[i].trim();
                        if (!line) continue;

                        try {
                            const data = JSON.parse(line);
                            if ("result" in data) {
                                yield {
                                    newVtxos: (data.result.newVtxos || []).map(
                                        convertVtxo
                                    ),
                                    spentVtxos: (
                                        data.result.spentVtxos || []
                                    ).map(convertVtxo),
                                };
                            }
                        } catch (err) {
                            console.error(
                                "Failed to parse address update:",
                                err
                            );
                            throw err;
                        }
                    }

                    buffer = lines[lines.length - 1];
                }
            } catch (error) {
                console.error("Address subscription error:", error);
                throw error;
            }
        }
    }

    private toTxTree(t: ProtoTypes.Tree): TxTree {
        // collect the parent txids to determine later if a node is a leaf
        const parentTxids = new Set<string>();
        t.levels.forEach((level) =>
            level.nodes.forEach((node) => {
                if (node.parentTxid) {
                    parentTxids.add(node.parentTxid);
                }
            })
        );

        return new TxTree(
            t.levels.map((row, level) =>
                row.nodes.map((node, levelIndex) => ({
                    txid: node.txid,
                    tx: node.tx,
                    parentTxid: node.parentTxid,
                    leaf: !parentTxids.has(node.txid),
                    level,
                    levelIndex,
                }))
            )
        );
    }
}

function convertVtxo(vtxo: IndexerGetVirtualCoinsVtxoResponse): VirtualCoin {
    return {
        txid: vtxo.outpoint.txid,
        vout: vtxo.outpoint.vout,
        value: Number(vtxo.amount),
        status: {
            confirmed: !!vtxo.commitmentTxid,
        },
        virtualStatus: {
            state: vtxo.isLeaf ? "settled" : "pending",
            batchTxID: vtxo.commitmentTxid,
            batchExpiry: vtxo.expiresAt ? Number(vtxo.expiresAt) : undefined,
        },
        spentBy: vtxo.spentBy,
        createdAt: new Date(Number(vtxo.createdAt) * 1000),
    };
}
