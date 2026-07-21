import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { execSync } from "child_process";
import { p2tr } from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1.js";
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
    arkade,
    Extension,
    EmulatorPacket,
    networks,
    Transaction,
    WalletMode,
    RestDelegateProvider,
    VirtualTxRepository,
    ExitCaptureMode,
    ExitDataSource,
} from "../../src";
import { ANCHOR_PKSCRIPT } from "../../src/utils/anchor";
import type { ExtensionPacket } from "../../src/extension";
import { hex } from "@scure/base";

export const arkdExec = "docker exec -t arkd";

// Regtest Esplora REST API base URL. The arkade-regtest stack runs mempool,
// which serves the Esplora-compatible REST API under `/api` (the web UI lives
// at the root path and returns HTML). Every onchain helper must use this base —
// hitting the root path makes JSON parsing fail on the HTML frontend.
export const ESPLORA_API_URL = "http://localhost:3000/api";

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

export async function createTestArkWallet(opts?: {
    virtualTxRepository?: VirtualTxRepository;
    exitDataCapture?: {
        mode?: ExitCaptureMode;
        minExitWorthSats?: number;
        sources?: ExitDataSource[];
    };
}): Promise<TestArkWallet> {
    const identity = createTestIdentity();

    const wallet = await Wallet.create({
        identity,
        arkServerUrl: "http://localhost:7070",
        onchainProvider: new EsploraProvider(ESPLORA_API_URL, {
            forcePolling: true,
            pollingInterval: 2000,
        }),
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
            virtualTxRepository: opts?.virtualTxRepository,
            exitDataCapture: opts?.exitDataCapture,
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
        onchainProvider: new EsploraProvider(ESPLORA_API_URL, {
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
        onchainProvider: new EsploraProvider(ESPLORA_API_URL, {
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
        onchainProvider: new EsploraProvider(ESPLORA_API_URL, {
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

/**
 * Bitcoin Core's block count, read straight from the node.
 *
 * Every indexer in the stack (mempool/Fulcrum behind EsploraProvider, nbxplorer
 * behind arkd) trails this by an unbounded amount — right after `mineBlocks(10)`
 * they still report the pre-mine tip for a second or two. Use this, not an
 * indexer's tip, whenever a test needs a height no consumer can already be past:
 * every indexer height is <= this one, so a locktime built on it is guaranteed
 * immature everywhere at the moment it is read.
 */
export function coreBlockCount(): number {
    return Number(execCommand(`node regtest/regtest.mjs rpc getblockcount`));
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
 * Perform a real server-signer rotation by delegating to the regtest CLI's
 * `set-signers`: it recreates `arkd-wallet` with the given active signer (and
 * optional deprecated signers, each with an optional cutoff date), unlocks it,
 * and restarts `arkd` so it re-reads the signer set. Resolves once `/v1/info`
 * reflects the exact rotation.
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

    // Delegate the rotation to the regtest CLI's `set-signers`, which owns the
    // recreate → unlock → restart-arkd → readiness mechanism (and the env/compose
    // plumbing). `regtest` is symlinked into the package dir by scripts/regtest.sh;
    // `--env .env.regtest` makes the CLI use THIS package's regtest env (image,
    // ports) — the same override the stack was started with — so the recreated
    // arkd-wallet matches the running stack. arkd parses each deprecated entry as
    // `<hexkey>[:<unix-seconds cutoff>]`.
    const deprecatedArg = deprecated
        .map((d) => (d.cutoffDate != null ? `${d.priv}:${d.cutoffDate}` : d.priv))
        .join(",");
    try {
        execSync(
            `node regtest/regtest.mjs set-signers --env .env.regtest --active ${activeSignerPriv}` +
                (deprecatedArg ? ` --deprecated ${deprecatedArg}` : ""),
            { stdio: "pipe" },
        );
    } catch (err) {
        const e = err as { stderr?: Buffer; stdout?: Buffer; message?: string };
        throw new Error(
            `rotateArkdSigner: set-signers failed: ${e.stderr?.toString() || e.stdout?.toString() || e.message}`,
        );
    }

    // The CLI already waited for arkd to re-sync and verified the deprecated
    // COUNT; assert the EXACT pubkeys here (identity, not just count) and return
    // the resulting info. Poll briefly in case `/v1/info` is still settling.
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
        onchainProvider: new EsploraProvider(ESPLORA_API_URL, {
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

/**
 * Returns a freshly-generated taproot pkScript (pay-to-key, no script-path).
 * Used as a "throwaway recipient" where the destination identity is irrelevant.
 */
export function randomP2TR(): Uint8Array {
    const sk = schnorr.utils.randomSecretKey();
    const xonly = schnorr.getPublicKey(sk);
    const payment = p2tr(xonly, undefined, networks.regtest);
    return payment.script;
}

/**
 * Builds an arkade script that enforces:
 *   output[witness[0]].scriptPubKey == taproot(witness_program)  AND
 *   output[witness[0]].value == amount
 *
 * Witness stack (provided at spend time): [output_index].
 * Mirrors the Go `enforcePayTo` helper.
 */
export function enforcePayTo(pkScript: Uint8Array, amount: bigint): Uint8Array {
    if (pkScript[0] !== 0x51 || pkScript[1] !== 0x20) {
        throw new Error("enforcePayTo: expected a v1 P2TR pkScript");
    }
    const witnessProgram = pkScript.slice(2);
    return arkade.ArkadeScript.encode([
        "DUP",
        "INSPECTOUTPUTSCRIPTPUBKEY",
        1,
        "EQUALVERIFY",
        witnessProgram,
        "EQUALVERIFY",
        "INSPECTOUTPUTVALUE",
        amount,
        "EQUAL",
    ]);
}

/**
 * Builds an arkade script that enforces:
 *   tx.version == 2  (intent-proof gate, blocks off-chain Ark txs at v=3)
 *   output[0].scriptPubKey == input[self].scriptPubKey
 *   output[0].value        == input[self].value
 *
 * Witness stack: empty. Mirrors the Go `enforceSelfSend` helper.
 */
export function enforceSelfSend(): Uint8Array {
    return arkade.ArkadeScript.encode([
        "INSPECTVERSION",
        new Uint8Array([0x02, 0x00, 0x00, 0x00]),
        "EQUALVERIFY",
        // output[0].scriptPubKey
        0,
        "INSPECTOUTPUTSCRIPTPUBKEY",
        1,
        "EQUALVERIFY",
        "PUSHCURRENTINPUTINDEX",
        "INSPECTINPUTSCRIPTPUBKEY",
        1,
        "EQUALVERIFY",
        "EQUALVERIFY",
        // output[0].value
        0,
        "INSPECTOUTPUTVALUE",
        "PUSHCURRENTINPUTINDEX",
        "INSPECTINPUTVALUE",
        "EQUAL",
    ]);
}

/**
 * Inserts (or merges into existing) an Extension OP_RETURN containing an
 * EmulatorPacket built from `entries`, modifying `tx` in place.
 *
 * Behavior matches the Go `addEmulatorPacket`:
 * - If an extension OP_RETURN already exists, the emulator packet is appended.
 * - Otherwise, a new extension is inserted before the P2A anchor (if any),
 *   else appended at the end.
 */
export function addEmulatorPacket(
    tx: Transaction,
    entries: { vin: number; script: Uint8Array; witness?: Uint8Array }[],
): void {
    const packet = EmulatorPacket.create(
        entries.map((e) => ({
            vin: e.vin,
            script: e.script,
            witness: e.witness ?? new Uint8Array(0),
        })),
    );

    // Try to merge into an existing extension output.
    for (let i = 0; i < tx.outputsLength; i++) {
        const out = tx.getOutput(i);
        if (!out?.script) continue;
        if (!Extension.isExtension(out.script)) continue;
        const existing = Extension.fromBytes(out.script);
        const merged = Extension.create([...existing.getPackets(), packet as ExtensionPacket]);
        tx.updateOutput(i, { script: merged.serialize(), amount: 0n });
        return;
    }

    // No existing extension — insert a new one.
    const ext = Extension.create([packet as ExtensionPacket]);
    const newOut = ext.txOut();

    // If the last output is the P2A anchor, swap it: [..., anchor] → [..., ext, anchor].
    const lastIdx = tx.outputsLength - 1;
    const lastOut = tx.getOutput(lastIdx);
    if (
        lastOut?.script &&
        lastOut.script.length === ANCHOR_PKSCRIPT.length &&
        lastOut.script.every((b, j) => b === ANCHOR_PKSCRIPT[j])
    ) {
        // @scure Transaction has no `insertOutput`. Rebuild the last two outputs:
        // overwrite slot lastIdx with the extension and append the anchor.
        tx.updateOutput(lastIdx, {
            script: newOut.script,
            amount: newOut.amount,
        });
        tx.addOutput({ script: lastOut.script, amount: lastOut.amount ?? 0n });
        return;
    }

    tx.addOutput({ script: newOut.script, amount: newOut.amount });
}

/**
 * Returns the index of the first output whose script matches `pkScript`.
 * Throws if none is found.
 */
export function findOutputIndex(tx: Transaction, pkScript: Uint8Array): number {
    for (let i = 0; i < tx.outputsLength; i++) {
        const out = tx.getOutput(i);
        if (!out?.script) continue;
        if (
            out.script.length === pkScript.length &&
            out.script.every((b, j) => b === pkScript[j])
        ) {
            return i;
        }
    }
    throw new Error("findOutputIndex: no matching output");
}

/**
 * Polls the regtest esplora API until a UTXO appears at the given address.
 * Returns the first UTXO found. Used by onchain spend tests.
 */
export async function waitForUtxo(
    address: string,
    timeoutMs = 60_000,
): Promise<{ txid: string; vout: number; value: number }> {
    const provider = new EsploraProvider(ESPLORA_API_URL);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const utxos = await provider.getCoins(address);
            if (utxos.length > 0) {
                const u = utxos[0];
                return { txid: u.txid, vout: u.vout, value: u.value };
            }
        } catch {
            // ignore, keep polling
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`waitForUtxo: timeout for ${address}`);
}
