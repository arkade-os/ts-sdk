import { describe, it, expect, vi } from "vitest";
import { hex } from "@scure/base";
import {
    VtxoManager,
    SettlementConfig,
    MAX_VTXOS_PER_SETTLEMENT,
} from "../src/wallet/vtxo-manager";
import type { IWallet } from "../src/wallet";
import type { ExtendedCoin } from "../src/wallet";
import type { BoardingUtxoGroup } from "../src/wallet/wallet";
import type { ArkInfo, DeprecatedSigner } from "../src/providers/ark";
import type { Contract, ContractWithVtxos, ExtendedContractVtxo } from "../src/contracts/types";
import type { RelativeTimelock } from "../src/script/tapscript";
import { CSVMultisigTapscript } from "../src/script/tapscript";

// Mock chain tip height returned by the wallet's onchainProvider.
const TIP_HEIGHT = 1_000_000;
// Block-typed per-row boarding CSV delay (matches DefaultVtxo's default unit).
const BOARDING_CSV_BLOCKS: RelativeTimelock = { type: "blocks", value: 144n };

let boardingCounter = 0;
function makeBoardingCoin(
    value: number,
    opts: { confirmed?: boolean; blockHeight?: number } = {},
): ExtendedCoin {
    // Default a freshly mined coin at the chain tip, so a block-typed CSV delay
    // is NOT yet satisfied (tip - height = 0 < delay) — i.e. not CSV-expired.
    const { confirmed = true, blockHeight = TIP_HEIGHT } = opts;
    return {
        txid: `boarding-${boardingCounter++}`,
        vout: 0,
        value,
        status: confirmed
            ? { confirmed: true, block_height: blockHeight, block_time: 1 }
            : { confirmed: false },
        forfeitTapLeafScript: [new Uint8Array(), new Uint8Array()],
        intentTapLeafScript: [new Uint8Array(), new Uint8Array()],
        tapTree: new Uint8Array(),
    } as unknown as ExtendedCoin;
}

function makeBoardingGroup(
    serverPubKey: string,
    coins: ExtendedCoin[],
    csvTimelock: RelativeTimelock = BOARDING_CSV_BLOCKS,
): BoardingUtxoGroup {
    return {
        // The tapscript object is not read by the classifier (it works off
        // serverPubKey + csvTimelock), so a minimal stub suffices.
        tapscript: {} as BoardingUtxoGroup["tapscript"],
        serverPubKey,
        csvTimelock,
        coins,
    };
}

const ACTIVE = "aa".repeat(32);
const DEP_A = "bb".repeat(32);
const DEP_B = "cc".repeat(32);
const DEP_DUE = "ee".repeat(32);
const DEP_EXPIRED = "ff".repeat(32);
const UNKNOWN = "dd".repeat(32);

const ARK_ADDRESS =
    "tark1qpt0syx7j0jspe69kldtljet0x9jz6ns4xw70m0w0xl30yfhn0mzmxz6yz8rduexx9sv73mqth7ecy8rtzcgm498kad3avmhyhmy097ew6h83g";

const NOW_S = Math.floor(Date.now() / 1000);

function makeInfo(
    signerPubkey: string,
    deprecatedSigners: DeprecatedSigner[] = [],
    intentFee: Record<string, string> = {},
): ArkInfo {
    return {
        signerPubkey,
        deprecatedSigners,
        fees: { intentFee, txFeeRate: "" },
    } as unknown as ArkInfo;
}

let vtxoCounter = 0;
function makeVtxo(
    contractScript: string,
    value: number,
    state: "settled" | "swept" | "preconfirmed" = "settled",
    isSpent = false,
): ExtendedContractVtxo {
    return {
        txid: `txid-${vtxoCounter++}`,
        vout: 0,
        value,
        contractScript,
        isSpent,
        status: { confirmed: true },
        createdAt: new Date(),
        isUnrolled: false,
        virtualStatus: { state },
        forfeitTapLeafScript: [new Uint8Array(), new Uint8Array()],
        intentTapLeafScript: [new Uint8Array(), new Uint8Array()],
        tapTree: new Uint8Array(),
    } as unknown as ExtendedContractVtxo;
}

function makeContract(serverPubKey: string, type = "default"): Contract {
    return {
        type,
        params: { serverPubKey, pubKey: "01".repeat(32), csvTimelock: "144" },
        script: `${type}-${serverPubKey}`,
        address: `addr-${serverPubKey}`,
        state: "active",
        createdAt: Date.now(),
    };
}

function cwv(serverPubKey: string, vtxos: ExtendedContractVtxo[]): ContractWithVtxos {
    return { contract: makeContract(serverPubKey), vtxos };
}

interface MigrationMockOptions {
    info: ArkInfo;
    contractsWithVtxos: ContractWithVtxos[];
    walletSigner?: string; // x-only hex of the wallet's own snapshot signer
    address?: string;
    /** Boarding groups returned by `getBoardingUtxosForSigners` (Section 7). */
    boardingGroups?: BoardingUtxoGroup[];
}

function createMigrationMockWallet(opts: MigrationMockOptions) {
    const settle = vi.fn().mockResolvedValue("migrate-txid");
    let arkServerPublicKey = hex.decode(opts.walletSigner ?? ACTIVE);
    const rotateServerSigner = vi.fn(async (next: Uint8Array) => {
        arkServerPublicKey = next;
    });
    const getContractsWithVtxos = vi.fn().mockResolvedValue(opts.contractsWithVtxos);
    // Filter the supplied boarding groups by the requested signer set, mirroring
    // the real wallet's allowed-signer discovery.
    const getBoardingUtxosForSigners = vi.fn(async (allowed: Set<string>) =>
        (opts.boardingGroups ?? []).filter((g) => allowed.has(g.serverPubKey)),
    );
    const getInfo = vi.fn().mockResolvedValue(opts.info);

    const wallet = {
        get arkServerPublicKey() {
            return arkServerPublicKey;
        },
        arkProvider: { getInfo },
        rotateServerSigner,
        getContractManager: vi.fn().mockResolvedValue({
            getContractsWithVtxos,
            onContractEvent: vi.fn().mockReturnValue(() => {}),
            refreshOutpoints: vi.fn().mockResolvedValue(undefined),
        }),
        getAddress: vi.fn().mockResolvedValue(opts.address ?? ARK_ADDRESS),
        getDelegateManager: vi.fn().mockResolvedValue(undefined),
        getVtxos: vi.fn().mockResolvedValue([]),
        settle,
        dustAmount: 1000n,
        // Boarding migration surface (Section 7). Defaults to no boarding
        // groups; tests that exercise boarding override getBoardingUtxosForSigners.
        getBoardingUtxosForSigners,
        onchainProvider: {
            getChainTip: vi
                .fn()
                .mockResolvedValue({ height: TIP_HEIGHT, time: 0, hash: "0".repeat(64) }),
        },
    } as unknown as IWallet;

    return {
        wallet,
        settle,
        rotateServerSigner,
        getContractsWithVtxos,
        getBoardingUtxosForSigners,
        getInfo,
    };
}

// Disable the background poll so migrateCore is exercised in isolation.
const newManager = (wallet: IWallet) => new VtxoManager(wallet, undefined, false);

describe("VtxoManager - deprecated-signer migration", () => {
    it("migrates dueNow (no cutoff) VTXOs immediately via settle", async () => {
        const { wallet, settle } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, [{ pubkey: DEP_DUE }]),
            contractsWithVtxos: [cwv(DEP_DUE, [makeVtxo("default-" + DEP_DUE, 5000)])],
        });
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        expect(report.rotated).toBe(false);
        expect(report.txid).toBe("migrate-txid");
        expect(report.migrated).toHaveLength(1);
        expect(report.migrated[0].signerPubKey).toBe(DEP_DUE);
        expect(report.expired).toHaveLength(0);
        expect(settle).toHaveBeenCalledOnce();
        const settleArg = settle.mock.calls[0][0];
        expect(settleArg.inputs).toHaveLength(1);
        expect(settleArg.outputs[0].address).toBe(ARK_ADDRESS);
        // No intent fees configured → output equals the input value.
        expect(settleArg.outputs[0].amount).toBe(5000n);
    });

    it("orders migration inputs by cutoff urgency: dueNow, then soonest cutoff", async () => {
        const { wallet, settle } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, [
                { pubkey: DEP_DUE }, // due immediately
                { pubkey: DEP_A, cutoffDate: BigInt(NOW_S + 100) }, // urgent
                { pubkey: DEP_B, cutoffDate: BigInt(NOW_S + 10_000) }, // less urgent
            ]),
            contractsWithVtxos: [
                cwv(DEP_B, [makeVtxo("default-" + DEP_B, 2222)]),
                cwv(DEP_DUE, [makeVtxo("default-" + DEP_DUE, 3333)]),
                cwv(DEP_A, [makeVtxo("default-" + DEP_A, 1111)]),
            ],
        });
        const manager = newManager(wallet);

        await manager.migrateDeprecatedSignerVtxos();

        const inputs = settle.mock.calls[0][0].inputs as ExtendedContractVtxo[];
        expect(inputs.map((v) => v.value)).toEqual([3333, 1111, 2222]);
    });

    it("reports expired-cutoff VTXOs without migrating them", async () => {
        const { wallet, settle } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, [
                { pubkey: DEP_DUE },
                { pubkey: DEP_EXPIRED, cutoffDate: BigInt(NOW_S - 100) },
            ]),
            contractsWithVtxos: [
                cwv(DEP_DUE, [makeVtxo("default-" + DEP_DUE, 5000)]),
                cwv(DEP_EXPIRED, [makeVtxo("default-" + DEP_EXPIRED, 9000)]),
            ],
        });
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        expect(report.migrated.map((m) => m.signerPubKey)).toEqual([DEP_DUE]);
        expect(report.expired.map((m) => m.signerPubKey)).toEqual([DEP_EXPIRED]);
        const inputs = settle.mock.calls[0][0].inputs as ExtendedContractVtxo[];
        expect(inputs).toHaveLength(1);
    });

    it("excludes swept (recoverable) and spent VTXOs from migration", async () => {
        const script = "default-" + DEP_DUE;
        const { wallet, settle } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, [{ pubkey: DEP_DUE }]),
            contractsWithVtxos: [
                cwv(DEP_DUE, [
                    makeVtxo(script, 5000),
                    makeVtxo(script, 6000, "swept"), // recoverable → recovery path, not migration
                    makeVtxo(script, 7000, "settled", true), // spent → excluded
                ]),
            ],
        });
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        expect(report.migrated).toHaveLength(1);
        expect(settle.mock.calls[0][0].inputs).toHaveLength(1);
    });

    it("applies a mid-session rotation first when the wallet's own signer is deprecated", async () => {
        const { wallet, rotateServerSigner, settle } = createMigrationMockWallet({
            walletSigner: DEP_A, // wallet was built before the rotation
            info: makeInfo(ACTIVE, [{ pubkey: DEP_A, cutoffDate: BigInt(NOW_S + 5000) }]),
            contractsWithVtxos: [cwv(DEP_A, [makeVtxo("default-" + DEP_A, 8000)])],
        });
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        expect(rotateServerSigner).toHaveBeenCalledOnce();
        expect(hex.encode(rotateServerSigner.mock.calls[0][0])).toBe(ACTIVE);
        expect(report.rotated).toBe(true);
        expect(report.migrated).toHaveLength(1);
        expect(settle).toHaveBeenCalledOnce();
    });

    it("does not rotate or migrate when the wallet's own signer is unknown", async () => {
        const { wallet, rotateServerSigner, settle } = createMigrationMockWallet({
            walletSigner: UNKNOWN,
            info: makeInfo(ACTIVE, [{ pubkey: DEP_A, cutoffDate: BigInt(NOW_S + 5000) }]),
            contractsWithVtxos: [cwv(DEP_A, [makeVtxo("default-" + DEP_A, 8000)])],
        });
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        expect(report.skipped).toBe("unknown-wallet-signer");
        expect(report.rotated).toBe(false);
        expect(rotateServerSigner).not.toHaveBeenCalled();
        expect(settle).not.toHaveBeenCalled();
    });

    it("short-circuits without an indexer sweep when nothing is deprecated", async () => {
        const { wallet, getContractsWithVtxos, settle } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, []),
            contractsWithVtxos: [],
        });
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        expect(report.migrated).toHaveLength(0);
        expect(report.signers).toHaveLength(0);
        expect(report.skipped).toBeUndefined();
        expect(getContractsWithVtxos).not.toHaveBeenCalled();
        expect(settle).not.toHaveBeenCalled();
    });

    it("returns a settle error in the report without throwing", async () => {
        const { wallet, settle } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, [{ pubkey: DEP_DUE }]),
            contractsWithVtxos: [cwv(DEP_DUE, [makeVtxo("default-" + DEP_DUE, 5000)])],
        });
        settle.mockRejectedValueOnce(new Error("server rejected old-key input"));
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        expect(report.error).toContain("server rejected old-key input");
        expect(report.migrated).toHaveLength(0);
    });

    it("getDeprecatedSignerStatus aggregates per-signer status without migrating", async () => {
        const { wallet, settle } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, [
                { pubkey: DEP_A, cutoffDate: BigInt(NOW_S + 3600) },
                { pubkey: DEP_EXPIRED, cutoffDate: BigInt(NOW_S - 5) },
            ]),
            contractsWithVtxos: [
                cwv(ACTIVE, [makeVtxo("default-" + ACTIVE, 1000)]), // current → not reported
                cwv(DEP_A, [
                    makeVtxo("default-" + DEP_A, 4000),
                    makeVtxo("default-" + DEP_A, 1000),
                ]),
                cwv(DEP_EXPIRED, [makeVtxo("default-" + DEP_EXPIRED, 9000)]),
            ],
        });
        const manager = newManager(wallet);

        const signers = await manager.getDeprecatedSignerStatus();

        expect(settle).not.toHaveBeenCalled();
        const byKey = new Map(signers.map((s) => [s.signerPubKey, s]));
        expect(byKey.get(ACTIVE)).toBeUndefined();
        expect(byKey.get(DEP_A)?.status).toBe("MIGRATABLE");
        expect(byKey.get(DEP_A)?.vtxoCount).toBe(2);
        expect(byKey.get(DEP_A)?.totalValue).toBe(5000);
        expect(byKey.get(DEP_EXPIRED)?.status).toBe("EXPIRED");
    });
});

// ── Section 7: deprecated-signer boarding UTXO recovery ──────────────────────

describe("VtxoManager - deprecated-signer boarding migration (Section 7)", () => {
    it("migrates a boarding-only deprecated-signer set via settle (no no-deprecated-vtxos skip)", async () => {
        const { wallet, settle } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, [{ pubkey: DEP_DUE }]),
            contractsWithVtxos: [], // no offchain VTXOs at all
            boardingGroups: [makeBoardingGroup(DEP_DUE, [makeBoardingCoin(5000)])],
        });
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        expect(report.skipped).toBeUndefined();
        expect(report.txid).toBe("migrate-txid");
        expect(report.migrated).toHaveLength(1);
        expect(report.migrated[0].signerPubKey).toBe(DEP_DUE);
        expect(report.migrated[0].value).toBe(5000);
        expect(settle).toHaveBeenCalledOnce();
        expect(settle.mock.calls[0][0].inputs).toHaveLength(1);
        expect(settle.mock.calls[0][0].outputs[0].address).toBe(ARK_ADDRESS);
    });

    it("combines old-signer boarding + old-signer VTXOs into one settle to the current address", async () => {
        const { wallet, settle } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, [{ pubkey: DEP_DUE }]),
            contractsWithVtxos: [cwv(DEP_DUE, [makeVtxo("default-" + DEP_DUE, 4000)])],
            boardingGroups: [makeBoardingGroup(DEP_DUE, [makeBoardingCoin(6000)])],
        });
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        expect(report.migrated).toHaveLength(2);
        expect(settle.mock.calls[0][0].inputs).toHaveLength(2);
        expect(settle.mock.calls[0][0].outputs[0].address).toBe(ARK_ADDRESS);
        const values = report.migrated.map((m) => m.value).sort((a, b) => a - b);
        expect(values).toEqual([4000, 6000]);
    });

    it("reports EXPIRED-signer boarding without migrating it", async () => {
        const { wallet, settle } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, [
                { pubkey: DEP_DUE },
                { pubkey: DEP_EXPIRED, cutoffDate: BigInt(NOW_S - 100) },
            ]),
            contractsWithVtxos: [],
            boardingGroups: [
                makeBoardingGroup(DEP_DUE, [makeBoardingCoin(5000)]),
                makeBoardingGroup(DEP_EXPIRED, [makeBoardingCoin(9000)]),
            ],
        });
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        expect(report.migrated.map((m) => m.signerPubKey)).toEqual([DEP_DUE]);
        expect(report.expired.map((m) => m.signerPubKey)).toEqual([DEP_EXPIRED]);
        expect(settle.mock.calls[0][0].inputs).toHaveLength(1);
        // The expired-signer boarding is still counted in its report row.
        const expiredRow = report.signers.find((s) => s.signerPubKey === DEP_EXPIRED);
        expect(expiredRow?.boardingCount).toBe(1);
        expect(expiredRow?.boardingValue).toBe(9000);
    });

    it("judges boarding-output CSV expiry against each row's own delay, not a global one", async () => {
        const { wallet } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, [{ pubkey: DEP_A, cutoffDate: BigInt(NOW_S + 10_000) }]),
            contractsWithVtxos: [],
            boardingGroups: [
                // Same MIGRATABLE signer, two addresses with DIFFERENT per-row CSV
                // delays. Both coins sit 100 blocks below the tip:
                //  - 50-block delay  → 100 >= 50  → CSV-expired → NOT migratable
                //  - 200-block delay → 100 >= 200 → not expired → migratable
                makeBoardingGroup(
                    DEP_A,
                    [makeBoardingCoin(3000, { blockHeight: TIP_HEIGHT - 100 })],
                    {
                        type: "blocks",
                        value: 50n,
                    },
                ),
                makeBoardingGroup(
                    DEP_A,
                    [makeBoardingCoin(4000, { blockHeight: TIP_HEIGHT - 100 })],
                    {
                        type: "blocks",
                        value: 200n,
                    },
                ),
            ],
        });
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        // Only the coin under the longer (200-block) delay is migratable.
        expect(report.migrated.map((m) => m.value)).toEqual([4000]);
        // But BOTH confirmed coins are counted in the signer's report row,
        // including the CSV-expired one (it leaves via the unilateral sweep).
        const row = report.signers.find((s) => s.signerPubKey === DEP_A);
        expect(row?.boardingCount).toBe(2);
        expect(row?.boardingValue).toBe(7000);
    });

    it("excludes unconfirmed boarding coins from migration and reporting", async () => {
        const { wallet, settle } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, [{ pubkey: DEP_DUE }]),
            contractsWithVtxos: [],
            boardingGroups: [
                makeBoardingGroup(DEP_DUE, [makeBoardingCoin(5000, { confirmed: false })]),
            ],
        });
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        expect(report.migrated).toHaveLength(0);
        // No confirmed coins → no report row → both migratable sets empty.
        expect(report.skipped).toBe("no-deprecated-vtxos");
        expect(report.signers).toHaveLength(0);
        expect(settle).not.toHaveBeenCalled();
    });

    it("drops uneconomic boarding coins whose input fee exceeds their value", async () => {
        const { wallet, settle } = createMigrationMockWallet({
            // Flat 2000-sat onchain input fee.
            info: makeInfo(ACTIVE, [{ pubkey: DEP_DUE }], { onchainInput: "2000.0" }),
            contractsWithVtxos: [],
            boardingGroups: [
                makeBoardingGroup(DEP_DUE, [makeBoardingCoin(1500), makeBoardingCoin(5000)]),
            ],
        });
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        // 1500-sat coin: fee 2000 >= 1500 → dropped; 5000-sat coin kept.
        expect(report.migrated.map((m) => m.value)).toEqual([5000]);
        expect(settle.mock.calls[0][0].inputs).toHaveLength(1);
    });

    it("defers overflow beyond the combined cap by cutoff urgency", async () => {
        const dueCoins = Array.from({ length: MAX_VTXOS_PER_SETTLEMENT }, () =>
            makeBoardingCoin(5000),
        );
        const { wallet } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, [
                { pubkey: DEP_DUE }, // dueNow → most urgent
                { pubkey: DEP_A, cutoffDate: BigInt(NOW_S + 10_000) }, // less urgent
            ]),
            contractsWithVtxos: [],
            boardingGroups: [
                makeBoardingGroup(DEP_DUE, dueCoins),
                makeBoardingGroup(DEP_A, [makeBoardingCoin(5000)]),
            ],
        });
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        // 51 candidates, cap 50: the least-urgent DEP_A coin is deferred.
        expect(report.migrated).toHaveLength(MAX_VTXOS_PER_SETTLEMENT);
        expect(report.deferred).toBe(1);
        expect(report.migrated.every((m) => m.signerPubKey === DEP_DUE)).toBe(true);
    });

    it("getDeprecatedSignerStatus reports boarding-only signers and aggregates across addresses", async () => {
        const { wallet, settle } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, [
                { pubkey: DEP_A, cutoffDate: BigInt(NOW_S + 3600) },
                { pubkey: DEP_EXPIRED, cutoffDate: BigInt(NOW_S - 5) },
            ]),
            contractsWithVtxos: [], // no VTXOs — boarding-only holdings
            boardingGroups: [
                // DEP_A spread across two boarding addresses → aggregate.
                makeBoardingGroup(DEP_A, [makeBoardingCoin(4000)]),
                makeBoardingGroup(DEP_A, [makeBoardingCoin(1000)]),
                makeBoardingGroup(DEP_EXPIRED, [makeBoardingCoin(9000)]),
            ],
        });
        const manager = newManager(wallet);

        const signers = await manager.getDeprecatedSignerStatus();

        expect(settle).not.toHaveBeenCalled();
        const byKey = new Map(signers.map((s) => [s.signerPubKey, s]));
        expect(byKey.get(DEP_A)?.status).toBe("MIGRATABLE");
        expect(byKey.get(DEP_A)?.vtxoCount).toBe(0);
        expect(byKey.get(DEP_A)?.boardingCount).toBe(2);
        expect(byKey.get(DEP_A)?.boardingValue).toBe(5000);
        // An EXPIRED-only signer with boarding holdings still produces a row.
        expect(byKey.get(DEP_EXPIRED)?.status).toBe("EXPIRED");
        expect(byKey.get(DEP_EXPIRED)?.boardingCount).toBe(1);
        expect(byKey.get(DEP_EXPIRED)?.boardingValue).toBe(9000);
    });
});

// ── Section 5: automatic migration opt-out in the poll loop ──────────────────

// Seconds-based CSV exit script so getBoardingTimelock resolves without a
// chain-tip lookup.
const boardingExitScript = hex.encode(
    CSVMultisigTapscript.encode({
        timelock: { type: "seconds", value: 604672n },
        pubkeys: [new Uint8Array(32).fill(0x01)],
    }).script,
);

// A wallet that is both sweep-capable (so the poll body runs) and
// migration-capable (so the migration branch can run). getContractsWithVtxos is
// the observable signal that migrateCore proceeded past its early-exit.
function createPollableWallet() {
    const getContractsWithVtxos = vi.fn().mockResolvedValue([]);
    const getInfo = vi.fn().mockResolvedValue(
        // Advertise a deprecated signer so migrateCore does NOT early-exit.
        makeInfo(ACTIVE, [{ pubkey: DEP_DUE }]),
    );
    const wallet = {
        arkServerPublicKey: hex.decode(ACTIVE),
        arkProvider: { getInfo },
        rotateServerSigner: vi.fn().mockResolvedValue(undefined),
        getVtxos: vi.fn().mockResolvedValue([]),
        getAddress: vi.fn().mockResolvedValue(ARK_ADDRESS),
        getDelegateManager: vi.fn().mockResolvedValue(undefined),
        getContractManager: vi.fn().mockResolvedValue({
            getContractsWithVtxos,
            onContractEvent: vi.fn().mockReturnValue(() => {}),
            refreshOutpoints: vi.fn().mockResolvedValue(undefined),
        }),
        settle: vi.fn().mockResolvedValue("txid"),
        dustAmount: 1000n,
        getBoardingUtxos: vi.fn().mockResolvedValue([]),
        getBoardingUtxosForSigners: vi.fn().mockResolvedValue([]),
        getBoardingAddress: vi.fn().mockResolvedValue("bcrt1qtest"),
        boardingTapscript: {
            exitScript: boardingExitScript,
            pkScript: new Uint8Array([0x51, 0x20, ...new Array(32).fill(0)]),
            exit: vi.fn(),
        },
        onchainProvider: {
            getFeeRate: vi.fn().mockResolvedValue(1),
            broadcastTransaction: vi.fn(),
            getChainTip: vi.fn().mockResolvedValue({ height: 1000, time: 0, hash: "0".repeat(64) }),
        },
        network: { bech32: "bcrt" },
        signOnchainBoardingTx: vi.fn().mockImplementation((tx: any) => tx),
    } as unknown as IWallet;
    return { wallet, getContractsWithVtxos };
}

async function runOnePoll(config: SettlementConfig | false) {
    const { wallet, getContractsWithVtxos } = createPollableWallet();
    const manager = new VtxoManager(wallet, undefined, config);
    await (manager as any).pollBoardingUtxos();
    await manager.dispose();
    return getContractsWithVtxos;
}

describe("VtxoManager - automatic migration opt-out (Section 5)", () => {
    it("runs deprecated-signer migration on the poll by default", async () => {
        const getContractsWithVtxos = await runOnePoll({});
        expect(getContractsWithVtxos).toHaveBeenCalled();
    });

    it("skips migration when deprecatedSignerMigration is false but keeps the poll", async () => {
        const getContractsWithVtxos = await runOnePoll({ deprecatedSignerMigration: false });
        expect(getContractsWithVtxos).not.toHaveBeenCalled();
    });

    it("skips migration entirely when settlement is disabled", async () => {
        const getContractsWithVtxos = await runOnePoll(false);
        expect(getContractsWithVtxos).not.toHaveBeenCalled();
    });
});
