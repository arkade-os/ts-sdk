import { describe, it, expect, vi, beforeEach } from "vitest";
import { hex } from "@scure/base";
import {
    Wallet,
    SingleKey,
    OnchainWallet,
    RestArkProvider,
    ReadonlyWallet,
} from "../src";
import { ReadonlySingleKey } from "../src/identity/singleKey";
import type { Coin } from "../src/wallet";

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock EventSource
const MockEventSource = vi.fn().mockImplementation((url: string) => ({
    url,
    onmessage: null,
    onerror: null,
    close: vi.fn(),
}));
vi.stubGlobal("EventSource", MockEventSource);

describe("Wallet", () => {
    // Test vector from BIP340
    const mockPrivKeyHex =
        "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2";
    // X-only pubkey (without the 02/03 prefix)
    const mockServerKeyHex =
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const mockIdentity = SingleKey.fromHex(mockPrivKeyHex);

    beforeEach(() => {
        mockFetch.mockReset();
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

            const wallet = await OnchainWallet.create(
                mockIdentity,
                "mutinynet"
            );

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
            // 1. getInfo() call during wallet creation
            // 2. getBoardingUtxos() -> getCoins() call
            // 3. getVtxos() -> first vtxos call (spendable)
            // 4. getVtxos() -> second vtxos call (recoverable)

            mockFetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            signerPubkey: mockServerKeyHex,
                            forfeitPubkey: mockServerKeyHex,
                            batchExpiry: BigInt(144),
                            unilateralExitDelay: BigInt(144),
                            roundInterval: BigInt(144),
                            network: "mutinynet",
                            forfeitAddress:
                                "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
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
                    json: () => Promise.resolve(mockServerResponse),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({ vtxos: [] }),
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

            const wallet = await OnchainWallet.create(
                mockIdentity,
                "mutinynet"
            );

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
        ];

        beforeEach(() => {
            mockFetch.mockReset();
        });

        it("should throw error when amount is negative", async () => {
            const wallet = await OnchainWallet.create(
                mockIdentity,
                "mutinynet"
            );

            await expect(
                wallet.send({
                    address: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
                    amount: -1000,
                })
            ).rejects.toThrow("Amount must be positive");
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
                    onchainInput: "1000",
                    onchainOutput: "1000",
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

        it("should convert intentFee.onchainInput and intentFee.onchainOutput to bigint", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockArkInfo),
            });

            const provider = new RestArkProvider("http://localhost:7070");
            const info = await provider.getInfo();
            expect(info.fees.intentFee.onchainInput).toBe(BigInt(1000));
            expect(info.fees.intentFee.onchainOutput).toBe(BigInt(1000));
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
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockArkInfo),
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
            const readonlyBoardingAddress =
                await readonlyWallet.getBoardingAddress();
            expect(boardingAddress).toBe(readonlyBoardingAddress);
        });

        it("should not have sendBitcoin method on ReadonlyWallet type", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockArkInfo),
            });

            const wallet = await Wallet.create({
                identity: mockIdentity,
                arkServerUrl: "http://localhost:7070",
            });

            const readonlyWallet = await wallet.toReadonly();

            // ReadonlyWallet should not have sendBitcoin in its type
            expect((readonlyWallet as any).sendBitcoin).toBeUndefined();
            expect((readonlyWallet as any).settle).toBeUndefined();
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

            mockFetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve(mockArkInfo),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve(mockUTXOs),
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

            // Should be able to get balance
            mockFetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve(mockUTXOs),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({ vtxos: [] }),
                });

            const balance = await readonlyWallet.getBalance();
            expect(balance.boarding.total).toBe(100000);
        });
    });
});

describe("ReadonlyWallet", () => {
    const mockServerKeyHex =
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

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
        const privateKeyHex =
            "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2";
        const key = SingleKey.fromHex(privateKeyHex);
        const compressedPubKey = await key.compressedPublicKey();

        // Create readonly identity
        const readonlyIdentity =
            ReadonlySingleKey.fromPublicKey(compressedPubKey);

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

    it("should query balance with ReadonlyWallet", async () => {
        const privateKeyHex =
            "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2";
        const key = SingleKey.fromHex(privateKeyHex);
        const compressedPubKey = await key.compressedPublicKey();
        const readonlyIdentity =
            ReadonlySingleKey.fromPublicKey(compressedPubKey);

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

        mockFetch
            .mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockArkInfo),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockUTXOs),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ vtxos: [] }),
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
        const privateKeyHex =
            "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2";
        const key = SingleKey.fromHex(privateKeyHex);
        const compressedPubKey = await key.compressedPublicKey();
        const readonlyIdentity =
            ReadonlySingleKey.fromPublicKey(compressedPubKey);

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
