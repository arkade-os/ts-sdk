import type { NetworkName } from "../../networks";
import type { WalletRequest, WalletUpdaterRequest } from "./wallet-message-handler";

export type WalletRequestBinding = { readonly scope: string; readonly network: NetworkName };

export function walletOperation(message: WalletUpdaterRequest): WalletRequest | undefined {
    if (message.type !== "SCOPED_WALLET_REQUEST_V1") return message;
    const request = message.payload?.request;
    return request && typeof request.type === "string" ? request : undefined;
}

export function requiresWalletScope(request: WalletRequest): boolean {
    switch (request.type) {
        case "GET_STATUS":
            return false;
        default:
            return true;
    }
}
