import { describe, it, expect, vi } from "vitest";
import {
    Wallet,
    areSameScriptBaselineTypesCompatible,
    ensureWalletContract,
} from "../../src/wallet/wallet";
import { InMemoryWalletRepository } from "../../src/repositories/inMemory/walletRepository";
import { InMemoryContractRepository } from "../../src/repositories/inMemory/contractRepository";
import { SingleKey } from "../../src/identity/singleKey";
import { DefaultVtxo } from "../../src/script/default";
import { ContractManager } from "../../src/contracts/contractManager";
import { contractHandlers } from "../../src/contracts/handlers";
import { DefaultContractHandler } from "../../src/contracts/handlers/default";
import { isDiscoverable } from "../../src/contracts/types";
import { timelockToSequence } from "../../src/utils/timelock";
import { hex } from "@scure/base";

// Valid secp256k1 server pubkey (33-byte compressed, generator point) and a
// real CSV-multisig checkpoint tapscript — both lifted from the proven
// test/helpers/restoreWallet.ts harness so Wallet.create() parses cleanly.
const SERVER_PUBKEY_HEX = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const CHECKPOINT_TAPSCRIPT =
    "5ab27520e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac";

// boardingExitDelay is a seconds-type relative timelock and must be a multiple
// of 512 (BIP68 seconds granularity; bip68.encode throws otherwise). 604672 =
// 1181 * 512 (~7 days). unilateralExitDelay is a small block delay, so the
// offchain `default` baseline script never collides with the boarding script.
function makeInfo(overrides: Partial<any> = {}) {
    return {
        signerPubkey: SERVER_PUBKEY_HEX,
        forfeitPubkey: SERVER_PUBKEY_HEX,
        network: "mutinynet",
        batchExpiry: 144n,
        unilateralExitDelay: 144n,
        boardingExitDelay: 604672n,
        roundInterval: 144n,
        dust: 1000n,
        forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
        checkpointTapscript: CHECKPOINT_TAPSCRIPT,
        ...overrides,
    };
}

function makeIdleIndexer() {
    return {
        getVtxos: vi.fn(async () => ({ vtxos: [] })),
        subscribeForScripts: vi.fn(async () => "sub-id"),
        unsubscribeForScripts: vi.fn(async () => {}),
        // Idle subscription stream: resolves only when the watcher aborts, so
        // it never emits and keeps the contract watcher quiet during tests.
        getSubscription: vi.fn(async function* (_subId: string, abortSignal: AbortSignal) {
            await new Promise<void>((resolve) => {
                if (abortSignal?.aborted) return resolve();
                abortSignal?.addEventListener("abort", () => resolve(), { once: true });
            });
        }),
        watchAddresses: vi.fn(async () => () => {}),
    } as any;
}

function makeIdleOnchain() {
    return {
        getCoins: vi.fn(async () => []),
        getTransactions: vi.fn(async () => []),
        getTxOutspends: vi.fn(async () => []),
        getTxStatus: vi.fn(async () => ({ confirmed: false })),
        getChainTip: vi.fn(async () => ({ height: 0, hash: "", time: 0 })),
        broadcastTransaction: vi.fn(async () => "txid"),
        watchAddresses: vi.fn(async () => () => {}),
    } as any;
}

async function makeWallet(infoOverrides: Partial<any> = {}) {
    const identity = SingleKey.fromHex("1".repeat(64));
    const info = makeInfo(infoOverrides);

    const arkProvider = { getInfo: vi.fn(async () => info) } as any;
    const indexerProvider = makeIdleIndexer();
    const onchainProvider = makeIdleOnchain();

    const wallet = await Wallet.create({
        identity,
        // Disable background settlement so no renewal loop races our
        // contract-manager assertions.
        settlementConfig: false,
        arkProvider,
        indexerProvider,
        onchainProvider,
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
    });

    return { wallet, info, identity, arkProvider, indexerProvider, onchainProvider };
}

describe("boarding contract: getBoardingAddress backward compatibility", () => {
    it("returns the address derived directly from a DefaultVtxo.Script for the same keys/timelock", async () => {
        const { wallet, info } = await makeWallet();

        const serverPubKey = hex.decode(info.signerPubkey).slice(1);
        const pubKey = await wallet.identity.xOnlyPublicKey();
        // Reconstruct the pre-change boardingTapscript exactly: DefaultVtxo.Script
        // with csvTimelock sourced from boardingExitDelay.
        const legacy = new DefaultVtxo.Script({
            pubKey,
            serverPubKey,
            csvTimelock: {
                value: info.boardingExitDelay,
                type: info.boardingExitDelay < 512n ? "blocks" : "seconds",
            },
        });

        const expected = legacy.onchainAddress(wallet.network);
        expect(await wallet.getBoardingAddress()).toEqual(expected);
    });

    it("derives getBoardingAddress from boardingTapscript without loading the persisted contract", async () => {
        const { wallet } = await makeWallet();
        // No contract-manager access here: getBoardingAddress must not trigger
        // contract-manager initialization.
        const address = await wallet.getBoardingAddress();
        expect(address).toEqual(wallet.boardingTapscript.onchainAddress(wallet.network));
    });
});

describe("boarding contract: wallet.boardingTapscript source", () => {
    it("is sourced from BoardingContractHandler.createScript and remains a DefaultVtxo.Script", async () => {
        const { wallet, info } = await makeWallet();

        expect(wallet.boardingTapscript).toBeInstanceOf(DefaultVtxo.Script);

        // Rebuild the script the way wallet setup does — via the boarding
        // handler from the resolved pubkey, server key, and boarding timelock —
        // and confirm it is byte-identical to wallet.boardingTapscript.
        const handler = contractHandlers.get("boarding")!;
        const serverPubKey = hex.decode(info.signerPubkey).slice(1);
        const pubKey = await wallet.identity.xOnlyPublicKey();
        const boardingTimelock = {
            value: info.boardingExitDelay,
            type: info.boardingExitDelay < 512n ? ("blocks" as const) : ("seconds" as const),
        };
        const fromHandler = handler.createScript({
            pubKey: hex.encode(pubKey),
            serverPubKey: hex.encode(serverPubKey),
            csvTimelock: timelockToSequence(boardingTimelock).toString(),
        });

        expect(hex.encode(fromHandler.pkScript)).toEqual(
            hex.encode(wallet.boardingTapscript.pkScript),
        );
    });
});

describe("boarding contract: persistence through the contract-manager path", () => {
    it("creates and persists an active boarding contract matching wallet.boardingTapscript", async () => {
        const { wallet } = await makeWallet();
        const manager = await wallet.getContractManager();

        const boarding = await manager.getContracts({ type: ["boarding"] });
        expect(boarding).toHaveLength(1);

        const contract = boarding[0];
        expect(contract.type).toBe("boarding");
        expect(contract.state).toBe("active");
        // Contract.script is the boarding pkScript; matches wallet.boardingTapscript.
        expect(contract.script).toEqual(hex.encode(wallet.boardingTapscript.pkScript));
        // Contract.address holds the Arkade address derived from the script.
        expect(contract.address).toEqual(
            wallet.boardingTapscript
                .address(wallet.network.hrp, wallet.arkServerPublicKey)
                .encode(),
        );
        // The script re-derived from the persisted params matches the stored script.
        const handler = contractHandlers.get(contract.type)!;
        expect(hex.encode(handler.createScript(contract.params).pkScript)).toEqual(contract.script);
    });

    it("can be re-read through the repository", async () => {
        const { wallet } = await makeWallet();
        await wallet.getContractManager();

        const fromRepo = await wallet.contractRepository.getContracts({ type: ["boarding"] });
        expect(fromRepo).toHaveLength(1);
        expect(fromRepo[0].script).toEqual(hex.encode(wallet.boardingTapscript.pkScript));
    });

    it("registers the boarding script with the ContractWatcher (subscribes via the indexer)", async () => {
        const { wallet, indexerProvider } = await makeWallet();
        await wallet.getContractManager();

        const subscribedScripts = indexerProvider.subscribeForScripts.mock.calls.flatMap(
            (call: any[]) => call[0] ?? [],
        );
        expect(subscribedScripts).toContain(hex.encode(wallet.boardingTapscript.pkScript));
    });

    it("is idempotent: re-initializing does not duplicate the boarding contract", async () => {
        const { wallet } = await makeWallet();

        const m1 = await wallet.getContractManager();
        const before = await m1.getContracts({ type: ["boarding"] });
        expect(before).toHaveLength(1);

        // Force a fresh initialization pass against the same repository.
        await wallet.dispose();
        const m2 = await wallet.getContractManager();
        const after = await m2.getContracts({ type: ["boarding"] });
        expect(after).toHaveLength(1);
        expect(after[0].script).toEqual(before[0].script);
    });
});

describe("boarding contract: VTXO annotation and spend paths", () => {
    it("annotates a VTXO landing on the boarding script to the boarding contract with spendable paths", async () => {
        const { wallet } = await makeWallet();
        const manager = await wallet.getContractManager();

        const boardingScript = hex.encode(wallet.boardingTapscript.pkScript);
        const vtxo = {
            txid: "ab".repeat(32),
            vout: 0,
            value: 5000,
            status: { confirmed: true, block_height: 100, block_time: 1 },
            virtualStatus: { state: "settled" as const },
            createdAt: new Date(),
            script: boardingScript,
        };

        // Sanity: the persisted boarding contract is keyed by exactly this script.
        const persisted = await wallet.contractRepository.getContracts({ type: ["boarding"] });
        expect(persisted.map((c) => c.script)).toContain(boardingScript);

        const annotated = await manager.annotateVtxos([vtxo as any]);
        expect(annotated).toHaveLength(1);
        // Annotated VTXO carries the taproot tree for the boarding script.
        expect(annotated[0].tapTree).toBeDefined();

        // The boarding contract yields a collaborative (forfeit) spend path.
        const handler = contractHandlers.get("boarding")!;
        const contract = (await manager.getContracts({ type: ["boarding"] }))[0];
        const script = handler.createScript(contract.params);
        const paths = handler.getSpendablePaths(script, contract, {
            collaborative: true,
            currentTime: Date.now(),
        });
        expect(paths.length).toBeGreaterThanOrEqual(1);
    });
});

describe("boarding contract: not discoverable", () => {
    it("is not part of the discoverable handler set", () => {
        const handler = contractHandlers.get("boarding");
        expect(isDiscoverable(handler)).toBe(false);
    });
});

describe("boarding contract: server boarding-exit-delay change", () => {
    it("promotes the latest boarding script while keeping the old boarding contract persisted and watched", async () => {
        const sharedWalletRepo = new InMemoryWalletRepository();
        const sharedContractRepo = new InMemoryContractRepository();
        const identity = SingleKey.fromHex("1".repeat(64));

        const build = async (boardingExitDelay: bigint) => {
            const info = makeInfo({ boardingExitDelay });
            const arkProvider = { getInfo: vi.fn(async () => info) } as any;
            const indexerProvider = makeIdleIndexer();
            const onchainProvider = makeIdleOnchain();
            const wallet = await Wallet.create({
                identity,
                settlementConfig: false,
                arkProvider,
                indexerProvider,
                onchainProvider,
                storage: {
                    walletRepository: sharedWalletRepo,
                    contractRepository: sharedContractRepo,
                },
            });
            return { wallet, indexerProvider };
        };

        // First boot: boarding delay A (604672 = 1181 * 512, ~7 days).
        const a = await build(604672n);
        const scriptA = hex.encode(a.wallet.boardingTapscript.pkScript);
        await a.wallet.getContractManager();
        await a.wallet.dispose();

        // Second boot: server advertises a different boarding delay B
        // (1209344 = 2362 * 512, ~14 days).
        const b = await build(1209344n);
        const scriptB = hex.encode(b.wallet.boardingTapscript.pkScript);
        const managerB = await b.wallet.getContractManager();

        // Distinct scripts → distinct boarding contracts.
        expect(scriptB).not.toEqual(scriptA);

        // getBoardingAddress promotes the latest (B) script.
        expect(await b.wallet.getBoardingAddress()).toEqual(
            b.wallet.boardingTapscript.onchainAddress(b.wallet.network),
        );

        // Both boarding contracts remain persisted and active.
        const boardingContracts = await managerB.getContracts({ type: ["boarding"] });
        const scripts = boardingContracts.map((c) => c.script);
        expect(scripts).toContain(scriptA);
        expect(scripts).toContain(scriptB);
        expect(boardingContracts.every((c) => c.state === "active")).toBe(true);

        // The new boarding script is registered with the watcher on boot B.
        const subscribed = b.indexerProvider.subscribeForScripts.mock.calls.flatMap(
            (call: any[]) => call[0] ?? [],
        );
        expect(subscribed).toContain(scriptB);

        await b.wallet.dispose();
    });
});

describe("boarding contract: HD key selection stays wallet-owned", () => {
    it("persists a boarding contract whose pubkey is the wallet-resolved key, not allocated by the handler", async () => {
        const { wallet } = await makeWallet();
        const manager = await wallet.getContractManager();

        const walletPubKey = await wallet.identity.xOnlyPublicKey();
        const boarding = (await manager.getContracts({ type: ["boarding"] }))[0];
        expect(boarding.params.pubKey).toEqual(hex.encode(walletPubKey));
        // Same key the wallet's boardingTapscript uses — one resolved key shared.
        expect(boarding.params.pubKey).toEqual(hex.encode(wallet.boardingTapscript.options.pubKey));
    });
});

describe("areSameScriptBaselineTypesCompatible", () => {
    it("treats default <-> boarding as compatible (both directions)", () => {
        expect(areSameScriptBaselineTypesCompatible("default", "boarding")).toBe(true);
        expect(areSameScriptBaselineTypesCompatible("boarding", "default")).toBe(true);
    });

    it("treats same type as compatible", () => {
        for (const t of ["default", "boarding", "delegate", "vhtlc"]) {
            expect(areSameScriptBaselineTypesCompatible(t, t)).toBe(true);
        }
    });

    it("treats every other pairing as incompatible", () => {
        const incompatible: [string, string][] = [
            ["default", "delegate"],
            ["boarding", "delegate"],
            ["default", "vhtlc"],
            ["boarding", "vhtlc"],
            ["delegate", "vhtlc"],
        ];
        for (const [a, b] of incompatible) {
            expect(areSameScriptBaselineTypesCompatible(a, b)).toBe(false);
            expect(areSameScriptBaselineTypesCompatible(b, a)).toBe(false);
        }
    });
});

describe("ensureWalletContract", () => {
    // Shared (params -> script) pair. boarding and default handlers derive a
    // byte-identical script from identical params, so the same script/params
    // can back either type — exactly the collision this helper resolves.
    const PK = "5b3a7b5e8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f";
    const SPK = "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b";
    const sharedParams = {
        pubKey: PK,
        serverPubKey: SPK,
        csvTimelock: timelockToSequence({ value: 86016n, type: "seconds" }).toString(),
    };
    const sharedScript = hex.encode(DefaultContractHandler.createScript(sharedParams).pkScript);

    async function makeManager() {
        const indexerProvider = makeIdleIndexer();
        const contractRepository = new InMemoryContractRepository();
        const manager = await ContractManager.create({
            indexerProvider,
            contractRepository,
            walletRepository: new InMemoryWalletRepository(),
            watcherConfig: { failsafePollIntervalMs: 1000, reconnectDelayMs: 500 },
        });
        return { manager, indexerProvider, contractRepository };
    }

    const baselineParams = (type: string) => ({
        type,
        params: sharedParams,
        script: sharedScript,
        address: "addr",
        state: "active" as const,
    });

    const subscribedScripts = (indexerProvider: any): string[] =>
        indexerProvider.subscribeForScripts.mock.calls.flatMap((call: any[]) => call[0] ?? []);

    it("creates the contract when no row exists for the script", async () => {
        const { manager } = await makeManager();
        try {
            await ensureWalletContract(manager, baselineParams("boarding"));
            const rows = await manager.getContracts({ script: sharedScript });
            expect(rows).toHaveLength(1);
            expect(rows[0].type).toBe("boarding");
        } finally {
            manager.dispose();
        }
    });

    it("is idempotent for the same type (no duplicate row)", async () => {
        const { manager } = await makeManager();
        try {
            await ensureWalletContract(manager, baselineParams("boarding"));
            await ensureWalletContract(manager, baselineParams("boarding"));
            expect(await manager.getContracts({ script: sharedScript })).toHaveLength(1);
        } finally {
            manager.dispose();
        }
    });

    it("collision direction A: existing default, then boarding accepts the row (no duplicate, watched)", async () => {
        const { manager, indexerProvider } = await makeManager();
        try {
            await ensureWalletContract(manager, baselineParams("default"));
            await ensureWalletContract(manager, baselineParams("boarding"));

            const rows = await manager.getContracts({ script: sharedScript });
            // Assert by script, not type: the script owns exactly one row.
            expect(rows).toHaveLength(1);
            expect(rows[0].type).toBe("default");
            expect(rows[0].state).toBe("active");
            expect(subscribedScripts(indexerProvider)).toContain(sharedScript);
        } finally {
            manager.dispose();
        }
    });

    it("collision direction B: existing boarding, then default promotes the row to default (default wins)", async () => {
        const { manager, indexerProvider } = await makeManager();
        try {
            // Stale `boarding` row persisted first (an earlier boot where the
            // boarding script did not collide with any default baseline).
            await ensureWalletContract(manager, baselineParams("boarding"));
            // A later boot's default baseline now resolves to the same script.
            await ensureWalletContract(manager, baselineParams("default"));

            const rows = await manager.getContracts({ script: sharedScript });
            expect(rows).toHaveLength(1);
            // Promoted to `default` so the shared script — also the wallet's
            // live offchain baseline — stays visible to the type-gated
            // consumers (notifyIncomingFunds, getWalletScripts, getScriptMap).
            expect(rows[0].type).toBe("default");
            expect(rows[0].state).toBe("active");
            // No boarding-typed row remains for the shared script.
            expect(await manager.getContracts({ type: ["boarding"] })).toHaveLength(0);
            expect(subscribedScripts(indexerProvider)).toContain(sharedScript);
        } finally {
            manager.dispose();
        }
    });

    it("still throws on a genuinely incompatible existing type for the same script", async () => {
        const { manager, contractRepository } = await makeManager();
        try {
            // Seed an incompatible (vhtlc) row directly at the shared script,
            // bypassing createContract's params validation.
            await contractRepository.saveContract({
                type: "vhtlc",
                params: sharedParams,
                script: sharedScript,
                address: "addr",
                state: "active",
                createdAt: 0,
            });

            await expect(
                ensureWalletContract(manager, baselineParams("default")),
            ).rejects.toThrow();

            // No duplicate row was created.
            expect(await manager.getContracts({ script: sharedScript })).toHaveLength(1);
        } finally {
            manager.dispose();
        }
    });
});

describe("boarding contract: default/boarding script collision (boardingExitDelay == unilateralExitDelay)", () => {
    it("init succeeds, keeps one row for the shared script, and does not force a separate boarding row", async () => {
        // unilateralExitDelay defaults to 144 (blocks) in makeInfo; matching the
        // boarding delay makes the boarding script byte-identical to the default
        // baseline script.
        const { wallet } = await makeWallet({ boardingExitDelay: 144n });
        const manager = await wallet.getContractManager();

        const boardingScript = hex.encode(wallet.boardingTapscript.pkScript);
        const rows = await manager.getContracts({ script: boardingScript });

        // Assert by script: exactly one row owns the shared script.
        expect(rows).toHaveLength(1);
        expect(rows[0].state).toBe("active");
        // The default baseline is created first, so it owns the colliding row;
        // no second `boarding`-typed row is forced.
        expect(rows[0].type).toBe("default");
        expect(await manager.getContracts({ type: ["boarding"] })).toHaveLength(0);

        // getBoardingAddress still resolves from the (shared) boarding script.
        expect(await wallet.getBoardingAddress()).toEqual(
            wallet.boardingTapscript.onchainAddress(wallet.network),
        );
    });
});
