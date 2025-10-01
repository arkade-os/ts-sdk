import type { ExtendedVirtualCoin, VirtualCoin, Wallet } from "..";

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
