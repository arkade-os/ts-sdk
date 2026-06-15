import { describe, it, expect, beforeEach } from "vitest";
import { hex } from "@scure/base";
import {
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    SingleKey,
    Wallet,
} from "../../src";
import {
    beforeEachFaucet,
    createTestIdentity,
    DeprecatedSignerSpec,
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
 * The rotation is REAL: `rotateArkdSigner` recreates `arkd-wallet` with a new
 * active signer (and the previous one advertised as deprecated, optionally with
 * a real cutoff date), then restarts `arkd`. Pre-rotation funds are real
 * on-chain/off-chain state, and the wallet observes the rotation only through
 * the server's `/v1/info`. arkd holds both keys, so it co-signs the cooperative
 * migration of the stale funds.
 *
 * Cutoff axis (real): the fixture advertises a per-deprecated-signer cutoff via
 * `ARKD_WALLET_DEPRECATED_SIGNER_KEYS=<key>[:<unix-seconds>]`. No cutoff (`0`)
 * classifies `DUE_NOW`; a future cutoff classifies `MIGRATABLE`; a past cutoff
 * classifies `EXPIRED` (cooperative migration closed).
 *
 * Boarding migration is also real on the pinned images: a pre-rotation boarding
 * UTXO under a deprecated signer is discovered, settled cooperatively, and
 * reported in the migration result. (VTXO migration co-signs the forfeit with the
 * deprecated key; boarding migration co-signs the collaborative boarding leaf.)
 *
 * Each test funds under signer `A`, then rotates `A` → `B` (with `A` deprecated)
 * and migrates. `A` is the key the regtest stack — and the shared `ark` CLI
 * faucet — boots under (`ARKD_WALLET_SIGNER_KEY` in regtest/.env.defaults); `B`
 * is a second test-owned constant. A `beforeEach` resets the server to `A`
 * (baseline) before funding, because the `ark` CLI faucet can only fund while
 * the server is on its home signer `A`. VTXO and boarding funds are never mixed
 * in one wallet: a failed boarding input would poison the shared settle.
 */
describe("deprecated-signer migration (real rotation)", () => {
    // `A` = the key regtest/.env.defaults boots arkd-wallet (and the ark CLI)
    // under. `B` = a second known-valid secp256k1 key the test owns (BIP340
    // test-vector secret key). arkd needs both privs to co-sign migration of
    // A→B funds.
    const A_SEC = "afcd3fa10f82a05fddc9574fdb13b3991b568e89cc39a72ba4401df8abef35f0";
    const A_PUB = "e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdb";
    const B_SEC = "b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef";
    const B_PUB = "dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659";

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
        const onA = norm(info.signerPubkey) === (await xonly(A_SEC));
        if (onA && info.deprecatedSigners.length === 0) return;
        await rotateArkdSigner({ activeSignerPriv: A_SEC, deprecatedSigners: [] });
    };

    const makeWallet = async (useMnemonic = false): Promise<Wallet> =>
        Wallet.create({
            identity: createTestIdentity(useMnemonic),
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

    /**
     * Build a wallet under the baseline signer `A`, fund a single real VTXO, then
     * rotate `A` → `B` advertising `A` deprecated with the given cutoff spec.
     * Returns the wallet (caller disposes), its manager, and identifiers.
     */
    const fundVtxoUnderAThenRotate = async (
        deprecatedSpec: DeprecatedSignerSpec,
        useMnemonic = false,
    ) => {
        const fromX = await xonly(A_SEC);
        const toX = await xonly(B_SEC);
        const wallet = await makeWallet(useMnemonic);
        // The wallet derived its server key from the baseline (A) signer.
        expect(hex.encode(wallet.arkServerPublicKey)).toBe(fromX);

        const amount = 10_000;
        faucetOffchain(await wallet.getAddress(), amount);
        const vtxos = await poll(async () => {
            const v = await wallet.getVtxos();
            return v.length > 0 ? v : null;
        });
        expect(vtxos).toHaveLength(1);
        expect(vtxos[0].value).toBe(amount);
        const stale = `${vtxos[0].txid}:${vtxos[0].vout}`;

        const vtxoManager = await wallet.getVtxoManager();
        const contractManager = await wallet.getContractManager();

        await rotateArkdSigner({ activeSignerPriv: B_SEC, deprecatedSigners: [deprecatedSpec] });

        // arkd's restart drops the wallet's SSE subscription. Wait for it to
        // reconnect and re-track the deprecated signer's funds before returning,
        // so the it-block migrates on fresh state instead of racing the reconnect.
        // (The ContractWatcher reconnect fix resolves this in ~5s; if reconnect
        // regresses, this poll times out and the test fails deterministically.)
        await poll(async () => {
            const s = await vtxoManager.getDeprecatedSignerStatus();
            return s.some((x) => x.vtxoCount > 0 || x.boardingCount > 0) ? s : null;
        });

        return { wallet, vtxoManager, contractManager, amount, stale, fromX, toX };
    };

    // Order matters: restore baseline signer A BEFORE the faucet redeems notes.
    beforeEach(resetToBaselineSigner, 120_000);
    beforeEach(beforeEachFaucet, 20_000);

    // ── 1. Fixture sanity — a real rotation is observable (capability guard) ──
    // If a run lands a non-rotation arkd-wallet image, `rotateArkdSigner` times
    // out here with a clear message instead of letting the rest fail obscurely.
    it("observes a real signer rotation via getInfo", { timeout: 180_000 }, async () => {
        const before = await getServerInfo(arkUrl);
        expect(norm(before.signerPubkey)).toBe(await xonly(A_SEC));

        const after = await rotateArkdSigner({
            activeSignerPriv: B_SEC,
            deprecatedSigners: [A_SEC],
        });

        expect(norm(after.signerPubkey)).toBe(await xonly(B_SEC));
        expect(after.deprecatedSigners.map((s) => norm(s.pubkey))).toContain(await xonly(A_SEC));
    });

    // ── 2. VTXO, no cutoff → DUE_NOW → cooperative migration ─────────────────
    for (const useMnemonic of [false, true]) {
        it(
            `migrates a real VTXO with no cutoff (DUE_NOW) - ${useMnemonic ? "mnemonic" : "singleKey"}`,
            { timeout: 240_000 },
            async () => {
                const { wallet, vtxoManager, contractManager, amount, stale, fromX, toX } =
                    await fundVtxoUnderAThenRotate(A_SEC, useMnemonic);
                try {
                    // Check contracts before migration
                    const before = await contractManager.getContracts();
                    expect(before.filter((c) => c.params.serverPubKey === A_PUB)).toHaveLength(2);
                    expect(before.filter((c) => c.type === "boarding")).toHaveLength(1);
                    expect(before.filter((c) => c.type === "default")).toHaveLength(1);
                    expect(before.filter((c) => c.state === "active")).toHaveLength(2);
                    expect(before).toHaveLength(2);

                    const status = await vtxoManager.getDeprecatedSignerStatus();
                    expect(status).toHaveLength(1);
                    expect(status[0]).toMatchObject({
                        signerPubKey: fromX,
                        status: "DUE_NOW",
                        vtxoCount: 1,
                        totalValue: amount,
                    });
                    expect(status[0].cutoffDate).toBeUndefined();

                    const balanceBefore = await wallet.getBalance();
                    const report = await vtxoManager.migrateDeprecatedSignerVtxos();
                    expect(report.rotated).toBe(true);
                    // VTXO leg ran through the send path; `txid` is the Ark
                    // transaction id from send, NOT a settle commitment txid.
                    expect(report.vtxos?.txid).toBeDefined();
                    expect(report.vtxos?.error).toBeUndefined();
                    expect(report.boarding).toBeUndefined();
                    expect(report.skipped).toBeUndefined();
                    expect(report.expired).toEqual([]);
                    expect(report.vtxos?.migrated.map((m) => `${m.txid}:${m.vout}`)).toContain(
                        stale,
                    );

                    // Wallet re-derived onto the active (B) signer; nothing left under A.
                    expect(hex.encode(wallet.arkServerPublicKey)).toBe(toX);
                    const postStatus = await vtxoManager.getDeprecatedSignerStatus();
                    expect(
                        postStatus.some((s) => s.signerPubKey === fromX && s.vtxoCount > 0),
                    ).toBe(false);

                    const balanceAfter = await poll(async () => {
                        const b = await wallet.getBalance();
                        return b.available === balanceBefore.available ? b : null;
                    });
                    expect(balanceAfter.available).toBe(balanceBefore.available);

                    // Check contracts after migration
                    const after = await contractManager.getContracts();
                    expect(after.filter((c) => c.params.serverPubKey === A_PUB)).toHaveLength(2);
                    expect(after.filter((c) => c.params.serverPubKey === B_PUB)).toHaveLength(2);
                    expect(after.filter((c) => c.type === "boarding")).toHaveLength(2);
                    expect(after.filter((c) => c.type === "default")).toHaveLength(2);
                    expect(after.filter((c) => c.state === "active")).toHaveLength(4);
                    expect(after).toHaveLength(4);
                } finally {
                    await wallet.dispose();
                }
            },
        );
    }

    // ── 3. VTXO, future cutoff → MIGRATABLE → cooperative migration ──────────
    for (const useMnemonic of [false, true]) {
        it(
            `migrates a real VTXO before its cutoff (MIGRATABLE) ${useMnemonic ? "with" : "without"} mnemonic`,
            { timeout: 240_000 },
            async () => {
                const cutoff = Math.floor(Date.now() / 1000) + 86_400; // +1 day
                const { wallet, vtxoManager, contractManager, amount, stale, fromX, toX } =
                    await fundVtxoUnderAThenRotate(
                        {
                            priv: A_SEC,
                            cutoffDate: cutoff,
                        },
                        useMnemonic,
                    );
                try {
                    // Check contracts before migration
                    const before = await contractManager.getContracts();
                    expect(before.filter((c) => c.params.serverPubKey === A_PUB)).toHaveLength(2);
                    expect(before.filter((c) => c.type === "boarding")).toHaveLength(1);
                    expect(before.filter((c) => c.type === "default")).toHaveLength(1);
                    expect(before.filter((c) => c.state === "active")).toHaveLength(2);
                    expect(before).toHaveLength(2);

                    const status = await vtxoManager.getDeprecatedSignerStatus();
                    expect(status).toHaveLength(1);
                    expect(status[0]).toMatchObject({
                        signerPubKey: fromX,
                        status: "MIGRATABLE",
                        vtxoCount: 1,
                        totalValue: amount,
                    });
                    expect(status[0].cutoffDate).toBe(BigInt(cutoff));
                    expect(status[0].secondsUntilCutoff).toBeGreaterThan(0);

                    const balanceBefore = await wallet.getBalance();
                    const report = await vtxoManager.migrateDeprecatedSignerVtxos();
                    expect(report.rotated).toBe(true);
                    // VTXO leg send id (not a settle commitment txid).
                    expect(report.vtxos?.txid).toBeDefined();
                    expect(report.vtxos?.error).toBeUndefined();
                    expect(report.boarding).toBeUndefined();
                    expect(report.skipped).toBeUndefined();
                    expect(report.expired).toEqual([]);
                    expect(report.vtxos?.migrated.map((m) => `${m.txid}:${m.vout}`)).toContain(
                        stale,
                    );
                    // The migrated ref carries the advertised cutoff.
                    expect(report.vtxos?.migrated[0].cutoffDate).toBe(BigInt(cutoff));

                    expect(hex.encode(wallet.arkServerPublicKey)).toBe(toX);
                    const postStatus = await vtxoManager.getDeprecatedSignerStatus();
                    expect(
                        postStatus.some((s) => s.signerPubKey === fromX && s.vtxoCount > 0),
                    ).toBe(false);

                    const balanceAfter = await poll(async () => {
                        const b = await wallet.getBalance();
                        return b.available === balanceBefore.available ? b : null;
                    });
                    expect(balanceAfter.available).toBe(balanceBefore.available);

                    // Check contracts after migration
                    const after = await contractManager.getContracts();
                    expect(after.filter((c) => c.params.serverPubKey === A_PUB)).toHaveLength(2);
                    expect(after.filter((c) => c.params.serverPubKey === B_PUB)).toHaveLength(2);
                    expect(after.filter((c) => c.type === "boarding")).toHaveLength(2);
                    expect(after.filter((c) => c.type === "default")).toHaveLength(2);
                    expect(after.filter((c) => c.state === "active")).toHaveLength(4);
                } finally {
                    await wallet.dispose();
                }
            },
        );
    }

    // ── 4. VTXO, past cutoff → EXPIRED → no cooperative settle ───────────────
    for (const useMnemonic of [false, true]) {
        it(
            "does not cooperatively settle a VTXO past its cutoff (EXPIRED)",
            { timeout: 240_000 },
            async () => {
                const cutoff = Math.floor(Date.now() / 1000) - 86_400; // -1 day
                const { wallet, vtxoManager, contractManager, amount, stale, fromX, toX } =
                    await fundVtxoUnderAThenRotate(
                        {
                            priv: A_SEC,
                            cutoffDate: cutoff,
                        },
                        useMnemonic,
                    );
                try {
                    // Check contracts before migration
                    const before = await contractManager.getContracts();
                    expect(before.filter((c) => c.params.serverPubKey === A_PUB)).toHaveLength(2);
                    expect(before.filter((c) => c.type === "boarding")).toHaveLength(1);
                    expect(before.filter((c) => c.type === "default")).toHaveLength(1);
                    expect(before.filter((c) => c.state === "active")).toHaveLength(2);
                    expect(before).toHaveLength(2);

                    const status = await vtxoManager.getDeprecatedSignerStatus();
                    expect(status).toHaveLength(1);
                    expect(status[0]).toMatchObject({
                        signerPubKey: fromX,
                        status: "EXPIRED",
                        vtxoCount: 1,
                        totalValue: amount,
                    });
                    expect(status[0].cutoffDate).toBe(BigInt(cutoff));
                    expect(status[0].secondsUntilCutoff).toBeLessThanOrEqual(0);

                    // Cooperative migration is closed past the cutoff: the wallet still
                    // re-derives its receive state to the active signer, but no settle is
                    // submitted — the stale VTXO is reported as expired (it recovers via
                    // the server batch sweep, not a cooperative settle).
                    const report = await vtxoManager.migrateDeprecatedSignerVtxos();
                    expect(report.rotated).toBe(true);
                    expect(hex.encode(wallet.arkServerPublicKey)).toBe(toX);
                    // Past cutoff: no migratable inputs → neither leg, global skip.
                    expect(report.vtxos).toBeUndefined();
                    expect(report.boarding).toBeUndefined();
                    expect(report.skipped).toBe("no-deprecated-vtxos");
                    expect(report.expired.map((m) => `${m.txid}:${m.vout}`)).toContain(stale);

                    // Check contracts after migration
                    const after = await contractManager.getContracts();
                    expect(after.filter((c) => c.params.serverPubKey === A_PUB)).toHaveLength(2);
                    expect(after.filter((c) => c.params.serverPubKey === B_PUB)).toHaveLength(2);
                    expect(after.filter((c) => c.type === "boarding")).toHaveLength(2);
                    expect(after.filter((c) => c.type === "default")).toHaveLength(2);
                    expect(after.filter((c) => c.state === "active")).toHaveLength(4);
                } finally {
                    await wallet.dispose();
                }
            },
        );
    }

    // ── 5. Boarding UTXO, no cutoff → DUE_NOW → cooperative migration ───────
    //
    // Discovery + classification of a real pre-rotation boarding UTXO is REAL and
    // the cooperative SETTLE is expected to succeed on the pinned arkd images. A
    // boarding input carries a tapscript multisig leaf that needs the SERVER's
    // deprecated-key signature; this test proves the fixture supplies it and that
    // the SDK threads the old input script into a migration output under B.
    for (const useMnemonic of [false, true]) {
        it(
            "migrates a real boarding UTXO with no cutoff (DUE_NOW)",
            { timeout: 240_000 },
            async () => {
                const fromX = await xonly(A_SEC);
                const toX = await xonly(B_SEC);

                const wallet = await makeWallet(useMnemonic);
                try {
                    // Check contracts after migration
                    const contractManager = await wallet.getContractManager();
                    const before = await contractManager.getContracts();
                    expect(before.filter((c) => c.params.serverPubKey === A_PUB)).toHaveLength(2);
                    expect(before.filter((c) => c.type === "boarding")).toHaveLength(1);
                    expect(before.filter((c) => c.type === "default")).toHaveLength(1);
                    expect(before.filter((c) => c.state === "active")).toHaveLength(2);
                    expect(before).toHaveLength(2);

                    expect(hex.encode(wallet.arkServerPublicKey)).toBe(fromX);

                    // Fund a real confirmed boarding UTXO under A (no VTXO — isolates
                    // the boarding-input migration path from the VTXO one).
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

                    await rotateArkdSigner({
                        activeSignerPriv: B_SEC,
                        deprecatedSigners: [A_SEC],
                    });

                    const vtxoManager = await wallet.getVtxoManager();

                    // Wait for the wallet to re-track the boarding UTXO after arkd's
                    // restart (its SSE subscription reconnects) before discovery /
                    // migration, so this doesn't race the reconnect.
                    await poll(async () => {
                        const s = await vtxoManager.getDeprecatedSignerStatus();
                        return s.some((x) => x.vtxoCount > 0 || x.boardingCount > 0) ? s : null;
                    });

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

                    // Per the arkd reference (TestDeprecatedSignerKey / "boarding"), a
                    // boarding UTXO locked to a not-yet-expired deprecated signer must
                    // still be cooperatively settleable — exactly like a VTXO. The
                    // wallet rotates its receive state to the active signer, then
                    // migrates the boarding input into a fresh VTXO under B.
                    const stale = `${boarding[0].txid}:${boarding[0].vout}`;
                    const report = await vtxoManager.migrateDeprecatedSignerVtxos();
                    expect(report.rotated).toBe(true);
                    expect(hex.encode(wallet.arkServerPublicKey)).toBe(toX);
                    // Boarding migrates through its OWN settle leg (separate from
                    // the send-based VTXO leg); its txid is a settle commitment.
                    expect(report.vtxos).toBeUndefined();
                    expect(report.boarding?.txid).toBeDefined();
                    expect(report.boarding?.error).toBeUndefined();
                    expect(report.boarding?.skipped).toBeUndefined();
                    expect(report.skipped).toBeUndefined();
                    expect(report.expired).toEqual([]);
                    expect(report.boarding?.migrated.map((m) => `${m.txid}:${m.vout}`)).toContain(
                        stale,
                    );

                    // The migration settle spends the boarding UTXO on-chain; its
                    // disappearance from deprecated-signer discovery depends on the
                    // commitment tx confirming + being indexed, so we don't assert it
                    // here (the reference only asserts the settle succeeds). The
                    // deterministic post-conditions — receive state moved to B and the
                    // boarding outpoint reported as migrated — are checked above.

                    // Check contracts after migration
                    const after = await contractManager.getContracts();
                    expect(after.filter((c) => c.params.serverPubKey === A_PUB)).toHaveLength(2);
                    expect(after.filter((c) => c.params.serverPubKey === B_PUB)).toHaveLength(2);
                    expect(after.filter((c) => c.type === "boarding")).toHaveLength(2);
                    expect(after.filter((c) => c.type === "default")).toHaveLength(2);
                    expect(after.filter((c) => c.state === "active")).toHaveLength(4);
                } finally {
                    await wallet.dispose();
                }
            },
        );
    }
});
