import { SettleParams, SendBitcoinParams, GetVtxosFilter } from "..";

/**
 * Request is the namespace that contains the request types for the service worker.
 */
export namespace Request {
    export type Type =
        | "INIT_WALLET"
        | "SETTLE"
        | "GET_ADDRESS"
        | "GET_BOARDING_ADDRESS"
        | "GET_BALANCE"
        | "GET_VTXOS"
        | "GET_VIRTUAL_COINS"
        | "GET_BOARDING_UTXOS"
        | "SEND_BITCOIN"
        | "GET_TRANSACTION_HISTORY"
        | "GET_STATUS"
        | "CLEAR"
        | "SIGN"
        | "SIGN_TRANSACTION";

    export interface Base {
        type: Type;
        id: string;
    }

    export function isBase(message: unknown): message is Base {
        return (
            typeof message === "object" && message !== null && "type" in message
        );
    }

    export interface InitWallet extends Base {
        type: "INIT_WALLET";
        privateKey: string;
        arkServerUrl: string;
        arkServerPublicKey?: string;
    }

    export function isInitWallet(message: Base): message is InitWallet {
        return (
            message.type === "INIT_WALLET" &&
            "arkServerUrl" in message &&
            typeof message.arkServerUrl === "string" &&
            "privateKey" in message &&
            typeof message.privateKey === "string" &&
            ("arkServerPublicKey" in message
                ? message.arkServerPublicKey === undefined ||
                  typeof message.arkServerPublicKey === "string"
                : true)
        );
    }

    export interface Settle extends Base {
        type: "SETTLE";
        params?: SettleParams;
    }

    export function isSettle(message: Base): message is Settle {
        return message.type === "SETTLE";
    }

    export interface GetAddress extends Base {
        type: "GET_ADDRESS";
    }

    export function isGetAddress(message: Base): message is GetAddress {
        return message.type === "GET_ADDRESS";
    }

    export interface GetBoardingAddress extends Base {
        type: "GET_BOARDING_ADDRESS";
    }

    export function isGetBoardingAddress(
        message: Base
    ): message is GetBoardingAddress {
        return message.type === "GET_BOARDING_ADDRESS";
    }

    export interface GetBalance extends Base {
        type: "GET_BALANCE";
    }

    export function isGetBalance(message: Base): message is GetBalance {
        return message.type === "GET_BALANCE";
    }

    export interface GetVtxos extends Base {
        type: "GET_VTXOS";
        filter?: GetVtxosFilter;
    }

    export function isGetVtxos(message: Base): message is GetVtxos {
        return message.type === "GET_VTXOS";
    }

    export interface GetVirtualCoins extends Base {
        type: "GET_VIRTUAL_COINS";
    }

    export function isGetVirtualCoins(
        message: Base
    ): message is GetVirtualCoins {
        return message.type === "GET_VIRTUAL_COINS";
    }

    export interface GetBoardingUtxos extends Base {
        type: "GET_BOARDING_UTXOS";
    }

    export function isGetBoardingUtxos(
        message: Base
    ): message is GetBoardingUtxos {
        return message.type === "GET_BOARDING_UTXOS";
    }

    export interface SendBitcoin extends Base {
        type: "SEND_BITCOIN";
        params: SendBitcoinParams;
    }

    export function isSendBitcoin(message: Base): message is SendBitcoin {
        return (
            message.type === "SEND_BITCOIN" &&
            "params" in message &&
            message.params !== null &&
            typeof message.params === "object" &&
            "address" in message.params &&
            typeof message.params.address === "string" &&
            "amount" in message.params &&
            typeof message.params.amount === "number"
        );
    }

    export interface GetTransactionHistory extends Base {
        type: "GET_TRANSACTION_HISTORY";
    }

    export function isGetTransactionHistory(
        message: Base
    ): message is GetTransactionHistory {
        return message.type === "GET_TRANSACTION_HISTORY";
    }

    export interface GetStatus extends Base {
        type: "GET_STATUS";
    }

    export function isGetStatus(message: Base): message is GetStatus {
        return message.type === "GET_STATUS";
    }

    export interface Clear extends Base {
        type: "CLEAR";
    }

    export interface Sign extends Base {
        type: "SIGN";
        tx: string;
        inputIndexes?: number[];
    }

    export function isSign(message: Base): message is Sign {
        return (
            message.type === "SIGN" &&
            "tx" in message &&
            typeof message.tx === "string" &&
            ("inputIndexes" in message && message.inputIndexes != undefined
                ? Array.isArray(message.inputIndexes) &&
                  message.inputIndexes.every(
                      (index) => typeof index === "number"
                  )
                : true)
        );
    }

    export interface SignTransaction extends Base {
        type: "SIGN_TRANSACTION";
        transaction: number[]; // Serialized PSBT as number array
        inputIndexes?: number[];
    }

    export function isSignTransaction(
        message: Base
    ): message is SignTransaction {
        return (
            message.type === "SIGN_TRANSACTION" &&
            "transaction" in message &&
            Array.isArray(message.transaction) &&
            message.transaction.every(
                (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255
            ) &&
            ("inputIndexes" in message && message.inputIndexes != undefined
                ? Array.isArray(message.inputIndexes) &&
                  message.inputIndexes.every(
                      (index) => Number.isInteger(index) && index >= 0
                  )
                : true)
        );
    }
}
