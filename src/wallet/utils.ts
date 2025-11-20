import type {
    Coin,
    ExtendedCoin,
    ExtendedVirtualCoin,
    VirtualCoin,
    Wallet,
} from "..";

export const DUST_AMOUNT = 546; // sats

export function extendVirtualCoin(
    wallet: Wallet,
    vtxo: VirtualCoin
): ExtendedVirtualCoin {
    return {
        ...vtxo,
        forfeitTapLeafScript: wallet.offchainTapscript.forfeit(),
        intentTapLeafScript: wallet.offchainTapscript.exit(),
        tapTree: wallet.offchainTapscript.encode(),
    };
}

export function extendCoin(wallet: Wallet, utxo: Coin): ExtendedCoin {
    return {
        ...utxo,
        forfeitTapLeafScript: wallet.boardingTapscript.forfeit(),
        intentTapLeafScript: wallet.boardingTapscript.exit(),
        tapTree: wallet.boardingTapscript.encode(),
    };
}
