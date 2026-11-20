import { describe, it, expect, vi } from "vitest";
import { hex } from "@scure/base";
import { VtxoManager } from "../src/wallet/vtxo-manager";
import { ExecutorContractHandler } from "../src/contracts/handlers/executor";
import { InMemoryContractRepository } from "../src";
import { collectContracts } from "../src/repositories/contractRepository";
import type { IWallet } from "../src/wallet";
import type { NormalizedExtendedVirtualCoin } from "../src/wallet/vtxo";
import type { Contract } from "../src/contracts/types";
import vectors from "./fixtures/executor/vectors.json";

// The wallet's identity key and the operator's signer key the watches are registered under.
const IDENTITY_X_ONLY = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const ROTATED_X_ONLY = "2f8bde4d1a07209355b4a7250a5c5128e88b84bddc619ab7cba8d569b240efe4";
const SIGNER_PUBKEY = vectors.serverPubkey;
// a retired operator signer, under which an older watch was registered
const OTHER_SIGNER_PUBKEY = "02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
const DUST = 1000n;
const MAX_FEE = 100;
const RENEWAL_WINDOW = 1000; // seconds, so the wallet's fallback margin is 500 s

/** An Executor renewal contract row for `owner`, carrying `metadata`. */
function renewalRow(
    ownerXOnly: string,
    metadata: Record<string, unknown> = { delegationStatus: "active" },
    signerPubkey = SIGNER_PUBKEY,
): Contract {
    const params = ExecutorContractHandler.serializeParams({
        template: "renewal",
        owner: hex.decode(`02${ownerXOnly}`),
        exitDelay: 144,
        renewalWindow: RENEWAL_WINDOW,
        maxFee: MAX_FEE,
        cosignerPubKey: hex.decode(vectors.cosignerPubkey),
        serverPubKey: hex.decode(signerPubkey),
        emulatorPubKey: hex.decode(vectors.emulatorPubkey),
    });
    const script = ExecutorContractHandler.createScript(params);
    return {
        type: "executor",
        params,
        script: hex.encode(script.pkScript),
        address: script.address("tark", hex.decode(signerPubkey).subarray(1)).encode(),
        state: "active",
        createdAt: Date.now(),
        metadata,
    };
}

/** A settled coin at `script`, far enough inside the window to be expiring but not deferred. */
function coin(
    script: string,
    overrides: Record<string, unknown> = {},
): NormalizedExtendedVirtualCoin {
    return {
        txid: "aa".repeat(32),
        vout: 0,
        value: 5000,
        createdAt: new Date(Date.now() - 100_000),
        expiresAt: new Date(Date.now() + 600_000),
        status: { confirmed: true },
        isUnrolled: false,
        isSpent: false,
        isSwept: false,
        isPreconfirmed: false,
        spentBy: "",
        commitmentTxIds: [],
        script,
        ...overrides,
    } as unknown as NormalizedExtendedVirtualCoin;
}

function walletWith(rows: Contract[], vtxos: NormalizedExtendedVirtualCoin[]): IWallet {
    // the rows the renewal pass reads back through the contract manager
    const repository = new InMemoryContractRepository();
    for (const row of rows) void repository.saveContract(row);
    return {
        getVtxos: vi.fn().mockResolvedValue(vtxos),
        getSpendableVtxos: vi.fn().mockResolvedValue(vtxos),
        getAddress: vi.fn().mockResolvedValue("arkade1myaddress"),
        getDelegateManager: vi.fn().mockResolvedValue(undefined),
        getContractManager: vi.fn().mockResolvedValue({
            onContractEvent: vi.fn().mockReturnValue(() => {}),
            refreshOutpoints: vi.fn().mockResolvedValue(undefined),
            getContracts: async (filter?: unknown) => collectContracts(repository, filter as never),
        }),
        settle: vi.fn().mockResolvedValue("mock-txid"),
        dustAmount: DUST,
        identity: {
            xOnlyPublicKey: vi.fn().mockResolvedValue(hex.decode(IDENTITY_X_ONLY)),
            compressedPublicKey: vi.fn().mockResolvedValue(hex.decode(`02${IDENTITY_X_ONLY}`)),
        },
        getOperatorInfo: vi.fn().mockResolvedValue({
            network: "regtest",
            signerPubkey: SIGNER_PUBKEY,
        }),
        arkProvider: {
            getInfo: vi.fn().mockResolvedValue({ fees: { intentFee: {} }, vtxoMaxAmount: -1n }),
        },
    } as unknown as IWallet;
}

const settleInputs = (wallet: IWallet) =>
    (wallet.settle as ReturnType<typeof vi.fn>).mock.calls[0][0].inputs;

describe("VtxoManager defers Executor-renewable delegated coins", () => {
    it("skips a coin at a live renewal watch, leaving nothing to renew", async () => {
        const row = renewalRow(IDENTITY_X_ONLY);
        const wallet = walletWith([row], [coin(row.script)]);
        const manager = new VtxoManager(wallet, {});

        await expect(manager.renewVtxos()).rejects.toThrow("No VTXOs available to renew");
        expect(wallet.settle).not.toHaveBeenCalled();
    });

    it("renews it inside the half-window fallback margin", async () => {
        const row = renewalRow(IDENTITY_X_ONLY);
        const inside = coin(row.script, {
            txid: "bb".repeat(32),
            expiresAt: new Date(Date.now() + 499_000),
        });
        const outside = coin(row.script);
        const wallet = walletWith([row], [inside, outside]);
        const manager = new VtxoManager(wallet, {});

        await manager.renewVtxos();
        const inputs = settleInputs(wallet);
        expect(inputs).toHaveLength(1);
        expect(inputs[0].txid).toBe(inside.txid);
    });

    it("renews it when it is recoverable", async () => {
        const row = renewalRow(IDENTITY_X_ONLY);
        const swept = coin(row.script, { txid: "cc".repeat(32), isSwept: true });
        const wallet = walletWith([row], [swept]);
        const manager = new VtxoManager(wallet, {});

        await manager.renewVtxos();
        expect(settleInputs(wallet).map((v: { txid: string }) => v.txid)).toEqual([swept.txid]);
    });

    it("renews it when the watch is expired, local, has no status, under another signer, or not held", async () => {
        const seconds = Math.floor(Date.now() / 1000);
        for (const [name, row] of [
            [
                "expired",
                renewalRow(IDENTITY_X_ONLY, {
                    delegationStatus: "active",
                    delegationExpiresAt: seconds - 10,
                }),
            ],
            ["local", renewalRow(IDENTITY_X_ONLY, { delegationStatus: "local" })],
            ["status-less", renewalRow(IDENTITY_X_ONLY, {})],
            [
                "another signer",
                renewalRow(IDENTITY_X_ONLY, { delegationStatus: "active" }, OTHER_SIGNER_PUBKEY),
            ],
            // no signingDescriptor derives this owner, so the wallet does not hold the watch
            ["not held", renewalRow(ROTATED_X_ONLY, { delegationStatus: "active" })],
        ] as const) {
            const vtxo = coin(row.script, { txid: name.padEnd(32, "0").slice(0, 32) });
            const wallet = walletWith([row], [vtxo]);
            const manager = new VtxoManager(wallet, {});

            await manager.renewVtxos();
            expect(settleInputs(wallet).map((v: { txid: string }) => v.txid)).toEqual([vtxo.txid]);
        }
    });

    it("renews a subdust coin at a live watch", async () => {
        const row = renewalRow(IDENTITY_X_ONLY);
        const subdust = coin(row.script, { txid: "dd".repeat(32), value: Number(DUST - 1n) });
        // a renewable coin at the wallet's own script carries the subdust one over dust
        const own = coin("51", { txid: "11".repeat(32) });
        const wallet = walletWith([row], [subdust, own]);
        const manager = new VtxoManager(wallet, {});

        await manager.renewVtxos();
        expect(new Set(settleInputs(wallet).map((v: { txid: string }) => v.txid))).toEqual(
            new Set([subdust.txid, own.txid]),
        );
    });

    it("renews a coin worth maxFee + dust at a live watch", async () => {
        const row = renewalRow(IDENTITY_X_ONLY);
        const small = coin(row.script, {
            txid: "ee".repeat(32),
            value: Number(BigInt(MAX_FEE) + DUST),
        });
        const wallet = walletWith([row], [small]);
        const manager = new VtxoManager(wallet, {});

        await manager.renewVtxos();
        expect(settleInputs(wallet).map((v: { txid: string }) => v.txid)).toEqual([small.txid]);
    });

    it("skips a coin at a rotated key's live renewal row", async () => {
        const rotated = renewalRow(ROTATED_X_ONLY, {
            delegationStatus: "active",
            signingDescriptor: `tr(${ROTATED_X_ONLY})`,
        });
        const wallet = walletWith([rotated], [coin(rotated.script)]);
        const manager = new VtxoManager(wallet, {});

        await expect(manager.renewVtxos()).rejects.toThrow("No VTXOs available to renew");
        expect(wallet.settle).not.toHaveBeenCalled();
    });

    it("still lists a skipped coin among the expiring VTXOs", async () => {
        const row = renewalRow(IDENTITY_X_ONLY);
        const vtxo = coin(row.script);
        const wallet = walletWith([row], [vtxo]);
        const manager = new VtxoManager(wallet, {});

        await expect(manager.getExpiringVtxos()).resolves.toEqual([vtxo]);
        expect(wallet.settle).not.toHaveBeenCalled();
    });
});
