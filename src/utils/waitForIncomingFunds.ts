import { Coin, VirtualCoin, Wallet } from "..";

export async function waitForIncomingFunds(wallet: Wallet): Promise<Coin[]> {
    return new Promise((resolve) => {
        wallet.notifyIncomingFunds(
            (coins: Coin[] | VirtualCoin[], stopFunc) => {
                resolve(coins);
                stopFunc();
            }
        );
    });
}
