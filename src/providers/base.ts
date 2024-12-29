import type { Coin, VirtualCoin } from "../types/wallet";
import type { UTXO, VTXO } from "../types/internal";
import type { ArkEvent } from "./ark";

export interface OnchainProvider {
    getCoins(address: string): Promise<Coin[]>;
    getFeeRate(): Promise<number>;
    broadcastTransaction(txHex: string): Promise<string>;
}

export interface ArkProvider {
    getVirtualCoins(address: string): Promise<VirtualCoin[]>;
    submitVirtualTx(psbtBase64: string): Promise<string>;
    subscribeToEvents(callback: (event: ArkEvent) => void): Promise<() => void>;
}

export abstract class BaseOnchainProvider implements OnchainProvider {
    constructor(protected baseUrl: string) {}

    abstract getCoins(address: string): Promise<Coin[]>;
    abstract getFeeRate(): Promise<number>;
    abstract broadcastTransaction(txHex: string): Promise<string>;

    protected convertUTXOsToCoin(utxos: UTXO[]): Coin[] {
        return utxos.map((utxo) => ({
            txid: utxo.txid,
            vout: utxo.vout,
            value: utxo.value,
            status: utxo.status,
        }));
    }
}

export abstract class BaseArkProvider implements ArkProvider {
    constructor(
        protected serverUrl: string,
        protected serverPublicKey: string
    ) {}

    abstract getVirtualCoins(address: string): Promise<VirtualCoin[]>;
    abstract submitVirtualTx(psbtBase64: string): Promise<string>;
    abstract subscribeToEvents(
        callback: (event: ArkEvent) => void
    ): Promise<() => void>;

    protected convertVTXOsToVirtualCoin(vtxos: VTXO[]): VirtualCoin[] {
        return vtxos.map((vtxo) => ({
            txid: vtxo.txid,
            vout: vtxo.vout,
            value: vtxo.value,
            status: {
                confirmed:
                    vtxo.status.state === "settled" &&
                    !!vtxo.status.batchOutpoint,
                block_height: undefined,
                block_hash: undefined,
                block_time: undefined,
            },
            virtualStatus: {
                state: vtxo.status.state,
                batchTxID: vtxo.status.batchOutpoint?.txid,
                batchExpiry: vtxo.status.batchExpiry,
            },
        }));
    }

    get url(): string {
        return this.serverUrl;
    }

    get pubkey(): string {
        return this.serverPublicKey;
    }
}
