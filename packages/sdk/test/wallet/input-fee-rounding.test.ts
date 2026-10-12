import { describe, it, expect, vi } from "vitest";
import { hex, base64 } from "@scure/base";
import { DelegateManagerImpl } from "../../src/wallet/delegate";
import { VtxoManager } from "../../src/wallet/vtxo-manager";
import { Transaction } from "../../src/utils/transaction";
import {
    ArkAddress,
    DefaultVtxo,
    type ArkadeInfo,
    type ContractVtxo,
    type ExtendedCoin,
    type Identity,
} from "../../src";
import type { DelegateProvider } from "../../src/providers/delegate";
import {
    TEST_DELEGATE_PUB_KEY,
    TEST_DEFAULT_ARK_ADDRESS,
    TEST_PUB_KEY,
    TEST_SERVER_PUB_KEY,
    TEST_SERVER_PUB_KEY_HEX,
    createMockContractVtxo,
    testDelegateScript,
} from "../contracts/helpers";

const identity: Identity = {
    sign: async (tx) => tx,
    xOnlyPublicKey: async () => TEST_PUB_KEY,
    compressedPublicKey: async () => new Uint8Array(33),
    signMessage: async () => new Uint8Array(64),
    signerSession: () => {
        throw new Error("unused");
    },
};

// 0.0025/sat: 1000 sats -> 2.5, the fractional per-input fee this exercises.
const arkInfo = (offchainInput: string): ArkadeInfo => ({
    boardingExitDelay: 144n,
    checkpointTapscript:
        "5ab27520e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
    deprecatedSigners: [],
    digest: "d",
    dust: 100n,
    fees: { intentFee: { offchainInput }, txFeeRate: "0" },
    forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    forfeitPubkey: TEST_SERVER_PUB_KEY_HEX,
    network: "mutinynet",
    serviceStatus: {},
    sessionDuration: 3600n,
    signerPubkey: TEST_SERVER_PUB_KEY_HEX,
    unilateralExitDelay: 144n,
    utxoMaxAmount: -1n,
    utxoMinAmount: 0n,
    version: "1",
    vtxoMaxAmount: -1n,
    vtxoMinAmount: 0n,
});

function delegateVtxo(value: number): ContractVtxo {
    return createMockContractVtxo(hex.encode(testDelegateScript.pkScript), {
        value,
        tapTree: testDelegateScript.encode(),
        forfeitTapLeafScript: testDelegateScript.forfeit(),
        intentTapLeafScript: testDelegateScript.delegate(),
        expiresAt: new Date(Date.now() + 86_400_000),
    });
}

function run(offchainInput: string, vtxos: ContractVtxo[]) {
    const registered: { proof: string }[] = [];
    const delegateProvider = {
        getDelegateInfo: async () => ({
            pubkey: hex.encode(TEST_DELEGATE_PUB_KEY),
            fee: "0",
            delegateAddress: TEST_DEFAULT_ARK_ADDRESS,
        }),
        delegate: async (intent: { proof: string }) => {
            registered.push(intent);
        },
    } as unknown as DelegateProvider;

    const manager = new DelegateManagerImpl(
        delegateProvider,
        { getInfo: async () => arkInfo(offchainInput) },
        identity,
    );
    return { registered, result: manager.delegate(vtxos, TEST_DEFAULT_ARK_ADDRESS) };
}

/** Amount of the output paying `destination` in the registered intent proof. */
function delegatedAmount(proof: string, destination: string): bigint {
    const tx = Transaction.fromPSBT(base64.decode(proof));
    const script = hex.encode(ArkAddress.decode(destination).pkScript);
    for (let i = 0; i < tx.outputsLength; i++) {
        const out = tx.getOutput(i);
        if (out.script && hex.encode(out.script) === script) return out.amount!;
    }
    throw new Error("destination output not found");
}

describe("delegate input fee rounding", () => {
    it("charges a fractional per-input fee rounded up to whole sats", async () => {
        const { registered, result } = run("amount * 0.0025", [delegateVtxo(1000)]);
        const { delegated, failed } = await result;

        expect(failed).toEqual([]);
        expect(delegated).toHaveLength(1);
        expect(delegatedAmount(registered[0].proof, TEST_DEFAULT_ARK_ADDRESS)).toBe(997n);
    });

    it("skips an input whose rounded-up fee leaves nothing", async () => {
        // 3 sats * 0.9 = 2.7 -> 3 whole sats, exactly the input value.
        const { result } = run("amount * 0.9", [delegateVtxo(3)]);
        const { failed } = await result;

        expect(failed).toHaveLength(1);
        expect((failed[0].error as Error).message).toContain("below dust limit");
    });
});

const boardingTapscript = new DefaultVtxo.Script({
    pubKey: TEST_PUB_KEY,
    serverPubKey: TEST_SERVER_PUB_KEY,
    csvTimelock: { value: 605_184n, type: "seconds" },
});

const boardingUtxo = (value: number): ExtendedCoin =>
    ({
        txid: `boarding-${value}`,
        vout: 0,
        value,
        status: { confirmed: true },
        forfeitTapLeafScript: boardingTapscript.forfeit(),
        intentTapLeafScript: boardingTapscript.forfeit(),
        tapTree: boardingTapscript.encode(),
    }) as unknown as ExtendedCoin;

describe("periodic settle boarding fee rounding", () => {
    it("skips a boarding input whose rounded-up fee leaves nothing", async () => {
        const settle = vi.fn().mockResolvedValue("mock-txid");
        const wallet = {
            getAddress: vi.fn().mockResolvedValue(TEST_DEFAULT_ARK_ADDRESS),
            getContractManager: vi.fn().mockResolvedValue({
                onContractEvent: vi.fn().mockReturnValue(() => {}),
                refreshOutpoints: vi.fn().mockResolvedValue(undefined),
            }),
            getDelegateManager: vi.fn().mockResolvedValue(undefined),
            getVtxos: vi.fn().mockResolvedValue([]),
            getSpendableVtxos: vi.fn().mockResolvedValue([]),
            settle,
            dustAmount: 1000n,
            boardingTapscript,
            network: {},
            signOnchainBoardingTx: vi.fn(),
            onchainProvider: { getChainTip: vi.fn() },
            arkProvider: {
                getInfo: vi.fn().mockResolvedValue({
                    fees: { intentFee: { onchainInput: "amount * 0.9" } },
                    vtxoMaxAmount: -1n,
                }),
            },
        };

        const manager = new VtxoManager(wallet as never);
        // Keep the pass boarding-only: the VTXO branch needs an indexer.
        (manager as unknown as { renewalInProgress: boolean }).renewalInProgress = true;
        await (
            manager as unknown as {
                runPeriodicSettle(utxos: ExtendedCoin[]): Promise<void>;
            }
        ).runPeriodicSettle([boardingUtxo(3), boardingUtxo(10_000)]);
        await manager.dispose();

        expect(settle).toHaveBeenCalledTimes(1);
        expect(settle.mock.calls[0][0].inputs.map((i: ExtendedCoin) => i.value)).toEqual([10_000]);
    });
});
