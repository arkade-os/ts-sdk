import {
    InMemoryContractRepository,
    InMemoryWalletRepository,
    MnemonicIdentity,
    RestDelegateProvider,
    Wallet,
} from "../../src";
import { execSync } from "child_process";

// EventSource is used internally by the SDK for settlement events (SSE).
// It is not available in Node.js by default, so we need to polyfill it.
import { EventSource } from "eventsource";
(globalThis as any).EventSource = EventSource;

const arkdExec = process.argv[2] || "docker exec -t arkd";

// HTTP port of the regtest `fulmine-delegator` service (DELEGATOR_HTTP_PORT
// in regtest/.env.defaults), which speaks the DelegateProvider REST API.
const DELEGATE_URL = "http://localhost:7012";

const ITERATIONS = 1000;
const FUND_AMOUNT = 500;
const DELEGATE_WAIT_MS = 16_000;

// WARNING: arkdExec is passed directly to shell. Only use trusted values.
// For production code, use execFileSync with separated arguments to prevent
// command injection vulnerabilities.
async function fundAddress(address: string, amount: number) {
    execSync(`${arkdExec} ark send --to ${address} --amount ${amount} --password secret`, {
        stdio: "inherit",
    });
}

// The arkd container's `ark` client wallet is seeded once (by `regtest.mjs
// start`) and never topped up again on its own, so repeated example/test runs
// against the same regtest stack can leave it without enough balance to cover
// `ITERATIONS * FUND_AMOUNT`. Mint and redeem a fresh note up front so this
// example doesn't depend on whatever that shared wallet happens to have left.
async function ensureArkClientFunded(amount: number) {
    const note = execSync(`${arkdExec} arkd note --amount ${amount}`, { encoding: "utf8" }).trim();
    execSync(`${arkdExec} ark redeem-notes -n ${note} --password secret`, { stdio: "inherit" });
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const alice = MnemonicIdentity.fromMnemonic(MNEMONIC, { isMainnet: false });

async function main() {
    const storage = {
        walletRepository: new InMemoryWalletRepository(),
        contractRepository: new InMemoryContractRepository(),
    };

    // Create Alice's wallet
    console.log("Creating Alice's wallet...");
    const aliceWallet = await Wallet.create({
        identity: alice,
        esploraUrl: "http://localhost:3000/api",
        arkServerUrl: "http://localhost:7070",
        storage,
        // force refresh in 2s at most for the example to run quickly
        watcherConfig: { failsafePollIntervalMs: 2000 },
        walletMode: "hd",
        // Configuring a delegate provider up front makes every rotated
        // receive address a delegate-type contract, so all the VTXOs funded
        // below are eligible for delegation later.
        delegateProvider: new RestDelegateProvider(DELEGATE_URL),
    });

    console.log("Funding the ark client wallet...");
    await ensureArkClientFunded(ITERATIONS * FUND_AMOUNT * 4);

    for (let i = 0; i < ITERATIONS; i++) {
        // Fund the current rotated address
        const address = await aliceWallet.getAddress();
        console.log(`Funding address ${address}...`);
        await fundAddress(address, FUND_AMOUNT).catch((e) => console.error(e));

        // Wait a moment for the rotation to pick up the new VTXO
        await sleep(50);
    }

    // `wallet.getVtxos()` strips the `contractScript` tag `delegate()` needs to
    // tell which contracts are delegate-eligible, so read through the contract
    // manager directly instead.
    const manager = await aliceWallet.getContractManager();
    const vtxosBeforeDelegate = (await manager.getContractsWithVtxos()).flatMap((c) =>
        c.vtxos.filter((v) => !v.isSpent),
    );
    console.log(`Vtxos before delegate: ${vtxosBeforeDelegate.length}`);

    console.log("Delegating all vtxos to consolidate them into one...");
    const delegateManager = await aliceWallet.getDelegateManager();
    if (!delegateManager) {
        throw new Error("Delegate manager unavailable: no delegate provider configured");
    }
    const destination = await aliceWallet.getAddress();
    const { delegated, failed } = await delegateManager.delegate(
        vtxosBeforeDelegate,
        destination,
        new Date(Date.now() + 1000),
    );
    console.log(`Delegated: ${delegated.length}, Failed: ${failed.length}`);

    console.log(`Waiting ${DELEGATE_WAIT_MS}ms for the delegate to consolidate...`);
    await sleep(DELEGATE_WAIT_MS);

    const vtxosAfterDelegate = (await manager.getContractsWithVtxos()).flatMap((c) =>
        c.vtxos.filter((v) => !v.isSpent),
    );
    console.log(`Vtxos after delegate: ${vtxosAfterDelegate.length}`);

    const balance = await aliceWallet.getBalance();
    console.log("Balance:", balance);

    const contracts = await manager.getContracts();
    console.log(`Contracts: ${contracts.length}`);

    manager.dispose();

    return 0;
}

main().catch(console.error);
