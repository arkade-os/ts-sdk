import { Wallet, SingleKey, OnchainWallet } from "../../src";
import { execSync } from "child_process";

export const arkdExec =
    process.env.ARK_ENV === "docker" ? "docker exec -t arkd" : "nigiri";

export interface TestArkWallet {
    wallet: Wallet;
    identity: SingleKey;
}

export interface TestOnchainWallet {
    wallet: OnchainWallet;
    identity: SingleKey;
}

export function execCommand(command: string): string {
    command += " | grep -v WARN";
    const result = execSync(command).toString().trim();
    return result;
}

export function createTestIdentity(): SingleKey {
    return SingleKey.fromRandomBytes();
}

export async function createTestOnchainWallet(): Promise<TestOnchainWallet> {
    const identity = createTestIdentity();
    const wallet = await OnchainWallet.create(identity, "regtest");
    return {
        wallet,
        identity,
    };
}

export async function createTestArkWallet(): Promise<TestArkWallet> {
    const identity = createTestIdentity();

    const wallet = await Wallet.create({
        identity,
        arkServerUrl: "http://localhost:7070",
    });

    return {
        wallet,
        identity,
    };
}

export function faucetOffchain(address: string, amount: number): void {
    execCommand(
        `${arkdExec} ark send --to ${address} --amount ${amount} --password secret`
    );
}

export function faucetOnchain(address: string, amount: number): void {
    const btc = (amount / 100_000_000).toFixed(8); // BTC with 8 decimals
    execCommand(`nigiri faucet ${address} ${btc}`);
}

export async function createVtxo(
    alice: TestArkWallet,
    amount: number
): Promise<string> {
    const address = await alice.wallet.getAddress();
    if (!address) throw new Error("Offchain address not defined.");

    faucetOffchain(address, amount);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const virtualCoins = await alice.wallet.getVtxos();
    if (!virtualCoins || virtualCoins.length === 0) {
        throw new Error("No VTXOs found after onboarding transaction.");
    }

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

// before each test check if the ark's cli running in the test env has at least 20_000 offchain balance
// if not, fund it with 100.000
export function beforeEachFaucet(): void {
    const balanceOutput = execCommand(`${arkdExec} ark balance`);
    const balance = JSON.parse(balanceOutput);
    const offchainBalance = balance.offchain_balance.total;

    if (offchainBalance <= 20_000) {
        const noteStr = execCommand(`${arkdExec} arkd note --amount 100000`);
        execCommand(
            `${arkdExec} ark redeem-notes -n ${noteStr} --password secret`
        );
    }
}

export async function waitFor(
    fn: () => Promise<boolean>,
    { timeout = 25_000, interval = 250 } = {}
): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error("timeout in waitFor");
}
