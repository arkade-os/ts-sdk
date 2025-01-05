import type { Coin, Outpoint, VirtualCoin } from "../types/wallet";
import type { UTXO, VTXO } from "../types/internal";
import type { ArkEvent } from "./ark";

export interface OnchainProvider {
    getCoins(address: string): Promise<Coin[]>;
    getFeeRate(): Promise<number>;
    broadcastTransaction(txHex: string): Promise<string>;
}

export type NoteInput = string;

export type VtxoInput = {
    outpoint: Outpoint;
    tapscripts: string[];
};

export type Input = NoteInput | VtxoInput;

export type Output = {
    address: string; // onchain or off-chain
    amount: bigint; // Amount to send in satoshis
};

export interface ArkProvider {
    getVirtualCoins(address: string): Promise<VirtualCoin[]>;
    submitVirtualTx(psbtBase64: string): Promise<string>;
    subscribeToEvents(callback: (event: ArkEvent) => void): Promise<() => void>;
    registerInputsForNextRound(
        inputs: Input[],
        vtxoTreeSigningPublicKey: string
    ): Promise<{ paymentID: string }>;
    registerOutputsForNextRound(
        paymentID: string,
        outputs: Output[]
    ): Promise<void>;
    submitTreeNonces(
        settlementID: string,
        pubkey: string,
        nonces: string
    ): Promise<void>;
    submitTreeSignatures(
        settlementID: string,
        pubkey: string,
        signatures: string
    ): Promise<void>;
    submitSignedForfeitTxs(
        signedForfeitTxs: string[],
        signedRoundTx?: string
    ): Promise<void>;
    ping(paymentID: string): Promise<void>;
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

    abstract registerInputsForNextRound(
        inputs: Input[],
        vtxoTreeSigningPublicKey: string
    ): Promise<{ paymentID: string }>;

    abstract registerOutputsForNextRound(
        paymentID: string,
        outputs: Output[]
    ): Promise<void>;

    abstract submitTreeNonces(
        settlementID: string,
        pubkey: string,
        treeNonces: string
    ): Promise<void>;

    abstract submitTreeSignatures(
        settlementID: string,
        pubkey: string,
        treeSignatures: string
    ): Promise<void>;

    abstract submitSignedForfeitTxs(
        signedForfeitTxs: string[],
        signedRoundTx?: string
    ): Promise<void>;

    abstract ping(requestId: string): Promise<void>;

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
