import { describe, it, expect, vi, beforeEach } from "vitest";
import { hex } from "@scure/base";
import {
    Wallet,
    SingleKey,
    OnchainWallet,
    RestArkProvider,
    ReadonlyWallet,
    Batch,
    DefaultVtxo,
    InMemoryWalletRepository,
    InMemoryContractRepository,
    ArkError,
    type IndexerProvider,
    type ArkProvider,
    type OnchainProvider,
    DelegateProvider,
} from "../src";
import { TEST_PUB_KEY, TEST_DELEGATE_PUB_KEY, TEST_SERVER_PUB_KEY } from "./contracts/helpers";
import type { ExtendedCoin, ExtendedVirtualCoin } from "../src/wallet";
import { CSVMultisigTapscript } from "../src/script/tapscript";
import { MAX_VTXOS_PER_SETTLEMENT } from "../src/wallet/vtxo-manager";
import { ReadonlySingleKey } from "../src/identity/singleKey";
import { IndexedDBWalletRepository, IndexedDBContractRepository } from "../src/repositories";
import type { Coin, VirtualCoin } from "../src/wallet";
import { MockEventSource } from "./mocks/eventSource";
import { timelockToSequence } from "../src/utils/timelock";
import { DEFAULT_ARKADE_SERVER_URL } from "../src/networks";

// Mock fetch
const { mockFetch } = vi.hoisted(() => ({
    mockFetch: vi.fn(),
}));

vi.mock("../src/utils/fetch", () => ({
    fetch: mockFetch,
    baseFetch: mockFetch,
}));

vi.stubGlobal("EventSource", MockEventSource);

// Shared IndexedDB repos — cleared between tests so cached VTXOs,
// sync cursors, and contracts from one test don't leak into the next.
const sharedRepo = new IndexedDBWalletRepository();
const sharedContractRepo = new IndexedDBContractRepository();

describe("Wallet", () => {
    // Test vector from BIP340
    const mockPrivKeyHex = "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2";
    // X-only pubkey (without the 02/03 prefix)
    const mockServerKeyHex = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const mockIdentity = SingleKey.fromHex(mockPrivKeyHex);

    beforeEach(async () => {
        mockFetch.mockReset();
        await sharedRepo.clear();
        await sharedContractRepo.clear();
    });

    describe("create", () => {
        it("defaults OnchainWallet to the bitcoin network", async () => {
            const wallet = await OnchainWallet.create(mockIdentity);

            expect(wallet.network.bech32).toBe("bc");
            expect(wallet.address.startsWith("bc1p")).toBe(true);
        });
    });

    describe("getBalance", () => {
        const mockUTXOs: Coin[] = [
            {
                txid: hex.encode(new Uint8Array(32).fill(1)),
                vout: 0,
                value: 100000,
                status: {
                    confirmed: true,
                    block_height: 100,
                    block_hash: hex.encode(new Uint8Array(32).fill(2)),
                    block_time: 1600000000,
                },
            },
        ];

        it("should calculate balance from coins", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockUTXOs),
            });

            const wallet = await OnchainWallet.create(mockIdentity, "mutinynet");

            const balance = await wallet.getBalance();
            expect(balance).toBe(100000);
        });

        it("should calculate balance from virtual coins", async () => {
            const mockServerResponse = {
                vtxos: [
                    {
                        outpoint: {
                            txid: hex.encode(new Uint8Array(32).fill(3)),
                            vout: 0,
                        },
                        amount: "50000",
                        spentBy: null,
                        expiresAt: "1704067200",
                        createdAt: "1704067200",
                        script: "cf63d80fddd790bb2de2b639545b7298d3b5c33d483d84b0be399fe828720fcf",
                        isPreconfirmed: false,
                        isSwept: false,
                        isUnrolled: false,
                        isSpent: false,
                        commitmentTxids: [
                            "f3e437911673f477f314f8fc31eb08def6ccff9edcd0524c10bcf5fc05009d69",
                        ],
                        settledBy: null,
                    },
                ],
            };

            // Setup mocks in the correct order based on actual call sequence:
            // 1. getInfo() during wallet creation
            // 2. getBoardingUtxos() -> esplora getCoins()
            // 3. ContractManager.createContract() full vtxo fetch for
            //    the wallet's default contract (includeSpent=true)
            // 4. ContractWatcher.subscribeForScripts for the wallet's script
            // 5. getContractsWithVtxos -> syncContracts delta fetch
            //
            // boardingExitDelay equals unilateralExitDelay here, so the
            // boarding script is byte-identical to the default baseline
            // contract's script. Contract-manager init creates the boarding
            // contract create-if-missing, so it is skipped (the script is
            // already persisted/watched via the default contract) and the
            // fetch sequence above is unchanged.

            mockFetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            signerPubkey: mockServerKeyHex,
                            forfeitPubkey: mockServerKeyHex,
                            batchExpiry: BigInt(144),
                            unilateralExitDelay: BigInt(144),
                            boardingExitDelay: BigInt(144),
                            roundInterval: BigInt(144),
                            network: "mutinynet",
                            forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
                            checkpointTapscript:
                                "5ab27520e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
                        }),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve(mockUTXOs),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({ vtxos: [] }),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({ subscriptionId: "sub-1" }),
                })
                .mockImplementationOnce((url: string) => {
                    // Extract the script from the request URL so the
                    // mock response matches the wallet's actual script.
                    const params = new URLSearchParams(url.split("?")[1]);
                    const script = params.getAll("scripts")[0];
                    mockServerResponse.vtxos[0].script = script;
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve(mockServerResponse),
                    });
                });

            const wallet = await Wallet.create({
                identity: mockIdentity,
                arkServerUrl: "http://localhost:7070",
            });

            const balance = await wallet.getBalance();
            expect(balance.settled).toBe(50000);
            expect(balance.boarding.total).toBe(100000);
            expect(balance.preconfirmed).toBe(0);
            expect(balance.available).toBe(50000);
            expect(balance.recoverable).toBe(0);
            expect(balance.total).toBe(150000);
        });
    });

    describe("getCoins", () => {
        const mockUTXOs: Coin[] = [
            {
                txid: hex.encode(new Uint8Array(32).fill(1)),
                vout: 0,
                value: 100000,
                status: {
                    confirmed: true,
                    block_height: 100,
                    block_hash: hex.encode(new Uint8Array(32).fill(2)),
                    block_time: 1600000000,
                },
            },
        ];

        it("should return coins from provider", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockUTXOs),
            });

            const wallet = await OnchainWallet.create(mockIdentity, "mutinynet");

            const coins = await wallet.getCoins();
            expect(coins).toEqual(mockUTXOs);
        });
    });

    describe("sendBitcoin", () => {
        const mockUTXOs = [
            {
                txid: hex.encode(new Uint8Array(32).fill(1)),
                vout: 0,
                value: 100000,
                status: {
                    confirmed: true,
                    block_height: 100,
                    block_hash: hex.encode(new Uint8Array(32).fill(2)),
                    block_time: 1600000000,
                },
            },
            {
                txid: hex.encode(new Uint8Array(32).fill(1)),
                vout: 1,
                value: 7000,
                status: {
                    confirmed: true,
                    block_height: 100,
                    block_hash: hex.encode(new Uint8Array(32).fill(2)),
                    block_time: 1600000000,
                },
            },
            {
                txid: hex.encode(new Uint8Array(32).fill(1)),
                vout: 2,
                value: 1000,
                status: {
                    confirmed: true,
                    block_height: 100,
                    block_hash: hex.encode(new Uint8Array(32).fill(2)),
                    block_time: 1600000000,
                },
            },
            {
                txid: hex.encode(new Uint8Array(32).fill(1)),
                vout: 3,
                value: 6500,
                status: {
                    confirmed: true,
                    block_height: 100,
                    block_hash: hex.encode(new Uint8Array(32).fill(2)),
                    block_time: 1600000000,
                },
            },
            {
                txid: hex.encode(new Uint8Array(32).fill(1)),
                vout: 4,
                value: 12000,
                status: {
                    confirmed: true,
                    block_height: 100,
                    block_hash: hex.encode(new Uint8Array(32).fill(2)),
                    block_time: 1600000000,
                },
            },
            {
                txid: hex.encode(new Uint8Array(32).fill(1)),
                vout: 5,
                value: 1400,
                status: {
                    confirmed: true,
                    block_height: 100,
                    block_hash: hex.encode(new Uint8Array(32).fill(2)),
                    block_time: 1600000000,
                },
            },
        ];
        const mockTxId = hex.encode(new Uint8Array(32).fill(1));
        const mockFeeRate = 3;

        beforeEach(() => {
            mockFetch.mockReset();
        });

        it("should throw error when amount is negative", async () => {
            const wallet = await OnchainWallet.create(mockIdentity, "mutinynet");

            await expect(
                wallet.send({
                    address: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
                    amount: -1000,
                }),
            ).rejects.toThrow("Amount must be positive");
        });

        it("should throw error when funds are insufficient", async () => {
            const mockFeeRate = 3;
            const mockTxId = hex.encode(new Uint8Array(32).fill(1));

            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockUTXOs),
            });
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ "1": mockFeeRate }),
            });

            const wallet = await OnchainWallet.create(mockIdentity, "mutinynet");

            await expect(
                wallet.send({
                    address: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
                    amount: 12500000,
                }),
            ).rejects.toThrow("Insufficient funds");
        });

        it("should throw when amount is below dust", async () => {
            const wallet = await OnchainWallet.create(mockIdentity, "mutinynet");
            await expect(
                wallet.send({
                    address: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
                    amount: 545,
                }),
            ).rejects.toThrow("Amount is below dust limit");
        });

        it("should send funds when change amount is below dust", async () => {
            const wallet = await OnchainWallet.create(mockIdentity, "mutinynet");

            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockUTXOs),
            });
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ "1": mockFeeRate }),
            });
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve(mockTxId),
            });

            expect(
                await wallet.send({
                    address: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
                    amount: 111500, // With selection of 100000 and 12000, the change is less than dust(546sats)
                }),
            ).toEqual(mockTxId);
        });

        it("should send amount with correct fees", async () => {
            const wallet = await OnchainWallet.create(mockIdentity, "mutinynet");

            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockUTXOs),
            });
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ "1": mockFeeRate }),
            });
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve(mockTxId),
            });

            expect(
                await wallet.send({
                    address: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
                    amount: 115000,
                }),
            ).toEqual(mockTxId);
        });

        it("should calculate different tx sizes for Segwit vs Taproot", async () => {
            const wallet = await OnchainWallet.create(mockIdentity, "mutinynet");

            const coins: Coin[] = [
                {
                    txid: hex.encode(new Uint8Array(32).fill(1)),
                    vout: 0,
                    value: 100_000_000,
                    status: {
                        confirmed: true,
                        block_height: 100,
                        block_hash: "",
                        block_time: 0,
                    },
                },
            ];
            const feeRate = 10;

            const mockCalls = () => {
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve(coins),
                });
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({ "1": feeRate }),
                });
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    text: () => Promise.resolve("txid_mock"),
                });
            };

            // 1. Send to Native Segwit Address (tb1q...)
            // We expect a smaller output size (~31 bytes)
            const segwitAddr = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
            mockCalls();
            await wallet.send({ address: segwitAddr, amount: 50_000 });

            // Extract the hex from the broadcast call (3rd call, 2nd arg is init object with body)
            const segwitTxHex = mockFetch.mock.calls[2][1].body;
            const segwitSize = segwitTxHex.length / 2;

            mockFetch.mockReset();

            // 2. Send to Taproot Address (Wallet Address is P2TR)
            // We expect a larger output size (~43 bytes)
            const taprootAddr = wallet.address;
            mockCalls();
            await wallet.send({ address: taprootAddr, amount: 50_000 });

            const taprootTxHex = mockFetch.mock.calls[2][1].body;
            const taprootSize = taprootTxHex.length / 2;

            expect(segwitSize).toBeLessThan(taprootSize);
        });

        it("should resolve oscillation when change is near dust limit", async () => {
            const wallet = await OnchainWallet.create(mockIdentity, "mutinynet");

            const feeRate = 10;
            // Calculations for the edge case:
            // Tx with 1 input, 1 output (no change) ≈ 111 vBytes. Fee ≈ 1110.
            // Tx with 1 input, 2 outputs (change) ≈ 154 vBytes. Fee ≈ 1540.
            // Difference (cost of change output) ≈ 430 sats.
            // Dust limit = 546 sats.
            // We need: Remaining Amount (after fee) to be > 546 BUT < (546 + 430).
            // Let's target Remaining = 800.

            const sendAmount = 50_000;
            const approxFeeNoChange = 1110;
            const inputAmount = sendAmount + approxFeeNoChange + 800;

            const coins: Coin[] = [
                {
                    txid: hex.encode(new Uint8Array(32).fill(2)),
                    vout: 0,
                    value: inputAmount,
                    status: {
                        confirmed: true,
                        block_height: 100,
                        block_hash: "",
                        block_time: 0,
                    },
                },
            ];

            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(coins),
            });
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ "1": feeRate }),
            });
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve("txid_mock"),
            });

            await expect(
                wallet.send({
                    address: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
                    amount: sendAmount,
                }),
            ).resolves.toBeDefined();
        });
    });

    describe("getInfos", () => {
        beforeEach(() => {
            mockFetch.mockReset();
        });

        const mockArkInfo = {
            signerPubkey: mockServerKeyHex,
            forfeitPubkey: mockServerKeyHex,
            batchExpiry: BigInt(144),
            unilateralExitDelay: BigInt(144),
            roundInterval: BigInt(144),
            network: "mutinynet",
            dust: BigInt(1000),
            forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
            checkpointTapscript:
                "5ab27520e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
            fees: {
                intentFee: {
                    onchainInput: "200.0",
                    onchainOutput: "1000",
                    offchainOutput: "amount * 0.1",
                },
                txFeeRate: "100",
            },
        };

        it("should initialize with ark provider when configured", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () =>
                    Promise.resolve({
                        ...mockArkInfo,
                        vtxoTreeExpiry: mockArkInfo.batchExpiry, // Server response uses vtxoTreeExpiry
                    }),
            });

            const wallet = await Wallet.create({
                identity: mockIdentity,
                arkServerUrl: "http://localhost:7070",
            });

            const address = await wallet.getAddress();
            expect(address).toBeDefined();

            const boardingAddress = await wallet.getBoardingAddress();
            expect(boardingAddress).toBeDefined();
        });

        it("should return intentFee config as strings", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockArkInfo),
            });

            const provider = new RestArkProvider("http://localhost:7070");
            const info = await provider.getInfo();
            expect(info.fees.intentFee.onchainInput).toBe("200.0");
            expect(info.fees.intentFee.onchainOutput).toBe("1000");
            expect(info.fees.intentFee.offchainOutput).toBe("amount * 0.1");
        });
    });

    describe("toReadonly", () => {
        const mockArkInfo = {
            signerPubkey: mockServerKeyHex,
            forfeitPubkey: mockServerKeyHex,
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

        beforeEach(() => {
            mockFetch.mockReset();
        });

        it("should convert Wallet to ReadonlyWallet", async () => {
            mockFetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve(mockArkInfo),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({ vtxos: [] }),
                });

            const wallet = await Wallet.create({
                identity: mockIdentity,
                arkServerUrl: "http://localhost:7070",
            });

            const readonlyWallet = await wallet.toReadonly();

            // Should be instance of ReadonlyWallet
            expect(readonlyWallet).toBeInstanceOf(ReadonlyWallet);

            // Should have the same addresses
            const address = await wallet.getAddress();
            const readonlyAddress = await readonlyWallet.getAddress();
            expect(address).toBe(readonlyAddress);

            const boardingAddress = await wallet.getBoardingAddress();
            const readonlyBoardingAddress = await readonlyWallet.getBoardingAddress();
            expect(boardingAddress).toBe(readonlyBoardingAddress);

            await wallet.dispose();
        });

        it("should not have sendBitcoin method on ReadonlyWallet type", async () => {
            mockFetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve(mockArkInfo),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({ vtxos: [] }),
                });

            const wallet = await Wallet.create({
                identity: mockIdentity,
                arkServerUrl: "http://localhost:7070",
            });

            const readonlyWallet = await wallet.toReadonly();

            // ReadonlyWallet should not have sendBitcoin in its type
            expect((readonlyWallet as any).sendBitcoin).toBeUndefined();
            expect((readonlyWallet as any).settle).toBeUndefined();

            await wallet.dispose();
        });

        it("should allow querying balance on ReadonlyWallet", async () => {
            const mockUTXOs: Coin[] = [
                {
                    txid: hex.encode(new Uint8Array(32).fill(1)),
                    vout: 0,
                    value: 100000,
                    status: {
                        confirmed: true,
                        block_height: 100,
                        block_hash: hex.encode(new Uint8Array(32).fill(2)),
                        block_time: 1600000000,
                    },
                },
            ];

            // Wallet.create triggers VtxoManager which lazily initializes
            // ContractManager in the background (registering the default
            // contract + subscribing). readonlyWallet.getBalance() then
            // drives another round of CM work (delta + spendableOnly).
            // Route by URL so ordering between the foreground Promise.all
            // and the background VtxoManager init doesn't matter.
            mockFetch.mockImplementation((url: string) => {
                if (url.includes("/v1/info")) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve(mockArkInfo),
                    });
                }
                if (url.includes("/script/subscribe")) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ subscriptionId: "sub-1" }),
                    });
                }
                if (url.includes("/address/") && url.includes("/utxo")) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve(mockUTXOs),
                    });
                }
                if (url.includes("/vtxos")) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ vtxos: [] }),
                    });
                }
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({}),
                    text: () => Promise.resolve(""),
                });
            });

            const wallet = await Wallet.create({
                identity: mockIdentity,
                arkServerUrl: "http://localhost:7070",
            });

            const readonlyWallet = await wallet.toReadonly();
            await wallet.dispose();

            const balance = await readonlyWallet.getBalance();
            expect(balance.boarding.total).toBe(100000);
        });
    });

    describe("delta-sync reconciliation", () => {
        const mockArkInfo = {
            signerPubkey: mockServerKeyHex,
            forfeitPubkey: mockServerKeyHex,
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
        const mockBatchExpiry = 1767225600000;

        async function createReadonlyTestWallet(getVtxos: IndexerProvider["getVtxos"]) {
            const compressedPubKey = await mockIdentity.compressedPublicKey();
            const readonlyIdentity = ReadonlySingleKey.fromPublicKey(compressedPubKey);
            const walletRepository = new InMemoryWalletRepository();
            const contractRepository = new InMemoryContractRepository();

            const wallet = await ReadonlyWallet.create({
                identity: readonlyIdentity,
                arkServerUrl: "http://localhost:7070",
                arkProvider: {
                    getInfo: vi.fn().mockResolvedValue(mockArkInfo),
                } as Partial<ArkProvider> as ArkProvider,
                indexerProvider: {
                    getVtxos,
                    subscribeForScripts: vi.fn().mockResolvedValue("sub-1"),
                    unsubscribeForScripts: vi.fn().mockResolvedValue(undefined),
                    getSubscription: async function* () {
                        // Empty stream — the watcher's listenLoop will exit
                        // cleanly and schedule a reconnect we never let run.
                    },
                } as Partial<IndexerProvider> as IndexerProvider,
                onchainProvider: {} as OnchainProvider,
                storage: {
                    walletRepository,
                    contractRepository,
                },
            });

            return { wallet, walletRepository };
        }

        function createMockVtxo(
            script: string,
            state: "preconfirmed" | "settled" = "preconfirmed",
        ): VirtualCoin {
            return {
                txid: "11".repeat(32),
                vout: 0,
                value: 50_000,
                status: {
                    confirmed: state !== "preconfirmed",
                    isLeaf: state !== "preconfirmed",
                },
                virtualStatus: {
                    state,
                    commitmentTxIds: ["22".repeat(32)],
                    batchExpiry: mockBatchExpiry,
                },
                // `settledBy` is the commitment tx that *consumed* this vtxo, so a live batch leaf
                // has none — arkd only ever writes it together with `spent = true`.
                spentBy: "",
                arkTxId: "",
                createdAt: new Date("2026-01-01T00:00:00.000Z"),
                isUnrolled: false,
                isSpent: false,
                isSwept: false,
                isPreconfirmed: state === "preconfirmed",
                commitmentTxIds: ["22".repeat(32)],
                expiresAt: new Date(mockBatchExpiry),
                script,
            };
        }

        it("should keep a preconfirmed VTXO when the full re-fetch still returns it", async () => {
            let walletScript = "";
            const getVtxos = vi
                .fn<IndexerProvider["getVtxos"]>()
                .mockImplementation(async (opts) => {
                    if (!walletScript && opts?.scripts?.[0]) {
                        walletScript = opts.scripts[0];
                    }
                    return { vtxos: [createMockVtxo(walletScript)] };
                });

            const { wallet } = await createReadonlyTestWallet(getVtxos);

            expect(await wallet.getVtxos()).toHaveLength(1);
            expect(await wallet.getVtxos()).toHaveLength(1);
        });

        it("should update VTXO state when the full re-fetch shows it settled", async () => {
            let walletScript = "";
            let state: "preconfirmed" | "settled" = "preconfirmed";
            const getVtxos = vi
                .fn<IndexerProvider["getVtxos"]>()
                .mockImplementation(async (opts) => {
                    if (!walletScript && opts?.scripts?.[0]) {
                        walletScript = opts.scripts[0];
                    }
                    return {
                        vtxos: [createMockVtxo(walletScript, state)],
                    };
                });

            const { wallet, walletRepository } = await createReadonlyTestWallet(getVtxos);

            expect((await wallet.getVtxos())[0].virtualStatus.state).toBe("preconfirmed");

            state = "settled";

            const vtxos = await wallet.getVtxos();
            expect(vtxos).toHaveLength(1);
            expect(vtxos[0].virtualStatus.state).toBe("settled");
            expect(vtxos[0].isSpent).toBe(false);

            const cached = await walletRepository.getVtxos(await wallet.getAddress());
            expect(cached).toHaveLength(1);
            expect(cached[0].virtualStatus.state).toBe("settled");
        });

        it("should mark a cached preconfirmed VTXO as spent when the full re-fetch no longer returns it", async () => {
            let walletScript = "";
            let markSpent = false;
            const getVtxos = vi
                .fn<IndexerProvider["getVtxos"]>()
                .mockImplementation(async (opts) => {
                    if (!walletScript && opts?.scripts?.[0]) {
                        walletScript = opts.scripts[0];
                    }
                    const vtxo = createMockVtxo(walletScript);
                    if (markSpent) vtxo.isSpent = true;
                    return { vtxos: [vtxo] };
                });

            const { wallet, walletRepository } = await createReadonlyTestWallet(getVtxos);

            expect(await wallet.getVtxos()).toHaveLength(1);

            markSpent = true;

            expect(await wallet.getVtxos()).toEqual([]);

            const cached = await walletRepository.getVtxos(await wallet.getAddress());
            expect(cached).toHaveLength(1);
            expect(cached[0].isSpent).toBe(true);
        });

        it("should mark a cached settled VTXO as spent when the full re-fetch no longer returns it", async () => {
            let walletScript = "";
            let markSpent = false;
            const getVtxos = vi
                .fn<IndexerProvider["getVtxos"]>()
                .mockImplementation(async (opts) => {
                    if (!walletScript && opts?.scripts?.[0]) {
                        walletScript = opts.scripts[0];
                    }
                    const vtxo = createMockVtxo(walletScript, "settled");
                    if (markSpent) vtxo.isSpent = true;
                    return { vtxos: [vtxo] };
                });

            const { wallet, walletRepository } = await createReadonlyTestWallet(getVtxos);

            const vtxos = await wallet.getVtxos();
            expect(vtxos).toHaveLength(1);
            expect(vtxos[0].virtualStatus.state).toBe("settled");

            markSpent = true;

            expect(await wallet.getVtxos()).toEqual([]);

            const cached = await walletRepository.getVtxos(await wallet.getAddress());
            expect(cached).toHaveLength(1);
            expect(cached[0].isSpent).toBe(true);
        });

        it("normalizes VTXOs from a legacy-only custom indexer provider", async () => {
            // A consumer-implemented provider is under no obligation to populate the canonical
            // facts, so legacy-shaped coins enter through the front door, not just from old rows.
            let walletScript = "";
            const getVtxos = vi
                .fn<IndexerProvider["getVtxos"]>()
                .mockImplementation(async (opts) => {
                    if (!walletScript && opts?.scripts?.[0]) walletScript = opts.scripts[0];
                    const {
                        isSpent,
                        isSwept,
                        isPreconfirmed,
                        commitmentTxIds,
                        expiresAt,
                        ...rest
                    } = createMockVtxo(walletScript);
                    return { vtxos: [rest as typeof rest & { isSpent?: boolean }] };
                });

            const { wallet } = await createReadonlyTestWallet(getVtxos);
            const [vtxo] = await wallet.getVtxos();

            expect(vtxo.isPreconfirmed).toBe(true);
            expect(vtxo.isSwept).toBe(false);
            expect(vtxo.isSpent).toBe(false);
            expect(vtxo.commitmentTxIds).toEqual(["22".repeat(32)]);
            expect(vtxo.expiresAt).toBeInstanceOf(Date);
        });

        it("egress: Wallet.getVtxos returns virtualStatus and spentBy === '' on unspent coins", async () => {
            let walletScript = "";
            const getVtxos = vi
                .fn<IndexerProvider["getVtxos"]>()
                .mockImplementation(async (opts) => {
                    if (!walletScript && opts?.scripts?.[0]) walletScript = opts.scripts[0];
                    return { vtxos: [createMockVtxo(walletScript)] };
                });

            const { wallet } = await createReadonlyTestWallet(getVtxos);
            const [vtxo] = await wallet.getVtxos();

            expect(vtxo.virtualStatus).toBeDefined();
            expect(vtxo.virtualStatus.state).toBe("preconfirmed");
            expect(vtxo.spentBy).toBe("");
        });
    });

    describe("clear", () => {
        const mockArkInfo = {
            signerPubkey: mockServerKeyHex,
            forfeitPubkey: mockServerKeyHex,
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

        function createMockVtxo(script: string): VirtualCoin {
            return {
                txid: "11".repeat(32),
                vout: 0,
                value: 50_000,
                status: { confirmed: false, isLeaf: false },
                virtualStatus: {
                    state: "preconfirmed",
                    commitmentTxIds: ["22".repeat(32)],
                    batchExpiry: 1767225600000,
                },
                isSpent: false,
                isSwept: false,
                isPreconfirmed: true,
                commitmentTxIds: ["22".repeat(32)],
                expiresAt: new Date(1767225600000),
                spentBy: "",
                settledBy: undefined,
                arkTxId: "",
                createdAt: new Date("2026-01-01T00:00:00.000Z"),
                isUnrolled: false,
                script,
            };
        }

        async function createReadonlyTestWallet() {
            let walletScript = "";
            const getVtxos = vi
                .fn<IndexerProvider["getVtxos"]>()
                .mockImplementation(async (opts) => {
                    if (!walletScript && opts?.scripts?.[0]) walletScript = opts.scripts[0];
                    return { vtxos: [createMockVtxo(walletScript)] };
                });

            const compressedPubKey = await mockIdentity.compressedPublicKey();
            const readonlyIdentity = ReadonlySingleKey.fromPublicKey(compressedPubKey);
            const walletRepository = new InMemoryWalletRepository();
            const contractRepository = new InMemoryContractRepository();

            const wallet = await ReadonlyWallet.create({
                identity: readonlyIdentity,
                arkServerUrl: "http://localhost:7070",
                arkProvider: {
                    getInfo: vi.fn().mockResolvedValue(mockArkInfo),
                } as Partial<ArkProvider> as ArkProvider,
                indexerProvider: {
                    getVtxos,
                    subscribeForScripts: vi.fn().mockResolvedValue("sub-1"),
                    unsubscribeForScripts: vi.fn().mockResolvedValue(undefined),
                    getSubscription: async function* () {},
                } as Partial<IndexerProvider> as IndexerProvider,
                onchainProvider: {} as OnchainProvider,
                storage: { walletRepository, contractRepository },
            });

            return { wallet, walletRepository, contractRepository };
        }

        it("wipes stored VTXOs and contracts from both repositories", async () => {
            const { wallet, walletRepository, contractRepository } =
                await createReadonlyTestWallet();
            const address = await wallet.getAddress();

            expect(await wallet.getVtxos()).toHaveLength(1);
            expect(await walletRepository.getVtxos(address)).toHaveLength(1);
            expect((await contractRepository.getContracts()).length).toBeGreaterThan(0);

            await wallet.clear();

            expect(await walletRepository.getVtxos(address)).toEqual([]);
            expect(await contractRepository.getContracts()).toEqual([]);
        });
    });

    describe("notifyIncomingFunds — single SSE stream", () => {
        const mockArkInfo = {
            signerPubkey: mockServerKeyHex,
            forfeitPubkey: mockServerKeyHex,
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

        it("opens exactly one getSubscription stream after notifyIncomingFunds", async () => {
            // `subscribeForScripts` legitimately fires more than once to
            // extend the same subscription id, so we count
            // `getSubscription` (the actual SSE open).
            const compressedPubKey = await mockIdentity.compressedPublicKey();
            const readonlyIdentity = ReadonlySingleKey.fromPublicKey(compressedPubKey);

            const getSubscriptionSpy = vi
                .fn<IndexerProvider["getSubscription"]>()
                .mockImplementation(async function* () {
                    await new Promise(() => {});
                });

            const wallet = await ReadonlyWallet.create({
                identity: readonlyIdentity,
                arkServerUrl: "http://localhost:7070",
                arkProvider: {
                    getInfo: vi.fn().mockResolvedValue(mockArkInfo),
                } as Partial<ArkProvider> as ArkProvider,
                indexerProvider: {
                    getVtxos: vi.fn().mockResolvedValue({ vtxos: [] }),
                    subscribeForScripts: vi.fn().mockResolvedValue("sub-shared"),
                    unsubscribeForScripts: vi.fn().mockResolvedValue(undefined),
                    getSubscription: getSubscriptionSpy,
                } as Partial<IndexerProvider> as IndexerProvider,
                onchainProvider: {
                    watchAddresses: vi
                        .fn<OnchainProvider["watchAddresses"]>()
                        .mockResolvedValue(() => {}),
                } as Partial<OnchainProvider> as OnchainProvider,
                storage: {
                    walletRepository: new InMemoryWalletRepository(),
                    contractRepository: new InMemoryContractRepository(),
                },
            });

            expect(getSubscriptionSpy).toHaveBeenCalledTimes(0);

            // Boot the ContractManager up-front so its watcher is already
            // running with an open SSE stream. Without this baseline,
            // `notifyIncomingFunds` would lazy-init the CM itself and a
            // regression where it opened its own subscription would still
            // produce exactly one `getSubscription` call.
            await wallet.getContractManager();
            // Yield so the cold-start kick reaches `getSubscription`.
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(getSubscriptionSpy).toHaveBeenCalledTimes(1);

            const stop = await wallet.notifyIncomingFunds(() => {});
            // Yield again to surface any extra stream opened by
            // `notifyIncomingFunds`.
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(getSubscriptionSpy).toHaveBeenCalledTimes(1);

            stop();
        });
    });

    describe("pending-spend filtering", () => {
        const mockArkInfo = {
            signerPubkey: mockServerKeyHex,
            forfeitPubkey: mockServerKeyHex,
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

        function createMockVtxo(script: string, txid: string): VirtualCoin {
            return {
                txid,
                vout: 0,
                value: 50_000,
                status: { confirmed: false },
                virtualStatus: {
                    state: "preconfirmed",
                    commitmentTxIds: ["22".repeat(32)],
                    batchExpiry: 1767225600000,
                },
                isSpent: false,
                isSwept: false,
                isPreconfirmed: true,
                commitmentTxIds: ["22".repeat(32)],
                expiresAt: new Date(1767225600000),
                spentBy: "",
                arkTxId: "",
                createdAt: new Date("2026-01-01T00:00:00.000Z"),
                isUnrolled: false,
                script,
            };
        }

        async function createWalletWithVtxos(txids: string[]) {
            const compressedPubKey = await mockIdentity.compressedPublicKey();
            const readonlyIdentity = ReadonlySingleKey.fromPublicKey(compressedPubKey);
            const walletRepository = new InMemoryWalletRepository();
            const contractRepository = new InMemoryContractRepository();

            let walletScript = "";
            const getVtxos = vi
                .fn<IndexerProvider["getVtxos"]>()
                .mockImplementation(async (opts) => {
                    if (!walletScript && opts?.scripts?.[0]) {
                        walletScript = opts.scripts[0];
                    }
                    return {
                        vtxos: txids.map((txid) => createMockVtxo(walletScript, txid)),
                    };
                });

            const wallet = await ReadonlyWallet.create({
                identity: readonlyIdentity,
                arkServerUrl: "http://localhost:7070",
                arkProvider: {
                    getInfo: vi.fn().mockResolvedValue(mockArkInfo),
                } as Partial<ArkProvider> as ArkProvider,
                indexerProvider: {
                    getVtxos,
                    subscribeForScripts: vi.fn().mockResolvedValue("sub-1"),
                    unsubscribeForScripts: vi.fn().mockResolvedValue(undefined),
                    getSubscription: async function* () {},
                } as Partial<IndexerProvider> as IndexerProvider,
                onchainProvider: {} as OnchainProvider,
                storage: {
                    walletRepository,
                    contractRepository,
                },
            });

            return { wallet };
        }

        it("getVtxos excludes outpoints present in _pendingSpendOutpoints", async () => {
            const txidA = "a".repeat(64);
            const txidB = "b".repeat(64);
            const { wallet } = await createWalletWithVtxos([txidA, txidB]);

            expect((await wallet.getVtxos()).map((v) => v.txid).sort()).toEqual(
                [txidA, txidB].sort(),
            );

            (wallet as any)._pendingSpendOutpoints.add(`${txidA}:0`);
            expect((await wallet.getVtxos()).map((v) => v.txid)).toEqual([txidB]);

            (wallet as any)._pendingSpendOutpoints.delete(`${txidA}:0`);
            expect((await wallet.getVtxos()).map((v) => v.txid).sort()).toEqual(
                [txidA, txidB].sort(),
            );
        });

        it("the in-flight set is in-memory only — a fresh instance sees the VTXO again", async () => {
            const txid = "c".repeat(64);
            const { wallet } = await createWalletWithVtxos([txid]);

            (wallet as any)._pendingSpendOutpoints.add(`${txid}:0`);
            expect(await wallet.getVtxos()).toHaveLength(0);

            // Simulating a process restart: a brand-new wallet instance over
            // the same repositories must surface the VTXO (no persistence).
            const { wallet: freshWallet } = await createWalletWithVtxos([txid]);
            expect((await freshWallet.getVtxos()).map((v) => v.txid)).toEqual([txid]);
        });

        it("_addPendingSpends tracks VTXO inputs and ignores boarding UTXOs", () => {
            const thisArg: any = { _pendingSpendOutpoints: new Set<string>() };
            const vtxoInput = {
                txid: "a".repeat(64),
                vout: 0,
                script: "51".repeat(17),
                isPreconfirmed: true,
            };
            const boardingInput = {
                txid: "b".repeat(64),
                vout: 1,
                status: { confirmed: true },
            };

            (Wallet.prototype as any)._addPendingSpends.call(thisArg, [vtxoInput, boardingInput]);

            expect(Array.from(thisArg._pendingSpendOutpoints)).toEqual([`${vtxoInput.txid}:0`]);
        });

        it("_removePendingSpends clears only the passed outpoints", () => {
            const thisArg: any = {
                _pendingSpendOutpoints: new Set<string>([
                    `${"a".repeat(64)}:0`,
                    `${"b".repeat(64)}:0`,
                ]),
            };
            const vtxoInput = {
                txid: "a".repeat(64),
                vout: 0,
                script: "51".repeat(17),
                isPreconfirmed: true,
            };

            (Wallet.prototype as any)._removePendingSpends.call(thisArg, [vtxoInput]);

            expect(Array.from(thisArg._pendingSpendOutpoints)).toEqual([`${"b".repeat(64)}:0`]);
        });
    });

    describe("mainnet unilateral exit delay compatibility", () => {
        const MAINNET_LEGACY_DELAY = 605184n;
        const ARKD_DELAY = 86528n;
        const MUTINYNET_DELAY = 144n;
        const DELEGATE_PUBKEY = mockServerKeyHex;

        const mockArkInfo = (network: "bitcoin" | "mutinynet", unilateralExitDelay: bigint) => ({
            signerPubkey: mockServerKeyHex,
            forfeitPubkey: mockServerKeyHex,
            batchExpiry: BigInt(144),
            unilateralExitDelay,
            boardingExitDelay: BigInt(144),
            roundInterval: BigInt(144),
            network,
            dust: BigInt(330),
            forfeitAddress:
                network === "bitcoin"
                    ? "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
                    : "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
            checkpointTapscript:
                "5ab27520e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
        });

        function sequence(value: bigint, type: "blocks" | "seconds") {
            return timelockToSequence({ value, type }).toString();
        }

        function contractSummaries(contracts: { type: string; params: Record<string, string> }[]) {
            return contracts
                .map((contract) => `${contract.type}:${contract.params.csvTimelock}`)
                .sort();
        }

        function createIndexerProvider() {
            return {
                getVtxos: vi.fn().mockResolvedValue({ vtxos: [] }),
                subscribeForScripts: vi.fn().mockResolvedValue("sub-1"),
                unsubscribeForScripts: vi.fn().mockResolvedValue(undefined),
                getSubscription: async function* () {},
            } as Partial<IndexerProvider> as IndexerProvider;
        }

        function createOnchainProvider() {
            return {
                getCoins: vi.fn().mockResolvedValue([]),
                getFeeRate: vi.fn().mockResolvedValue(1),
                broadcastTransaction: vi.fn().mockResolvedValue(""),
                getTxOutspends: vi.fn().mockResolvedValue([]),
                getTransactions: vi.fn().mockResolvedValue([]),
                getTxStatus: vi.fn().mockResolvedValue({ confirmed: false }),
                getChainTip: vi.fn().mockResolvedValue({
                    height: 1,
                    time: 1,
                    hash: "00".repeat(32),
                }),
                watchAddresses: vi.fn().mockResolvedValue(() => {}),
            } as Partial<OnchainProvider> as OnchainProvider;
        }

        function createDelegateProvider() {
            return {
                getDelegateInfo: vi.fn().mockResolvedValue({
                    pubkey: DELEGATE_PUBKEY,
                    fee: "0",
                    delegateAddress: "",
                    delegatorAddress: "",
                }),
                delegate: vi.fn().mockResolvedValue(undefined),
            } as Partial<DelegateProvider> as DelegateProvider;
        }

        async function createReadonlyTestWallet(config?: {
            network?: "bitcoin" | "mutinynet";
            unilateralExitDelay?: bigint;
            exitTimelock?: { value: bigint; type: "blocks" | "seconds" };
            delegateProvider?: DelegateProvider;
            delegatorProvider?: DelegateProvider;
        }) {
            const network = config?.network ?? "bitcoin";
            const compressedPubKey = await mockIdentity.compressedPublicKey();
            const readonlyIdentity = ReadonlySingleKey.fromPublicKey(compressedPubKey);
            const walletRepository = new InMemoryWalletRepository();
            const contractRepository = new InMemoryContractRepository();

            const wallet = await ReadonlyWallet.create({
                identity: readonlyIdentity,
                arkServerUrl: "http://localhost:7070",
                arkProvider: {
                    getInfo: vi
                        .fn()
                        .mockResolvedValue(
                            mockArkInfo(
                                network,
                                config?.unilateralExitDelay ??
                                    (network === "bitcoin" ? ARKD_DELAY : MUTINYNET_DELAY),
                            ),
                        ),
                } as Partial<ArkProvider> as ArkProvider,
                indexerProvider: createIndexerProvider(),
                onchainProvider: createOnchainProvider(),
                storage: {
                    walletRepository,
                    contractRepository,
                },
                exitTimelock: config?.exitTimelock,
                delegateProvider: config?.delegateProvider || config?.delegatorProvider,
            });

            return { wallet };
        }

        async function createFullMainnetWallet(config?: {
            delegateProvider?: DelegateProvider;
            delegatorProvider?: DelegateProvider;
        }) {
            const walletRepository = new InMemoryWalletRepository();
            const contractRepository = new InMemoryContractRepository();

            const wallet = await Wallet.create({
                identity: mockIdentity,
                arkServerUrl: "http://localhost:7070",
                arkProvider: {
                    getInfo: vi.fn().mockResolvedValue(mockArkInfo("bitcoin", ARKD_DELAY)),
                } as Partial<ArkProvider> as ArkProvider,
                indexerProvider: createIndexerProvider(),
                onchainProvider: createOnchainProvider(),
                storage: {
                    walletRepository,
                    contractRepository,
                },
                delegateProvider: config?.delegateProvider || config?.delegatorProvider,
                settlementConfig: false,
            });

            return { wallet };
        }

        it("uses the arkd exit timelock as the mainnet offchain address delay", async () => {
            const { wallet } = await createReadonlyTestWallet();

            try {
                expect(wallet.offchainTapscript.options.csvTimelock).toEqual({
                    value: ARKD_DELAY,
                    type: "seconds",
                });
            } finally {
                await wallet.dispose();
            }
        });

        it("registers arkd and legacy default contracts on mainnet", async () => {
            const { wallet } = await createReadonlyTestWallet();

            try {
                const manager = await wallet.getContractManager();
                const contracts = await manager.getContracts({
                    type: ["default", "delegate"],
                });

                expect(contractSummaries(contracts)).toEqual([
                    `default:${sequence(ARKD_DELAY, "seconds")}`,
                    `default:${sequence(MAINNET_LEGACY_DELAY, "seconds")}`,
                ]);
            } finally {
                await wallet.dispose();
            }
        });

        it("registers arkd and legacy default and delegate contracts on mainnet", async () => {
            const { wallet } = await createReadonlyTestWallet({
                delegateProvider: createDelegateProvider(),
            });

            try {
                const manager = await wallet.getContractManager();
                const contracts = await manager.getContracts({
                    type: ["default", "delegate"],
                });

                expect(contractSummaries(contracts)).toEqual([
                    `default:${sequence(ARKD_DELAY, "seconds")}`,
                    `default:${sequence(MAINNET_LEGACY_DELAY, "seconds")}`,
                    `delegate:${sequence(ARKD_DELAY, "seconds")}`,
                    `delegate:${sequence(MAINNET_LEGACY_DELAY, "seconds")}`,
                ]);
            } finally {
                await wallet.dispose();
            }
        });

        it("passes wallet contract timelocks through Wallet.create for delegate wallets", async () => {
            const { wallet } = await createFullMainnetWallet({
                delegateProvider: createDelegateProvider(),
            });

            try {
                expect(wallet.offchainTapscript.options.csvTimelock).toEqual({
                    value: ARKD_DELAY,
                    type: "seconds",
                });
                expect(
                    wallet.walletContractTimelocks.map((timelock) =>
                        timelockToSequence(timelock).toString(),
                    ),
                ).toEqual([
                    sequence(ARKD_DELAY, "seconds"),
                    sequence(MAINNET_LEGACY_DELAY, "seconds"),
                ]);

                const manager = await wallet.getContractManager();
                const contracts = await manager.getContracts({
                    type: ["default", "delegate"],
                });

                expect(contractSummaries(contracts)).toEqual([
                    `default:${sequence(ARKD_DELAY, "seconds")}`,
                    `default:${sequence(MAINNET_LEGACY_DELAY, "seconds")}`,
                    `delegate:${sequence(ARKD_DELAY, "seconds")}`,
                    `delegate:${sequence(MAINNET_LEGACY_DELAY, "seconds")}`,
                ]);
            } finally {
                await wallet.dispose();
            }
        });

        it("lets an explicit config.exitTimelock override compatibility registration", async () => {
            const override = { value: 1024n, type: "seconds" as const };
            const { wallet } = await createReadonlyTestWallet({
                exitTimelock: override,
            });

            expect(wallet.offchainTapscript.options.csvTimelock).toEqual(override);

            try {
                const manager = await wallet.getContractManager();
                const contracts = await manager.getContracts({
                    type: ["default", "delegate"],
                });

                expect(contractSummaries(contracts)).toEqual([
                    `default:${sequence(override.value, override.type)}`,
                ]);
            } finally {
                await wallet.dispose();
            }
        });

        it("dedupes the legacy delay when arkd advertises the legacy value", async () => {
            const { wallet } = await createReadonlyTestWallet({
                unilateralExitDelay: MAINNET_LEGACY_DELAY,
            });

            try {
                const manager = await wallet.getContractManager();
                const contracts = await manager.getContracts({
                    type: ["default", "delegate"],
                });

                expect(contractSummaries(contracts)).toEqual([
                    `default:${sequence(MAINNET_LEGACY_DELAY, "seconds")}`,
                ]);
            } finally {
                await wallet.dispose();
            }
        });

        it("does not register legacy mainnet delay variants on mutinynet", async () => {
            const { wallet } = await createReadonlyTestWallet({
                network: "mutinynet",
            });

            try {
                expect(wallet.walletContractTimelocks).toEqual([
                    { value: MUTINYNET_DELAY, type: "blocks" },
                ]);

                const manager = await wallet.getContractManager();
                const contracts = await manager.getContracts({
                    type: ["default", "delegate"],
                });

                expect(contractSummaries(contracts)).toEqual([
                    `default:${sequence(MUTINYNET_DELAY, "blocks")}`,
                ]);
            } finally {
                await wallet.dispose();
            }
        });
    });
});

describe("ReadonlyWallet", () => {
    beforeEach(async () => {
        mockFetch.mockReset();
        await sharedRepo.clear();
    });

    const mockServerKeyHex = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

    const mockArkInfo = {
        signerPubkey: mockServerKeyHex,
        forfeitPubkey: mockServerKeyHex,
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

    beforeEach(() => {
        mockFetch.mockReset();
    });

    it("should create ReadonlyWallet with ReadonlySingleKey", async () => {
        // Create a regular key first to get the public key
        const privateKeyHex = "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2";
        const key = SingleKey.fromHex(privateKeyHex);
        const compressedPubKey = await key.compressedPublicKey();

        // Create readonly identity
        const readonlyIdentity = ReadonlySingleKey.fromPublicKey(compressedPubKey);

        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(mockArkInfo),
        });

        const readonlyWallet = await ReadonlyWallet.create({
            identity: readonlyIdentity,
            arkServerUrl: "http://localhost:7070",
        });

        expect(readonlyWallet).toBeInstanceOf(ReadonlyWallet);

        // Should be able to get addresses
        const address = await readonlyWallet.getAddress();
        expect(address).toBeDefined();

        const boardingAddress = await readonlyWallet.getBoardingAddress();
        expect(boardingAddress).toBeDefined();
    });

    it("should create ReadonlyWallet with the default Arkade server URL", async () => {
        const key = SingleKey.fromRandomBytes();
        const compressedPubKey = await key.compressedPublicKey();
        const readonlyIdentity = ReadonlySingleKey.fromPublicKey(compressedPubKey);

        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(mockArkInfo),
        });

        const readonlyWallet = await ReadonlyWallet.create({
            identity: readonlyIdentity,
            storage: {
                walletRepository: new InMemoryWalletRepository(),
                contractRepository: new InMemoryContractRepository(),
            },
        });

        expect(readonlyWallet).toBeInstanceOf(ReadonlyWallet);
        expect(mockFetch).toHaveBeenCalledWith(`${DEFAULT_ARKADE_SERVER_URL}/v1/info`);
    });

    it("should query balance with ReadonlyWallet", async () => {
        const privateKeyHex = "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2";
        const key = SingleKey.fromHex(privateKeyHex);
        const compressedPubKey = await key.compressedPublicKey();
        const readonlyIdentity = ReadonlySingleKey.fromPublicKey(compressedPubKey);

        const mockUTXOs: Coin[] = [
            {
                txid: hex.encode(new Uint8Array(32).fill(1)),
                vout: 0,
                value: 50000,
                status: {
                    confirmed: true,
                    block_height: 100,
                    block_hash: hex.encode(new Uint8Array(32).fill(2)),
                    block_time: 1600000000,
                },
            },
        ];

        // ReadonlyWallet.create + getBalance triggers: getInfo, boarding,
        // ContractManager init (createContract fetch + subscribe),
        // getContractsWithVtxos (syncContracts + getVtxosForContracts).
        // Route by URL to keep ordering assumptions out of the test.
        mockFetch.mockImplementation((url: string) => {
            if (url.includes("/v1/info")) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve(mockArkInfo),
                });
            }
            if (url.includes("/script/subscribe")) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ subscriptionId: "sub-1" }),
                });
            }
            if (url.includes("/address/") && url.includes("/utxo")) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve(mockUTXOs),
                });
            }
            if (url.includes("/vtxos")) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ vtxos: [] }),
                });
            }
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({}),
                text: () => Promise.resolve(""),
            });
        });

        const readonlyWallet = await ReadonlyWallet.create({
            identity: readonlyIdentity,
            arkServerUrl: "http://localhost:7070",
        });

        const balance = await readonlyWallet.getBalance();
        expect(balance.boarding.total).toBe(50000);
        expect(balance.settled).toBe(0);
        expect(balance.total).toBe(50000);
    });

    it("should not have transaction methods on ReadonlyWallet", async () => {
        const privateKeyHex = "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2";
        const key = SingleKey.fromHex(privateKeyHex);
        const compressedPubKey = await key.compressedPublicKey();
        const readonlyIdentity = ReadonlySingleKey.fromPublicKey(compressedPubKey);

        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(mockArkInfo),
        });

        const readonlyWallet = await ReadonlyWallet.create({
            identity: readonlyIdentity,
            arkServerUrl: "http://localhost:7070",
        });

        // Should not have transaction methods
        expect((readonlyWallet as any).sendBitcoin).toBeUndefined();
        expect((readonlyWallet as any).settle).toBeUndefined();
    });
});

describe("Wallet.safeRegisterIntent", () => {
    it("signs the delete proof over the caller's inputs on 'duplicated input' retry", async () => {
        // This regression covers the incident where the auto-settle path
        // kept hitting "duplicated input" because the prior implementation
        // signed the delete proof over `getVtxos()` — which misses the
        // boarding UTXO that the stuck intent actually locked. The fix
        // scopes the proof to the *caller's* inputs (which include the
        // boarding UTXO for a boarding-settle), so the stuck intent is
        // cleared on the very first retry.
        const boardingInput = {
            txid: "b".repeat(64),
            vout: 0,
            value: 10_000,
            status: { confirmed: true, block_time: 1_700_000_000 },
        } as ExtendedCoin;
        const callerInputs: ExtendedCoin[] = [boardingInput];

        const registerIntent = vi
            .fn()
            .mockRejectedValueOnce(new ArkError(0, "duplicated input", "FailedPrecondition"))
            .mockResolvedValueOnce("intent-id-after-retry");
        const deleteIntent = vi.fn().mockResolvedValue(undefined);

        const makeDeleteIntentSignature = vi.fn().mockResolvedValue({
            proof: "delete-proof",
            message: { type: "delete", expire_at: 0 },
        });
        const getVtxos = vi.fn().mockResolvedValue([]);

        const thisArg: any = {
            arkProvider: { registerIntent, deleteIntent },
            makeDeleteIntentSignature,
            getVtxos,
        };

        const intent = {
            proof: "register-proof",
            message: { type: "register" } as any,
        };

        const result = await (Wallet.prototype as any).safeRegisterIntent.call(
            thisArg,
            intent,
            callerInputs,
        );

        expect(result).toBe("intent-id-after-retry");
        // The delete proof MUST be built from the caller's inputs, not
        // from getVtxos() — otherwise boarding-input stuck intents
        // remain on the server and the next registerIntent collides
        // again, producing the DeleteIntent treadmill seen in the panic.
        expect(makeDeleteIntentSignature).toHaveBeenCalledWith(callerInputs);
        expect(getVtxos).not.toHaveBeenCalled();
        expect(deleteIntent).toHaveBeenCalledTimes(1);
        expect(registerIntent).toHaveBeenCalledTimes(2);
    });

    it("does not attempt delete/retry for unrelated ArkError codes", async () => {
        const registerIntent = vi
            .fn()
            .mockRejectedValueOnce(new ArkError(3, "some other failure", "InvalidArgument"));
        const deleteIntent = vi.fn();
        const makeDeleteIntentSignature = vi.fn();

        const thisArg: any = {
            arkProvider: { registerIntent, deleteIntent },
            makeDeleteIntentSignature,
            getVtxos: vi.fn(),
        };

        await expect(
            (Wallet.prototype as any).safeRegisterIntent.call(
                thisArg,
                { proof: "p", message: { type: "register" } },
                [] as ExtendedCoin[],
            ),
        ).rejects.toThrow("some other failure");

        expect(deleteIntent).not.toHaveBeenCalled();
        expect(makeDeleteIntentSignature).not.toHaveBeenCalled();
        expect(registerIntent).toHaveBeenCalledTimes(1);
    });
});

describe("Wallet._settleImpl", () => {
    const walletAddress =
        "tark1qpt0syx7j0jspe69kldtljet0x9jz6ns4xw70m0w0xl30yfhn0mzmxz6yz8rduexx9sv73mqth7ecy8rtzcgm498kad3avmhyhmy097ew6h83g";

    const input = {
        txid: "a".repeat(64),
        vout: 0,
        value: 10_000,
        status: { confirmed: true, block_time: 1_700_000_000 },
    } as ExtendedCoin;

    it("primes the stream before registering the intent and replays the primed event to Batch.join", async () => {
        const callOrder: string[] = [];
        const primedEvent = { type: "batch_started", id: "batch-1" };
        const secondEvent = { type: "batch_finalized", id: "batch-1" };
        const stream = {
            next: vi
                .fn()
                .mockImplementationOnce(async () => {
                    callOrder.push("stream.next#1");
                    return { done: false, value: primedEvent };
                })
                .mockImplementationOnce(async () => {
                    callOrder.push("stream.next#2");
                    return { done: false, value: secondEvent };
                }),
            return: vi.fn(async () => {
                callOrder.push("stream.return");
                return { done: true, value: undefined };
            }),
            [Symbol.asyncIterator]() {
                return this;
            },
        } as AsyncIterableIterator<any>;

        const safeRegisterIntent = vi.fn(async () => {
            callOrder.push("safeRegisterIntent");
            return "intent-id";
        });
        const createBatchHandler = vi.fn().mockReturnValue({} as Batch.Handler);
        const updateDbAfterSettle = vi.fn().mockResolvedValue(undefined);
        const batchJoinSpy = vi.spyOn(Batch, "join").mockImplementation(async (eventIterator) => {
            callOrder.push("Batch.join");
            expect(eventIterator).not.toBe(stream);
            expect(await eventIterator.next()).toEqual({
                done: false,
                value: primedEvent,
            });
            expect(await eventIterator.next()).toEqual({
                done: false,
                value: secondEvent,
            });
            return "commitment-txid";
        });

        const thisArg: any = {
            network: "mutinynet",
            arkProvider: {
                getEventStream: vi.fn().mockReturnValue(stream),
                deleteIntent: vi.fn().mockResolvedValue(undefined),
            },
            _addPendingSpends: vi.fn(),
            _removePendingSpends: vi.fn(),
            getAddress: vi.fn().mockResolvedValue(walletAddress),
            makeRegisterIntentSignature: vi.fn().mockResolvedValue({
                proof: "register-proof",
                message: { type: "register" },
            }),
            makeDeleteIntentSignature: vi.fn().mockResolvedValue({
                proof: "delete-proof",
                message: { type: "delete", expire_at: 0 },
            }),
            safeRegisterIntent,
            createBatchHandler,
            updateDbAfterSettle,
            persistIntentSnapshot: vi.fn(),
            maybeRotateBoardingAfterBoard: vi.fn().mockResolvedValue(undefined),
        };

        const result = await (Wallet.prototype as any)._settleImpl.call(thisArg, {
            inputs: [input],
            outputs: [],
        });

        expect(result).toBe("commitment-txid");
        expect(callOrder).toEqual([
            "stream.next#1",
            "safeRegisterIntent",
            "Batch.join",
            "stream.next#2",
            "stream.return",
        ]);
        expect(stream.next).toHaveBeenCalledTimes(2);
        expect(stream.return).toHaveBeenCalledTimes(1);
        expect(createBatchHandler).toHaveBeenCalledWith("intent-id", [input], [], undefined);
        expect(updateDbAfterSettle).toHaveBeenCalledWith([input], "commitment-txid");
        // A successful settle feeds its resolved inputs to the rotate-on-board
        // hook (which decides whether a boarding UTXO was consumed).
        expect(thisArg.maybeRotateBoardingAfterBoard).toHaveBeenCalledWith([input]);
        batchJoinSpy.mockRestore();
    });

    it("closes the primed stream when safeRegisterIntent fails before Batch.join starts", async () => {
        const callOrder: string[] = [];
        let resolveFirstNext: ((value: IteratorResult<any>) => void) | undefined = undefined;
        const firstNext = new Promise<IteratorResult<any>>((resolve) => {
            resolveFirstNext = resolve;
        });
        const stream = {
            next: vi.fn(() => {
                callOrder.push("stream.next");
                return firstNext;
            }),
            return: vi.fn(async () => {
                callOrder.push("stream.return");
                resolveFirstNext?.({ done: true, value: undefined });
                return { done: true, value: undefined };
            }),
            [Symbol.asyncIterator]() {
                return this;
            },
        } as AsyncIterableIterator<any>;

        const registerError = new Error("register failed");
        const deleteIntent = vi.fn().mockResolvedValue(undefined);
        const batchJoinSpy = vi.spyOn(Batch, "join");
        const thisArg: any = {
            network: "mutinynet",
            arkProvider: {
                getEventStream: vi.fn().mockReturnValue(stream),
                deleteIntent,
            },
            _addPendingSpends: vi.fn(),
            _removePendingSpends: vi.fn(),
            getAddress: vi.fn().mockResolvedValue(walletAddress),
            makeRegisterIntentSignature: vi.fn().mockResolvedValue({
                proof: "register-proof",
                message: { type: "register" },
            }),
            makeDeleteIntentSignature: vi.fn().mockResolvedValue({
                proof: "delete-proof",
                message: { type: "delete", expire_at: 0 },
            }),
            safeRegisterIntent: vi.fn(async () => {
                callOrder.push("safeRegisterIntent");
                throw registerError;
            }),
            createBatchHandler: vi.fn(),
            updateDbAfterSettle: vi.fn(),
            persistIntentSnapshot: vi.fn(),
        };

        await expect(
            (Wallet.prototype as any)._settleImpl.call(thisArg, {
                inputs: [input],
                outputs: [],
            }),
        ).rejects.toThrow("register failed");

        expect(callOrder).toEqual(["stream.next", "safeRegisterIntent", "stream.return"]);
        expect(stream.return).toHaveBeenCalledTimes(1);
        expect(deleteIntent).toHaveBeenCalledTimes(1);
        expect(batchJoinSpy).not.toHaveBeenCalled();
        batchJoinSpy.mockRestore();
    });

    it("keeps a committed batch as batch_succeeded when a post-commit step throws", async () => {
        const stream = {
            next: vi.fn().mockResolvedValue({ done: false, value: { type: "batch_started" } }),
            return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
            [Symbol.asyncIterator]() {
                return this;
            },
        } as AsyncIterableIterator<any>;

        const deleteIntent = vi.fn().mockResolvedValue(undefined);
        const persistIntentSnapshot = vi.fn().mockResolvedValue(undefined);
        // Batch.join returns without invoking the handler, so the hook's
        // batch_succeeded write never lands — the exact gap the flag closes.
        const batchJoinSpy = vi.spyOn(Batch, "join").mockResolvedValue("commitment-txid");

        const thisArg: any = {
            network: "mutinynet",
            arkProvider: {
                getEventStream: vi.fn().mockReturnValue(stream),
                deleteIntent,
            },
            _addPendingSpends: vi.fn(),
            _removePendingSpends: vi.fn(),
            getAddress: vi.fn().mockResolvedValue(walletAddress),
            makeRegisterIntentSignature: vi.fn().mockResolvedValue({
                proof: "register-proof",
                message: { type: "register" },
            }),
            makeDeleteIntentSignature: vi.fn().mockResolvedValue({
                proof: "delete-proof",
                message: { type: "delete", expire_at: 0 },
            }),
            safeRegisterIntent: vi.fn().mockResolvedValue("intent-id"),
            createBatchHandler: vi.fn().mockReturnValue({} as Batch.Handler),
            updateDbAfterSettle: vi.fn().mockRejectedValue(new Error("db write failed")),
            maybeRotateBoardingAfterBoard: vi.fn().mockResolvedValue(undefined),
            persistIntentSnapshot,
        };

        await expect(
            (Wallet.prototype as any)._settleImpl.call(thisArg, { inputs: [input], outputs: [] }),
        ).rejects.toThrow("db write failed");

        const states = persistIntentSnapshot.mock.calls.map((c) => c[1]);
        expect(states).toContain("batch_succeeded");
        expect(states).not.toContain("cancelled");
        expect(deleteIntent).not.toHaveBeenCalled();
        batchJoinSpy.mockRestore();
    });

    // Regression coverage for the no-params (auto-select) settle branch, which
    // selects all spendable inputs itself and applies MAX_VTXOS_PER_SETTLEMENT.
    describe("no-params auto-select cap", () => {
        const exitScriptHex = hex.encode(
            CSVMultisigTapscript.encode({
                timelock: { type: "seconds", value: 604_672n },
                pubkeys: [new Uint8Array(32).fill(0x01)],
            }).script,
        );

        const makeVtxo = (value: number, i: number): ExtendedVirtualCoin =>
            ({
                txid: `vtxo-${value}-${i}`,
                vout: 0,
                value,
                virtualStatus: {
                    state: "settled",
                    batchExpiry: Date.now() + 60 * 60 * 1000,
                },
                isSpent: false,
                isSwept: false,
                isPreconfirmed: false,
                spentBy: "",
                commitmentTxIds: [],
                expiresAt: new Date(Date.now() + 60 * 60 * 1000),
                status: { confirmed: true },
                createdAt: new Date(),
                isUnrolled: false,
                forfeitTapLeafScript: [new Uint8Array(), new Uint8Array()],
                intentTapLeafScript: [new Uint8Array(), new Uint8Array()],
                tapTree: new Uint8Array(),
            }) as any;

        const makeBoardingUtxo = (value: number, vout = 0): ExtendedCoin =>
            ({
                txid: `boarding-${value}-${vout}`,
                vout,
                value,
                status: {
                    confirmed: true,
                    block_time: Math.floor(Date.now() / 1000) - 60,
                },
            }) as ExtendedCoin;

        // Build a `this` for _settleImpl that runs the auto-select branch and
        // short-circuits at makeRegisterIntentSignature, capturing the final
        // selected inputs (which is what gets registered with the server).
        const buildThisArg = (
            vtxos: ExtendedVirtualCoin[],
            intentFee: Record<string, string>,
            boardingUtxos: ExtendedCoin[] = [],
        ) => {
            let capturedInputs: ExtendedCoin[] | undefined;
            const sentinel = new Error("stop-after-selection");
            const thisArg: any = {
                network: "mutinynet",
                dustAmount: 330n,
                arkProvider: {
                    getInfo: vi.fn().mockResolvedValue({ fees: { intentFee } }),
                },
                onchainProvider: {
                    getChainTip: vi.fn().mockResolvedValue({ height: 1000 }),
                },
                boardingTapscript: { exitScript: exitScriptHex },
                getBoardingUtxos: vi.fn().mockResolvedValue(boardingUtxos),
                getVtxos: vi.fn().mockResolvedValue(vtxos),
                getAddress: vi.fn().mockResolvedValue(walletAddress),
                identity: {
                    signerSession: () => ({
                        getPublicKey: async () => new Uint8Array(32),
                    }),
                },
                makeRegisterIntentSignature: vi.fn(async (coins: ExtendedCoin[]) => {
                    capturedInputs = coins;
                    throw sentinel;
                }),
                makeDeleteIntentSignature: vi.fn().mockResolvedValue({
                    proof: "delete-proof",
                    message: { type: "delete", expire_at: 0 },
                }),
                _addPendingSpends: vi.fn(),
            };
            return { thisArg, sentinel, getCaptured: () => capturedInputs };
        };

        it("caps the number of auto-selected VTXOs at MAX_VTXOS_PER_SETTLEMENT", async () => {
            const value = 5_000;
            const vtxos = Array.from({ length: MAX_VTXOS_PER_SETTLEMENT + 5 }, (_, i) =>
                makeVtxo(value, i),
            );
            const { thisArg, sentinel, getCaptured } = buildThisArg(vtxos, {});

            await expect(
                (Wallet.prototype as any)._settleImpl.call(thisArg, undefined),
            ).rejects.toBe(sentinel);

            expect(getCaptured()).toHaveLength(MAX_VTXOS_PER_SETTLEMENT);
        });

        it("keeps boarding inputs in addition to capped auto-selected VTXOs", async () => {
            const boarding = [makeBoardingUtxo(10_000), makeBoardingUtxo(12_000, 1)];
            const value = 5_000;
            const vtxos = Array.from({ length: MAX_VTXOS_PER_SETTLEMENT + 5 }, (_, i) =>
                makeVtxo(value, i),
            );
            const { thisArg, sentinel, getCaptured } = buildThisArg(vtxos, {}, boarding);

            await expect(
                (Wallet.prototype as any)._settleImpl.call(thisArg, undefined),
            ).rejects.toBe(sentinel);

            const captured = getCaptured()!;
            expect(captured).toHaveLength(boarding.length + MAX_VTXOS_PER_SETTLEMENT);
            expect(captured.slice(0, boarding.length)).toEqual(boarding);
            expect(captured.slice(boarding.length)).toHaveLength(MAX_VTXOS_PER_SETTLEMENT);
        });

        it("settles the highest-value VTXOs first when capping", async () => {
            // 10 large VTXOs listed AFTER 50 small ones. Sorting by value
            // before the cap must rescue the large ones so the capped batch
            // carries the most value (overflow settles on the next call).
            const small = Array.from({ length: MAX_VTXOS_PER_SETTLEMENT }, (_, i) =>
                makeVtxo(1_000, i),
            );
            const large = Array.from({ length: 10 }, (_, i) => makeVtxo(10_000, 1_000 + i));
            const { thisArg, sentinel, getCaptured } = buildThisArg([...small, ...large], {});

            await expect(
                (Wallet.prototype as any)._settleImpl.call(thisArg, undefined),
            ).rejects.toBe(sentinel);

            const captured = getCaptured()!;
            expect(captured).toHaveLength(MAX_VTXOS_PER_SETTLEMENT);
            expect(captured.filter((v: any) => v.value === 10_000)).toHaveLength(10);
        });

        it("caps viable VTXOs, not an uneconomic prefix", async () => {
            // 50 uneconomic VTXOs ahead of 3 viable ones, with a flat 200-sat
            // offchain input fee. The cap must count viable inputs only, so the
            // 3 VTXOs behind the uneconomic prefix are still selected.
            const tiny = Array.from({ length: MAX_VTXOS_PER_SETTLEMENT }, (_, i) =>
                makeVtxo(100, i),
            );
            const normal = Array.from({ length: 3 }, (_, i) => makeVtxo(10_000, 1_000 + i));
            const { thisArg, sentinel, getCaptured } = buildThisArg([...tiny, ...normal], {
                offchainInput: "200.0",
            });

            await expect(
                (Wallet.prototype as any)._settleImpl.call(thisArg, undefined),
            ).rejects.toBe(sentinel);

            const captured = getCaptured()!;
            expect(captured).toHaveLength(3);
            expect(captured.every((v: any) => v.value === 10_000)).toBe(true);
        });

        it("caps the auto-selected total at the server's vtxoMaxAmount", async () => {
            const value = 5_000;
            const vtxos = Array.from({ length: 10 }, (_, i) => makeVtxo(value, i));
            const { thisArg, sentinel, getCaptured } = buildThisArg(vtxos, {});
            // No intent fees, so net == value; the 12000 ceiling fits only 2.
            thisArg.arkProvider.getInfo.mockResolvedValue({
                fees: { intentFee: {} },
                vtxoMaxAmount: 12000n,
            });

            await expect(
                (Wallet.prototype as any)._settleImpl.call(thisArg, undefined),
            ).rejects.toBe(sentinel);

            expect(getCaptured()).toHaveLength(2);
        });

        it("does not cap the auto-selected total when vtxoMaxAmount is -1", async () => {
            const value = 5_000;
            const vtxos = Array.from({ length: 10 }, (_, i) => makeVtxo(value, i));
            const { thisArg, sentinel, getCaptured } = buildThisArg(vtxos, {});
            thisArg.arkProvider.getInfo.mockResolvedValue({
                fees: { intentFee: {} },
                vtxoMaxAmount: -1n,
            });

            await expect(
                (Wallet.prototype as any)._settleImpl.call(thisArg, undefined),
            ).rejects.toBe(sentinel);

            expect(getCaptured()).toHaveLength(10);
        });

        it("skips an oversized VTXO and selects a smaller one within vtxoMaxAmount", async () => {
            // byValueDescending tries 12000 first (> 10000 ceiling, skipped),
            // then 5000 fits. A break here would settle nothing.
            const vtxos = [makeVtxo(12_000, 0), makeVtxo(5_000, 1)];
            const { thisArg, sentinel, getCaptured } = buildThisArg(vtxos, {});
            thisArg.arkProvider.getInfo.mockResolvedValue({
                fees: { intentFee: {} },
                vtxoMaxAmount: 10_000n,
            });

            await expect(
                (Wallet.prototype as any)._settleImpl.call(thisArg, undefined),
            ).rejects.toBe(sentinel);

            const captured = getCaptured()!;
            expect(captured).toHaveLength(1);
            expect(captured[0].value).toBe(5_000);
        });

        it("compares vtxoMaxAmount against the projected post-fee output", async () => {
            // Pre-fee subtotal (10_500) exceeds the 10_000 ceiling, but the
            // flat 1000-sat output fee brings the registered output down to
            // 9_500, which fits. The VTXO must be selected, not dropped.
            const vtxos = [makeVtxo(10_500, 0)];
            const { thisArg, sentinel, getCaptured } = buildThisArg(vtxos, {
                offchainOutput: "1000.0",
            });
            thisArg.arkProvider.getInfo.mockResolvedValue({
                fees: { intentFee: { offchainOutput: "1000.0" } },
                vtxoMaxAmount: 10_000n,
            });

            await expect(
                (Wallet.prototype as any)._settleImpl.call(thisArg, undefined),
            ).rejects.toBe(sentinel);

            const captured = getCaptured()!;
            expect(captured).toHaveLength(1);
            expect(captured[0].value).toBe(10_500);
        });

        it("reads the receive address once so a mid-settle rotation can't desync the output script", async () => {
            // The output and the asset-routing destination script must come
            // from one address read; re-reading could observe a
            // WalletReceiveRotator.rotate() swap (it mutates offchainTapscript
            // without _txLock) and make findDestinationOutputIndex miss.
            const vtxos = [makeVtxo(5_000, 0)];
            const { thisArg, sentinel } = buildThisArg(vtxos, {});

            await expect(
                (Wallet.prototype as any)._settleImpl.call(thisArg, undefined),
            ).rejects.toBe(sentinel);

            expect(thisArg.getAddress).toHaveBeenCalledTimes(1);
        });
    });
});

describe("Wallet.updateDbAfterOffchainTx", () => {
    const PRIMARY_SCRIPT = "ab".repeat(34);
    const PRIMARY_ADDR = "ark1primaryaddress";
    const DELEGATE_SCRIPT = "cd".repeat(34);
    const DELEGATE_ADDR = "ark1delegateaddress";

    const primaryPkScript = hex.decode(PRIMARY_SCRIPT);

    const makeThisArg = (overrides: {
        annotateVtxos: ReturnType<typeof vi.fn>;
        contracts: { script: string; address: string }[];
        saveVtxos?: ReturnType<typeof vi.fn>;
        saveTransactions?: ReturnType<typeof vi.fn>;
    }) => {
        const saveVtxos = overrides.saveVtxos ?? vi.fn().mockResolvedValue(undefined);
        const saveTransactions = overrides.saveTransactions ?? vi.fn().mockResolvedValue(undefined);
        const getContracts = vi.fn().mockResolvedValue(overrides.contracts);
        const getContractManager = vi.fn().mockResolvedValue({
            annotateVtxos: overrides.annotateVtxos,
            getContracts,
        });
        const arkAddress = { encode: () => PRIMARY_ADDR };
        const offchainTapscript: any = {
            pkScript: primaryPkScript,
            forfeit: () => [new Uint8Array(32), new Uint8Array(33)],
            encode: () => new Uint8Array(64),
            address: () => arkAddress,
        };
        return {
            thisArg: {
                network: { hrp: "ark" },
                arkServerPublicKey: new Uint8Array(32),
                walletRepository: { saveVtxos, saveTransactions },
                getContractManager,
            } as any,
            offchainTapscript,
            saveVtxos,
            saveTransactions,
            getContracts,
        };
    };

    const makeSpentInput = (script: string, suffix: string): VirtualCoin => ({
        txid: suffix.repeat(64).slice(0, 64),
        vout: 0,
        value: 5_000,
        status: { confirmed: true },
        virtualStatus: { state: "preconfirmed", batchExpiry: 1_700_000_000 },
        createdAt: new Date(),
        isUnrolled: false,
        isSpent: false,
        isSwept: false,
        isPreconfirmed: true,
        spentBy: "",
        commitmentTxIds: [],
        expiresAtHeight: 1_700_000,
        script,
    });

    const annotated = (input: VirtualCoin): any => ({
        ...input,
        forfeitTapLeafScript: [new Uint8Array(32), new Uint8Array(33)],
        intentTapLeafScript: [new Uint8Array(32), new Uint8Array(34)],
        tapTree: new Uint8Array(64),
    });

    it("saves single-contract spend rows and the change row under the primary bucket", async () => {
        const input = makeSpentInput(PRIMARY_SCRIPT, "1");
        const annotateVtxos = vi.fn().mockResolvedValue([annotated(input)]);
        const { thisArg, offchainTapscript, saveVtxos, saveTransactions } = makeThisArg({
            annotateVtxos,
            contracts: [{ script: PRIMARY_SCRIPT, address: PRIMARY_ADDR }],
        });

        await (Wallet.prototype as any).updateDbAfterOffchainTx.call(
            thisArg,
            [input],
            "ark-tx-id",
            [], // empty checkpoints → loop takes the no-PSBT branch
            1_000, // sentAmount
            4_000n, // changeAmount
            1, // changeVout
            offchainTapscript,
        );

        // Per-script saves: one for the spent row, one for the change row.
        expect(saveVtxos).toHaveBeenCalledTimes(2);
        expect(saveVtxos).toHaveBeenCalledWith(
            PRIMARY_ADDR,
            expect.arrayContaining([
                expect.objectContaining({
                    txid: input.txid,
                    isSpent: true,
                    script: PRIMARY_SCRIPT,
                }),
            ]),
        );
        expect(saveVtxos).toHaveBeenCalledWith(
            PRIMARY_ADDR,
            expect.arrayContaining([
                expect.objectContaining({
                    txid: "ark-tx-id",
                    vout: 1,
                    script: PRIMARY_SCRIPT,
                }),
            ]),
        );

        expect(saveTransactions).toHaveBeenCalledTimes(1);
        expect(saveTransactions.mock.calls[0][0]).toBe(PRIMARY_ADDR);
    });

    it("routes multi-contract spend rows to their owning contract buckets", async () => {
        const primaryInput = makeSpentInput(PRIMARY_SCRIPT, "1");
        const delegateInput = makeSpentInput(DELEGATE_SCRIPT, "2");
        const annotateVtxos = vi
            .fn()
            .mockResolvedValue([annotated(primaryInput), annotated(delegateInput)]);
        const { thisArg, offchainTapscript, saveVtxos } = makeThisArg({
            annotateVtxos,
            contracts: [
                { script: PRIMARY_SCRIPT, address: PRIMARY_ADDR },
                { script: DELEGATE_SCRIPT, address: DELEGATE_ADDR },
            ],
        });

        await (Wallet.prototype as any).updateDbAfterOffchainTx.call(
            thisArg,
            [primaryInput, delegateInput],
            "ark-tx-id",
            [],
            1_000,
            0n, // no change → only spent rows
            0,
            offchainTapscript,
        );

        expect(saveVtxos).toHaveBeenCalledTimes(2);
        const calls = new Map(saveVtxos.mock.calls.map(([addr, vtxos]: any) => [addr, vtxos]));
        expect(calls.get(PRIMARY_ADDR)).toHaveLength(1);
        expect(calls.get(PRIMARY_ADDR)[0].script).toBe(PRIMARY_SCRIPT);
        expect(calls.get(DELEGATE_ADDR)).toHaveLength(1);
        expect(calls.get(DELEGATE_ADDR)[0].script).toBe(DELEGATE_SCRIPT);
    });

    it("saves change separately from primary-bucket spent rows", async () => {
        const primaryInput = makeSpentInput(PRIMARY_SCRIPT, "1");
        const delegateInput = makeSpentInput(DELEGATE_SCRIPT, "2");
        const annotateVtxos = vi
            .fn()
            .mockResolvedValue([annotated(primaryInput), annotated(delegateInput)]);
        const { thisArg, offchainTapscript, saveVtxos } = makeThisArg({
            annotateVtxos,
            contracts: [
                { script: PRIMARY_SCRIPT, address: PRIMARY_ADDR },
                { script: DELEGATE_SCRIPT, address: DELEGATE_ADDR },
            ],
        });

        await (Wallet.prototype as any).updateDbAfterOffchainTx.call(
            thisArg,
            [primaryInput, delegateInput],
            "ark-tx-id",
            [],
            1_000,
            4_000n,
            1,
            offchainTapscript,
        );

        // Per-script saves: primary spent, delegate spent, change (primary script).
        expect(saveVtxos).toHaveBeenCalledTimes(3);
        expect(saveVtxos).toHaveBeenCalledWith(
            PRIMARY_ADDR,
            expect.arrayContaining([expect.objectContaining({ script: PRIMARY_SCRIPT })]),
        );
        expect(saveVtxos).toHaveBeenCalledWith(
            DELEGATE_ADDR,
            expect.arrayContaining([expect.objectContaining({ script: DELEGATE_SCRIPT })]),
        );
    });

    it("rethrows when a spent VTXO has no script", async () => {
        const input = makeSpentInput(PRIMARY_SCRIPT, "1");
        const annotateVtxos = vi
            .fn()
            .mockResolvedValue([{ ...annotated(input), script: undefined }]);
        const { thisArg, offchainTapscript, saveVtxos } = makeThisArg({
            annotateVtxos,
            contracts: [{ script: PRIMARY_SCRIPT, address: PRIMARY_ADDR }],
        });

        await expect(
            (Wallet.prototype as any).updateDbAfterOffchainTx.call(
                thisArg,
                [input],
                "ark-tx-id",
                [],
                1_000,
                0n,
                0,
                offchainTapscript,
            ),
        ).rejects.toThrow(/has no script/);

        expect(saveVtxos).not.toHaveBeenCalled();
    });

    it("rethrows when a spent VTXO references an unknown contract", async () => {
        const input = makeSpentInput(PRIMARY_SCRIPT, "1");
        const orphan = {
            ...annotated(input),
            script: "ee".repeat(34),
        };
        const annotateVtxos = vi.fn().mockResolvedValue([orphan]);
        const { thisArg, offchainTapscript, saveVtxos } = makeThisArg({
            annotateVtxos,
            contracts: [{ script: PRIMARY_SCRIPT, address: PRIMARY_ADDR }],
        });

        await expect(
            (Wallet.prototype as any).updateDbAfterOffchainTx.call(
                thisArg,
                [input],
                "ark-tx-id",
                [],
                1_000,
                0n,
                0,
                offchainTapscript,
            ),
        ).rejects.toThrow(/no contract owns script/);

        expect(saveVtxos).not.toHaveBeenCalled();
    });

    it("binds the change VTXO metadata to the snapshot, not to this.offchainTapscript / this.arkServerPublicKey", async () => {
        // PR #489 review #1 contract test: the change output's pkScript
        // is captured under `_txLock` BEFORE the offchain round-trip,
        // but the change-VTXO metadata (`forfeitTapLeafScript`,
        // `tapTree`, `script`, `primaryAddress`) is written AFTER the
        // round-trip — `rotateServerSigner` could swap
        // `this.offchainTapscript` AND `this.arkServerPublicKey` in
        // between. The fix threads the pre-round-trip snapshot (tapscript
        // + server key) down as parameters and derives all fields from
        // them. A regression that re-reads `this.offchainTapscript` or
        // `this.arkServerPublicKey` inside the function would bind the
        // change/primaryAddress to the post-rotation epoch while the
        // server's VTXO is locked to the pre-rotation one — the exact P1
        // race we're guarding against.
        //
        // Two real `DefaultVtxo.Script` instances with distinct
        // pubkeys: `tapscriptOld` lives on `this.offchainTapscript`
        // (deliberately the "wrong" one), `tapscriptNew` is the
        // snapshot threaded through. The change-VTXO fields must
        // match `tapscriptNew` everywhere.
        const tapscriptOld = new DefaultVtxo.Script({
            pubKey: TEST_PUB_KEY,
            serverPubKey: TEST_SERVER_PUB_KEY,
            csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
        });
        const tapscriptNew = new DefaultVtxo.Script({
            pubKey: TEST_DELEGATE_PUB_KEY,
            serverPubKey: TEST_SERVER_PUB_KEY,
            csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
        });
        // Sanity: the two tapscripts produce distinguishable outputs.
        // Without this, any assertion below would be vacuously true.
        expect(hex.encode(tapscriptOld.pkScript)).not.toBe(hex.encode(tapscriptNew.pkScript));

        const SPEND_SCRIPT = hex.encode(tapscriptOld.pkScript);
        const SPEND_ADDR = tapscriptOld.address("ark", TEST_SERVER_PUB_KEY).encode();
        const CHANGE_SCRIPT = hex.encode(tapscriptNew.pkScript);
        const CHANGE_ADDR = tapscriptNew.address("ark", TEST_SERVER_PUB_KEY).encode();

        const input: VirtualCoin = {
            txid: "1".repeat(64),
            vout: 0,
            value: 5_000,
            status: { confirmed: true },
            virtualStatus: {
                state: "preconfirmed",
                batchExpiry: 1_700_000_000,
            },
            createdAt: new Date(),
            isUnrolled: false,
            isSpent: false,
            isSwept: false,
            isPreconfirmed: true,
            spentBy: "",
            commitmentTxIds: [],
            expiresAtHeight: 1_700_000,
            script: SPEND_SCRIPT,
        };
        const annotatedInput: any = {
            ...input,
            forfeitTapLeafScript: [new Uint8Array(32), new Uint8Array(33)],
            intentTapLeafScript: [new Uint8Array(32), new Uint8Array(34)],
            tapTree: new Uint8Array(64),
        };

        const saveVtxos = vi.fn().mockResolvedValue(undefined);
        const saveTransactions = vi.fn().mockResolvedValue(undefined);
        const getContractManager = vi.fn().mockResolvedValue({
            annotateVtxos: vi.fn().mockResolvedValue([annotatedInput]),
            getContracts: vi.fn().mockResolvedValue([
                // Spent input is owned by the OLD script's contract.
                { script: SPEND_SCRIPT, address: SPEND_ADDR },
                // Change is owned by the NEW script's contract.
                { script: CHANGE_SCRIPT, address: CHANGE_ADDR },
            ]),
        });

        const thisArg = {
            network: { hrp: "ark" },
            // Deliberately the WRONG server key on `this`. A regression that
            // re-reads `this.arkServerPublicKey` would derive `primaryAddress`
            // from this instead of the snapshot below.
            arkServerPublicKey: TEST_PUB_KEY,
            // Deliberately the WRONG tapscript on `this`. A regression
            // that re-reads `this.offchainTapscript` inside the
            // function would bind the change to this instead of the
            // snapshot.
            offchainTapscript: tapscriptOld,
            arkAddress: tapscriptOld.address("ark", TEST_SERVER_PUB_KEY),
            walletRepository: { saveVtxos, saveTransactions },
            getContractManager,
        } as any;

        await (Wallet.prototype as any).updateDbAfterOffchainTx.call(
            thisArg,
            [input],
            "ark-tx-id",
            [], // empty checkpoints → no-PSBT branch
            1_000,
            4_000n,
            1,
            tapscriptNew, // the tapscript snapshot
            TEST_SERVER_PUB_KEY, // the server-key snapshot
        );

        // Find the change-row save (the one keyed by CHANGE_ADDR).
        const changeCall = saveVtxos.mock.calls.find(([addr]: any) => addr === CHANGE_ADDR);
        expect(changeCall).toBeDefined();
        const [, changeRows] = changeCall!;
        expect(changeRows).toHaveLength(1);
        const changeVtxo = changeRows[0];

        // The four script-shaped fields all derive from `tapscriptNew`.
        // Asserting each individually so a regression points at the
        // exact field that broke. `TapLeafScript` is
        // `[ControlBlockObject, Uint8Array]` — assert by structural
        // equality on the object and hex equality on the script bytes.
        expect(changeVtxo.script).toBe(CHANGE_SCRIPT);
        expect(hex.encode(changeVtxo.tapTree)).toBe(hex.encode(tapscriptNew.encode()));
        const expectedForfeit = tapscriptNew.forfeit();
        expect(changeVtxo.forfeitTapLeafScript[0]).toEqual(expectedForfeit[0]);
        expect(hex.encode(changeVtxo.forfeitTapLeafScript[1])).toBe(hex.encode(expectedForfeit[1]));
        expect(changeVtxo.intentTapLeafScript[0]).toEqual(expectedForfeit[0]);
        expect(hex.encode(changeVtxo.intentTapLeafScript[1])).toBe(hex.encode(expectedForfeit[1]));

        // `primaryAddress` (the address `saveTransactions` is keyed by)
        // also derives from the snapshot tapscript + server key, not from
        // `this.offchainTapscript` / `this.arkServerPublicKey`. With the wrong
        // server key on `this`, a regression would key it by neither CHANGE_ADDR
        // nor SPEND_ADDR.
        expect(saveTransactions).toHaveBeenCalledTimes(1);
        expect(saveTransactions.mock.calls[0][0]).toBe(CHANGE_ADDR);
        expect(saveTransactions.mock.calls[0][0]).not.toBe(SPEND_ADDR);
    });
});

describe("Wallet.updateDbAfterSettle", () => {
    const PRIMARY_SCRIPT = "ab".repeat(34);
    const PRIMARY_ADDR = "ark1primaryaddress";
    const DELEGATE_SCRIPT = "cd".repeat(34);
    const DELEGATE_ADDR = "ark1delegateaddress";
    const BOARDING_ADDR = "bc1boardingaddr";

    // Per-address boarding-UTXO buckets keyed by address. `updateDbAfterSettle`
    // resolves the source address of each boarding input from its tapTree, so
    // the mock must return the right bucket per address (not a single global
    // list) to exercise the address-aware cleanup (plan §6-III.4).
    const makeThisArg = (overrides: {
        annotateVtxos: ReturnType<typeof vi.fn>;
        contracts: { script: string; address: string }[];
        currentBoardingUtxos?: any[];
        boardingUtxosByAddress?: Record<string, any[]>;
        network?: any;
    }) => {
        const saveVtxos = vi.fn().mockResolvedValue(undefined);
        const saveUtxos = vi.fn().mockResolvedValue(undefined);
        const deleteUtxos = vi.fn().mockResolvedValue(undefined);
        const byAddress = overrides.boardingUtxosByAddress;
        const getUtxos = vi
            .fn()
            .mockImplementation(async (address: string) =>
                byAddress ? (byAddress[address] ?? []) : (overrides.currentBoardingUtxos ?? []),
            );
        const getContracts = vi.fn().mockResolvedValue(overrides.contracts);
        const getContractManager = vi.fn().mockResolvedValue({
            annotateVtxos: overrides.annotateVtxos,
            getContracts,
        });
        return {
            thisArg: {
                walletRepository: {
                    saveVtxos,
                    saveUtxos,
                    deleteUtxos,
                    getUtxos,
                },
                getContractManager,
                getBoardingAddress: vi.fn().mockResolvedValue(BOARDING_ADDR),
                network: overrides.network ?? { bech32: "bcrt", hrp: "tark" },
            } as any,
            saveVtxos,
            saveUtxos,
            deleteUtxos,
            getUtxos,
        };
    };

    // A boarding ExtendedCoin carrying a real per-UTXO tapTree, so
    // `updateDbAfterSettle` can resolve its on-chain source address.
    const makeBoardingCoin = (
        tapscript: DefaultVtxo.Script,
        txidChar: string,
        value = 10_000,
    ): ExtendedCoin =>
        ({
            txid: txidChar.repeat(64).slice(0, 64),
            vout: 0,
            value,
            status: { confirmed: true },
            forfeitTapLeafScript: tapscript.forfeit(),
            intentTapLeafScript: tapscript.forfeit(),
            tapTree: tapscript.encode(),
        }) as ExtendedCoin;

    const makeVtxoInput = (script: string, suffix: string): ExtendedCoin =>
        ({
            txid: suffix.repeat(64).slice(0, 64),
            vout: 0,
            value: 5_000,
            status: { confirmed: true },
            virtualStatus: { state: "preconfirmed" },
            createdAt: new Date(),
            isUnrolled: false,
            isSpent: false,
            script,
            forfeitTapLeafScript: [new Uint8Array(32), new Uint8Array(33)],
            intentTapLeafScript: [new Uint8Array(32), new Uint8Array(34)],
            tapTree: new Uint8Array(64),
        }) as ExtendedCoin;

    it("saves single-contract settle rows under the primary bucket", async () => {
        const input = makeVtxoInput(PRIMARY_SCRIPT, "1");
        const annotateVtxos = vi.fn().mockResolvedValue([input]);
        const { thisArg, saveVtxos } = makeThisArg({
            annotateVtxos,
            contracts: [{ script: PRIMARY_SCRIPT, address: PRIMARY_ADDR }],
        });

        await (Wallet.prototype as any).updateDbAfterSettle.call(thisArg, [input], "commitment-tx");

        expect(saveVtxos).toHaveBeenCalledTimes(1);
        const [addr, vtxos] = saveVtxos.mock.calls[0];
        expect(addr).toBe(PRIMARY_ADDR);
        expect(vtxos).toHaveLength(1);
        // Consumed by settlement, so `isSpent`/`settledBy` are set and the legacy projection
        // follows its precedence: "spent" outranks "settled". `settledBy` names the commitment
        // tx that consumed this vtxo — it is not a live batch leaf. This is also what the
        // indexer reports for the same vtxo on re-fetch.
        expect(vtxos[0].virtualStatus.state).toBe("spent");
        expect(vtxos[0].settledBy).toBe("commitment-tx");
        expect(vtxos[0].isSpent).toBe(true);
    });

    it("routes multi-contract settle rows to their owning contract buckets", async () => {
        const primaryInput = makeVtxoInput(PRIMARY_SCRIPT, "1");
        const delegateInput = makeVtxoInput(DELEGATE_SCRIPT, "2");
        const annotateVtxos = vi.fn().mockResolvedValue([primaryInput, delegateInput]);
        const { thisArg, saveVtxos } = makeThisArg({
            annotateVtxos,
            contracts: [
                { script: PRIMARY_SCRIPT, address: PRIMARY_ADDR },
                { script: DELEGATE_SCRIPT, address: DELEGATE_ADDR },
            ],
        });

        await (Wallet.prototype as any).updateDbAfterSettle.call(
            thisArg,
            [primaryInput, delegateInput],
            "commitment-tx",
        );

        expect(saveVtxos).toHaveBeenCalledTimes(2);
        const calls = new Map(saveVtxos.mock.calls.map(([addr, vtxos]: any) => [addr, vtxos]));
        expect(calls.get(PRIMARY_ADDR)).toHaveLength(1);
        expect(calls.get(PRIMARY_ADDR)[0].script).toBe(PRIMARY_SCRIPT);
        expect(calls.get(DELEGATE_ADDR)).toHaveLength(1);
        expect(calls.get(DELEGATE_ADDR)[0].script).toBe(DELEGATE_SCRIPT);
    });

    it("removes a settled boarding input from the bucket of the address it sits on", async () => {
        const network = { bech32: "bcrt", hrp: "tark" } as any;
        const boardingScript = new DefaultVtxo.Script({
            pubKey: TEST_PUB_KEY,
            serverPubKey: TEST_SERVER_PUB_KEY,
            csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
        });
        const boardingAddr = boardingScript.onchainAddress(network);
        const boardingInput = makeBoardingCoin(boardingScript, "b");
        const otherUtxo = {
            txid: "c".repeat(64),
            vout: 0,
            value: 1000,
            status: { confirmed: true },
        };
        const annotateVtxos = vi.fn().mockResolvedValue([]);
        const { thisArg, saveVtxos, deleteUtxos, saveUtxos, getUtxos } = makeThisArg({
            annotateVtxos,
            contracts: [{ script: PRIMARY_SCRIPT, address: PRIMARY_ADDR }],
            network,
            boardingUtxosByAddress: {
                [boardingAddr]: [{ txid: boardingInput.txid, vout: 0, value: 10_000 }, otherUtxo],
            },
        });

        await (Wallet.prototype as any).updateDbAfterSettle.call(
            thisArg,
            [boardingInput],
            "commitment-tx",
        );

        expect(saveVtxos).not.toHaveBeenCalled();
        // Cleanup targets the bucket of the address the UTXO actually sits on.
        expect(getUtxos).toHaveBeenCalledWith(boardingAddr);
        expect(deleteUtxos).toHaveBeenCalledWith(boardingAddr);
        expect(saveUtxos).toHaveBeenCalledWith(boardingAddr, [otherUtxo]);
    });

    it("settling a boarding UTXO from a PREVIOUS boarding address cleans up that historical bucket only (plan §6-III.4)", async () => {
        const network = { bech32: "bcrt", hrp: "tark" } as any;
        // Two distinct boarding addresses (different owner pubkeys) — a current
        // and a rotated-away "previous" one.
        const currentScript = new DefaultVtxo.Script({
            pubKey: TEST_PUB_KEY,
            serverPubKey: TEST_SERVER_PUB_KEY,
            csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
        });
        const previousScript = new DefaultVtxo.Script({
            pubKey: hex.decode("c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"),
            serverPubKey: TEST_SERVER_PUB_KEY,
            csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
        });
        const currentAddr = currentScript.onchainAddress(network);
        const previousAddr = previousScript.onchainAddress(network);
        expect(previousAddr).not.toBe(currentAddr);

        // Settle a UTXO received at the PREVIOUS boarding address.
        const previousInput = makeBoardingCoin(previousScript, "d");
        const leftoverAtPrevious = {
            txid: "e".repeat(64),
            vout: 0,
            value: 2000,
            status: { confirmed: true },
        };
        const untouchedAtCurrent = {
            txid: "f".repeat(64),
            vout: 0,
            value: 3000,
            status: { confirmed: true },
        };

        const annotateVtxos = vi.fn().mockResolvedValue([]);
        const { thisArg, deleteUtxos, saveUtxos, getUtxos } = makeThisArg({
            annotateVtxos,
            contracts: [{ script: PRIMARY_SCRIPT, address: PRIMARY_ADDR }],
            network,
            boardingUtxosByAddress: {
                [previousAddr]: [
                    { txid: previousInput.txid, vout: 0, value: 10_000 },
                    leftoverAtPrevious,
                ],
                [currentAddr]: [untouchedAtCurrent],
            },
        });

        await (Wallet.prototype as any).updateDbAfterSettle.call(
            thisArg,
            [previousInput],
            "commitment-tx",
        );

        // Only the previous bucket is rewritten; the current bucket is untouched.
        expect(getUtxos).toHaveBeenCalledWith(previousAddr);
        expect(getUtxos).not.toHaveBeenCalledWith(currentAddr);
        expect(deleteUtxos).toHaveBeenCalledWith(previousAddr);
        expect(deleteUtxos).not.toHaveBeenCalledWith(currentAddr);
        expect(saveUtxos).toHaveBeenCalledWith(previousAddr, [leftoverAtPrevious]);
    });

    it("rethrows when a settled VTXO has no script", async () => {
        const input = makeVtxoInput(PRIMARY_SCRIPT, "1");
        const annotateVtxos = vi.fn().mockResolvedValue([{ ...input, script: undefined }]);
        const { thisArg, saveVtxos } = makeThisArg({
            annotateVtxos,
            contracts: [{ script: PRIMARY_SCRIPT, address: PRIMARY_ADDR }],
        });

        await expect(
            (Wallet.prototype as any).updateDbAfterSettle.call(thisArg, [input], "commitment-tx"),
        ).rejects.toThrow(/has no script/);

        expect(saveVtxos).not.toHaveBeenCalled();
    });

    it("rethrows when a settled VTXO references an unknown contract", async () => {
        const input = makeVtxoInput(PRIMARY_SCRIPT, "1");
        const orphan = { ...input, script: "ee".repeat(34) };
        const annotateVtxos = vi.fn().mockResolvedValue([orphan]);
        const { thisArg, saveVtxos } = makeThisArg({
            annotateVtxos,
            contracts: [{ script: PRIMARY_SCRIPT, address: PRIMARY_ADDR }],
        });

        await expect(
            (Wallet.prototype as any).updateDbAfterSettle.call(thisArg, [orphan], "commitment-tx"),
        ).rejects.toThrow(/no contract owns script/);

        expect(saveVtxos).not.toHaveBeenCalled();
    });
});
