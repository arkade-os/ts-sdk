import { hex } from "@scure/base";
import { WalletBalance, VirtualCoin, ArkTransaction, IWallet, Coin } from "..";
import { ExtendedVirtualCoin } from "../..";
import { SettlementEvent } from "../../providers/ark";

function getRandomId(): string {
    const randomValue = crypto.getRandomValues(new Uint8Array(16));
    return hex.encode(randomValue);
}

/**
 * Response is the namespace that contains the response types for the service worker.
 */
export namespace Response {
    export type Type =
        | "WALLET_INITIALIZED"
        | "WALLET_RELOADED"
        | "SETTLE_EVENT"
        | "SETTLE_SUCCESS"
        | "ADDRESS"
        | "BOARDING_ADDRESS"
        | "BALANCE"
        | "VTXOS"
        | "VIRTUAL_COINS"
        | "BOARDING_UTXOS"
        | "SEND_BITCOIN_SUCCESS"
        | "TRANSACTION_HISTORY"
        | "WALLET_STATUS"
        | "ERROR"
        | "CLEAR_RESPONSE"
        | "VTXO_UPDATE"
        | "UTXO_UPDATE";

    export interface Base {
        type: Type;
        success: boolean;
        id: string;
    }

    export const walletInitialized = (id: string): Base => ({
        type: "WALLET_INITIALIZED",
        success: true,
        id,
    });

    export interface Error extends Base {
        type: "ERROR";
        success: false;
        message: string;
    }

    export function error(id: string, message: string): Error {
        return {
            type: "ERROR",
            success: false,
            message,
            id,
        };
    }

    export interface SettleEvent extends Base {
        type: "SETTLE_EVENT";
        success: true;
        event: SettlementEvent;
    }

    export function settleEvent(
        id: string,
        event: SettlementEvent
    ): SettleEvent {
        return {
            type: "SETTLE_EVENT",
            success: true,
            event,
            id,
        };
    }

    export interface SettleSuccess extends Base {
        type: "SETTLE_SUCCESS";
        success: true;
        txid: string;
    }

    export function settleSuccess(id: string, txid: string): SettleSuccess {
        return {
            type: "SETTLE_SUCCESS",
            success: true,
            txid,
            id,
        };
    }

    export function isSettleSuccess(response: Base): response is SettleSuccess {
        return response.type === "SETTLE_SUCCESS" && response.success;
    }

    export interface Address extends Base {
        type: "ADDRESS";
        success: true;
        address: string;
    }

    export function isAddress(response: Base): response is Address {
        return response.type === "ADDRESS" && response.success === true;
    }

    export function isBoardingAddress(
        response: Base
    ): response is BoardingAddress {
        return (
            response.type === "BOARDING_ADDRESS" && response.success === true
        );
    }

    export function address(id: string, address: string): Address {
        return {
            type: "ADDRESS",
            success: true,
            address,
            id,
        };
    }

    export interface BoardingAddress extends Base {
        type: "BOARDING_ADDRESS";
        success: true;
        address: string;
    }

    export function boardingAddress(
        id: string,
        address: string
    ): BoardingAddress {
        return {
            type: "BOARDING_ADDRESS",
            success: true,
            address,
            id,
        };
    }

    export interface Balance extends Base {
        type: "BALANCE";
        success: true;
        balance: WalletBalance;
    }

    export function isBalance(response: Base): response is Balance {
        return response.type === "BALANCE" && response.success === true;
    }

    export function balance(id: string, balance: WalletBalance): Balance {
        return {
            type: "BALANCE",
            success: true,
            balance,
            id,
        };
    }

    export interface Vtxos extends Base {
        type: "VTXOS";
        success: true;
        vtxos: Awaited<ReturnType<IWallet["getVtxos"]>>;
    }

    export function isVtxos(response: Base): response is Vtxos {
        return response.type === "VTXOS" && response.success === true;
    }

    export function vtxos(
        id: string,
        vtxos: Awaited<ReturnType<IWallet["getVtxos"]>>
    ): Vtxos {
        return {
            type: "VTXOS",
            success: true,
            vtxos,
            id,
        };
    }

    export interface VirtualCoins extends Base {
        type: "VIRTUAL_COINS";
        success: true;
        virtualCoins: VirtualCoin[];
    }

    export function isVirtualCoins(response: Base): response is VirtualCoins {
        return response.type === "VIRTUAL_COINS" && response.success === true;
    }

    export function virtualCoins(
        id: string,
        virtualCoins: VirtualCoin[]
    ): VirtualCoins {
        return {
            type: "VIRTUAL_COINS",
            success: true,
            virtualCoins,
            id,
        };
    }

    export interface BoardingUtxos extends Base {
        type: "BOARDING_UTXOS";
        success: true;
        boardingUtxos: Awaited<ReturnType<IWallet["getBoardingUtxos"]>>;
    }

    export function isBoardingUtxos(response: Base): response is BoardingUtxos {
        return response.type === "BOARDING_UTXOS" && response.success === true;
    }

    export function boardingUtxos(
        id: string,
        boardingUtxos: Awaited<ReturnType<IWallet["getBoardingUtxos"]>>
    ): BoardingUtxos {
        return {
            type: "BOARDING_UTXOS",
            success: true,
            boardingUtxos,
            id,
        };
    }

    export interface SendBitcoinSuccess extends Base {
        type: "SEND_BITCOIN_SUCCESS";
        success: true;
        txid: string;
    }

    export function isSendBitcoinSuccess(
        response: Base
    ): response is SendBitcoinSuccess {
        return (
            response.type === "SEND_BITCOIN_SUCCESS" &&
            response.success === true
        );
    }

    export function sendBitcoinSuccess(
        id: string,
        txid: string
    ): SendBitcoinSuccess {
        return {
            type: "SEND_BITCOIN_SUCCESS",
            success: true,
            txid,
            id,
        };
    }

    export interface TransactionHistory extends Base {
        type: "TRANSACTION_HISTORY";
        success: true;
        transactions: ArkTransaction[];
    }

    export function isTransactionHistory(
        response: Base
    ): response is TransactionHistory {
        return (
            response.type === "TRANSACTION_HISTORY" && response.success === true
        );
    }

    export function transactionHistory(
        id: string,
        transactions: ArkTransaction[]
    ): TransactionHistory {
        return {
            type: "TRANSACTION_HISTORY",
            success: true,
            transactions,
            id,
        };
    }

    export interface WalletStatus extends Base {
        type: "WALLET_STATUS";
        success: true;
        status: {
            walletInitialized: boolean;
            xOnlyPublicKey: Uint8Array | undefined;
        };
    }

    export function isWalletStatus(response: Base): response is WalletStatus {
        return response.type === "WALLET_STATUS" && response.success === true;
    }

    export function walletStatus(
        id: string,
        walletInitialized: boolean,
        xOnlyPublicKey: Uint8Array | undefined
    ): WalletStatus {
        return {
            type: "WALLET_STATUS",
            success: true,
            status: {
                walletInitialized,
                xOnlyPublicKey,
            },
            id,
        };
    }

    export interface ClearResponse extends Base {
        type: "CLEAR_RESPONSE";
    }

    export function isClearResponse(response: Base): response is ClearResponse {
        return response.type === "CLEAR_RESPONSE";
    }

    export function clearResponse(id: string, success: boolean): ClearResponse {
        return {
            type: "CLEAR_RESPONSE",
            success,
            id,
        };
    }

    export interface WalletReloaded extends Base {
        type: "WALLET_RELOADED";
    }

    export function isWalletReloaded(
        response: Base
    ): response is WalletReloaded {
        return response.type === "WALLET_RELOADED";
    }

    export function walletReloaded(
        id: string,
        success: boolean
    ): WalletReloaded {
        return {
            type: "WALLET_RELOADED",
            success,
            id,
        };
    }

    export interface VtxoUpdate extends Base {
        type: "VTXO_UPDATE";
        spentVtxos: ExtendedVirtualCoin[];
        newVtxos: ExtendedVirtualCoin[];
    }

    export function isVtxoUpdate(response: Base): response is VtxoUpdate {
        return response.type === "VTXO_UPDATE";
    }

    export function vtxoUpdate(
        newVtxos: ExtendedVirtualCoin[],
        spentVtxos: ExtendedVirtualCoin[]
    ): VtxoUpdate {
        return {
            type: "VTXO_UPDATE",
            id: getRandomId(), // spontaneous update, not tied to a request
            success: true,
            spentVtxos,
            newVtxos,
        };
    }

    export interface UtxoUpdate extends Base {
        type: "UTXO_UPDATE";
        coins: Coin[];
    }

    export function isUtxoUpdate(response: Base): response is UtxoUpdate {
        return response.type === "UTXO_UPDATE";
    }

    export function utxoUpdate(coins: Coin[]): UtxoUpdate {
        return {
            type: "UTXO_UPDATE",
            id: getRandomId(), // spontaneous update, not tied to a request
            success: true,
            coins,
        };
    }
}
