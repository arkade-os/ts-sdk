import type { Coin, ExtendedCoin, ExtendedVirtualCoin, VirtualCoin } from "..";
import { ReadonlyWallet } from "./wallet";

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
