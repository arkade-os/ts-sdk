import { hex } from "@scure/base";
import { execSync } from "child_process";
import {
    Wallet,
    SingleKey,
    EsploraProvider,
    RestIndexerProvider,
    ArkAddress,
    InMemoryWalletRepository,
    InMemoryContractRepository,
} from "@arkade-os/sdk";
import type { Identity } from "@arkade-os/sdk";

// Polyfill EventSource for Node. The SDK opens SSE subscriptions in the
// background (ContractWatcher); the swap path itself uses direct RPC, so a
// no-op stub is enough to silence "EventSource is not defined".
if (typeof (globalThis as any).EventSource === "undefined") {
    class StubEventSource {
        readyState = 0;
        constructor(public url: string) {}
        addEventListener(): void {}
        removeEventListener(): void {}
        close(): void {
            this.readyState = 2;
        }
    }
    (globalThis as any).EventSource = StubEventSource;
}

const arkdExec = "docker exec -t arkd";

export interface TestArkWallet {
    wallet: Wallet;
    identity: Identity;
}

function execCommand(command: string): string {
    command += " | grep -v WARN";
    const result = execSync(command).toString().trim();
    return result;
}

export async function createTestArkWallet(): Promise<TestArkWallet> {
    const identity = SingleKey.fromRandomBytes();

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
    execCommand(`${arkdExec} ark send --to ${address} --amount ${amount} --password secret`);
}

export async function beforeEachFaucet(): Promise<void> {
    const receiveOutput = execCommand(`${arkdExec} ark receive`);
    const receive = JSON.parse(receiveOutput);
    const receiveAddress = receive.offchain_address;

    const { vtxos } = await new RestIndexerProvider("http://localhost:7070").getVtxos({
        scripts: [hex.encode(ArkAddress.decode(receiveAddress).pkScript)],
        spendableOnly: true,
    });
    const offchainBalance = vtxos.reduce((sum: number, vtxo) => sum + vtxo.value, 0);

    if (offchainBalance <= 20_000) {
        const noteStr = execCommand(`${arkdExec} arkd note --amount 200000`);
        execCommand(`${arkdExec} ark redeem-notes -n ${noteStr} --password secret`);
    }
}
