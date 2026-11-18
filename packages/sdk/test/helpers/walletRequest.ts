import { expect } from "vitest";
import { DEFAULT_ARKADE_SERVER_URL, type NetworkName } from "../../src/networks";
import type { WalletRequestBinding } from "../../src/wallet/serviceWorker/wallet-request";
import { vtxoReservationScope } from "../../src/wallet/vtxoReservationScope";

export function testWalletBinding(
    publicKey: Uint8Array,
    operatorUrl: string = DEFAULT_ARKADE_SERVER_URL,
    network: NetworkName = "bitcoin",
): WalletRequestBinding {
    return { scope: vtxoReservationScope(operatorUrl, publicKey), network };
}

export function bindTestWallet<T>(wallet: T, binding: WalletRequestBinding): T {
    return Object.assign(wallet as T & object, {
        expectedWalletScope: binding.scope,
        expectedNetwork: binding.network,
        walletRequestBinding: binding,
    });
}

export function scopedWalletRequest(request: any, binding: WalletRequestBinding): any {
    return {
        type: "SCOPED_WALLET_REQUEST_V1",
        id: request.id,
        tag: request.tag,
        payload: { binding, request },
    };
}

export function walletRequestOf(message: any): any {
    return message.type === "SCOPED_WALLET_REQUEST_V1" ? message.payload.request : message;
}

export function scopedRequestMatching(request: unknown): unknown {
    return expect.objectContaining({
        type: "SCOPED_WALLET_REQUEST_V1",
        payload: expect.objectContaining({
            binding: { scope: expect.any(String), network: "bitcoin" },
            request,
        }),
    });
}
