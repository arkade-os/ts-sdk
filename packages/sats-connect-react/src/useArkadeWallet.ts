import { useContext } from "react";
import { ArkadeWalletContext } from "./ArkadeWalletProvider";
import type { ArkadeWalletContextType } from "./types";

export function useArkadeWallet<
    TNetwork extends string = string,
>(): ArkadeWalletContextType<TNetwork> {
    const context = useContext(ArkadeWalletContext);
    if (!context) {
        throw new Error("useArkadeWallet must be used within ArkadeWalletProvider");
    }
    return context as unknown as ArkadeWalletContextType<TNetwork>;
}
