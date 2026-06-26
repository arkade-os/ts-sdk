import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Wallet, SingleKey, InMemoryWalletRepository, InMemoryContractRepository } from "../src";

/**
 * Regression for the arkade.money phantom-receive inflation (boarding sweeps).
 *
 * The mainnet Esplora (mempool.arkade.sh) returns `/outspends` as
 * `[{"spent":true}]` WITHOUT the spender txid. getBoardingTxs() must still
 * recover the sweep (commitment) txid — by scanning the boarding address's own
 * transactions for the one whose vin spends the boarding output — so the swept
 * VTXO is correctly suppressed by buildTransactionHistory instead of being
 * double-counted on top of the boarding deposit.
 */

const SINGLEKEY_HEX = "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2";
const SERVER_PUBKEY_HEX = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

const mockArkInfo = {
    signerPubkey: SERVER_PUBKEY_HEX,
    forfeitPubkey: SERVER_PUBKEY_HEX,
    batchExpiry: BigInt(144),
    unilateralExitDelay: BigInt(144),
    boardingExitDelay: BigInt(144),
    roundInterval: BigInt(144),
    network: "mutinynet",
    dust: BigInt(1000),
    forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    checkpointTapscript:
        "5ab27520e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
};

const FUNDING_TXID = "aa".repeat(32);
const SWEEP_TXID = "bb".repeat(32);
const BOARDING_VALUE = 48955;

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock("../src/utils/fetch", () => ({ fetch: mockFetch, baseFetch: mockFetch }));

const MockEventSource = vi.fn().mockImplementation((url: string) => ({
    url,
    onmessage: null,
    onerror: null,
    close: vi.fn(),
}));

beforeEach(() => {
    vi.stubGlobal("EventSource", MockEventSource);
    mockFetch.mockReset();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("getBoardingTxs — sweep correlation without outspend txid", () => {
    it("recovers the sweep commitment txid from address-tx vins (arkade Esplora omits it)", async () => {
        // Resolved after wallet.create(); the mock closure reads it lazily so
        // the /info fetch during create() is served before we know the address.
        let boardingAddr = "";

        // The boarding address's on-chain history: a funding deposit, then a
        // sweep tx that spends that deposit (boarding output appears in its vin).
        const fundingTx = {
            txid: FUNDING_TXID,
            vin: [{ txid: "ee".repeat(32), vout: 7 }],
            vout: [{ scriptpubkey_address: "", value: BOARDING_VALUE }],
            status: { confirmed: true, block_time: 1_763_000_000 },
        };
        const sweepTx = {
            txid: SWEEP_TXID,
            vin: [{ txid: FUNDING_TXID, vout: 0 }], // spends the boarding output
            vout: [{ scriptpubkey_address: "tb1pelsewhere", value: 40000 }],
            status: { confirmed: true, block_time: 1_763_000_500 },
        };

        mockFetch.mockImplementation((url: string) => {
            const reply = (body: unknown) =>
                Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
            if (url.includes("/info")) return reply(mockArkInfo);
            if (url.includes("subscribe") || url.includes("subscriptions"))
                return reply({ subscriptionId: "sub-1" });
            if (url.includes("vtxo") || url.includes("scripts")) return reply({ vtxos: [] });
            if (boardingAddr && url.includes(`/address/${boardingAddr}/txs`))
                return reply([fundingTx, sweepTx]);
            // arkade Esplora: spent flag present, spender txid OMITTED.
            if (url.includes(`/tx/${FUNDING_TXID}/outspends`)) return reply([{ spent: true }]);
            return reply([]);
        });

        const wallet = await Wallet.create({
            identity: SingleKey.fromHex(SINGLEKEY_HEX),
            walletMode: "static",
            arkServerUrl: "http://localhost:7070",
            storage: {
                walletRepository: new InMemoryWalletRepository(),
                contractRepository: new InMemoryContractRepository(),
            },
        });

        boardingAddr = await wallet.getBoardingAddress();
        fundingTx.vout[0].scriptpubkey_address = boardingAddr;

        const { boardingTxs, commitmentsToIgnore } = await wallet.getBoardingTxs();

        // The sweep must be ignorable so the resulting VTXO is suppressed.
        expect(commitmentsToIgnore.has(SWEEP_TXID)).toBe(true);
        // And we must never pollute the set with `undefined`.
        expect(commitmentsToIgnore.has(undefined as unknown as string)).toBe(false);

        const boarding = boardingTxs.find((t) => t.key.boardingTxid === FUNDING_TXID);
        expect(boarding).toBeDefined();
        expect(boarding!.settled).toBe(true);
        expect(boarding!.key.commitmentTxid).toBe(SWEEP_TXID);

        await wallet.dispose();
    });
});
