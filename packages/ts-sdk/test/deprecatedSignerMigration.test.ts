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
    // A missing cutoffDate at a call site means "no cutoff" — normalized to the
    // `0n` sentinel arkd advertises (non-nullable field), which classifies
    // DUE_NOW. Mirrors `RestArkProvider.getInfo`'s `BigInt(cutoffDate ?? 0)`.
    deprecatedSigners: { pubkey: string; cutoffDate?: bigint }[] = [],
    intentFee: Record<string, string> = {},
    vtxoMaxAmount: bigint = -1n, // -1 = no per-output ceiling
): ArkInfo {
    const normalized: DeprecatedSigner[] = deprecatedSigners.map((s) => ({
        pubkey: s.pubkey,
        cutoffDate: s.cutoffDate ?? 0n,
    }));
    return {
        signerPubkey,
        deprecatedSigners: normalized,
        fees: { intentFee, txFeeRate: "" },
        vtxoMaxAmount,
    } as unknown as ArkInfo;
}

let vtxoCounter = 0;
// Settled/preconfirmed VTXOs always carry a batch expiry; only unrolled coins
// lack one. The send-based migration leg requires it (sendSelectedVtxosToSelf
// rejects no-expiry inputs), so the default fixture must have it too.
const DEFAULT_BATCH_EXPIRY = Date.now() + 365 * 24 * 3600 * 1000;

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
        virtualStatus: { state, batchExpiry: DEFAULT_BATCH_EXPIRY },
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
    // The VTXO leg migrates through the Ark send path; the boarding leg keeps
    // settle. Distinct return so tests can tell the two legs' txids apart.
    const sendSelectedVtxosToSelf = vi.fn().mockResolvedValue("vtxo-send-txid");
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
        sendSelectedVtxosToSelf,
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
        sendSelectedVtxosToSelf,
        rotateServerSigner,
        getContractsWithVtxos,
        getBoardingUtxosForSigners,
        getInfo,
    };
}

// Disable the background poll so migrateCore is exercised in isolation.
const newManager = (wallet: IWallet) => new VtxoManager(wallet, undefined, false);

describe("VtxoManager - deprecated-signer migration", () => {
    it("migrates dueNow (no cutoff) VTXOs immediately via send (not settle)", async () => {
        const { wallet, settle, sendSelectedVtxosToSelf } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, [{ pubkey: DEP_DUE }]),
            contractsWithVtxos: [cwv(DEP_DUE, [makeVtxo("default-" + DEP_DUE, 5000)])],
        });
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        expect(report.rotated).toBe(false);
        // VTXO leg ran through the send path; boarding leg absent (no boarding).
        expect(report.vtxos?.txid).toBe("vtxo-send-txid");
        expect(report.vtxos?.migrated).toHaveLength(1);
        expect(report.vtxos?.migrated[0].signerPubKey).toBe(DEP_DUE);
        expect(report.boarding).toBeUndefined();
        expect(report.expired).toHaveLength(0);
        // The deprecated VTXO migrated through send, never settle.
        expect(settle).not.toHaveBeenCalled();
        expect(sendSelectedVtxosToSelf).toHaveBeenCalledOnce();
        const sentInputs = sendSelectedVtxosToSelf.mock.calls[0][0] as ExtendedContractVtxo[];
        expect(sentInputs).toHaveLength(1);
        expect(sentInputs[0].value).toBe(5000);
    });

    it("orders migration inputs by value, highest first", async () => {
        const { wallet, sendSelectedVtxosToSelf } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, [
                { pubkey: DEP_DUE },
                { pubkey: DEP_A, cutoffDate: BigInt(NOW_S + 100) },
                { pubkey: DEP_B, cutoffDate: BigInt(NOW_S + 10_000) },
            ]),
            contractsWithVtxos: [
                cwv(DEP_B, [makeVtxo("default-" + DEP_B, 2222)]),
                cwv(DEP_DUE, [makeVtxo("default-" + DEP_DUE, 3333)]),
                cwv(DEP_A, [makeVtxo("default-" + DEP_A, 1111)]),
            ],
        });
        const manager = newManager(wallet);

        await manager.migrateDeprecatedSignerVtxos();

        // Value-descending, independent of cutoff (migration is mandatory for all).
        const inputs = sendSelectedVtxosToSelf.mock.calls[0][0] as ExtendedContractVtxo[];
        expect(inputs.map((v) => v.value)).toEqual([3333, 2222, 1111]);
    });

    it("reports expired-cutoff VTXOs without migrating them", async () => {
        const { wallet, sendSelectedVtxosToSelf } = createMigrationMockWallet({
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

        expect(report.vtxos?.migrated.map((m) => m.signerPubKey)).toEqual([DEP_DUE]);
        expect(report.expired.map((m) => m.signerPubKey)).toEqual([DEP_EXPIRED]);
        const inputs = sendSelectedVtxosToSelf.mock.calls[0][0] as ExtendedContractVtxo[];
        expect(inputs).toHaveLength(1);
    });

    it("excludes swept (recoverable) and spent VTXOs from migration", async () => {
        const script = "default-" + DEP_DUE;
        const { wallet, sendSelectedVtxosToSelf } = createMigrationMockWallet({
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

        expect(report.vtxos?.migrated).toHaveLength(1);
        expect(sendSelectedVtxosToSelf.mock.calls[0][0]).toHaveLength(1);
    });

    it("excludes deprecated-signer VTXOs without a batchExpiry and still migrates the rest", async () => {
        // An unrolled (or otherwise no-expiry) input cannot go through the send
        // leg — sendSelectedVtxosToSelf would throw and fail the whole leg — so
        // classification must leave it out while still migrating the valid ones.
        const script = "default-" + DEP_DUE;
        const noExpiry = makeVtxo(script, 4000);
        (noExpiry.virtualStatus as { batchExpiry?: number }).batchExpiry = undefined;
        const { wallet, sendSelectedVtxosToSelf } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, [{ pubkey: DEP_DUE }]),
            contractsWithVtxos: [cwv(DEP_DUE, [makeVtxo(script, 5000), noExpiry])],
        });
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        expect(report.vtxos?.error).toBeUndefined();
        expect(report.vtxos?.migrated).toHaveLength(1);
        const inputs = sendSelectedVtxosToSelf.mock.calls[0][0] as ExtendedContractVtxo[];
        expect(inputs).toHaveLength(1);
        expect(inputs[0].value).toBe(5000);
        // The skipped no-expiry coin is still reported as a deprecated holding.
        expect(report.signers.find((s) => s.signerPubKey === DEP_DUE)?.vtxoCount).toBe(2);
    });

    it("applies a mid-session rotation first when the wallet's own signer is deprecated", async () => {
        const { wallet, rotateServerSigner, sendSelectedVtxosToSelf } = createMigrationMockWallet({
            walletSigner: DEP_A, // wallet was built before the rotation
            info: makeInfo(ACTIVE, [{ pubkey: DEP_A, cutoffDate: BigInt(NOW_S + 5000) }]),
            contractsWithVtxos: [cwv(DEP_A, [makeVtxo("default-" + DEP_A, 8000)])],
        });
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        expect(rotateServerSigner).toHaveBeenCalledOnce();
        expect(hex.encode(rotateServerSigner.mock.calls[0][0])).toBe(ACTIVE);
        expect(report.rotated).toBe(true);
        expect(report.vtxos?.migrated).toHaveLength(1);
        expect(sendSelectedVtxosToSelf).toHaveBeenCalledOnce();
    });

    it("does not rotate or migrate when the wallet's own signer is unknown", async () => {
        const { wallet, rotateServerSigner, settle, sendSelectedVtxosToSelf } =
            createMigrationMockWallet({
                walletSigner: UNKNOWN,
                info: makeInfo(ACTIVE, [{ pubkey: DEP_A, cutoffDate: BigInt(NOW_S + 5000) }]),
                contractsWithVtxos: [cwv(DEP_A, [makeVtxo("default-" + DEP_A, 8000)])],
            });
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        expect(report.skipped).toBe("unknown-wallet-signer");
        expect(report.rotated).toBe(false);
        expect(report.vtxos).toBeUndefined();
        expect(report.boarding).toBeUndefined();
        expect(rotateServerSigner).not.toHaveBeenCalled();
        expect(settle).not.toHaveBeenCalled();
        expect(sendSelectedVtxosToSelf).not.toHaveBeenCalled();
    });

    it("short-circuits without an indexer sweep when nothing is deprecated", async () => {
        const { wallet, getContractsWithVtxos, settle, sendSelectedVtxosToSelf } =
            createMigrationMockWallet({
                info: makeInfo(ACTIVE, []),
                contractsWithVtxos: [],
            });
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        expect(report.vtxos).toBeUndefined();
        expect(report.boarding).toBeUndefined();
        expect(report.signers).toHaveLength(0);
        expect(report.skipped).toBeUndefined();
        expect(getContractsWithVtxos).not.toHaveBeenCalled();
        expect(settle).not.toHaveBeenCalled();
        expect(sendSelectedVtxosToSelf).not.toHaveBeenCalled();
    });

    it("returns a send error in the vtxos leg without throwing", async () => {
        const { wallet, sendSelectedVtxosToSelf } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, [{ pubkey: DEP_DUE }]),
            contractsWithVtxos: [cwv(DEP_DUE, [makeVtxo("default-" + DEP_DUE, 5000)])],
        });
        sendSelectedVtxosToSelf.mockRejectedValueOnce(new Error("server rejected old-key input"));
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        expect(report.vtxos?.error).toContain("server rejected old-key input");
        expect(report.vtxos?.migrated).toHaveLength(0);
        expect(report.vtxos?.txid).toBeUndefined();
    });

    it("surfaces a rotation throw as a failed pass: manual API rejects, automatic pass does not crash", async () => {
        const { wallet, rotateServerSigner } = createMigrationMockWallet({
            walletSigner: DEP_A, // deprecated snapshot → ensureReceiveOnActiveSigner rotates
            info: makeInfo(ACTIVE, [{ pubkey: DEP_A, cutoffDate: BigInt(NOW_S + 5000) }]),
            contractsWithVtxos: [cwv(DEP_A, [makeVtxo("default-" + DEP_A, 8000)])],
        });
        // A missing/invalid checkpointTapscript fails the rotation up front.
        rotateServerSigner.mockRejectedValue(new Error("Invalid checkpointTapscript from server"));
        const manager = newManager(wallet);

        // Manual API: the throw propagates as a rejection.
        await expect(manager.migrateDeprecatedSignerVtxos()).rejects.toThrow(
            "Invalid checkpointTapscript from server",
        );

        // Automatic pass: caught into backoff, never a crash.
        await expect((manager as any).runMigrationPass()).resolves.toBeUndefined();
        expect((manager as any).consecutiveMigrationFailures).toBeGreaterThan(0);
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
        // Boarding migrates through its own settle leg; no VTXO leg here.
        expect(report.vtxos).toBeUndefined();
        expect(report.boarding?.txid).toBe("migrate-txid");
        expect(report.boarding?.migrated).toHaveLength(1);
        expect(report.boarding?.migrated[0].signerPubKey).toBe(DEP_DUE);
        expect(report.boarding?.migrated[0].value).toBe(5000);
        expect(settle).toHaveBeenCalledOnce();
        expect(settle.mock.calls[0][0].inputs).toHaveLength(1);
        expect(settle.mock.calls[0][0].outputs[0].address).toBe(ARK_ADDRESS);
    });

    it("migrates old-signer boarding + VTXOs in SEPARATE legs (send + settle), never one settle", async () => {
        const { wallet, settle, sendSelectedVtxosToSelf } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, [{ pubkey: DEP_DUE }]),
            contractsWithVtxos: [cwv(DEP_DUE, [makeVtxo("default-" + DEP_DUE, 4000)])],
            boardingGroups: [makeBoardingGroup(DEP_DUE, [makeBoardingCoin(6000)])],
        });
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        // VTXO leg: send the 4000 VTXO. Boarding leg: a SEPARATE settle of the
        // 6000 boarding coin — never one combined settle of both.
        expect(sendSelectedVtxosToSelf).toHaveBeenCalledOnce();
        expect(settle).toHaveBeenCalledOnce();
        const sentInputs = sendSelectedVtxosToSelf.mock.calls[0][0] as ExtendedContractVtxo[];
        expect(sentInputs.map((v) => v.value)).toEqual([4000]);
        expect(settle.mock.calls[0][0].inputs).toHaveLength(1);
        expect(settle.mock.calls[0][0].inputs[0].value).toBe(6000);
        expect(settle.mock.calls[0][0].outputs[0].address).toBe(ARK_ADDRESS);

        expect(report.vtxos?.txid).toBe("vtxo-send-txid");
        expect(report.vtxos?.migrated.map((m) => m.value)).toEqual([4000]);
        expect(report.boarding?.txid).toBe("migrate-txid");
        expect(report.boarding?.migrated.map((m) => m.value)).toEqual([6000]);
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

        expect(report.boarding?.migrated.map((m) => m.signerPubKey)).toEqual([DEP_DUE]);
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
        expect(report.boarding?.migrated.map((m) => m.value)).toEqual([4000]);
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

        expect(report.boarding).toBeUndefined();
        expect(report.vtxos).toBeUndefined();
        // No confirmed coins → no report row → both migratable sets empty.
        expect(report.skipped).toBe("no-deprecated-vtxos");
        expect(report.signers).toHaveLength(0);
        expect(settle).not.toHaveBeenCalled();
    });

    it("migrates every boarding coin at full value, fee-exempt (no economic skip)", async () => {
        const { wallet, settle } = createMigrationMockWallet({
            // Even with a flat 2000-sat onchain input fee advertised, a forced
            // migration is fee-exempt: nothing is dropped or fee-discounted.
            info: makeInfo(ACTIVE, [{ pubkey: DEP_DUE }], { onchainInput: "2000.0" }),
            contractsWithVtxos: [],
            boardingGroups: [
                makeBoardingGroup(DEP_DUE, [makeBoardingCoin(1500), makeBoardingCoin(5000)]),
            ],
        });
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        // Both coins migrate at full value; the output is the gross sum.
        expect(report.boarding?.migrated.map((m) => m.value).sort((a, b) => a - b)).toEqual([
            1500, 5000,
        ]);
        expect(settle.mock.calls[0][0].inputs).toHaveLength(2);
        expect(settle.mock.calls[0][0].outputs[0].amount).toBe(6500n);
    });

    it("defers count-cap overflow by value (lowest-value input deferred)", async () => {
        const bigCoins = Array.from({ length: MAX_VTXOS_PER_SETTLEMENT }, () =>
            makeBoardingCoin(5000),
        );
        const { wallet } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, [{ pubkey: DEP_DUE }]),
            contractsWithVtxos: [],
            // 51 candidates; value-descending keeps the 5000s, defers the 1000.
            boardingGroups: [makeBoardingGroup(DEP_DUE, [...bigCoins, makeBoardingCoin(1000)])],
        });
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        expect(report.boarding?.migrated).toHaveLength(MAX_VTXOS_PER_SETTLEMENT);
        expect(report.boarding?.deferred).toBe(1);
        expect(report.boarding?.migrated.map((m) => m.value)).not.toContain(1000);
    });

    it("caps a migration batch to the per-output ceiling (vtxoMaxAmount), deferring the rest", async () => {
        const { wallet, settle } = createMigrationMockWallet({
            // 10_000-sat per-output ceiling.
            info: makeInfo(ACTIVE, [{ pubkey: DEP_DUE }], {}, 10_000n),
            contractsWithVtxos: [],
            boardingGroups: [
                makeBoardingGroup(DEP_DUE, [
                    makeBoardingCoin(6000),
                    makeBoardingCoin(5000),
                    makeBoardingCoin(4000),
                ]),
            ],
        });
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        // value-desc 6000,5000,4000 under a 10_000 ceiling: take 6000, skip 5000
        // (would reach 11_000), take 4000 → output exactly 10_000. 5000 deferred.
        expect(report.boarding?.migrated.map((m) => m.value).sort((a, b) => a - b)).toEqual([
            4000, 6000,
        ]);
        expect(settle.mock.calls[0][0].outputs[0].amount).toBe(10_000n);
        expect(report.boarding?.deferred).toBe(1);
        expect(report.boarding?.oversized).toBeUndefined();
    });

    it("reports inputs above vtxoMaxAmount as oversized (cannot migrate cooperatively) and warns", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { wallet } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, [{ pubkey: DEP_DUE }], {}, 5000n),
            contractsWithVtxos: [],
            boardingGroups: [
                makeBoardingGroup(DEP_DUE, [makeBoardingCoin(8000), makeBoardingCoin(3000)]),
            ],
        });
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        // 8000 > 5000 ceiling → oversized (unilateral exit); 3000 migrates.
        expect(report.boarding?.migrated.map((m) => m.value)).toEqual([3000]);
        expect(report.boarding?.oversized?.map((m) => m.value)).toEqual([8000]);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining("cannot be migrated cooperatively"),
        );
        warn.mockRestore();
    });

    it("migrates nothing but reports oversized when every input exceeds vtxoMaxAmount", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { wallet, settle } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, [{ pubkey: DEP_DUE }], {}, 5000n),
            contractsWithVtxos: [],
            boardingGroups: [makeBoardingGroup(DEP_DUE, [makeBoardingCoin(8000)])],
        });
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        // All boarding inputs oversized → boarding leg present but skipped.
        expect(report.boarding?.migrated).toHaveLength(0);
        expect(report.boarding?.skipped).toBe("oversized-only");
        expect(report.boarding?.oversized?.map((m) => m.value)).toEqual([8000]);
        expect(report.skipped).toBeUndefined();
        expect(settle).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it("applies dust floors per leg: a below-dust VTXO leg is skipped while boarding still settles", async () => {
        const { wallet, settle, sendSelectedVtxosToSelf } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, [{ pubkey: DEP_DUE }]),
            // A 500-sat VTXO is below the 1000-sat dust floor on its own; the
            // 5000-sat boarding coin clears its own floor. The old combined dust
            // guard would have summed them and let the VTXO ride; per-leg floors
            // skip the VTXO leg without suppressing the boarding leg.
            contractsWithVtxos: [cwv(DEP_DUE, [makeVtxo("default-" + DEP_DUE, 500)])],
            boardingGroups: [makeBoardingGroup(DEP_DUE, [makeBoardingCoin(5000)])],
        });
        const manager = newManager(wallet);

        const report = await manager.migrateDeprecatedSignerVtxos();

        expect(report.vtxos?.skipped).toBe("below-dust");
        expect(report.vtxos?.migrated).toHaveLength(0);
        expect(sendSelectedVtxosToSelf).not.toHaveBeenCalled();
        // The boarding leg settles independently of the skipped VTXO leg.
        expect(report.boarding?.txid).toBe("migrate-txid");
        expect(report.boarding?.migrated.map((m) => m.value)).toEqual([5000]);
        expect(settle).toHaveBeenCalledOnce();
        // Per-leg skips never bubble up to the global skip.
        expect(report.skipped).toBeUndefined();
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
        sendSelectedVtxosToSelf: vi.fn().mockResolvedValue("vtxo-send-txid"),
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

// ── Section 6 / post-cutoff: lifecycle reporting + recovery destination ───────

// A settled VTXO carrying an explicit batch expiry (used to assert nextSweepEta).
function makeVtxoWithExpiry(
    contractScript: string,
    value: number,
    state: "settled" | "swept" | "preconfirmed",
    batchExpiry: number,
): ExtendedContractVtxo {
    return {
        txid: `txid-${vtxoCounter++}`,
        vout: 0,
        value,
        contractScript,
        isSpent: false,
        status: { confirmed: true },
        createdAt: new Date(),
        isUnrolled: false,
        virtualStatus: { state, batchExpiry },
        forfeitTapLeafScript: [new Uint8Array(), new Uint8Array()],
        intentTapLeafScript: [new Uint8Array(), new Uint8Array()],
        tapTree: new Uint8Array(),
    } as unknown as ExtendedContractVtxo;
}

// Active-signer Ark address (the rotation/recovery destination) and a distinct
// deprecated-signer Ark address the wallet's stale snapshot derives. Both are
// valid bech32m so the periodic-settle output-fee step can decode them.
const ACTIVE_ADDRESS = ARK_ADDRESS;
const DEPRECATED_ADDRESS =
    "tark1qqellv77udfmr20tun8dvju5vgudpf9vxe8jwhthrkn26fz96pawqfdy8nk05rsmrf8h94j26905e7n6sng8y059z8ykn2j5xcuw4xt846qj6x";

interface RecoveryMockOptions {
    info: ArkInfo;
    /** x-only hex of the wallet's own construction-time snapshot signer. */
    walletSigner: string;
    /** Contracts (with their VTXOs) the wallet holds; also drives getVtxos. */
    contractsWithVtxos: ContractWithVtxos[];
}

// A wallet that is both migration-capable and sweep-capable, returns its VTXOs
// from getVtxos, and whose getAddress reflects the CURRENT snapshot signer — so
// a rotation to the active signer visibly changes the settle destination.
function createRecoveryMockWallet(opts: RecoveryMockOptions) {
    const settle = vi.fn().mockResolvedValue("recover-txid");
    let arkServerPublicKey = hex.decode(opts.walletSigner);
    const rotateServerSigner = vi.fn(async (next: Uint8Array) => {
        arkServerPublicKey = next;
    });
    const allVtxos = opts.contractsWithVtxos.flatMap((c) => c.vtxos);
    const getVtxos = vi.fn().mockResolvedValue(allVtxos);
    const getContractsWithVtxos = vi.fn().mockResolvedValue(opts.contractsWithVtxos);
    const getAddress = vi.fn(async () =>
        hex.encode(arkServerPublicKey) === ACTIVE ? ACTIVE_ADDRESS : DEPRECATED_ADDRESS,
    );

    const wallet = {
        get arkServerPublicKey() {
            return arkServerPublicKey;
        },
        arkProvider: { getInfo: vi.fn().mockResolvedValue(opts.info) },
        rotateServerSigner,
        getVtxos,
        getAddress,
        getDelegateManager: vi.fn().mockResolvedValue(undefined),
        getContractManager: vi.fn().mockResolvedValue({
            getContractsWithVtxos,
            onContractEvent: vi.fn().mockReturnValue(() => {}),
            refreshOutpoints: vi.fn().mockResolvedValue(undefined),
        }),
        settle,
        sendSelectedVtxosToSelf: vi.fn().mockResolvedValue("vtxo-send-txid"),
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

    return { wallet, settle, rotateServerSigner, getAddress, getVtxos, getContractsWithVtxos };
}

describe("VtxoManager - post-cutoff lifecycle reporting (Section 6)", () => {
    it("splits an EXPIRED holding into recoverableNow vs awaitingSweep with a nextSweepEta", async () => {
        const etaFar = Date.now() + 200_000;
        const etaSoon = Date.now() + 100_000; // soonest among the awaiting set
        const script = "default-" + DEP_EXPIRED;
        const { wallet } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, [{ pubkey: DEP_EXPIRED, cutoffDate: BigInt(NOW_S - 100) }]),
            contractsWithVtxos: [
                cwv(DEP_EXPIRED, [
                    makeVtxo(script, 5000, "swept"), // swept → recoverableNow
                    makeVtxoWithExpiry(script, 3000, "settled", etaFar), // awaitingSweep
                    makeVtxoWithExpiry(script, 2000, "settled", etaSoon), // awaitingSweep
                ]),
            ],
        });

        const row = (await newManager(wallet).getDeprecatedSignerStatus()).find(
            (s) => s.signerPubKey === DEP_EXPIRED,
        )!;

        expect(row.status).toBe("EXPIRED");
        expect(row.recoverableCount).toBe(1);
        expect(row.recoverableValue).toBe(5000);
        expect(row.awaitingSweepCount).toBe(2);
        expect(row.awaitingSweepValue).toBe(5000);
        expect(row.nextSweepEta).toBe(etaSoon);
        // Back-compat: vtxoCount/totalValue stay the not-yet-swept spendable set.
        expect(row.vtxoCount).toBe(2);
        expect(row.totalValue).toBe(5000);
    });

    it("reports zero awaiting (and no ETA) when an EXPIRED holding is fully swept", async () => {
        const script = "default-" + DEP_EXPIRED;
        const { wallet } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, [{ pubkey: DEP_EXPIRED, cutoffDate: BigInt(NOW_S - 100) }]),
            contractsWithVtxos: [
                cwv(DEP_EXPIRED, [
                    makeVtxo(script, 4000, "swept"),
                    makeVtxo(script, 1000, "swept"),
                ]),
            ],
        });

        const row = (await newManager(wallet).getDeprecatedSignerStatus()).find(
            (s) => s.signerPubKey === DEP_EXPIRED,
        )!;

        expect(row.recoverableCount).toBe(2);
        expect(row.recoverableValue).toBe(5000);
        expect(row.awaitingSweepCount).toBe(0);
        expect(row.awaitingSweepValue).toBe(0);
        expect(row.nextSweepEta).toBeUndefined();
    });

    it("does not populate recover/awaitingSweep fields for a non-EXPIRED (migratable) signer", async () => {
        const script = "default-" + DEP_A;
        const { wallet } = createMigrationMockWallet({
            info: makeInfo(ACTIVE, [{ pubkey: DEP_A, cutoffDate: BigInt(NOW_S + 3600) }]),
            contractsWithVtxos: [
                cwv(DEP_A, [makeVtxo(script, 5000), makeVtxo(script, 6000, "swept")]),
            ],
        });

        const row = (await newManager(wallet).getDeprecatedSignerStatus()).find(
            (s) => s.signerPubKey === DEP_A,
        )!;

        expect(row.status).toBe("MIGRATABLE");
        expect(row.recoverableCount).toBe(0);
        expect(row.recoverableValue).toBe(0);
        expect(row.awaitingSweepCount).toBe(0);
        expect(row.nextSweepEta).toBeUndefined();
    });

    it("transitions awaitingSweep → recoverableNow on sweep, and recovery drains the swept set", async () => {
        const script = "default-" + DEP_EXPIRED;
        const info = makeInfo(ACTIVE, [{ pubkey: DEP_EXPIRED, cutoffDate: BigInt(NOW_S - 100) }]);

        // Before the server sweep: spendable, not yet swept → awaitingSweep.
        const awaiting = createRecoveryMockWallet({
            walletSigner: ACTIVE,
            info,
            contractsWithVtxos: [
                cwv(DEP_EXPIRED, [
                    makeVtxoWithExpiry(script, 5000, "settled", Date.now() + 100_000),
                ]),
            ],
        });
        let row = (await newManager(awaiting.wallet).getDeprecatedSignerStatus()).find(
            (s) => s.signerPubKey === DEP_EXPIRED,
        )!;
        expect(row.awaitingSweepCount).toBe(1);
        expect(row.recoverableCount).toBe(0);

        // After the server sweep: state flips to "swept" → recoverableNow.
        const sweptVtxo = makeVtxo(script, 5000, "swept");
        const swept = createRecoveryMockWallet({
            walletSigner: ACTIVE,
            info,
            contractsWithVtxos: [cwv(DEP_EXPIRED, [sweptVtxo])],
        });
        const manager = newManager(swept.wallet);
        row = (await manager.getDeprecatedSignerStatus()).find(
            (s) => s.signerPubKey === DEP_EXPIRED,
        )!;
        expect(row.recoverableCount).toBe(1);
        expect(row.awaitingSweepCount).toBe(0);

        // The recoverableNow set is exactly what the recovery pass drains.
        await manager.recoverVtxos();
        const inputs = swept.settle.mock.calls[0][0].inputs as ExtendedContractVtxo[];
        expect(inputs).toHaveLength(1);
        expect(`${inputs[0].txid}:${inputs[0].vout}`).toBe(`${sweptVtxo.txid}:${sweptVtxo.vout}`);
    });
});

describe("VtxoManager - recovery destination pins the active signer (Section 6)", () => {
    it("recoverVtxos rotates to the active signer before settling a deprecated-signer recoverable VTXO", async () => {
        const script = "default-" + DEP_A;
        const { wallet, settle, rotateServerSigner } = createRecoveryMockWallet({
            walletSigner: DEP_A, // long-lived pre-rotation snapshot
            info: makeInfo(ACTIVE, [{ pubkey: DEP_A, cutoffDate: BigInt(NOW_S + 5000) }]),
            contractsWithVtxos: [cwv(DEP_A, [makeVtxo(script, 5000, "swept")])],
        });

        await newManager(wallet).recoverVtxos();

        expect(rotateServerSigner).toHaveBeenCalledOnce();
        expect(hex.encode(rotateServerSigner.mock.calls[0][0])).toBe(ACTIVE);
        // Destination committed to the ACTIVE signer, not the deprecated snapshot.
        expect(settle.mock.calls[0][0].outputs[0].address).toBe(ACTIVE_ADDRESS);
    });

    it("renewVtxos rotates to the active signer before settling a deprecated-signer recoverable VTXO", async () => {
        const script = "default-" + DEP_A;
        const { wallet, settle, rotateServerSigner } = createRecoveryMockWallet({
            walletSigner: DEP_A,
            info: makeInfo(ACTIVE, [{ pubkey: DEP_A, cutoffDate: BigInt(NOW_S + 5000) }]),
            contractsWithVtxos: [cwv(DEP_A, [makeVtxo(script, 5000, "swept")])],
        });

        await newManager(wallet).renewVtxos();

        expect(rotateServerSigner).toHaveBeenCalledOnce();
        expect(hex.encode(rotateServerSigner.mock.calls[0][0])).toBe(ACTIVE);
        expect(settle.mock.calls[0][0].outputs[0].address).toBe(ACTIVE_ADDRESS);
    });

    it("runPeriodicSettle rotates to the active signer before settling a deprecated-signer recoverable VTXO", async () => {
        const script = "default-" + DEP_A;
        const { wallet, settle, rotateServerSigner } = createRecoveryMockWallet({
            walletSigner: DEP_A,
            info: makeInfo(ACTIVE, [{ pubkey: DEP_A, cutoffDate: BigInt(NOW_S + 5000) }]),
            contractsWithVtxos: [cwv(DEP_A, [makeVtxo(script, 5000, "swept")])],
        });
        // settlementConfig enabled so getExpiringVtxos pulls recoverable VTXOs.
        const manager = new VtxoManager(wallet, undefined, {});

        await (manager as any).runPeriodicSettle([]);
        await manager.dispose();

        expect(rotateServerSigner).toHaveBeenCalledOnce();
        expect(hex.encode(rotateServerSigner.mock.calls[0][0])).toBe(ACTIVE);
        expect(settle.mock.calls[0][0].outputs[0].address).toBe(ACTIVE_ADDRESS);
    });

    it("recoverVtxos does NOT rotate on a current-snapshot wallet (guard is a no-op)", async () => {
        const script = "default-" + ACTIVE;
        const { wallet, settle, rotateServerSigner } = createRecoveryMockWallet({
            walletSigner: ACTIVE,
            info: makeInfo(ACTIVE, [{ pubkey: DEP_A, cutoffDate: BigInt(NOW_S + 5000) }]),
            contractsWithVtxos: [cwv(ACTIVE, [makeVtxo(script, 5000, "swept")])],
        });

        await newManager(wallet).recoverVtxos();

        expect(rotateServerSigner).not.toHaveBeenCalled();
        expect(settle.mock.calls[0][0].outputs[0].address).toBe(ACTIVE_ADDRESS);
    });

    it("does not eagerly rotate when a pre-rotation instance renews only current-signer inputs", async () => {
        const script = "default-" + ACTIVE;
        const { wallet, rotateServerSigner } = createRecoveryMockWallet({
            // Deprecated snapshot (pre-rotation), but the only recoverable input
            // is under the CURRENT signer → no deprecated-signer input carried.
            walletSigner: DEP_A,
            info: makeInfo(ACTIVE, [{ pubkey: DEP_A, cutoffDate: BigInt(NOW_S + 5000) }]),
            contractsWithVtxos: [cwv(ACTIVE, [makeVtxo(script, 5000, "swept")])],
        });

        await newManager(wallet).renewVtxos();

        expect(rotateServerSigner).not.toHaveBeenCalled();
    });
});
