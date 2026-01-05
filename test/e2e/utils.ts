import { hex } from "@scure/base";
import {
    Wallet,
    SingleKey,
    OnchainWallet,
    EsploraProvider,
    RestIndexerProvider,
    ArkAddress,
    IntentFeeConfig,
} from "../../src";
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
        onchainProvider: new EsploraProvider("http://localhost:3000", {
            forcePolling: true,
            pollingInterval: 2000,
        }),
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
export async function beforeEachFaucet(): Promise<void> {
    const receiveOutput = execCommand(`${arkdExec} ark receive`);
    const receive = JSON.parse(receiveOutput);
    const receiveAddress = receive.offchain_address;

    const { vtxos } = await new RestIndexerProvider(
        "http://localhost:7070"
    ).getVtxos({
        scripts: [hex.encode(ArkAddress.decode(receiveAddress).pkScript)],
        spendableOnly: true,
    });
    const offchainBalance = vtxos.reduce(
        (sum: number, vtxo) => sum + vtxo.value,
        0
    );

    if (offchainBalance <= 20_000) {
        const noteStr = execCommand(`${arkdExec} arkd note --amount 100000`);
        execCommand(
            `${arkdExec} ark redeem-notes -n ${noteStr} --password secret`
        );
    }
}

export function setFees(fees: IntentFeeConfig): void {
    let cmd = `${arkdExec} arkd fees intent`;
    if (fees.offchainInput) {
        cmd += ` --offchain-input ${fees.offchainInput}`;
    }
    if (fees.onchainInput) {
        cmd += ` --onchain-input ${fees.onchainInput}`;
    }
    if (fees.offchainOutput) {
        cmd += ` --offchain-output ${fees.offchainOutput}`;
    }
    if (fees.onchainOutput) {
        cmd += ` --onchain-output ${fees.onchainOutput}`;
    }
    execCommand(cmd);
}

export function clearFees(): void {
    execCommand(`${arkdExec} arkd fees clear`);
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
