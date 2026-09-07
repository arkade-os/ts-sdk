import type { Params, Requests, RpcResult } from "sats-connect";

export type SatsConnectRequest = <Method extends keyof Requests>(
    method: Method,
    params: Params<Method>,
    providerId?: string,
) => Promise<RpcResult<Method>>;

export type SatsConnectNetwork = "Mainnet" | "Testnet" | "Signet" | "Regtest";

export interface ArkadeWalletConfig {
    arkServerUrl: string;
    esploraUrl: string;
    satsConnectNetwork?: SatsConnectNetwork;
    connectMessage?: string;
    providerId?: string;
    satsConnectRequest?: SatsConnectRequest;
    checkProvider?: boolean;
}

export interface ArkadeWalletInfo {
    arkAddress: string;
    boardingAddress: string;
    ordinalAddress: string;
    paymentAddress: string;
    userPubKey: string;
}
