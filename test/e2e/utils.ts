import { utils } from "@scure/btc-signer";
import { hex } from "@scure/base";
import { IWallet, Wallet, InMemoryKey } from "../../src";
import { execSync } from "child_process";

export const arkdExec =
    process.env.ARK_ENV === "docker" ? "docker exec -t arkd" : "nigiri";

// Deterministic server public key from mnemonic "abandon" x24
export const ARK_SERVER_PUBKEY =
    "038a9bbb1fb2aa92b9557dd0b39a85f31d204f58b41c62ea112d6ad148a9881285";

export const X_ONLY_PUBLIC_KEY = hex.decode(ARK_SERVER_PUBKEY).slice(1);

export interface TestWallet {
    wallet: IWallet;
    identity: InMemoryKey;
}

export function createTestIdentity(): InMemoryKey {
    const privateKeyBytes = utils.randomPrivateKeyBytes();
    const privateKeyHex = hex.encode(privateKeyBytes);
    return InMemoryKey.fromHex(privateKeyHex);
}

export async function createTestWallet(): Promise<TestWallet> {
    const identity = createTestIdentity();

    const wallet = await Wallet.create({
        network: "regtest",
        identity,
        arkServerUrl: "http://localhost:7070",
        arkServerPublicKey: ARK_SERVER_PUBKEY,
    });

    return {
        wallet,
        identity,
    };
}

export function faucetOffchain(address: string, amount: number): void {
    execSync(
        `${arkdExec} ark send --to ${address} --amount ${amount} --password secret`
    );
}

export async function createVtxo(
    alice: TestWallet,
    amount: number
): Promise<string> {
    const address = (await alice.wallet.getAddress()).offchain;
    if (!address) throw new Error("Offchain address not defined.");

    faucetOffchain(address, amount);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const virtualCoins = await alice.wallet.getVtxos();
    if (!virtualCoins || virtualCoins.length === 0) {
        throw new Error("No VTXOs found after onboarding transaction.");
    }

    const vtxo = virtualCoins[0];

    const settleTxid = await alice.wallet.settle({
        inputs: virtualCoins,
        outputs: [
            {
                address,
                amount: BigInt(
                    virtualCoins.reduce((sum, vtxo) => sum + vtxo.value, 0)
                ),
            },
        ],
    });

    return settleTxid;
}
