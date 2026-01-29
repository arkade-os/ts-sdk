import { hex } from "@scure/base";
import {
    WalletBalance,
    VirtualCoin,
    ArkTransaction,
    IWallet,
    Coin,
    ExtendedCoin,
} from "..";
import { ExtendedVirtualCoin } from "../..";
import { SettlementEvent } from "../../providers/ark";
import type {
    Contract,
    ContractVtxo,
    ContractBalance,
    ContractEvent,
    ContractWithVtxos,
    PathSelection,
} from "../../contracts";

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
        | "UTXO_UPDATE"
        // Contract operations
        | "CONTRACTS"
        | "CONTRACT"
        | "CONTRACT_CREATED"
        | "CONTRACT_STATE_UPDATED"
        | "CONTRACT_UPDATED"
        | "CONTRACT_DATA_UPDATED"
        | "CONTRACT_DELETED"
        | "CONTRACT_VTXOS"
        | "CONTRACT_VTXOS_FOR_CONTRACT"
        | "CONTRACT_BALANCE"
        | "CONTRACT_BALANCES"
        | "TOTAL_CONTRACT_BALANCE"
        | "SPENDABLE_PATHS"
        | "ALL_SPENDING_PATHS"
        | "CAN_SPEND"
        | "SPENDING_PATH"
        | "CONTRACTS_WITH_VTXOS"
        | "CONTRACT_WATCHING"
        | "CONTRACT_EVENTS_SUBSCRIBED"
        | "CONTRACT_EVENTS_UNSUBSCRIBED"
        | "CONTRACT_MANAGER_DISPOSED"
        | "CONTRACT_EVENT";

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
        coins: ExtendedCoin[];
    }

    export function isUtxoUpdate(response: Base): response is UtxoUpdate {
        return response.type === "UTXO_UPDATE";
    }

    export function utxoUpdate(coins: ExtendedCoin[]): UtxoUpdate {
        return {
            type: "UTXO_UPDATE",
            id: getRandomId(), // spontaneous update, not tied to a request
            success: true,
            coins,
        };
    }

    // Contract operations

    export interface Contracts extends Base {
        type: "CONTRACTS";
        success: true;
        contracts: Contract[];
    }

    export function isContracts(response: Base): response is Contracts {
        return response.type === "CONTRACTS" && response.success === true;
    }

    export function contracts(id: string, contracts: Contract[]): Contracts {
        return {
            type: "CONTRACTS",
            success: true,
            contracts,
            id,
        };
    }

    export interface ContractsWithVtxos extends Base {
        type: "CONTRACTS_WITH_VTXOS";
        success: true;
        contracts: ContractWithVtxos[];
    }

    export function isContractsWithVtxos(
        response: Base
    ): response is ContractsWithVtxos {
        return (
            response.type === "CONTRACTS_WITH_VTXOS" &&
            response.success === true
        );
    }

    export function contractsWithVtxos(
        id: string,
        contracts: ContractWithVtxos[]
    ): ContractsWithVtxos {
        return {
            type: "CONTRACTS_WITH_VTXOS",
            success: true,
            contracts,
            id,
        };
    }

    export interface ContractResponse extends Base {
        type: "CONTRACT";
        success: true;
        contract: Contract | undefined;
    }

    export function isContract(response: Base): response is ContractResponse {
        return response.type === "CONTRACT" && response.success === true;
    }

    export function contract(
        id: string,
        contract: Contract | undefined
    ): ContractResponse {
        return {
            type: "CONTRACT",
            success: true,
            contract,
            id,
        };
    }

    export interface ContractCreated extends Base {
        type: "CONTRACT_CREATED";
        success: true;
        contract: Contract;
    }

    export function isContractCreated(
        response: Base
    ): response is ContractCreated {
        return (
            response.type === "CONTRACT_CREATED" && response.success === true
        );
    }

    export function contractCreated(
        id: string,
        contract: Contract
    ): ContractCreated {
        return {
            type: "CONTRACT_CREATED",
            success: true,
            contract,
            id,
        };
    }

    export interface ContractStateUpdated extends Base {
        type: "CONTRACT_STATE_UPDATED";
        success: true;
    }

    export function isContractStateUpdated(
        response: Base
    ): response is ContractStateUpdated {
        return (
            response.type === "CONTRACT_STATE_UPDATED" &&
            response.success === true
        );
    }

    export function contractStateUpdated(id: string): ContractStateUpdated {
        return {
            type: "CONTRACT_STATE_UPDATED",
            success: true,
            id,
        };
    }

    export interface ContractUpdated extends Base {
        type: "CONTRACT_UPDATED";
        success: true;
        contract: Contract;
    }

    export function isContractUpdated(
        response: Base
    ): response is ContractUpdated {
        return (
            response.type === "CONTRACT_UPDATED" && response.success === true
        );
    }

    export function contractUpdated(
        id: string,
        contract: Contract
    ): ContractUpdated {
        return {
            type: "CONTRACT_UPDATED",
            success: true,
            contract,
            id,
        };
    }

    export interface ContractDataUpdated extends Base {
        type: "CONTRACT_DATA_UPDATED";
        success: true;
    }

    export function isContractDataUpdated(
        response: Base
    ): response is ContractDataUpdated {
        return (
            response.type === "CONTRACT_DATA_UPDATED" &&
            response.success === true
        );
    }

    export function contractDataUpdated(id: string): ContractDataUpdated {
        return {
            type: "CONTRACT_DATA_UPDATED",
            success: true,
            id,
        };
    }

    export interface ContractDeleted extends Base {
        type: "CONTRACT_DELETED";
        success: true;
    }

    export function isContractDeleted(
        response: Base
    ): response is ContractDeleted {
        return (
            response.type === "CONTRACT_DELETED" && response.success === true
        );
    }

    export function contractDeleted(id: string): ContractDeleted {
        return {
            type: "CONTRACT_DELETED",
            success: true,
            id,
        };
    }

    export interface ContractVtxosResponse extends Base {
        type: "CONTRACT_VTXOS";
        success: true;
        vtxos: Map<string, ContractVtxo[]>;
    }

    export function isContractVtxos(
        response: Base
    ): response is ContractVtxosResponse {
        return response.type === "CONTRACT_VTXOS" && response.success === true;
    }

    export function contractVtxos(
        id: string,
        vtxos: Map<string, ContractVtxo[]>
    ): ContractVtxosResponse {
        return {
            type: "CONTRACT_VTXOS",
            success: true,
            vtxos,
            id,
        };
    }

    export interface ContractVtxosForContractResponse extends Base {
        type: "CONTRACT_VTXOS_FOR_CONTRACT";
        success: true;
        vtxos: ContractVtxo[];
    }

    export function isContractVtxosForContract(
        response: Base
    ): response is ContractVtxosForContractResponse {
        return (
            response.type === "CONTRACT_VTXOS_FOR_CONTRACT" &&
            response.success === true
        );
    }

    export function contractVtxosForContract(
        id: string,
        vtxos: ContractVtxo[]
    ): ContractVtxosForContractResponse {
        return {
            type: "CONTRACT_VTXOS_FOR_CONTRACT",
            success: true,
            vtxos,
            id,
        };
    }

    export interface ContractBalanceResponse extends Base {
        type: "CONTRACT_BALANCE";
        success: true;
        balance: ContractBalance;
    }

    export function isContractBalance(
        response: Base
    ): response is ContractBalanceResponse {
        return (
            response.type === "CONTRACT_BALANCE" && response.success === true
        );
    }

    export function contractBalance(
        id: string,
        balance: ContractBalance
    ): ContractBalanceResponse {
        return {
            type: "CONTRACT_BALANCE",
            success: true,
            balance,
            id,
        };
    }

    export interface ContractBalancesResponse extends Base {
        type: "CONTRACT_BALANCES";
        success: true;
        balances: Map<string, ContractBalance>;
    }

    export function isContractBalances(
        response: Base
    ): response is ContractBalancesResponse {
        return (
            response.type === "CONTRACT_BALANCES" && response.success === true
        );
    }

    export function contractBalances(
        id: string,
        balances: Map<string, ContractBalance>
    ): ContractBalancesResponse {
        return {
            type: "CONTRACT_BALANCES",
            success: true,
            balances,
            id,
        };
    }

    export interface TotalContractBalanceResponse extends Base {
        type: "TOTAL_CONTRACT_BALANCE";
        success: true;
        balance: ContractBalance;
    }

    export function isTotalContractBalance(
        response: Base
    ): response is TotalContractBalanceResponse {
        return (
            response.type === "TOTAL_CONTRACT_BALANCE" &&
            response.success === true
        );
    }

    export function totalContractBalance(
        id: string,
        balance: ContractBalance
    ): TotalContractBalanceResponse {
        return {
            type: "TOTAL_CONTRACT_BALANCE",
            success: true,
            balance,
            id,
        };
    }

    export interface SpendablePathsResponse extends Base {
        type: "SPENDABLE_PATHS";
        success: true;
        paths: PathSelection[];
    }

    export function isSpendablePaths(
        response: Base
    ): response is SpendablePathsResponse {
        return response.type === "SPENDABLE_PATHS" && response.success === true;
    }

    export function spendablePaths(
        id: string,
        paths: PathSelection[]
    ): SpendablePathsResponse {
        return {
            type: "SPENDABLE_PATHS",
            success: true,
            paths,
            id,
        };
    }

    export interface AllSpendingPathsResponse extends Base {
        type: "ALL_SPENDING_PATHS";
        success: true;
        paths: PathSelection[];
    }

    export function isAllSpendingPaths(
        response: Base
    ): response is AllSpendingPathsResponse {
        return (
            response.type === "ALL_SPENDING_PATHS" && response.success === true
        );
    }

    export function allSpendingPaths(
        id: string,
        paths: PathSelection[]
    ): AllSpendingPathsResponse {
        return {
            type: "ALL_SPENDING_PATHS",
            success: true,
            paths,
            id,
        };
    }

    export interface CanSpendResponse extends Base {
        type: "CAN_SPEND";
        success: true;
        canSpend: boolean;
    }

    export function isCanSpend(response: Base): response is CanSpendResponse {
        return response.type === "CAN_SPEND" && response.success === true;
    }

    export function canSpend(id: string, canSpend: boolean): CanSpendResponse {
        return {
            type: "CAN_SPEND",
            success: true,
            canSpend,
            id,
        };
    }

    export interface SpendingPathResponse extends Base {
        type: "SPENDING_PATH";
        success: true;
        path: PathSelection | null;
    }

    export function isSpendingPath(
        response: Base
    ): response is SpendingPathResponse {
        return response.type === "SPENDING_PATH" && response.success === true;
    }

    export function spendingPath(
        id: string,
        path: PathSelection | null
    ): SpendingPathResponse {
        return {
            type: "SPENDING_PATH",
            success: true,
            path,
            id,
        };
    }

    export interface ContractWatchingResponse extends Base {
        type: "CONTRACT_WATCHING";
        success: true;
        isWatching: boolean;
    }

    export function isContractWatching(
        response: Base
    ): response is ContractWatchingResponse {
        return (
            response.type === "CONTRACT_WATCHING" && response.success === true
        );
    }

    export function contractWatching(
        id: string,
        isWatching: boolean
    ): ContractWatchingResponse {
        return {
            type: "CONTRACT_WATCHING",
            success: true,
            isWatching,
            id,
        };
    }

    export interface ContractEventsSubscribed extends Base {
        type: "CONTRACT_EVENTS_SUBSCRIBED";
        success: true;
    }

    export function isContractEventsSubscribed(
        response: Base
    ): response is ContractEventsSubscribed {
        return (
            response.type === "CONTRACT_EVENTS_SUBSCRIBED" &&
            response.success === true
        );
    }

    export function contractEventsSubscribed(
        id: string
    ): ContractEventsSubscribed {
        return {
            type: "CONTRACT_EVENTS_SUBSCRIBED",
            success: true,
            id,
        };
    }

    export interface ContractEventsUnsubscribed extends Base {
        type: "CONTRACT_EVENTS_UNSUBSCRIBED";
        success: true;
    }

    export function isContractEventsUnsubscribed(
        response: Base
    ): response is ContractEventsUnsubscribed {
        return (
            response.type === "CONTRACT_EVENTS_UNSUBSCRIBED" &&
            response.success === true
        );
    }

    export function contractEventsUnsubscribed(
        id: string
    ): ContractEventsUnsubscribed {
        return {
            type: "CONTRACT_EVENTS_UNSUBSCRIBED",
            success: true,
            id,
        };
    }

    export interface ContractManagerDisposed extends Base {
        type: "CONTRACT_MANAGER_DISPOSED";
        success: true;
    }

    export function isContractManagerDisposed(
        response: Base
    ): response is ContractManagerDisposed {
        return (
            response.type === "CONTRACT_MANAGER_DISPOSED" &&
            response.success === true
        );
    }

    export function contractManagerDisposed(
        id: string
    ): ContractManagerDisposed {
        return {
            type: "CONTRACT_MANAGER_DISPOSED",
            success: true,
            id,
        };
    }

    export interface ContractEventResponse extends Base {
        type: "CONTRACT_EVENT";
        success: true;
        event: ContractEvent;
    }

    export function isContractEvent(
        response: Base
    ): response is ContractEventResponse {
        return response.type === "CONTRACT_EVENT" && response.success === true;
    }

    export function contractEvent(event: ContractEvent): ContractEventResponse {
        return {
            type: "CONTRACT_EVENT",
            id: getRandomId(), // spontaneous event, not tied to a request
            success: true,
            event,
        };
    }
}
