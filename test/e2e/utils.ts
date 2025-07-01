import { utils } from "@scure/btc-signer";
import { hex } from "@scure/base";
import { IWallet, Wallet, InMemoryKey, OnchainWallet } from "../../src";
import { execSync } from "child_process";

export const arkdExec =
    process.env.ARK_ENV === "docker" ? "docker exec -t arkd" : "nigiri";

// Deterministic server public key from mnemonic "abandon" x24
export const ARK_SERVER_PUBKEY =
    "038a9bbb1fb2aa92b9557dd0b39a85f31d204f58b41c62ea112d6ad148a9881285";

export const X_ONLY_PUBLIC_KEY = hex.decode(ARK_SERVER_PUBKEY).slice(1);

export interface TestArkWallet {
    wallet: IWallet;
    identity: InMemoryKey;
}

export interface TestOnchainWallet {
    wallet: OnchainWallet;
    identity: InMemoryKey;
}

/**
 * Generates a new random in-memory key for testing purposes.
 *
 * @returns An `InMemoryKey` instance created from a randomly generated private key.
 */
export function createTestIdentity(): InMemoryKey {
    const privateKeyBytes = utils.randomPrivateKeyBytes();
    const privateKeyHex = hex.encode(privateKeyBytes);
    return InMemoryKey.fromHex(privateKeyHex);
}

/**
 * Creates a test onchain wallet and associated identity for the regtest network.
 *
 * @returns An object containing the onchain wallet instance and its identity.
 */
export function createTestOnchainWallet(): TestOnchainWallet {
    const identity = createTestIdentity();
    const wallet = new OnchainWallet(identity, "regtest");
    return {
        wallet,
        identity,
    };
}

/**
 * Asynchronously creates a test Ark wallet configured for the regtest network.
 *
 * Generates a new identity and initializes a Wallet instance connected to a local Ark server using a deterministic server public key.
 *
 * @returns An object containing the created Wallet and its associated identity.
 */
export async function createTestArkWallet(): Promise<TestArkWallet> {
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

/**
 * Sends Ark tokens offchain to the specified address using a shell command.
 *
 * @param address - The recipient's offchain address
 * @param amount - The amount of Ark tokens to send
 */
export function faucetOffchain(address: string, amount: number): void {
    execSync(
        `${arkdExec} ark send --to ${address} --amount ${amount} --password secret`
    );
}

/**
 * Creates and settles a virtual transaction output (VTXO) for the specified Ark wallet.
 *
 * Funds the wallet's offchain address with the given amount, waits for processing, and consolidates all available VTXOs into a single output. Returns the transaction ID of the settle operation.
 *
 * @param alice - The test Ark wallet to receive and settle the VTXO
 * @param amount - The amount to fund the wallet's offchain address
 * @returns The transaction ID of the settle transaction
 */
export async function createVtxo(
    alice: TestArkWallet,
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
