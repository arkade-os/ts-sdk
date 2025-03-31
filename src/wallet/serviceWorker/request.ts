import { NetworkName } from "../../networks";
import { SettleParams, SendBitcoinParams } from "..";

export namespace Request {
    export type Type =
        | "INIT_WALLET"
        | "SETTLE"
        | "GET_ADDRESS"
        | "GET_BALANCE"
        | "GET_COINS"
        | "GET_VTXOS"
        | "GET_VIRTUAL_COINS"
        | "GET_BOARDING_UTXOS"
        | "SEND_BITCOIN"
        | "GET_TRANSACTION_HISTORY"
        | "GET_STATUS"
        | "CLEAR";

    export interface Base {
        type: Type;
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
        network: NetworkName;
        arkServerPublicKey?: string;
    }

    export function isInitWallet(message: Base): message is InitWallet {
        return (
            message.type === "INIT_WALLET" &&
            "privateKey" in message &&
            typeof message.privateKey === "string" &&
            "arkServerUrl" in message &&
            typeof message.arkServerUrl === "string" &&
            "network" in message &&
            typeof message.network === "string" &&
            ("arkServerPublicKey" in message
                ? typeof message.arkServerPublicKey === "string" ||
                  message.arkServerPublicKey === undefined
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

    export interface GetBalance extends Base {
        type: "GET_BALANCE";
    }

    export function isGetBalance(message: Base): message is GetBalance {
        return message.type === "GET_BALANCE";
    }

    export interface GetCoins extends Base {
        type: "GET_COINS";
    }

    export function isGetCoins(message: Base): message is GetCoins {
        return message.type === "GET_COINS";
    }

    export interface GetVtxos extends Base {
        type: "GET_VTXOS";
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
        zeroFee?: boolean;
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
}
