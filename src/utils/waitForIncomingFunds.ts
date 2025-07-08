import { Coin, VirtualCoin, Wallet } from "..";

export async function waitForIncomingFunds(
    wallet: Wallet
): Promise<Coin[] | VirtualCoin[]> {
    return new Promise(async (resolve) => {
        const stopFunc = await wallet.notifyIncomingFunds(
            (coins: Coin[] | VirtualCoin[]) => {
                resolve(coins);
                stopFunc();
            }
        );
    });
}
