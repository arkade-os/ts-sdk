import type { Coin, ExtendedCoin, ExtendedVirtualCoin, VirtualCoin } from "..";
import { ReadonlyWallet } from "./wallet";
import { hex } from "@scure/base";

export const DUST_AMOUNT = 546; // sats

export function extendVirtualCoin(
    wallet: { offchainTapscript: ReadonlyWallet["offchainTapscript"] },
    vtxo: VirtualCoin
): ExtendedVirtualCoin {
    return {
        ...vtxo,
        forfeitTapLeafScript: wallet.offchainTapscript.forfeit(),
        intentTapLeafScript: wallet.offchainTapscript.forfeit(),
        tapTree: wallet.offchainTapscript.encode(),
    };
}

export function extendCoin(
    wallet: { boardingTapscript: ReadonlyWallet["boardingTapscript"] },
    utxo: Coin
): ExtendedCoin {
    return {
        ...utxo,
        forfeitTapLeafScript: wallet.boardingTapscript.forfeit(),
        intentTapLeafScript: wallet.boardingTapscript.forfeit(),
        tapTree: wallet.boardingTapscript.encode(),
    };
}

export function getRandomId(): string {
    const randomValue = crypto.getRandomValues(new Uint8Array(16));
    return hex.encode(randomValue);
}
