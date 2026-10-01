import { describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { Address, OutScript } from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1.js";

import { Wallet } from "../src";
import { DefaultVtxo } from "../src/script/default";
import { DelegateVtxo } from "../src/script/delegate";
import { DelegateManagerImpl } from "../src/wallet/delegate";
import { toVirtualStatus } from "../src/wallet/vtxo";
import { Transaction } from "../src/utils/transaction";
import { networks } from "../src/networks";
import type { TapLeafScript } from "../src/script/base";
import type { ExtendedCoin, ExtendedVirtualCoin } from "../src/wallet";
import type { BatchFinalizationEvent } from "../src/providers/ark";

const NETWORK = networks.regtest;

const PAST = new Date("2026-01-01T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");
const DELEGATE_AT = new Date("2026-06-01T00:00:00.000Z");

const key = (seed: number) => schnorr.getPublicKey(new Uint8Array(32).fill(seed));
const PUBKEY = key(1);
const SERVER_PUBKEY = key(2);
const DELEGATE_PUBKEY = key(3);
const CSV_TIMELOCK = { value: 144n, type: "blocks" as const };

const ONCHAIN_ADDRESS = Address(NETWORK).encode({
    type: "tr",
    pubkey: hex.decode("33".repeat(32)),
});
const ARK_ADDRESS =
    "tark1qpt0syx7j0jspe69kldtljet0x9jz6ns4xw70m0w0xl30yfhn0mzmxz6yz8rduexx9sv73mqth7ecy8rtzcgm498kad3avmhyhmy097ew6h83g";

const pkScript = (address: string) => OutScript.encode(Address(NETWORK).decode(address));

type ForfeitableScript = {
    pkScript: Uint8Array;
    encode(): Uint8Array;
    forfeit(): TapLeafScript;
};

/** A settle input past its batch expiry that the operator has not swept. Overrides vary one fact. */
function vtxoInput(
    script: ForfeitableScript,
    over: Partial<ExtendedVirtualCoin> = {},
): ExtendedVirtualCoin {
    const facts = {
        isSpent: false,
        isSwept: false,
        isPreconfirmed: false,
        commitmentTxIds: ["22".repeat(32)],
        expiresAt: PAST,
        ...over,
    };
    return {
        txid: "11".repeat(32),
        vout: 0,
        value: 50_000,
        status: { confirmed: true, isLeaf: true },
        createdAt: new Date("2025-12-01T00:00:00.000Z"),
        isUnrolled: false,
        spentBy: "",
        script: hex.encode(script.pkScript),
        tapTree: script.encode(),
        forfeitTapLeafScript: script.forfeit(),
        intentTapLeafScript: script.forfeit(),
        ...facts,
        virtualStatus: toVirtualStatus(facts),
        ...over,
    } as unknown as ExtendedVirtualCoin;
}

const vtxoScript = new DefaultVtxo.Script({
    pubKey: PUBKEY,
    serverPubKey: SERVER_PUBKEY,
    csvTimelock: CSV_TIMELOCK,
});

function commitmentEvent(): BatchFinalizationEvent {
    const tx = new Transaction({ allowUnknownOutputs: true });
    tx.addOutput({ script: new Uint8Array([0x51]), amount: 5_000n });
    return {
        id: "batch-1",
        commitmentTx: base64.encode(tx.toPSBT()),
    } as BatchFinalizationEvent;
}

const connectorsGraph = () => ({
    leaves: () => [
        {
            id: "cc".repeat(32),
            getOutput: () => ({ amount: 450n, script: pkScript(ONCHAIN_ADDRESS) }),
        },
    ],
});

async function finalize(input: ExtendedVirtualCoin) {
    const thisArg: any = {
        network: NETWORK,
        dustAmount: 1_000n,
        arkProvider: { submitSignedForfeitTxs: vi.fn(async () => {}) },
        _signerRouter: { sign: vi.fn(async (tx: Transaction) => tx) },
    };

    await (Wallet.prototype as any).handleSettlementFinalizationEvent.call(
        thisArg,
        commitmentEvent(),
        [input],
        pkScript(ONCHAIN_ADDRESS),
        [],
        connectorsGraph(),
        undefined,
    );

    return thisArg;
}

describe("settlement forfeits a VTXO past expiry that is not swept", () => {
    it("submits exactly one forfeit, spending that VTXO", async () => {
        const input = vtxoInput(vtxoScript);

        const thisArg = await finalize(input);

        const calls = thisArg.arkProvider.submitSignedForfeitTxs.mock.calls;
        expect(calls).toHaveLength(1);
        const [forfeits, signedSettlement] = calls[0];
        expect(forfeits).toHaveLength(1);
        expect(signedSettlement).toBeUndefined();

        const forfeit = Transaction.fromPSBT(base64.decode(forfeits[0]));
        expect(hex.encode(forfeit.getInput(0).txid!)).toBe(input.txid);
        expect(forfeit.getInput(0).index).toBe(input.vout);
    });

    it("submits no forfeit for a swept VTXO", async () => {
        const thisArg = await finalize(vtxoInput(vtxoScript, { isSwept: true }));

        expect(thisArg.arkProvider.submitSignedForfeitTxs).not.toHaveBeenCalled();
    });

    it("submits no forfeit for an unrolled VTXO", async () => {
        const thisArg = await finalize(vtxoInput(vtxoScript, { isUnrolled: true }));

        expect(thisArg.arkProvider.submitSignedForfeitTxs).not.toHaveBeenCalled();
    });
});

describe("delegation forfeits a VTXO past expiry that is not swept", () => {
    const vtxoScript = new DelegateVtxo.Script({
        pubKey: PUBKEY,
        serverPubKey: SERVER_PUBKEY,
        delegatePubKey: DELEGATE_PUBKEY,
        csvTimelock: CSV_TIMELOCK,
    });

    function harness() {
        const delegateProvider = {
            getDelegateInfo: vi.fn(async () => ({
                pubkey: hex.encode(DELEGATE_PUBKEY),
                fee: 0,
                delegateAddress: ARK_ADDRESS,
            })),
            delegate: vi.fn(async (_intent: unknown, _forfeits: string[]) => {}),
        };
        const arkInfoProvider = {
            getInfo: vi.fn(async () => ({
                fees: { intentFee: {}, txFeeRate: "1" },
                dust: 330n,
                forfeitAddress: "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080",
                network: "regtest",
                sessionDuration: 3600n,
            })),
        };
        const identity = { sign: vi.fn(async (tx: Transaction) => tx) };

        const manager = new DelegateManagerImpl(
            delegateProvider as any,
            arkInfoProvider as any,
            identity as any,
        );
        return { manager, delegateProvider };
    }

    async function delegateForfeits(input: ExtendedVirtualCoin): Promise<string[]> {
        const { manager, delegateProvider } = harness();

        const result = await manager.delegate([input as any], ARK_ADDRESS, DELEGATE_AT);

        // Surfaces a harness failure, which `delegate` otherwise swallows into `failed`.
        expect(result.failed.map((f) => String(f.error))).toEqual([]);
        return delegateProvider.delegate.mock.calls[0][1];
    }

    it("sends one delegate forfeit", async () => {
        expect(await delegateForfeits(vtxoInput(vtxoScript))).toHaveLength(1);
    });

    it("sends no delegate forfeit for a swept VTXO", async () => {
        expect(await delegateForfeits(vtxoInput(vtxoScript, { isSwept: true }))).toHaveLength(0);
    });

    it("sends no delegate forfeit for an unrolled VTXO", async () => {
        expect(await delegateForfeits(vtxoInput(vtxoScript, { isUnrolled: true }))).toHaveLength(0);
    });
});

describe("settle refreshes the swept state of expired inputs", () => {
    const STOP = "stop-before-intent";
    const EXPIRY_HEIGHT = 500;

    type SettleOpts = {
        fresh?: ExtendedVirtualCoin[];
        refreshOutpoints?: () => Promise<void>;
        tipHeight?: number;
    };

    function harness(opts: SettleOpts) {
        const refreshOutpoints = vi.fn(opts.refreshOutpoints ?? (async () => {}));
        const getChainTip = vi.fn(async () => ({ height: opts.tipHeight ?? 0 }));
        const captured: ExtendedCoin[][] = [];
        const thisArg: any = {
            network: NETWORK,
            onchainProvider: { getChainTip },
            getAddress: vi.fn(async () => ARK_ADDRESS),
            getContractManager: vi.fn(async () => ({ refreshOutpoints })),
            getVtxos: vi.fn(async () => opts.fresh ?? []),
            logUngatedInputs: vi.fn(async () => {}),
            makeRegisterIntentSignature: vi.fn(async (inputs: ExtendedCoin[]) => {
                captured.push(inputs);
                throw new Error(STOP);
            }),
            makeDeleteIntentSignature: vi.fn(async () => ({})),
        };
        return { thisArg, refreshOutpoints, getChainTip, captured };
    }

    async function settle(inputs: ExtendedVirtualCoin[], opts: SettleOpts = {}) {
        const h = harness(opts);

        await expect(
            (Wallet.prototype as any)._settleImpl.call(h.thisArg, {
                inputs,
                outputs: [{ address: ONCHAIN_ADDRESS, amount: 10_000n }],
            }),
        ).rejects.toThrow(STOP);

        return h;
    }

    it("marks an input the operator already swept, so no forfeit is built for it", async () => {
        const input = vtxoInput(vtxoScript);

        const { refreshOutpoints, captured } = await settle([input], {
            fresh: [vtxoInput(vtxoScript, { isSwept: true })],
        });

        expect(refreshOutpoints).toHaveBeenCalledWith([{ txid: input.txid, vout: input.vout }]);
        const refreshed = captured[0][0] as ExtendedVirtualCoin;
        expect(refreshed.isSwept).toBe(true);

        const thisArg = await finalize(refreshed);
        expect(thisArg.arkProvider.submitSignedForfeitTxs).not.toHaveBeenCalled();
    });

    it("still forfeits an input the refresh reports unswept", async () => {
        const { refreshOutpoints, captured } = await settle([vtxoInput(vtxoScript)], {
            fresh: [vtxoInput(vtxoScript)],
        });

        expect(refreshOutpoints).toHaveBeenCalled();
        const refreshed = captured[0][0] as ExtendedVirtualCoin;
        expect(refreshed.isSwept).toBe(false);

        const thisArg = await finalize(refreshed);
        expect(thisArg.arkProvider.submitSignedForfeitTxs).toHaveBeenCalledTimes(1);
    });

    it("makes no call when no input is past expiry", async () => {
        const { thisArg, refreshOutpoints } = await settle([
            vtxoInput(vtxoScript, { expiresAt: FUTURE }),
        ]);

        expect(thisArg.getContractManager).not.toHaveBeenCalled();
        expect(refreshOutpoints).not.toHaveBeenCalled();
    });

    it("settles with the cached inputs when the refresh throws", async () => {
        const input = vtxoInput(vtxoScript);

        const { refreshOutpoints, captured } = await settle([input], {
            refreshOutpoints: async () => {
                throw new Error("indexer down");
            },
        });

        expect(refreshOutpoints).toHaveBeenCalled();
        expect(captured[0][0]).toBe(input);
    });

    it("resolves the chain tip to catch a height-expired input", async () => {
        const input = vtxoInput(vtxoScript, {
            expiresAt: undefined,
            expiresAtHeight: EXPIRY_HEIGHT,
        });

        const { getChainTip, captured } = await settle([input], {
            tipHeight: EXPIRY_HEIGHT + 1,
            fresh: [vtxoInput(vtxoScript, { isSwept: true })],
        });

        expect(getChainTip).toHaveBeenCalled();
        expect((captured[0][0] as ExtendedVirtualCoin).isSwept).toBe(true);
    });

    it("fetches no chain tip when every expiry is time-based", async () => {
        const { getChainTip, refreshOutpoints } = await settle([vtxoInput(vtxoScript)], {
            fresh: [vtxoInput(vtxoScript)],
        });

        expect(refreshOutpoints).toHaveBeenCalled();
        expect(getChainTip).not.toHaveBeenCalled();
    });
});
