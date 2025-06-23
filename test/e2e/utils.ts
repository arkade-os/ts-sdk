import { utils } from "@scure/btc-signer";
import { hex } from "@scure/base";
import { IWallet, Wallet, InMemoryKey } from "../../src";

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
