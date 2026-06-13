import {
    Wallet,
    SingleKey,
    MnemonicIdentity,
    Identity,
    OnchainWallet,
    EsploraProvider,
    IntentFeeConfig,
    InMemoryWalletRepository,
    InMemoryContractRepository,
    ArkInfo,
    ArkProvider,
    RestArkProvider,
    WalletRepository,
    ContractRepository,
    WalletMode,
    RestDelegateProvider,
} from "../../src";
import { execSync } from "child_process";
import { hex } from "@scure/base";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export const arkdExec = "docker exec -t arkd";

let arkCliInitialized = false;

function ensureArkCliInitialized(): void {
    if (arkCliInitialized) return;
    try {
        execSync(
            `${arkdExec} ark init --password secret --server-url localhost:7070 --explorer http://mempool_web/api`,
            { stdio: "pipe" },
        );
    } catch {
        // already initialized — ignore
    }
    arkCliInitialized = true;
}

export interface TestArkWallet {
    wallet: Wallet;
    identity: Identity;
}

export interface TestOnchainWallet {
    wallet: OnchainWallet;
    identity: Identity;
}

export function execCommand(command: string): string {
    const result = execSync(command, { encoding: "utf8" })
        .replace(/\r/g, "")
        .split("\n")
        .filter((line) => !line.includes("WARN"))
        .join("\n")
        .trim();
    if (result.startsWith("error:")) {
        throw new Error(result);
    }
    return result;
}

export function createTestIdentity(useMnemonic = false): Identity {
    if (useMnemonic) {
        const mnemonic = generateMnemonic(wordlist);
        return MnemonicIdentity.fromMnemonic(mnemonic, {
            isMainnet: false,
        });
    }
    return SingleKey.fromRandomBytes();
}

export async function createTestOnchainWallet(): Promise<TestOnchainWallet> {
    const identity = createTestIdentity();
    const wallet = await OnchainWallet.create(identity, "regtest");
    return {
        wallet,
        identity,
    };
}

export async function createTestArkWallet(): Promise<TestArkWallet> {
    const identity = createTestIdentity();

    const wallet = await Wallet.create({
        identity,
        arkServerUrl: "http://localhost:7070",
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

    return {
        wallet,
        identity,
    };
}

export async function createTestArkWalletWithDelegate(): Promise<TestArkWallet> {
    const identity = createTestIdentity();

    const wallet = await Wallet.create({
        identity,
        arkServerUrl: "http://localhost:7070",
        onchainProvider: new EsploraProvider("http://localhost:3000/api", {
            forcePolling: true,
            pollingInterval: 2000,
        }),
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
        delegateProvider: new RestDelegateProvider("http://localhost:7012"),
        settlementConfig: false,
    });

    return {
        wallet,
        identity,
    };
}

export async function createTestArkWalletWithMnemonic(): Promise<TestArkWallet> {
    const mnemonic = generateMnemonic(wordlist);
    const identity = MnemonicIdentity.fromMnemonic(mnemonic, {
        isMainnet: false,
    });

    const wallet = await Wallet.create({
        identity,
        arkServerUrl: "http://localhost:7070",
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

    return {
        wallet,
        identity,
    };
}

/**
 * Build a Wallet from a given mnemonic and optional repositories.
 *
 * This is the counterpart to `createTestArkWalletWithMnemonic` that lets the
 * caller supply both the seed and the storage layer, making it possible to
 * construct a second wallet on the same mnemonic with *fresh* (separate)
 * repositories — the pattern needed by restore tests.
 *
 * An optional `walletMode` is forwarded verbatim to `Wallet.create`'s
 * config. Omitting it preserves the previous behaviour (the SDK default,
 * `'auto'`, which currently behaves like `'static'`). Restore tests pass
 * `'hd'` so the receive address rotates off the index-0 baseline — the
 * only scenario where `restore()` is actually load-bearing.
 */
export async function createTestArkWalletFromMnemonic(
    mnemonic: string,
    repos?: SharedRepos,
    walletMode?: WalletMode,
): Promise<TestArkWallet> {
    const identity = MnemonicIdentity.fromMnemonic(mnemonic, {
        isMainnet: false,
    });
    const storage = repos ?? createSharedRepos();

    const wallet = await Wallet.create({
        identity,
        ...(walletMode !== undefined ? { walletMode } : {}),
        arkServerUrl: "http://localhost:7070",
        onchainProvider: new EsploraProvider("http://localhost:3000/api", {
            forcePolling: true,
            pollingInterval: 2000,
        }),
        storage: {
            walletRepository: storage.walletRepository,
            contractRepository: storage.contractRepository,
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

export function faucetOnchain(address: string, amount: number): void {
    const btc = (amount / 100_000_000).toFixed(8); // BTC with 8 decimals
    // --confirm mines 1 block immediately so the funds confirm (the new
    // arkade-regtest CLI does not auto-mine on faucet). Run from repo root.
    execCommand(`node regtest/regtest.mjs faucet ${address} ${btc} --confirm`);
}

export function mineBlocks(n: number = 1): void {
    execCommand(`node regtest/regtest.mjs mine ${n}`);
}

export async function createVtxo(alice: TestArkWallet, amount: number): Promise<string> {
    const address = await alice.wallet.getAddress();
    if (!address) throw new Error("Offchain address not defined.");

    faucetOffchain(address, amount);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const virtualCoins = await alice.wallet.getVtxos();
    if (!virtualCoins || virtualCoins.length === 0) {
        throw new Error("No VTXOs found after onboarding transaction.");
    }

    const settleTxid = await alice.wallet.settle({
        inputs: virtualCoins,
        outputs: [
            {
                address,
                amount: BigInt(virtualCoins.reduce((sum, vtxo) => sum + vtxo.value, 0)),
            },
        ],
    });

    return settleTxid;
}

// before each test, ensure the faucet wallet has fresh spendable VTXOs.
// After rounds, existing VTXOs can become stale (balance shows them but
// ark send can't spend them), so we always redeem a fresh note.
export async function beforeEachFaucet(): Promise<void> {
    ensureArkCliInitialized();
    const noteStr = execCommand(`${arkdExec} arkd note --amount 200000`);
    execCommand(`${arkdExec} ark redeem-notes -n ${noteStr} --password secret`);
}

export function setFees(fees: IntentFeeConfig): void {
    let cmd = `${arkdExec} arkd fees intent`;
    if (fees.offchainInput) {
        cmd += ` --offchain-input ${fees.offchainInput}`;
    }
    if (fees.onchainInput) {
        cmd += ` --onchain-input ${fees.onchainInput}`;
    }
    if (fees.offchainOutput) {
        cmd += ` --offchain-output ${fees.offchainOutput}`;
    }
    if (fees.onchainOutput) {
        cmd += ` --onchain-output ${fees.onchainOutput}`;
    }
    execCommand(cmd);
}

export function clearFees(): void {
    execCommand(`${arkdExec} arkd fees clear`);
}

export async function waitFor(
    fn: () => Promise<boolean>,
    { timeout = 25_000, interval = 250 } = {},
): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error("timeout in waitFor");
}

/**
 * Wrap a real ArkProvider, overriding selected fields of `getInfo()` while
 * forwarding every other method to the underlying provider. Used to simulate
 * server-config changes (e.g. `unilateralExitDelay`) between wallet loads
 * without actually restarting arkd.
 */
export function createOverrideInfoArkProvider(
    real: ArkProvider,
    overrides: Partial<ArkInfo>,
): ArkProvider {
    return new Proxy(real, {
        get(target, prop, receiver) {
            if (prop === "getInfo") {
                return async () => {
                    const info = await target.getInfo();
                    return { ...info, ...overrides };
                };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

// ─── Server-signer rotation fixture (deprecated-keys e2e) ───────────────────
//
// Drives a REAL signer rotation on the running regtest arkd at test time,
// without editing the `regtest/` submodule. Ported from the proven Go e2e
// (`recreateArkdWallet` / `restartArkd` in
// ../arkd/internal/test/e2e/utils_test.go), adapted to this repo's two-file,
// profiled compose project (`arkade-regtest`) launched by `regtest.mjs`.

const ARK_URL = "http://localhost:7070";

export interface ServerSignerInfo {
    /** Active signer pubkey, hex exactly as arkd's `/v1/info` returns it. */
    signerPubkey: string;
    deprecatedSigners: { pubkey: string; cutoffDate?: string }[];
}

/** Read the current active + deprecated signer set from `GET /v1/info`. */
export async function getServerInfo(arkUrl: string = ARK_URL): Promise<ServerSignerInfo> {
    const res = await fetch(`${arkUrl}/v1/info`);
    if (!res.ok) {
        throw new Error(`getServerInfo: ${res.status} ${res.statusText}`);
    }
    const j: any = await res.json();
    return {
        signerPubkey: j.signerPubkey ?? "",
        deprecatedSigners: (j.deprecatedSigners ?? []).map((s: any) => ({
            pubkey: s.pubkey ?? "",
            cutoffDate: s.cutoffDate,
        })),
    };
}

/** Normalize a signer pubkey hex to lowercase x-only (drop a compressed prefix). */
function toXOnly(pubkeyHex: string): string {
    const s = pubkeyHex.toLowerCase();
    return s.length === 66 ? s.slice(2) : s;
}

/**
 * A deprecated signer to advertise: a bare private-key hex (no cutoff), or a
 * `{ priv, cutoffDate }` pair. `cutoffDate` is a Unix timestamp in **seconds**;
 * arkd accepts it appended to the key as `<hexkey>:<unix-seconds>` in
 * `ARKD_WALLET_DEPRECATED_SIGNER_KEYS` (cutoff `0`/absent = no cutoff → DUE_NOW).
 */
export type DeprecatedSignerSpec = string | { priv: string; cutoffDate?: number };

/**
 * Perform a real server-signer rotation: recreate `arkd-wallet` with the given
 * active signer (and optional deprecated signers, each with an optional cutoff
 * date), then restart `arkd` so it re-reads the signer set. Resolves once
 * `/v1/info` reflects the rotation.
 *
 * Keys are **private** keys (hex), matching the `ARKD_WALLET_SIGNER_KEY` /
 * `ARKD_WALLET_DEPRECATED_SIGNER_KEYS` fixture env. The fixture must hold the
 * deprecated private key so arkd can co-sign the cooperative migration of
 * pre-rotation funds.
 */
export async function rotateArkdSigner(params: {
    activeSignerPriv: string;
    deprecatedSigners?: DeprecatedSignerSpec[];
    arkUrl?: string;
}): Promise<ServerSignerInfo> {
    const { activeSignerPriv, arkUrl = ARK_URL } = params;
    const deprecated = (params.deprecatedSigners ?? []).map((d) =>
        typeof d === "string" ? { priv: d, cutoffDate: undefined as number | undefined } : d,
    );

    // Build the recreate subprocess env exactly as `regtest.mjs` would: defaults
    // + the package `.env.regtest`, so `ARKD_WALLET_IMAGE` resolves to the
    // rotation-capable local image and ports match. A bare vitest process does
    // not have this env, and the compose default image has no rotation support.
    // `regtest` is symlinked into the package dir by scripts/regtest.sh, so this
    // path resolves at e2e runtime.
    const { loadEnv } = await import("../../regtest/lib/env.mjs");
    loadEnv("regtest", ".env.regtest");

    // arkd parses each entry as `<hexkey>[:<unix-seconds cutoff>]`.
    const env = {
        ...process.env,
        ARKD_WALLET_SIGNER_KEY: activeSignerPriv,
        ARKD_WALLET_DEPRECATED_SIGNER_KEYS: deprecated
            .map((d) => (d.cutoffDate != null ? `${d.priv}:${d.cutoffDate}` : d.priv))
            .join(","),
    };

    // Recreate ONLY arkd-wallet, reusing the named `ark_wallet_datadir` volume
    // so the on-chain wallet seed/state survive (never pass --volumes). The
    // three-file, profiled, project-named form matches the running stack
    // (regtest/lib/compose.mjs); the Go reference's single-file/profile-less
    // form would target the wrong compose project. Both `base` and `ark`
    // profiles must be enabled: `--no-deps` keeps arkd-wallet's dependencies
    // (bitcoin, nbxplorer — both `base`-gated) from being recreated, but they
    // must still be DEFINED in the project or compose rejects arkd-wallet's
    // `depends_on` as an "undefined service".
    execSync(
        [
            "docker compose",
            "-p arkade-regtest",
            "-f regtest/docker/compose.base.yml",
            "-f regtest/docker/compose.ark.yml",
            "-f test/e2e/compose.rotation.yml",
            "--profile base --profile ark",
            "up -d --force-recreate --no-deps arkd-wallet",
        ].join(" "),
        { stdio: "pipe", env },
    );

    // arkd caches the signer pubkey set at startup, so it must restart to pick
    // up the rotated wallet. On this stack arkd auto-unlocks the recreated
    // wallet via its env unlocker (ARKD_UNLOCKER_TYPE=env) on restart, so no
    // admin unlock call is needed (unlike the Go reference's stack).
    execSync("docker container stop arkd", { stdio: "pipe" });
    await new Promise((r) => setTimeout(r, 5000));
    execSync("docker container start arkd", { stdio: "pipe", env });

    // Wait for arkd readiness AND for the rotation to be observable: RPCs racing
    // the restart get "server not ready", so poll until `/v1/info` both succeeds
    // and reports the new active signer + the full deprecated set.
    const expectedActive = toXOnly(
        hex.encode(await SingleKey.fromHex(activeSignerPriv).xOnlyPublicKey()),
    );
    const expectedDeprecated = await Promise.all(
        deprecated.map(async (d) =>
            toXOnly(hex.encode(await SingleKey.fromHex(d.priv).xOnlyPublicKey())),
        ),
    );

    const deadline = Date.now() + 90_000;
    let lastInfo: ServerSignerInfo | undefined;
    while (Date.now() < deadline) {
        try {
            lastInfo = await getServerInfo(arkUrl);
            const activeOk = toXOnly(lastInfo.signerPubkey) === expectedActive;
            const advertised = new Set(lastInfo.deprecatedSigners.map((s) => toXOnly(s.pubkey)));
            const deprecatedOk = expectedDeprecated.every((p) => advertised.has(p));
            if (activeOk && deprecatedOk) return lastInfo;
        } catch {
            // arkd not ready yet — keep polling.
        }
        await new Promise((r) => setTimeout(r, 2000));
    }

    throw new Error(
        `rotateArkdSigner: timed out waiting for arkd to advertise active signer ` +
            `${expectedActive} with deprecated [${expectedDeprecated.join(", ")}]. ` +
            `The pinned arkd-wallet image may not support ARKD_WALLET_DEPRECATED_SIGNER_KEYS ` +
            `(signer rotation). Last /v1/info: ${JSON.stringify(lastInfo)}`,
    );
}

export interface SharedRepos {
    walletRepository: WalletRepository;
    contractRepository: ContractRepository;
}

export function createSharedRepos(): SharedRepos {
    return {
        walletRepository: new InMemoryWalletRepository(),
        contractRepository: new InMemoryContractRepository(),
    };
}

/**
 * Create a delegate-enabled wallet using a provided identity and repositories,
 * with an `ArkProvider` whose `getInfo()` overrides `unilateralExitDelay` to
 * simulate a server-side config change without restarting arkd.
 */
export async function createTestArkWalletWithDelegateAndOverride(opts: {
    identity: Identity;
    repos: SharedRepos;
    unilateralExitDelay: bigint;
}): Promise<TestArkWallet> {
    const arkServerUrl = "http://localhost:7070";
    const realProvider = new RestArkProvider(arkServerUrl);
    const arkProvider = createOverrideInfoArkProvider(realProvider, {
        unilateralExitDelay: opts.unilateralExitDelay,
        // This fixture exercises the current-signer exit-delay change only. Pin a
        // clean (no-deprecated) signer set so a deprecated signer left advertised
        // by an earlier e2e (e.g. the migration suite, run on the shared regtest
        // arkd) can't add deprecated-signer baseline contracts and skew the exact
        // contract counts asserted below. The baseline matrix now fans over
        // current ∪ deprecated signers, so the test must control that axis.
        deprecatedSigners: [],
    });

    const wallet = await Wallet.create({
        identity: opts.identity,
        arkServerUrl,
        arkProvider,
        onchainProvider: new EsploraProvider("http://localhost:3000/api", {
            forcePolling: true,
            pollingInterval: 2000,
        }),
        storage: {
            walletRepository: opts.repos.walletRepository,
            contractRepository: opts.repos.contractRepository,
        },
        delegateProvider: new RestDelegateProvider("http://localhost:7012"),
        settlementConfig: false,
    });

    return {
        wallet,
        identity: opts.identity,
    };
}
