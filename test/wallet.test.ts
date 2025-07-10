import { describe, it, expect, vi, beforeEach } from "vitest";
import { hex } from "@scure/base";
import { Wallet, SingleKey, OnchainWallet } from "../src";
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

            const wallet = new OnchainWallet(mockIdentity, "mutinynet");

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

            mockFetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            signerPubkey: mockServerKeyHex,
                            batchExpiry: BigInt(144),
                            unilateralExitDelay: BigInt(144),
                            roundInterval: BigInt(144),
                            network: "mutinynet",
                            forfeitAddress:
                                "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
                        }),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve(mockServerResponse),
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

            const wallet = new OnchainWallet(mockIdentity, "mutinynet");

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
            const wallet = new OnchainWallet(mockIdentity, "mutinynet");

            await expect(
                wallet.send({
                    address: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
                    amount: -1000,
                })
            ).rejects.toThrow("Amount must be positive");
        });
    });

    describe("getInfos", () => {
        const mockArkInfo = {
            signerPubkey: mockServerKeyHex,
            batchExpiry: BigInt(144),
            unilateralExitDelay: BigInt(144),
            roundInterval: BigInt(144),
            network: "mutinynet",
            dust: BigInt(1000),
            boardingDescriptorTemplate: "boarding_template",
            vtxoDescriptorTemplates: ["vtxo_template"],
            forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
            marketHour: {
                start: 0,
                end: 24,
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
    });
});
