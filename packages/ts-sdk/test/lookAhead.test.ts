import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { hex } from "@scure/base";
import { ContractManager, InMemoryContractRepository, InMemoryWalletRepository } from "../src";
import { DefaultVtxo } from "../src/script/default";
import { DelegateVtxo } from "../src/script/delegate";
import type { RelativeTimelock } from "../src/script/tapscript";
import type { CandidateDeps } from "../src/contracts/types";
import { WALLET_RECEIVE_SOURCE } from "../src/contracts/metadata";
import { deriveDescriptorLeafPubKey } from "../src/identity/descriptor";
import { makeHdProviderForTest } from "./helpers/hdProvider";
import {
    installRestoreHarness,
    teardownRestoreHarness,
    makeHdWalletForTest,
    makeStaticWalletForTest,
    makeMockIndexer,
} from "./helpers/restoreWallet";

/**
 * Regression: the band used to derive one script per index from the wallet's
 * own receive tapscript, so a delegate wallet (what the Arkade web wallet is)
 * never saw a payment to the plain `default` address NArk hands out at the same
 * index — live or after a reload. Only `restore()`, whose gap scan probes the
 * full candidate matrix, recovered those funds.
 */

const SERVER_A = hex.decode("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
const SERVER_B = hex.decode("c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5");
const DELEGATE_PUBKEY = hex.decode(
    "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
);
/** Same key as advertised over the wire: compressed, x-only-ized on decode. */
const DELEGATE_PUBKEY_COMPRESSED = `02${hex.encode(DELEGATE_PUBKEY)}`;
const TL_A: RelativeTimelock = { value: 144n, type: "blocks" };
const TL_B: RelativeTimelock = { value: 288n, type: "blocks" };

function defaultScriptHex(descriptor: string, serverPubKey: Uint8Array, tl: RelativeTimelock) {
    return hex.encode(
        new DefaultVtxo.Script({
            pubKey: deriveDescriptorLeafPubKey(descriptor),
            serverPubKey,
            csvTimelock: tl,
        }).pkScript,
    );
}

function delegateScriptHex(descriptor: string, serverPubKey: Uint8Array, tl: RelativeTimelock) {
    return hex.encode(
        new DelegateVtxo.Script({
            pubKey: deriveDescriptorLeafPubKey(descriptor),
            serverPubKey,
            csvTimelock: tl,
            delegatePubKey: DELEGATE_PUBKEY,
        }).pkScript,
    );
}

describe("HD look-ahead band composition", () => {
    const size = 2;

    /** Manager with a band over real HD descriptors; `usedScripts` read as funded. */
    async function makeBandManager(opts?: {
        usedScripts?: Set<string>;
        deps?: Partial<CandidateDeps>;
        watermark?: number;
    }) {
        const provider = await makeHdProviderForTest();
        const indexer = makeMockIndexer(opts?.usedScripts ?? new Set());
        const contractRepository = new InMemoryContractRepository();
        const promoted: number[] = [];
        const manager = await ContractManager.create({
            indexerProvider: indexer,
            contractRepository,
            walletRepository: new InMemoryWalletRepository(),
            watcherConfig: { failsafePollIntervalMs: 100_000, reconnectDelayMs: 100_000 },
            lookAhead: {
                size,
                currentWatermark: async () => opts?.watermark ?? -1,
                materialize: (index) => provider.materializeDescriptorAt(index),
                candidateDeps: () => ({
                    network: { hrp: "tark" },
                    serverPubKey: SERVER_A,
                    csvTimelocks: [TL_A],
                    ...opts?.deps,
                }),
                onPromoted: async (index) => {
                    promoted.push(index);
                },
            },
        });
        return { manager, indexer, contractRepository, provider, promoted };
    }

    /** Every script the watcher has subscribed, across all subscription POSTs. */
    const subscribed = (indexer: { subscribeCalls: string[][] }) =>
        new Set(indexer.subscribeCalls.flat());

    it("watches the default variant at every band index", async () => {
        const { manager, indexer, provider } = await makeBandManager();
        try {
            const scripts = subscribed(indexer);
            // A fresh wallet (watermark -1) yields [0, size - 1].
            for (const index of [0, 1]) {
                const descriptor = provider.materializeDescriptorAt(index);
                expect(scripts.has(defaultScriptHex(descriptor, SERVER_A, TL_A))).toBe(true);
            }
        } finally {
            manager.dispose();
        }
    });

    it("watches BOTH variants at every band index for a delegate wallet", async () => {
        const { manager, indexer, provider } = await makeBandManager({
            deps: { delegatePubKey: DELEGATE_PUBKEY },
        });
        try {
            const scripts = subscribed(indexer);
            for (const index of [0, 1]) {
                const descriptor = provider.materializeDescriptorAt(index);
                expect(scripts.has(delegateScriptHex(descriptor, SERVER_A, TL_A))).toBe(true);
                // The regression.
                expect(scripts.has(defaultScriptHex(descriptor, SERVER_A, TL_A))).toBe(true);
            }
        } finally {
            manager.dispose();
        }
    });

    it("spans the timelock and deprecated-signer axes", async () => {
        const { manager, indexer, provider } = await makeBandManager({
            deps: { csvTimelocks: [TL_A, TL_B], deprecatedSignerPubKeys: [SERVER_B] },
        });
        try {
            const scripts = subscribed(indexer);
            const descriptor = provider.materializeDescriptorAt(1);
            for (const server of [SERVER_A, SERVER_B]) {
                for (const tl of [TL_A, TL_B]) {
                    expect(scripts.has(defaultScriptHex(descriptor, server, tl))).toBe(true);
                }
            }
        } finally {
            manager.dispose();
        }
    });

    it("covers [watermark - size, watermark + size] and nothing beyond", async () => {
        const watermark = 5;
        const { manager, indexer, provider } = await makeBandManager({ watermark });
        try {
            const scripts = subscribed(indexer);
            for (let index = watermark - size; index <= watermark + size; index++) {
                const descriptor = provider.materializeDescriptorAt(index);
                expect(scripts.has(defaultScriptHex(descriptor, SERVER_A, TL_A))).toBe(true);
            }
            for (const outside of [watermark - size - 1, watermark + size + 1]) {
                const descriptor = provider.materializeDescriptorAt(outside);
                expect(scripts.has(defaultScriptHex(descriptor, SERVER_A, TL_A))).toBe(false);
            }
        } finally {
            manager.dispose();
        }
    });

    it("promotes a funded cross-variant hit to an untagged repository row", async () => {
        const provider = await makeHdProviderForTest();
        const descriptor = provider.materializeDescriptorAt(1);
        const fundedScript = defaultScriptHex(descriptor, SERVER_A, TL_A);

        const { manager, contractRepository, promoted } = await makeBandManager({
            usedScripts: new Set([fundedScript]),
            deps: { delegatePubKey: DELEGATE_PUBKEY },
        });
        try {
            const rows = await contractRepository.getContracts({ script: [fundedScript] });
            expect(rows).toHaveLength(1);
            // The funded variant, not the wallet's own delegate shape.
            expect(rows[0].type).toBe("default");
            // Signable, but never advertised as our own receive address.
            expect(rows[0].metadata?.signingDescriptor).toBe(descriptor);
            expect(rows[0].metadata?.source).toBeUndefined();
            expect(promoted).toContain(1);
        } finally {
            manager.dispose();
        }
    });

    it("leaves unfunded band entries out of the repository", async () => {
        const { manager, contractRepository } = await makeBandManager({
            deps: { delegatePubKey: DELEGATE_PUBKEY },
        });
        try {
            expect(await contractRepository.getContracts({})).toEqual([]);
        } finally {
            manager.dispose();
        }
    });
});

describe("Wallet HD look-ahead", () => {
    beforeEach(installRestoreHarness);
    afterEach(teardownRestoreHarness);

    it("credits an externally issued default-variant address on a delegate wallet", async () => {
        // The `default` address an external issuer would hand out at index 1.
        const probe = await makeHdWalletForTest(new Set(), new Set(), {
            delegatePubKey: DELEGATE_PUBKEY_COMPRESSED,
        });
        const descriptor = probe.hdProvider.materializeDescriptorAt(1);
        const issued = hex.encode(
            new DefaultVtxo.Script({
                pubKey: deriveDescriptorLeafPubKey(descriptor),
                serverPubKey: probe.wallet.offchainTapscript.options.serverPubKey,
                csvTimelock: probe.wallet.offchainTapscript.options.csvTimelock,
            }).pkScript,
        );
        await probe.wallet.dispose();

        // A fresh same-seed wallet must credit them from the band alone.
        const { wallet, contractRepository } = await makeHdWalletForTest(
            new Set([issued]),
            new Set(),
            {
                delegatePubKey: DELEGATE_PUBKEY_COMPRESSED,
            },
        );
        try {
            expect(wallet.offchainTapscript).toBeInstanceOf(DelegateVtxo.Script);
            const rows = await contractRepository.getContracts({ script: [issued] });
            expect(rows).toHaveLength(1);
            expect(rows[0].type).toBe("default");
            expect(rows[0].metadata?.source).not.toBe(WALLET_RECEIVE_SOURCE);
            expect((await wallet.getBalance()).total).toBeGreaterThan(0);
        } finally {
            await wallet.dispose();
        }
    });

    it("survives an HD provider handed in keyring-wrapped as walletMode", async () => {
        const probe = await makeHdWalletForTest();
        const issued = defaultScriptHex(
            probe.hdProvider.materializeDescriptorAt(1),
            probe.wallet.offchainTapscript.options.serverPubKey,
            probe.wallet.offchainTapscript.options.csvTimelock!,
        );
        await probe.wallet.dispose();

        // The keyring forwards duck-typed capabilities but not its base's
        // class, so an `instanceof HDDescriptorProvider` that skips the
        // unwrap silently drops the band and the payment never lands.
        const { wallet, contractRepository } = await makeHdWalletForTest(
            new Set([issued]),
            new Set(),
            { wrapInKeyring: true },
        );
        try {
            expect(await contractRepository.getContracts({ script: [issued] })).toHaveLength(1);
            expect((await wallet.getBalance()).total).toBeGreaterThan(0);
        } finally {
            await wallet.dispose();
        }
    });

    it("stays off for a static wallet (no watermark to look ahead of)", async () => {
        const probe = await makeHdWalletForTest();
        const descriptor = probe.hdProvider.materializeDescriptorAt(1);
        await probe.wallet.dispose();

        const { wallet, indexer } = await makeStaticWalletForTest();
        try {
            const rotated = hex.encode(
                new DefaultVtxo.Script({
                    pubKey: deriveDescriptorLeafPubKey(descriptor),
                    serverPubKey: wallet.offchainTapscript.options.serverPubKey,
                    csvTimelock: wallet.offchainTapscript.options.csvTimelock,
                }).pkScript,
            );
            expect(new Set(indexer.subscribeCalls.flat()).has(rotated)).toBe(false);
        } finally {
            await wallet.dispose();
        }
    });
});
