import {
    Wallet,
    SingleKey,
    MnemonicIdentity,
    Identity,
    OnchainWallet,
    EsploraProvider,
    IntentFeeConfig,
    InMemoryWalletRepository,
    InMemoryContractRepository,
    ArkInfo,
    ArkProvider,
    RestArkProvider,
    WalletRepository,
    ContractRepository,
} from "../../src";
import { execSync } from "child_process";
import { RestDelegatorProvider } from "../../src/providers/delegator";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export const arkdExec = "docker exec -t arkd";

let arkCliInitialized = false;

function ensureArkCliInitialized(): void {
    if (arkCliInitialized) return;
    try {
        execSync(
            `${arkdExec} ark init --password secret --server-url localhost:7070 --explorer http://chopsticks:3000`,
            { stdio: "pipe" }
        );
    } catch {
        // already initialized — ignore
    }
    arkCliInitialized = true;
}

export interface TestArkWallet {
    wallet: Wallet;
    identity: Identity;
}

export interface TestOnchainWallet {
    wallet: OnchainWallet;
    identity: SingleKey;
}

export function execCommand(command: string): string {
    const result = execSync(command, { encoding: "utf8" })
        .replace(/\r/g, "")
        .split("\n")
        .filter((line) => !line.includes("WARN"))
        .join("\n")
        .trim();
    if (result.startsWith("error:")) {
        throw new Error(result);
    }
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
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
        settlementConfig: false,
    });

    return {
        wallet,
        identity,
    };
}

export async function createTestArkWalletWithDelegate(): Promise<TestArkWallet> {
    const identity = createTestIdentity();

    const wallet = await Wallet.create({
        identity,
        arkServerUrl: "http://localhost:7070",
        onchainProvider: new EsploraProvider("http://localhost:3000", {
            forcePolling: true,
            pollingInterval: 2000,
        }),
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
        delegatorProvider: new RestDelegatorProvider("http://localhost:7012"),
        settlementConfig: false,
    });

    return {
        wallet,
        identity,
    };
}

export async function createTestArkWalletWithMnemonic(): Promise<TestArkWallet> {
    const mnemonic = generateMnemonic(wordlist);
    const identity = MnemonicIdentity.fromMnemonic(mnemonic, {
        isMainnet: false,
    });

    const wallet = await Wallet.create({
        identity,
        arkServerUrl: "http://localhost:7070",
        onchainProvider: new EsploraProvider("http://localhost:3000", {
            forcePolling: true,
            pollingInterval: 2000,
        }),
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
        settlementConfig: false,
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

// before each test, ensure the faucet wallet has fresh spendable VTXOs.
// After rounds, existing VTXOs can become stale (balance shows them but
// ark send can't spend them), so we always redeem a fresh note.
export async function beforeEachFaucet(): Promise<void> {
    ensureArkCliInitialized();
    const noteStr = execCommand(`${arkdExec} arkd note --amount 200000`);
    execCommand(`${arkdExec} ark redeem-notes -n ${noteStr} --password secret`);
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

/**
 * Wrap a real ArkProvider, overriding selected fields of `getInfo()` while
 * forwarding every other method to the underlying provider. Used to simulate
 * server-config changes (e.g. `unilateralExitDelay`) between wallet loads
 * without actually restarting arkd.
 */
export function createOverrideInfoArkProvider(
    real: ArkProvider,
    overrides: Partial<ArkInfo>
): ArkProvider {
    return new Proxy(real, {
        get(target, prop, receiver) {
            if (prop === "getInfo") {
                return async () => {
                    const info = await target.getInfo();
                    return { ...info, ...overrides };
                };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

export interface SharedRepos {
    walletRepository: WalletRepository;
    contractRepository: ContractRepository;
}

export function createSharedRepos(): SharedRepos {
    return {
        walletRepository: new InMemoryWalletRepository(),
        contractRepository: new InMemoryContractRepository(),
    };
}

/**
 * Create a delegator-enabled wallet using a provided identity and repositories,
 * with an `ArkProvider` whose `getInfo()` overrides `unilateralExitDelay` to
 * simulate a server-side config change without restarting arkd.
 */
export async function createTestArkWalletWithDelegateAndOverride(opts: {
    identity: Identity;
    repos: SharedRepos;
    unilateralExitDelay: bigint;
}): Promise<TestArkWallet> {
    const arkServerUrl = "http://localhost:7070";
    const realProvider = new RestArkProvider(arkServerUrl);
    const arkProvider = createOverrideInfoArkProvider(realProvider, {
        unilateralExitDelay: opts.unilateralExitDelay,
    });

    const wallet = await Wallet.create({
        identity: opts.identity,
        arkServerUrl,
        arkProvider,
        onchainProvider: new EsploraProvider("http://localhost:3000", {
            forcePolling: true,
            pollingInterval: 2000,
        }),
        storage: {
            walletRepository: opts.repos.walletRepository,
            contractRepository: opts.repos.contractRepository,
        },
        delegatorProvider: new RestDelegatorProvider("http://localhost:7012"),
        settlementConfig: false,
    });

    return {
        wallet,
        identity: opts.identity,
    };
}
