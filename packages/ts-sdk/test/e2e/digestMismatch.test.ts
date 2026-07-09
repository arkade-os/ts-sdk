import { describe, it, expect, beforeEach } from "vitest";
import { hex } from "@scure/base";
import {
    ArkInfo,
    DigestMismatchError,
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    SingleKey,
    Wallet,
} from "../../src";
import {
    beforeEachFaucet,
    createTestIdentity,
    faucetOffchain,
    getServerInfo,
    rotateArkdSigner,
    waitFor,
} from "./utils";

const arkUrl = "http://localhost:7070";

/**
 * End-to-end proof of the client-side server-info digest mechanism
 * (`X-Digest` / `DIGEST_MISMATCH`) across a REAL arkd signer rotation.
 *
 * The wallet caches arkd's server-info digest from its boot `getInfo`, then
 * sends it as the `X-Digest` header on every MUTATING request (via the
 * provider's `authedFetch`). A real signer rotation (`rotateArkdSigner`
 * recreates `arkd-wallet` on a new active key and restarts `arkd`) rotates the
 * server's digest, leaving the client's cached digest stale. The next mutating
 * request then carries a stale `X-Digest`; arkd v0.9.11 rejects a stale-but-
 * present digest with a structured `DIGEST_MISMATCH` (GetInfo is exempt, so the
 * refresh path always works). On that rejection the SDK clears + refetches info,
 * fires `onServerInfoChanged` (the wallet re-derives: `refreshDeprecatedSigners`
 * then `rotateServerSigner` onto the new key), and THROWS `DigestMismatchError`
 * — it never silently retries the request built against the now-stale config.
 *
 * `settlementConfig: false` keeps the wallet's poll loop off and no `getInfo`
 * runs between the rotation and the mutating call, so nothing refreshes the
 * cached digest behind the test's back — the stale digest is exercised for real.
 *
 * One focused case walks the whole round-trip: send (implicitly, via the
 * mismatch) → DIGEST_MISMATCH → refresh + emit + wallet rotation onto B → throw
 * (no silent retry) → a rebuilt request recovers (fresh digest, no mismatch).
 */
describe("server-info digest mismatch across a real signer rotation", () => {
    // `A` = the key regtest/.env.defaults boots arkd-wallet (and the ark CLI
    // faucet) under. `B` = a second known-valid secp256k1 key the test owns
    // (BIP340 test-vector secret key). arkd keeps A as a deprecated key so it
    // can co-sign, but this test only needs the rotation to move the digest.
    const A_SEC = "afcd3fa10f82a05fddc9574fdb13b3991b568e89cc39a72ba4401df8abef35f0";
    const B_SEC = "b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef";

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
     * unless it is already there. Runs before the faucet so the `ark` CLI
     * (pinned to its boot signer `A`) can fund.
     */
    const resetToBaselineSigner = async (): Promise<void> => {
        const info = await getServerInfo(arkUrl);
        const onA = norm(info.signerPubkey) === (await xonly(A_SEC));
        if (onA && info.deprecatedSigners.length === 0) return;
        await rotateArkdSigner({ activeSignerPriv: A_SEC, deprecatedSigners: [] });
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

    /**
     * `onServerInfoChanged` and the cached `_digest` live on `RestArkProvider`,
     * not the `ArkProvider` interface `wallet.arkProvider` is typed as (the
     * wallet duck-types `onServerInfoChanged` at setup). Reach them via this
     * structural cast — the same `_digest` probe the unit suite
     * (`arkProviderDigest.test.ts`) uses.
     */
    type DigestProbe = {
        _digest: string;
        onServerInfoChanged(listener: (info: ArkInfo) => void): () => void;
    };

    // Order matters: restore baseline signer A BEFORE the faucet redeems notes.
    beforeEach(resetToBaselineSigner, 120_000);
    beforeEach(beforeEachFaucet, 20_000);

    it(
        "stale X-Digest after rotation → DIGEST_MISMATCH → refresh + wallet re-derives onto the new signer, throws (no silent retry), and a rebuilt request recovers",
        { timeout: 240_000 },
        async () => {
            const fromX = await xonly(A_SEC);
            const toX = await xonly(B_SEC);

            const wallet = await makeWallet();
            try {
                // The wallet derived its server key from the baseline (A) signer,
                // and `Wallet.create`'s getInfo cached A's server-info digest.
                expect(hex.encode(wallet.arkServerPublicKey)).toBe(fromX);
                const probe = wallet.arkProvider as unknown as DigestProbe;
                const digestA = probe._digest;
                expect(digestA).not.toBe("");

                // Record every refreshed info the provider emits on a mismatch.
                const emitted: ArkInfo[] = [];
                probe.onServerInfoChanged((info) => emitted.push(info));

                // Fund a real VTXO under A (the ark CLI faucet only funds while
                // the server is on its home signer A) — the input the mutating
                // settle below registers.
                const amount = 10_000;
                faucetOffchain(await wallet.getAddress(), amount);
                const vtxos = await poll(async () => {
                    const v = await wallet.getVtxos();
                    return v.length > 0 ? v : null;
                });
                expect(vtxos).toHaveLength(1);
                expect(vtxos[0].value).toBe(amount);

                // Rotate the server A→B (A advertised deprecated so arkd retains
                // the key). This rotates arkd's server-info digest. Nothing
                // refreshes the client's cached digest across the rotation:
                // settlementConfig is off (no poll loop) and no getInfo runs
                // between here and the settle below — so the provider still holds
                // A's now-stale digest.
                const after = await rotateArkdSigner({
                    activeSignerPriv: B_SEC,
                    deprecatedSigners: [A_SEC],
                });
                expect(norm(after.signerPubkey)).toBe(toX);
                // Precondition for the mismatch: the cached digest is unchanged.
                expect(probe._digest).toBe(digestA);

                // The next MUTATING request carries the stale `X-Digest`. settle()
                // with explicit params reaches registerIntent through authedFetch
                // WITHOUT a getInfo first (only the no-params settle path refreshes
                // info), so arkd sees the stale digest and rejects with a
                // structured DIGEST_MISMATCH. authedFetch then clears + refetches
                // info, fires onServerInfoChanged, and THROWS DigestMismatchError —
                // it never silently retries. The throw simultaneously proves the
                // client SENT X-Digest (no header ⇒ no mismatch) and that arkd
                // round-tripped the structured error over its REST gateway.
                const address = await wallet.getAddress();
                let caught: unknown;
                try {
                    await wallet.settle({
                        inputs: vtxos,
                        outputs: [{ address, amount: BigInt(vtxos[0].value) }],
                    });
                } catch (e) {
                    caught = e;
                }
                expect(caught).toBeInstanceOf(DigestMismatchError);

                // The SDK refreshed its info exactly once: it emitted the new (B)
                // signer info, and the cached digest advanced off the stale A value
                // to the fresh one carried by that refreshed info.
                expect(emitted).toHaveLength(1);
                const refreshed = emitted[0];
                expect(norm(refreshed.signerPubkey)).toBe(toX);
                expect(probe._digest).not.toBe(digestA);
                expect(probe._digest).toBe(refreshed.digest);

                // The wallet's serialized onServerInfoChanged handler re-derived
                // onto B (refreshDeprecatedSigners + rotateServerSigner). It runs
                // async off the emit, so poll for the flip.
                await waitFor(async () => hex.encode(wallet.arkServerPublicKey) === toX, {
                    timeout: 30_000,
                    interval: 500,
                });
                expect(hex.encode(wallet.arkServerPublicKey)).toBe(toX);

                // Recovery: the digest is now fresh, so a rebuilt mutating request
                // no longer DIGEST_MISMATCHes. It may still fail for an unrelated
                // reason (the VTXO now sits under the deprecated A signer) or even
                // succeed — assert only that it is NOT another DigestMismatchError.
                let recovered: unknown;
                try {
                    await wallet.settle({
                        inputs: vtxos,
                        outputs: [
                            { address: await wallet.getAddress(), amount: BigInt(vtxos[0].value) },
                        ],
                    });
                } catch (e) {
                    recovered = e;
                }
                expect(recovered).not.toBeInstanceOf(DigestMismatchError);
            } finally {
                await wallet.dispose();
            }
        },
    );
});
