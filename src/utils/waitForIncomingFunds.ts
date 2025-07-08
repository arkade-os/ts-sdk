import { Coin, VirtualCoin, Wallet } from "..";

export async function waitForIncomingFunds(
    wallet: Wallet
): Promise<Coin[] | VirtualCoin[]> {
    let stopFunc: (() => void) | undefined;

    const promise = new Promise<Coin[] | VirtualCoin[]>((resolve) => {
        wallet.notifyIncomingFunds((coins: Coin[] | VirtualCoin[]) => {
            resolve(coins);
            if (stopFunc) stopFunc();
        }).then((stop) => {
            stopFunc = stop;
        });
    });

    return promise;
}
