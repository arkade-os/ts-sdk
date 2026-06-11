import { describe, it, expect, beforeEach } from "vitest";
import { hex } from "@scure/base";
import {
    ArkInfo,
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestArkProvider,
    Wallet,
} from "../../src";
import { beforeEachFaucet, createTestIdentity, faucetOffchain } from "./utils";

const arkUrl = "http://localhost:7070";

/**
 * Integration coverage for the deprecated-signer migration *decision and
 * reporting* surface (Sections 3 & 6): classification of the wallet's real,
 * on-chain VTXOs against a rotated signer axis, and the migration pass's
 * no-op selection.
 *
 * What this deliberately does NOT do — and cannot, on regtest:
 *   A faithful cooperative migration *settle* round-trip needs arkd to hold
 *   TWO signer keys at once — the deprecated one (to co-sign spending the stale
 *   VTXOs) and the active one (to issue the migrated outputs). regtest arkd has
 *   exactly one signer, and `classifyAgainstAxis` resolves the active signer
 *   first, so a VTXO under the live key is always `current` and never
 *   migratable. There is therefore no "rotate-to-self" trick that produces an
 *   arkd-accepted migration settle — the settle round-trip is blocked on a
 *   rotation-capable fixture and arkd#822 (docs open point 15).
 *
 * So we fake the *axis* (via a dynamic `getInfo()` override) rather than a real
 * rotation: the wallet is built while `getInfo()` still reports the live signer
 * (so its contract commits to the real key and recognizes the funded VTXO),
 * then the override demotes that key to `deprecatedSigners` to drive
 * classification. The status path never rotates the wallet or settles, so this
 * stays a pure read over real state.
 */
describe("deprecated-signer migration (reporting + decision)", () => {
    beforeEach(beforeEachFaucet, 20_000);

    const poll = async <T>(
        fn: () => Promise<T | null | undefined>,
        timeout = 20_000,
        interval = 500,
    ): Promise<T> => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            const r = await fn();
            if (r) return r;
            await new Promise((res) => setTimeout(res, interval));
        }
        throw new Error("poll timed out");
    };

    const fakeCompressedKey = async (): Promise<string> =>
        hex.encode(await createTestIdentity().compressedPublicKey());

    it(
        "classifies real VTXOs against a rotated axis and migrate is a clean no-op",
        { timeout: 60_000 },
        async () => {
            // Dynamic getInfo override: real while the wallet constructs (so its
            // contract is built under the live signer), faked afterward.
            const realProvider = new RestArkProvider(arkUrl);
            let infoOverride: Partial<ArkInfo> = {};
            const arkProvider = new Proxy(realProvider, {
                get(target, prop, receiver) {
                    if (prop === "getInfo") {
                        return async () => ({ ...(await target.getInfo()), ...infoOverride });
                    }
                    const value = Reflect.get(target, prop, receiver);
                    return typeof value === "function" ? value.bind(target) : value;
                },
            });

            const wallet = await Wallet.create({
                identity: createTestIdentity(),
                arkServerUrl: arkUrl,
                arkProvider,
                onchainProvider: new EsploraProvider("http://localhost:3000/api", {
                    forcePolling: true,
                    pollingInterval: 2000,
                }),
                storage: {
                    walletRepository: new InMemoryWalletRepository(),
                    contractRepository: new InMemoryContractRepository(),
                },
                settlementConfig: false,
            });

            try {
                const arkInfo = await realProvider.getInfo();
                const liveCompressed = arkInfo.signerPubkey;
                // The contract's serverPubKey is x-only; reports normalize to it.
                const liveXOnly = hex.encode(wallet.arkServerPublicKey);

                // Fund a real VTXO under the live signer and wait for the wallet
                // to sync it into its repository.
                const amount = 10_000;
                faucetOffchain(await wallet.getAddress(), amount);
                const vtxos = await poll(async () => {
                    const v = await wallet.getVtxos();
                    return v.length > 0 ? v : null;
                });
                expect(vtxos).toHaveLength(1);
                expect(vtxos[0].value).toBe(amount);

                const vtxoManager = await wallet.getVtxoManager();
                const fakeActive = await fakeCompressedKey();

                // --- Scenario A: live signer deprecated, cutoff in the future
                // → the wallet's real VTXO is reported as migratable. ---
                const future = BigInt(Math.floor(Date.now() / 1000) + 86_400);
                infoOverride = {
                    signerPubkey: fakeActive,
                    deprecatedSigners: [{ pubkey: liveCompressed, cutoffDate: future }],
                };
                const migratable = await vtxoManager.getDeprecatedSignerStatus();
                expect(migratable).toHaveLength(1);
                expect(migratable[0]).toMatchObject({
                    signerPubKey: liveXOnly,
                    status: "MIGRATABLE",
                    vtxoCount: 1,
                    totalValue: amount,
                });
                expect(migratable[0].cutoffDate).toBe(future);
                expect(migratable[0].secondsUntilCutoff).toBeGreaterThan(0);

                // --- Scenario B: same signer, cutoff in the past → expired
                // (cooperative migration closed, unilateral exit required). ---
                const past = BigInt(Math.floor(Date.now() / 1000) - 86_400);
                infoOverride = {
                    signerPubkey: fakeActive,
                    deprecatedSigners: [{ pubkey: liveCompressed, cutoffDate: past }],
                };
                const expired = await vtxoManager.getDeprecatedSignerStatus();
                expect(expired).toHaveLength(1);
                expect(expired[0]).toMatchObject({
                    signerPubKey: liveXOnly,
                    status: "EXPIRED",
                    vtxoCount: 1,
                    totalValue: amount,
                });
                expect(expired[0].secondsUntilCutoff).toBeLessThanOrEqual(0);

                // --- Scenario C: wallet's funds are all current; arkd merely
                // advertises an unrelated deprecated signer the wallet holds
                // nothing under → migrate is a clean no-op: no rotation, no
                // settle, balance untouched. ---
                const unrelated = await fakeCompressedKey();
                infoOverride = {
                    // signerPubkey omitted → spread keeps the real live signer,
                    // so the wallet's own snapshot classifies as current.
                    deprecatedSigners: [{ pubkey: unrelated, cutoffDate: future }],
                };
                const balanceBefore = await wallet.getBalance();
                const report = await vtxoManager.migrateDeprecatedSignerVtxos();
                expect(report.rotated).toBe(false);
                expect(report.migrated).toEqual([]);
                expect(report.expired).toEqual([]);
                expect(report.signers).toEqual([]);
                expect(report.txid).toBeUndefined();
                expect(report.skipped).toBe("no-deprecated-vtxos");

                const balanceAfter = await wallet.getBalance();
                expect(balanceAfter.available).toBe(balanceBefore.available);
            } finally {
                await wallet.dispose();
            }
        },
    );
});
