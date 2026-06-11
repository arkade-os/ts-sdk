import { describe, it, expect, beforeEach } from "vitest";
import { hex } from "@scure/base";
import {
    ArkInfo,
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestArkProvider,
    SingleKey,
    Wallet,
} from "../../src";
import {
    beforeEachFaucet,
    createTestIdentity,
    faucetOffchain,
    faucetOnchain,
    getServerInfo,
    rotateArkdSigner,
    waitFor,
} from "./utils";

const arkUrl = "http://localhost:7070";

/**
 * Real, fixture-driven server-signer rotation coverage for the deprecated-signer
 * migration surface (docs §3, §6, §7).
 *
 * The rotation here is REAL: `rotateArkdSigner` recreates `arkd-wallet` with a
 * new active signer (and the previous one advertised as deprecated), then
 * restarts `arkd`. Pre-rotation funds are real on-chain/off-chain state, and the
 * wallet observes the rotation only through the server's `/v1/info`. arkd holds
 * both keys, so it co-signs the cooperative migration of the stale funds.
 *
 * The fixture advertises NO cutoff date — arkd's `feat/deprecated-keys` branch
 * has no knob to set one and advertises `cutoffDate` as a non-nullable `0`
 * (its "no cutoff" sentinel, also what the gateway emits for the unset field).
 * The SDK keeps it as `0n` and the classifier maps `0n` → `DUE_NOW`, so the
 * real-rotation blocks assert `DUE_NOW`, not `MIGRATABLE`.
 *
 * Scope on the current image: VTXO migration is fully real (server co-signs the
 * forfeit with the deprecated key). Boarding migration is NOT — arkd only
 * co-signs boarding inputs with the active signer, so the cooperative boarding
 * settle is rejected (`INVALID_BOARDING_INPUT_SIG`); test #3 therefore asserts
 * real boarding *discovery* plus that server-side block. Cutoff *classification*
 * (`MIGRATABLE` future / `EXPIRED` past) is still faked in the single retained
 * Proxy-based test at the bottom. Both gaps are tracked for iteration 2 (the
 * boarding co-sign and the cutoff knob are server-side) — see
 * plans/arkd-keys-rotation-e2e.md.
 *
 * Each real-rotation test funds under signer `A`, then rotates `A` → `B` (with
 * `A` deprecated) and migrates. `A` is the key the regtest stack — and the
 * shared `ark` CLI faucet — boots under (`ARKD_WALLET_SIGNER_KEY` in
 * regtest/.env.defaults); `B` is a second test-owned constant. A `beforeEach`
 * resets the server to `A` (baseline) before funding, because the `ark` CLI
 * faucet can only fund while the server is on its home signer `A`.
 */
describe("deprecated-signer migration (real rotation)", () => {
    // `A` = the key regtest/.env.defaults boots arkd-wallet (and the ark CLI)
    // under. `B` = a second known-valid secp256k1 key the test owns (BIP340
    // test-vector secret key). arkd needs both privs to co-sign migration of
    // A→B funds.
    const A_PRIV = "afcd3fa10f82a05fddc9574fdb13b3991b568e89cc39a72ba4401df8abef35f0";
    const B_PRIV = "b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef";

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

    /** x-only (32-byte) hex of a private key. */
    const xonly = async (priv: string): Promise<string> =>
        hex.encode(await SingleKey.fromHex(priv).xOnlyPublicKey());

    /** Normalize a server-advertised pubkey hex to lowercase x-only. */
    const norm = (pubkeyHex: string): string => {
        const s = pubkeyHex.toLowerCase();
        return s.length === 66 ? s.slice(2) : s;
    };

    /**
     * Reset the server to the baseline signer `A` with no deprecated signers,
     * unless it is already there. Runs before the faucet so the `ark` CLI (which
     * is pinned to its boot signer `A`) can fund. Idempotent and cheap when the
     * server is already on `A` (the common case on a fresh stack / after the
     * suite's own teardown leaves it on `A`).
     */
    const resetToBaselineSigner = async (): Promise<void> => {
        const info = await getServerInfo(arkUrl);
        const onA = norm(info.signerPubkey) === (await xonly(A_PRIV));
        if (onA && info.deprecatedSigners.length === 0) return;
        await rotateArkdSigner({ activeSignerPriv: A_PRIV, deprecatedSignerPrivs: [] });
    };

    const makeWallet = async (): Promise<Wallet> =>
        Wallet.create({
            identity: createTestIdentity(),
            arkServerUrl: arkUrl,
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

    // Order matters: restore baseline signer A BEFORE the faucet redeems notes.
    beforeEach(resetToBaselineSigner, 120_000);
    beforeEach(beforeEachFaucet, 20_000);

    // ── 1. Fixture sanity — a real rotation is observable (capability guard) ──
    // If a run lands a non-rotation arkd-wallet image, `rotateArkdSigner` times
    // out here with a clear message instead of letting #2/#3 fail obscurely.
    it("observes a real signer rotation via getInfo", { timeout: 180_000 }, async () => {
        const before = await getServerInfo(arkUrl);
        expect(norm(before.signerPubkey)).toBe(await xonly(A_PRIV));

        const after = await rotateArkdSigner({
            activeSignerPriv: B_PRIV,
            deprecatedSignerPrivs: [A_PRIV],
        });

        expect(norm(after.signerPubkey)).toBe(await xonly(B_PRIV));
        expect(after.deprecatedSigners.map((s) => norm(s.pubkey))).toContain(await xonly(A_PRIV));
    });

    // ── 2. VTXO happy path — migrate a real VTXO after a real rotation ───────
    it("migrates a real pre-rotation VTXO (DUE_NOW)", { timeout: 240_000 }, async () => {
        const fromX = await xonly(A_PRIV);
        const toX = await xonly(B_PRIV);

        const wallet = await makeWallet();
        try {
            // The wallet derived its server key from the baseline (A) signer.
            expect(hex.encode(wallet.arkServerPublicKey)).toBe(fromX);

            // Fund a real VTXO under A and sync it into the repository.
            const amount = 10_000;
            faucetOffchain(await wallet.getAddress(), amount);
            const vtxos = await poll(async () => {
                const v = await wallet.getVtxos();
                return v.length > 0 ? v : null;
            });
            expect(vtxos).toHaveLength(1);
            expect(vtxos[0].value).toBe(amount);
            const stale = `${vtxos[0].txid}:${vtxos[0].vout}`;

            const balanceBefore = await wallet.getBalance();

            // Real rotation: A → B, A advertised deprecated (no cutoff).
            await rotateArkdSigner({
                activeSignerPriv: B_PRIV,
                deprecatedSignerPrivs: [A_PRIV],
            });

            const vtxoManager = await wallet.getVtxoManager();

            // Discovery: the stale VTXO under A is DUE_NOW (no cutoff).
            const status = await vtxoManager.getDeprecatedSignerStatus();
            expect(status).toHaveLength(1);
            expect(status[0]).toMatchObject({
                signerPubKey: fromX,
                status: "DUE_NOW",
                vtxoCount: 1,
                totalValue: amount,
            });
            expect(status[0].cutoffDate).toBeUndefined();

            // Cooperative migration of the stale VTXO to the active signer.
            const report = await vtxoManager.migrateDeprecatedSignerVtxos();
            expect(report.rotated).toBe(true);
            expect(report.txid).toBeDefined();
            expect(report.skipped).toBeUndefined();
            expect(report.expired).toEqual([]);
            expect(report.migrated.map((m) => `${m.txid}:${m.vout}`)).toContain(stale);

            // Wallet re-derived onto the active (B) signer.
            expect(hex.encode(wallet.arkServerPublicKey)).toBe(toX);

            // Nothing left under the deprecated signer; balance preserved
            // (migration is fee-exempt and the stack runs zero fees).
            const postStatus = await vtxoManager.getDeprecatedSignerStatus();
            expect(postStatus.some((s) => s.signerPubKey === fromX && s.vtxoCount > 0)).toBe(false);

            const balanceAfter = await poll(async () => {
                const b = await wallet.getBalance();
                return b.available === balanceBefore.available ? b : null;
            });
            expect(balanceAfter.available).toBe(balanceBefore.available);
        } finally {
            await wallet.dispose();
        }
    });

    // ── 3. Boarding discovery is real; cooperative settle is server-blocked ──
    //
    // Discovery + classification of a real pre-rotation boarding UTXO is REAL
    // and asserted here. The cooperative SETTLE, however, is blocked on the
    // current arkd image: a boarding input carries a tapscript multisig leaf
    // that requires the SERVER's signature, and arkd only ever co-signs boarding
    // inputs with the ACTIVE signer — never a deprecated one. (Verified in arkd
    // `feat/deprecated-keys`: `VerifyBoardingTapscriptSigs` mock-verifies
    // deprecated keys only on the non-`mustIncludeSignerSig` path used by VTXO
    // forfeits — see internal/infrastructure/tx-builder/covenantless/builder.go
    // — so a boarding input under a deprecated key fails verification with
    // `missing signature for <deprecated-key>`.) Unlike VTXOs (test #2), which
    // migrate for real, boarding migration is therefore gated on a server-side
    // fix. ITERATION 2: once arkd co-signs boarding inputs with deprecated keys,
    // promote this to a real happy path mirroring test #2 (see
    // plans/arkd-keys-rotation-e2e.md).
    it(
        "discovers a real boarding UTXO (DUE_NOW); settle is server-blocked",
        { timeout: 240_000 },
        async () => {
            const fromX = await xonly(A_PRIV);
            const toX = await xonly(B_PRIV);

            const wallet = await makeWallet();
            try {
                expect(hex.encode(wallet.arkServerPublicKey)).toBe(fromX);

                // Fund a real confirmed boarding UTXO under A.
                const amount = 100_000;
                faucetOnchain(await wallet.getBoardingAddress(), amount);
                await waitFor(
                    async () => {
                        const u = await wallet.getBoardingUtxos();
                        return u.length >= 1 && u.every((c) => c.status.confirmed);
                    },
                    { timeout: 30_000, interval: 2000 },
                );
                const boarding = await wallet.getBoardingUtxos();
                expect(boarding).toHaveLength(1);
                expect(boarding[0].value).toBe(amount);

                // Real rotation: A → B, A deprecated (no cutoff).
                await rotateArkdSigner({
                    activeSignerPriv: B_PRIV,
                    deprecatedSignerPrivs: [A_PRIV],
                });

                const vtxoManager = await wallet.getVtxoManager();

                // Discovery (REAL): the stale boarding UTXO under A is DUE_NOW.
                const status = await vtxoManager.getDeprecatedSignerStatus();
                expect(status).toHaveLength(1);
                expect(status[0]).toMatchObject({
                    signerPubKey: fromX,
                    status: "DUE_NOW",
                    vtxoCount: 0,
                    totalValue: 0,
                    boardingCount: 1,
                    boardingValue: amount,
                });
                expect(status[0].cutoffDate).toBeUndefined();

                // The wallet still rotates its receive state to the active signer
                // (that does not depend on the server co-signing the boarding input),
                // then the cooperative settle is rejected server-side because arkd
                // will not sign the boarding input with the deprecated key.
                const report = await vtxoManager.migrateDeprecatedSignerVtxos();
                expect(report.rotated).toBe(true);
                expect(hex.encode(wallet.arkServerPublicKey)).toBe(toX);
                expect(report.txid).toBeUndefined();
                expect(report.migrated).toEqual([]);
                expect(report.error).toContain("INVALID_BOARDING_INPUT_SIG");

                // The boarding UTXO is untouched on-chain (the settle never
                // landed). The wallet's own receive state moved to B, so
                // `getBoardingUtxos()` (which tracks the active address) no longer
                // lists it; the deprecated-signer discovery path, which scans the
                // old signer A, still reports it.
                const postStatus = await vtxoManager.getDeprecatedSignerStatus();
                expect(
                    postStatus.some((s) => s.signerPubKey === fromX && s.boardingCount === 1),
                ).toBe(true);
            } finally {
                await wallet.dispose();
            }
        },
    );

    // ── Retained faked test — cutoff CLASSIFICATION only (ITERATION 2) ───────
    //
    // The real fixture cannot advertise a cutoff date yet (no server knob), so
    // the future/past-cutoff classification semantics (`MIGRATABLE` / `EXPIRED`)
    // are still driven by a `getInfo()` Proxy here. ITERATION 2: once the server
    // grows a cutoff mechanism, fold these into the real-rotation happy paths
    // above and delete this test (see plans/arkd-keys-rotation-e2e.md).
    it(
        "classifies a future cutoff as MIGRATABLE and a past cutoff as EXPIRED (VTXO + boarding)",
        { timeout: 90_000 },
        async () => {
            // Real while the wallet constructs (so its contracts commit to the
            // live signer and recognize the funded coins), faked afterward.
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
                const liveXOnly = hex.encode(wallet.arkServerPublicKey);
                const fakeActive = hex.encode(await createTestIdentity().compressedPublicKey());

                // Fund a real VTXO and a real boarding UTXO under the live signer.
                const vtxoAmount = 10_000;
                faucetOffchain(await wallet.getAddress(), vtxoAmount);
                const vtxos = await poll(async () => {
                    const v = await wallet.getVtxos();
                    return v.length > 0 ? v : null;
                });
                expect(vtxos).toHaveLength(1);

                const boardingAmount = 100_000;
                faucetOnchain(await wallet.getBoardingAddress(), boardingAmount);
                await waitFor(
                    async () => {
                        const u = await wallet.getBoardingUtxos();
                        return u.length >= 1 && u.every((c) => c.status.confirmed);
                    },
                    { timeout: 30_000, interval: 2000 },
                );

                const vtxoManager = await wallet.getVtxoManager();

                // Future cutoff → MIGRATABLE, both VTXO and boarding counted.
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
                    totalValue: vtxoAmount,
                    boardingCount: 1,
                    boardingValue: boardingAmount,
                });
                expect(migratable[0].cutoffDate).toBe(future);
                expect(migratable[0].secondsUntilCutoff).toBeGreaterThan(0);

                // Past cutoff → EXPIRED.
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
                    totalValue: vtxoAmount,
                    boardingCount: 1,
                    boardingValue: boardingAmount,
                });
                expect(expired[0].secondsUntilCutoff).toBeLessThanOrEqual(0);
            } finally {
                await wallet.dispose();
            }
        },
    );
});
