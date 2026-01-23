import { SettleParams, SendBitcoinParams, GetVtxosFilter } from "..";
import type {
    Contract,
    ContractState,
    GetContractsFilter,
} from "../../contracts";
import { GetSpendablePathsOptions } from "../../contracts/contractManager";

/**
 * Request is the namespace that contains the request types for the service worker.
 */
export namespace Request {
    export type Type =
        | "INIT_WALLET"
        | "RELOAD_WALLET"
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
        // Contract operations
        | "CREATE_CONTRACT"
        | "GET_CONTRACTS"
        | "GET_CONTRACTS_WITH_VTXOS"
        | "UPDATE_CONTRACT"
        | "UPDATE_CONTRACT_STATE"
        | "DELETE_CONTRACT"
        | "GET_SPENDABLE_PATHS"
        | "IS_CONTRACT_MANAGER_WATCHING"
        | "SUBSCRIBE_CONTRACT_EVENTS"
        | "UNSUBSCRIBE_CONTRACT_EVENTS";

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
        key: { privateKey: string } | { publicKey: string };
        arkServerUrl: string;
        arkServerPublicKey?: string;
    }

    export function isInitWallet(message: Base): message is InitWallet {
        return (
            message.type === "INIT_WALLET" &&
            "arkServerUrl" in message &&
            typeof message.arkServerUrl === "string" &&
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

    export function isClear(message: Base): message is Clear {
        return message.type === "CLEAR";
    }

    export interface ReloadWallet extends Base {
        type: "RELOAD_WALLET";
    }

    export function isReloadWallet(message: Base): message is ReloadWallet {
        return message.type === "RELOAD_WALLET";
    }

    // Contract operations

    export interface GetContracts extends Base {
        type: "GET_CONTRACTS";
        filter?: GetContractsFilter;
    }

    export function isGetContracts(message: Base): message is GetContracts {
        return message.type === "GET_CONTRACTS";
    }

    export interface GetContractsWithVtxos extends Base {
        type: "GET_CONTRACTS_WITH_VTXOS";
        filter?: GetContractsFilter;
    }

    export function isGetContractsVtxos(
        message: Base
    ): message is GetContractsWithVtxos {
        return message.type === "GET_CONTRACTS_WITH_VTXOS";
    }

    export interface CreateContract extends Base {
        type: "CREATE_CONTRACT";
        params: {
            type: string;
            params: Record<string, string>;
            script: string;
            address: string;
            id?: string;
            label?: string;
            state?: ContractState;
            expiresAt?: number;
            data?: Record<string, string>;
            metadata?: Record<string, unknown>;
        };
    }

    export function isCreateContract(message: Base): message is CreateContract {
        return (
            message.type === "CREATE_CONTRACT" &&
            "params" in message &&
            typeof message.params === "object" &&
            message.params !== null &&
            "type" in message.params &&
            "params" in message.params &&
            "script" in message.params &&
            "address" in message.params
        );
    }

    export interface UpdateContract extends Base {
        type: "UPDATE_CONTRACT";
        contractId: string;
        updates: Partial<Omit<Contract, "id" | "createdAt">>;
    }

    export function isUpdateContract(message: Base): message is UpdateContract {
        return (
            message.type === "UPDATE_CONTRACT" &&
            "contractId" in message &&
            typeof message.contractId === "string" &&
            "updates" in message &&
            typeof message.updates === "object"
        );
    }

    export interface UpdateContractState extends Base {
        type: "UPDATE_CONTRACT_STATE";
        contractId: string;
        state: ContractState;
    }

    export function isUpdateContractState(
        message: Base
    ): message is UpdateContractState {
        return (
            message.type === "UPDATE_CONTRACT_STATE" &&
            "contractId" in message &&
            typeof message.contractId === "string" &&
            "state" in message &&
            (message.state === "active" || message.state === "inactive")
        );
    }

    export interface DeleteContract extends Base {
        type: "DELETE_CONTRACT";
        contractId: string;
    }

    export function isDeleteContract(message: Base): message is DeleteContract {
        return (
            message.type === "DELETE_CONTRACT" &&
            "contractId" in message &&
            typeof message.contractId === "string"
        );
    }

    export interface GetSpendablePaths extends Base {
        type: "GET_SPENDABLE_PATHS";
        options: GetSpendablePathsOptions;
    }

    export function isGetSpendablePaths(
        message: Base
    ): message is GetSpendablePaths {
        return message.type === "GET_SPENDABLE_PATHS";
    }

    export interface isContractManagerWatching extends Base {
        type: "IS_CONTRACT_MANAGER_WATCHING";
    }

    export function isIsContractWatching(
        message: Base
    ): message is isContractManagerWatching {
        return message.type === "IS_CONTRACT_MANAGER_WATCHING";
    }

    export interface SubscribeContractEvents extends Base {
        type: "SUBSCRIBE_CONTRACT_EVENTS";
    }

    export function isSubscribeContractEvents(
        message: Base
    ): message is SubscribeContractEvents {
        return message.type === "SUBSCRIBE_CONTRACT_EVENTS";
    }

    export interface UnsubscribeContractEvents extends Base {
        type: "UNSUBSCRIBE_CONTRACT_EVENTS";
    }

    export function isUnsubscribeContractEvents(
        message: Base
    ): message is UnsubscribeContractEvents {
        return message.type === "UNSUBSCRIBE_CONTRACT_EVENTS";
    }
}
