import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ArkadeSwaps } from "../src/arkade-swaps";
import {
    BoltzSwapProvider,
    CreateReverseSwapRequest,
    CreateReverseSwapResponse,
    CreateSubmarineSwapRequest,
    CreateSubmarineSwapResponse,
    CreateChainSwapRequest,
    CreateChainSwapResponse,
} from "../src/boltz-swap-provider";
import type {
    PendingReverseSwap,
    PendingSubmarineSwap,
    PendingChainSwap,
    ArkadeSwapsConfig,
    ChainFeesResponse,
    LimitsResponse,
} from "../src/types";
import {
    RestArkProvider,
    RestIndexerProvider,
    Identity,
    Wallet,
    SingleKey,
    ArkInfo,
} from "@arkade-os/sdk";
import { VHTLC } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { randomBytes } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { decodeInvoice } from "../src/utils/decoding";
import { pubECDSA } from "@scure/btc-signer/utils.js";

// Mock the @arkade-os/sdk modules
vi.mock("@arkade-os/sdk", async () => {
    const actual = await vi.importActual("@arkade-os/sdk");
    return {
        ...actual,
        Wallet: {
            create: vi.fn(),
        },
        RestArkProvider: vi.fn(),
        RestIndexerProvider: vi.fn(),
    };
});

// Mock WebSocket - this needs to be at the top level
vi.mock("ws", () => {
    return {
        WebSocket: vi.fn().mockImplementation((url: string) => {
            const mockWs = {
                url,
                onopen: null as ((event: any) => void) | null,
                onmessage: null as ((event: any) => void) | null,
                onerror: null as ((event: any) => void) | null,
                onclose: null as ((event: any) => void) | null,

                send: vi.fn().mockImplementation((data: string) => {
                    const message = JSON.parse(data);
                    // Simulate async WebSocket responses
                    process.nextTick(() => {
                        if (mockWs.onmessage && message.op === "subscribe") {
                            // Simulate swap.created status
                            mockWs.onmessage({
                                data: JSON.stringify({
                                    event: "update",
                                    args: [
                                        {
                                            id: message.args[0],
                                            status: "swap.created",
                                        },
                                    ],
                                }),
                            });

                            // Simulate transaction.confirmed status
                            process.nextTick(() => {
                                if (mockWs.onmessage) {
                                    mockWs.onmessage({
                                        data: JSON.stringify({
                                            event: "update",
                                            args: [
                                                {
                                                    id: message.args[0],
                                                    status: "transaction.confirmed",
                                                },
                                            ],
                                        }),
                                    });
                                }
                            });

                            // Simulate invoice.settled status
                            process.nextTick(() => {
                                if (mockWs.onmessage) {
                                    mockWs.onmessage({
                                        data: JSON.stringify({
                                            event: "update",
                                            args: [
                                                {
                                                    id: message.args[0],
                                                    status: "invoice.settled",
                                                },
                                            ],
                                        }),
                                    });
                                }
                            });
                        }
                    });
                }),

                close: vi.fn().mockImplementation(() => {
                    if (mockWs.onclose) {
                        mockWs.onclose({ type: "close" });
                    }
                }),
            };

            // Simulate connection opening
            process.nextTick(() => {
                if (mockWs.onopen) {
                    mockWs.onopen({ type: "open" });
                }
            });

            return mockWs;
        }),
    };
});

describe("ArkadeSwaps", () => {
    let indexerProvider: RestIndexerProvider;
    let swapProvider: BoltzSwapProvider;
    let arkProvider: RestArkProvider;
    let swaps: ArkadeSwaps;
    let identity: Identity;
    let wallet: Wallet;
    let mockSwapRepository: any;

    const seckeys = {
        alice: schnorr.utils.randomSecretKey(),
        boltz: schnorr.utils.randomSecretKey(),
        server: schnorr.utils.randomSecretKey(),
        fulmine: schnorr.utils.randomSecretKey(),
        ephemeral: schnorr.utils.randomSecretKey(),
    };

    const compressedPubkeys = {
        alice: hex.encode(pubECDSA(seckeys.alice, true)),
        boltz: hex.encode(pubECDSA(seckeys.boltz, true)),
        server: hex.encode(pubECDSA(seckeys.server, true)),
        fulmine: hex.encode(pubECDSA(seckeys.fulmine, true)),
        ephemeral: hex.encode(pubECDSA(seckeys.ephemeral, true)),
    };

    const mockPreimage = randomBytes(32);
    const mockPreimageHash = sha256(mockPreimage);

    const mock = {
        address: {
            ark: "tark1qr340xg400jtxat9hdd0ungyu6s05zjtdf85uj9smyzxshf98ndak8ytjppry3wwkavtm5lu2clrlr6rwq32ryqamwnzy5xncrjz4s62mw5yyx",
            btc: "bcrt1pqh9z96ct2zr95zs8a8ezfugu9dl08u3g2420aap2ngsg0f4s3z7s77hh3q",
        },
        amount: 50000,
        hex: "mock-hex",
        id: "mock-id",
        invoice: {
            amount: 3000000, // amount in satoshis
            description: "Payment request with multipart support",
            paymentHash:
                "850aeaf5f69670e8889936fc2e0cff3ceb0c3b5eab8f04ae57767118db673a91",
            expiry: 28800, // 8 hours in seconds
            address:
                "lntb30m1pw2f2yspp5s59w4a0kjecw3zyexm7zur8l8n4scw674w" +
                "8sftjhwec33km882gsdpa2pshjmt9de6zqun9w96k2um5ypmkjar" +
                "gypkh2mr5d9cxzun5ypeh2ursdae8gxqruyqvzddp68gup69uhnz" +
                "wfj9cejuvf3xshrwde68qcrswf0d46kcarfwpshyaplw3skw0tdw" +
                "4k8g6tsv9e8glzddp68gup69uhnzwfj9cejuvf3xshrwde68qcrs" +
                "wf0d46kcarfwpshyaplw3skw0tdw4k8g6tsv9e8gcqpfmy8keu46" +
                "zsrgtz8sxdym7yedew6v2jyfswg9zeqetpj2yw3f52ny77c5xsrg" +
                "53q9273vvmwhc6p0gucz2av5gtk3esevk0cfhyvzgxgpgyyavt",
        },
        lockupAddress: "mock-lockup-address",
        preimage: "mock-preimage",
        pubkeys: {
            alice: schnorr.getPublicKey(seckeys.alice),
            boltz: schnorr.getPublicKey(seckeys.boltz),
            server: schnorr.getPublicKey(seckeys.server),
            fulmine: schnorr.getPublicKey(seckeys.fulmine),
            ephemeral: schnorr.getPublicKey(seckeys.ephemeral),
        },
        txid: hex.encode(randomBytes(32)),
    };

    // Lightning swap fixtures
    const createSubmarineSwapRequest: CreateSubmarineSwapRequest = {
        invoice: mock.invoice.address,
        refundPublicKey: compressedPubkeys.alice,
    };

    const createSubmarineSwapResponse: CreateSubmarineSwapResponse = {
        id: mock.id,
        address: mock.address.ark,
        expectedAmount: mock.invoice.amount,
        acceptZeroConf: true,
        claimPublicKey: compressedPubkeys.boltz,
        timeoutBlockHeights: {
            refund: 17,
            unilateralClaim: 21,
            unilateralRefund: 42,
            unilateralRefundWithoutReceiver: 63,
        },
    };

    const createReverseSwapRequest: CreateReverseSwapRequest = {
        claimPublicKey: compressedPubkeys.alice,
        preimageHash: mock.invoice.paymentHash,
        invoiceAmount: mock.invoice.amount,
    };

    const createReverseSwapResponse: CreateReverseSwapResponse = {
        id: mock.id,
        invoice: mock.invoice.address,
        onchainAmount: mock.invoice.amount,
        lockupAddress: mock.lockupAddress,
        refundPublicKey: compressedPubkeys.boltz,
        timeoutBlockHeights: {
            refund: 17,
            unilateralClaim: 21,
            unilateralRefund: 42,
            unilateralRefundWithoutReceiver: 63,
        },
    };

    const mockReverseSwap: PendingReverseSwap = {
        id: mock.id,
        type: "reverse",
        createdAt: Math.floor(Date.now() / 1000),
        preimage: hex.encode(randomBytes(20)),
        request: createReverseSwapRequest,
        response: createReverseSwapResponse,
        status: "swap.created",
    };

    const mockSubmarineSwap: PendingSubmarineSwap = {
        id: mock.id,
        type: "submarine",
        createdAt: Math.floor(Date.now() / 1000),
        request: createSubmarineSwapRequest,
        response: createSubmarineSwapResponse,
        status: "swap.created",
    };

    // Chain swap fixtures
    const createArkBtcChainSwapRequest: CreateChainSwapRequest = {
        to: "BTC",
        from: "ARK",
        feeSatsPerByte: 1,
        userLockAmount: mock.amount,
        claimPublicKey: compressedPubkeys.ephemeral,
        refundPublicKey: compressedPubkeys.alice,
        preimageHash: hex.encode(mockPreimageHash),
    };

    const createBtcArkChainSwapRequest: CreateChainSwapRequest = {
        to: "ARK",
        from: "BTC",
        feeSatsPerByte: 1,
        userLockAmount: mock.amount,
        claimPublicKey: compressedPubkeys.alice,
        refundPublicKey: compressedPubkeys.ephemeral,
        preimageHash: hex.encode(mockPreimageHash),
    };

    const createArkBtcChainSwapResponse: CreateChainSwapResponse = {
        id: mock.id,
        claimDetails: {
            lockupAddress: mock.address.btc,
            amount: mock.amount,
            serverPublicKey: compressedPubkeys.boltz,
            swapTree: {
                claimLeaf: {
                    version: 0,
                    output: "",
                },
                refundLeaf: {
                    version: 0,
                    output: "",
                },
            },
            timeoutBlockHeight: 21,
        },
        lockupDetails: {
            serverPublicKey: compressedPubkeys.fulmine,
            lockupAddress: mock.address.ark,
            amount: mock.amount,
            timeoutBlockHeight: 21,
            timeouts: {
                refund: 17,
                unilateralClaim: 21,
                unilateralRefund: 42,
                unilateralRefundWithoutReceiver: 63,
            },
        },
    };

    const createBtcArkChainSwapResponse: CreateChainSwapResponse = {
        id: mock.id,
        claimDetails: {
            serverPublicKey: compressedPubkeys.fulmine,
            lockupAddress: mock.address.ark,
            amount: mock.amount,
            timeoutBlockHeight: 21,
            timeouts: {
                refund: 17,
                unilateralClaim: 21,
                unilateralRefund: 42,
                unilateralRefundWithoutReceiver: 63,
            },
        },
        lockupDetails: {
            lockupAddress: mock.address.btc,
            amount: mock.amount,
            serverPublicKey: compressedPubkeys.boltz,
            swapTree: {
                claimLeaf: {
                    version: 0,
                    output: "",
                },
                refundLeaf: {
                    version: 0,
                    output: "",
                },
            },
            timeoutBlockHeight: 21,
        },
    };

    const mockArkBtcChainSwap: PendingChainSwap = {
        id: mock.id,
        type: "chain",
        feeSatsPerByte: 1,
        preimage: hex.encode(randomBytes(32)),
        request: createArkBtcChainSwapRequest,
        response: createArkBtcChainSwapResponse,
        createdAt: Math.floor(Date.now() / 1000),
        ephemeralKey: hex.encode(randomBytes(32)),
        toAddress: mock.address.btc,
        status: "swap.created",
        amount: mock.amount,
    };

    const mockBtcArkChainSwap: PendingChainSwap = {
        id: mock.id,
        type: "chain",
        feeSatsPerByte: 1,
        preimage: hex.encode(randomBytes(32)),
        request: createBtcArkChainSwapRequest,
        response: createBtcArkChainSwapResponse,
        createdAt: Math.floor(Date.now() / 1000),
        ephemeralKey: hex.encode(randomBytes(32)),
        toAddress: mock.address.ark,
        status: "swap.created",
        amount: mock.amount,
    };

    const mockFeeInfo = {
        txFeeRate: "",
        intentFee: {
            offchainInput: "",
            offchainOutput: "",
            onchainInput: "",
            onchainOutput: "",
        },
    };

    const mockArkInfo: ArkInfo = {
        boardingExitDelay: 604800n,
        checkpointTapscript: "",
        deprecatedSigners: [],
        digest: "",
        dust: 333n,
        fees: mockFeeInfo,
        forfeitAddress: "mock-forfeit-address",
        forfeitPubkey: "mock-forfeit-pubkey",
        network: "regtest",
        scheduledSession: {
            duration: BigInt(0),
            fees: mockFeeInfo,
            nextEndTime: BigInt(0),
            nextStartTime: BigInt(0),
            period: BigInt(0),
        },
        serviceStatus: {},
        sessionDuration: 604800n,
        signerPubkey: hex.encode(mock.pubkeys.server),
        unilateralExitDelay: 604800n,
        version: "1.0.0",
        vtxoMaxAmount: 21000000n * 100_000_000n,
        utxoMaxAmount: 21000000n * 100_000_000n,
        vtxoMinAmount: -1n,
        utxoMinAmount: -1n,
    };

    const mockBtcArkVHTLC = {
        vhtlcScript: new VHTLC.Script({
            preimageHash: ripemd160(sha256(randomBytes(32))),
            receiver: mock.pubkeys.alice,
            sender: mock.pubkeys.boltz,
            server: mock.pubkeys.server,
            refundLocktime: BigInt(21000),
            unilateralClaimDelay: {
                type: "blocks",
                value: BigInt(21),
            },
            unilateralRefundDelay: {
                type: "blocks",
                value: BigInt(42),
            },
            unilateralRefundWithoutReceiverDelay: {
                type: "blocks",
                value: BigInt(63),
            },
        }),
        vhtlcAddress: mock.address.ark,
    };

    beforeEach(async () => {
        vi.clearAllMocks();

        // Create mock instances
        identity = SingleKey.fromPrivateKey(seckeys.alice);

        // Create mock providers first
        arkProvider = {
            getInfo: vi.fn(),
            submitTx: vi.fn(),
            finalizeTx: vi.fn(),
        } as any;

        indexerProvider = {
            getVtxos: vi.fn(),
        } as any;

        // Create mock swap repository
        mockSwapRepository = {
            saveSwap: vi.fn(),
            deleteSwap: vi.fn(),
            getAllSwaps: vi.fn(),
            clear: vi.fn(),
            [Symbol.asyncDispose]: vi.fn(),
        };

        // Mock wallet with necessary methods and providers
        wallet = {
            identity,
            arkProvider, // Add arkProvider to wallet
            indexerProvider, // Add indexerProvider to wallet
            sendBitcoin: vi.fn(),
            getAddress: vi.fn().mockResolvedValue("mock-address"),
        } as any;

        // Mock the Wallet.create method
        vi.mocked(Wallet.create).mockResolvedValue(wallet);

        swapProvider = new BoltzSwapProvider({ network: "regtest" });

        swaps = new ArkadeSwaps({
            wallet,
            arkProvider,
            swapProvider,
            indexerProvider,
            swapRepository: mockSwapRepository,
            swapManager: false,
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("Initialization", () => {
        it("should be instantiated with wallet and swap provider", () => {
            expect(swaps).toBeInstanceOf(ArkadeSwaps);
        });

        it("should fail to instantiate without required config", async () => {
            const params: ArkadeSwapsConfig = {
                wallet,
                swapProvider,
                arkProvider,
                indexerProvider,
            };
            expect(
                () =>
                    new ArkadeSwaps({
                        ...params,
                        swapProvider: null as any,
                    })
            ).toThrow("Swap provider is required.");
        });

        it("should default to wallet instances without required config", async () => {
            const params: ArkadeSwapsConfig = {
                wallet,
                swapProvider,
                arkProvider,
                indexerProvider,
            };
            expect(() => new ArkadeSwaps({ ...params })).not.toThrow();
            expect(
                () => new ArkadeSwaps({ ...params, arkProvider: null as any })
            ).not.toThrow();
            expect(
                () =>
                    new ArkadeSwaps({
                        ...params,
                        indexerProvider: null as any,
                    })
            ).not.toThrow();
        });

        it("should have expected lightning interface methods", () => {
            expect(swaps.claimVHTLC).toBeInstanceOf(Function);
            expect(swaps.createLightningInvoice).toBeInstanceOf(Function);
            expect(swaps.createReverseSwap).toBeInstanceOf(Function);
            expect(swaps.createSubmarineSwap).toBeInstanceOf(Function);
            expect(swaps.refundVHTLC).toBeInstanceOf(Function);
            expect(swaps.sendLightningPayment).toBeInstanceOf(Function);
            expect(swaps.waitAndClaim).toBeInstanceOf(Function);
            expect(swaps.waitForSwapSettlement).toBeInstanceOf(Function);
        });

        it("should have expected chain interface methods", () => {
            expect(swaps.arkToBtc).toBeInstanceOf(Function);
            expect(swaps.btcToArk).toBeInstanceOf(Function);
            expect(swaps.createChainSwap).toBeInstanceOf(Function);
            expect(swaps.verifyChainSwap).toBeInstanceOf(Function);
            expect(swaps.waitAndClaimArk).toBeInstanceOf(Function);
            expect(swaps.waitAndClaimBtc).toBeInstanceOf(Function);
            expect(swaps.claimBtc).toBeInstanceOf(Function);
            expect(swaps.claimArk).toBeInstanceOf(Function);
            expect(swaps.createVHTLCScript).toBeInstanceOf(Function);
            expect(swaps.getSwapStatus).toBeInstanceOf(Function);
            expect(swaps.getPendingChainSwaps).toBeInstanceOf(Function);
            expect(swaps.getSwapHistory).toBeInstanceOf(Function);
            expect(swaps.refreshSwapsStatus).toBeInstanceOf(Function);
        });
    });

    describe("Receive from Lightning", () => {
        describe("Create Lightning Invoice", () => {
            it("should throw if amount is not > 0", async () => {
                // act & assert
                await expect(
                    swaps.createLightningInvoice({ amount: 0 })
                ).rejects.toThrow("Amount must be greater than 0");
                await expect(
                    swaps.createLightningInvoice({ amount: -1 })
                ).rejects.toThrow("Amount must be greater than 0");
            });

            it("should create a Lightning invoice", async () => {
                // arrange
                const pendingSwap: PendingReverseSwap = {
                    ...mockReverseSwap,
                    preimage: mock.preimage,
                };
                vi.spyOn(swaps, "createReverseSwap").mockResolvedValueOnce(
                    pendingSwap
                );

                // act
                const result = await swaps.createLightningInvoice({
                    amount: mock.amount,
                });

                // assert
                expect(result.expiry).toBe(mock.invoice.expiry);
                expect(result.invoice).toBe(mock.invoice.address);
                expect(result.paymentHash).toBe(mock.invoice.paymentHash);
                expect(result.preimage).toBe(mock.preimage);
                expect(result.pendingSwap.request.claimPublicKey).toBe(
                    compressedPubkeys.alice
                );
            });

            it("should pass description to reverse swap when creating Lightning invoice", async () => {
                // arrange
                const testDescription = "Test payment description";
                const pendingSwap: PendingReverseSwap = {
                    ...mockReverseSwap,
                    request: {
                        ...createReverseSwapRequest,
                        description: testDescription,
                    },
                };
                const createReverseSwapSpy = vi
                    .spyOn(swaps, "createReverseSwap")
                    .mockResolvedValueOnce(pendingSwap);

                // act
                await swaps.createLightningInvoice({
                    amount: mock.amount,
                    description: testDescription,
                });

                // assert
                expect(createReverseSwapSpy).toHaveBeenCalledWith({
                    amount: mock.amount,
                    description: testDescription,
                });
            });
        });

        describe("Reverse Swaps", () => {
            it("should create a reverse swap", async () => {
                // arrange
                vi.spyOn(
                    swapProvider,
                    "createReverseSwap"
                ).mockResolvedValueOnce(createReverseSwapResponse);

                // act
                const pendingSwap = await swaps.createReverseSwap({
                    amount: mock.invoice.amount,
                });

                // assert
                expect(pendingSwap.request.invoiceAmount).toBe(
                    mock.invoice.amount
                );
                expect(pendingSwap.request.preimageHash).toHaveLength(64);
                expect(pendingSwap.response.invoice).toBe(mock.invoice.address);
                expect(pendingSwap.response.lockupAddress).toBe(
                    mock.lockupAddress
                );
                expect(pendingSwap.response.onchainAmount).toBe(
                    mock.invoice.amount
                );
                expect(pendingSwap.response.refundPublicKey).toBe(
                    compressedPubkeys.boltz
                );
                expect(pendingSwap.status).toEqual("swap.created");
            });

            it("should get correct swap status", async () => {
                // arrange
                vi.spyOn(
                    swapProvider,
                    "createReverseSwap"
                ).mockResolvedValueOnce(createReverseSwapResponse);
                vi.spyOn(swapProvider, "getSwapStatus").mockResolvedValueOnce({
                    status: "swap.created",
                });

                // act
                const pendingSwap = await swaps.createReverseSwap({
                    amount: mock.invoice.amount,
                });

                // assert
                expect(swaps.getSwapStatus).toBeInstanceOf(Function);
                const status = await swaps.getSwapStatus(pendingSwap.id);
                expect(status.status).toBe("swap.created");
            });

            it("should pass description to swap provider when creating reverse swap", async () => {
                // arrange
                const testDescription = "Test reverse swap description";
                const createReverseSwapSpy = vi
                    .spyOn(swapProvider, "createReverseSwap")
                    .mockResolvedValueOnce(createReverseSwapResponse);

                // act
                await swaps.createReverseSwap({
                    amount: mock.invoice.amount,
                    description: testDescription,
                });

                // assert
                expect(createReverseSwapSpy).toHaveBeenCalledWith({
                    invoiceAmount: mock.invoice.amount,
                    claimPublicKey: expect.any(String),
                    preimageHash: expect.any(String),
                    description: testDescription,
                });
            });
        });

        describe("VHTLC Operations", () => {
            const preimage = randomBytes(20);
            const mockVHTLC = {
                vhtlcAddress: mock.address.ark,
                vhtlcScript: new VHTLC.Script({
                    preimageHash: ripemd160(sha256(preimage)),
                    sender: mock.pubkeys.alice,
                    receiver: mock.pubkeys.boltz,
                    server: mock.pubkeys.server,
                    refundLocktime: BigInt(17),
                    unilateralClaimDelay: {
                        type: "blocks",
                        value: BigInt(21),
                    },
                    unilateralRefundDelay: {
                        type: "blocks",
                        value: BigInt(42),
                    },
                    unilateralRefundWithoutReceiverDelay: {
                        type: "blocks",
                        value: BigInt(63),
                    },
                }),
            };
            it("should claim a VHTLC", async () => {
                // arrange
                const pendingSwap: PendingReverseSwap = {
                    id: mock.id,
                    type: "reverse",
                    createdAt: Date.now(),
                    preimage: hex.encode(preimage),
                    request: createReverseSwapRequest,
                    response: createReverseSwapResponse,
                    status: "swap.created",
                };
                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );
                vi.spyOn(swaps, "createVHTLCScript").mockReturnValueOnce(
                    mockVHTLC
                );
                vi.spyOn(indexerProvider, "getVtxos").mockResolvedValueOnce({
                    vtxos: [],
                });
                vi.spyOn(arkProvider, "submitTx").mockResolvedValueOnce({
                    arkTxid: "",
                    finalArkTx: "",
                    signedCheckpointTxs: [],
                });
                vi.spyOn(arkProvider, "finalizeTx").mockResolvedValueOnce();
                await expect(swaps.claimVHTLC(pendingSwap)).rejects.toThrow(
                    "Boltz is trying to scam us"
                );
            });
        });

        describe("waitAndClaim", () => {
            it("should return valid txid when transaction is available", async () => {
                // arrange
                const pendingSwap = mockReverseSwap;

                // Mock getSwapStatus to return a status with valid transaction
                vi.spyOn(swapProvider, "getSwapStatus").mockResolvedValue({
                    status: "invoice.settled",
                });

                // Mock getReverseSwapTxId to return an object with valid transaction id
                vi.spyOn(swapProvider, "getReverseSwapTxId").mockResolvedValue({
                    id: mock.txid,
                    timeoutBlockHeight: 123,
                });

                // Mock monitorSwap to directly trigger the invoice.settled case
                vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                    async (swapId, update) => {
                        setTimeout(() => update("invoice.settled"), 10);
                    }
                );

                // act
                const result = await swaps.waitAndClaim(pendingSwap);

                // assert
                expect(result.txid).toBe(mock.txid);
                expect(result.txid).not.toBe("");
            });

            it("should throw error when transaction id is empty string", async () => {
                // arrange
                const pendingSwap = mockReverseSwap;

                // Mock getSwapStatus to return a status with empty transaction id
                vi.spyOn(swapProvider, "getSwapStatus").mockResolvedValue({
                    status: "invoice.settled",
                    transaction: {
                        id: "",
                        hex: mock.hex,
                    },
                });

                // Mock getReverseSwapTxId to return a undefined id (the problematic case)
                vi.spyOn(swapProvider, "getReverseSwapTxId").mockResolvedValue({
                    id: "",
                    timeoutBlockHeight: 123,
                });

                // Mock monitorSwap to directly trigger the invoice.settled case
                vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                    async (swapId, update) => {
                        setTimeout(() => update("invoice.settled"), 10);
                    }
                );

                // act & assert
                await expect(swaps.waitAndClaim(pendingSwap)).rejects.toThrow(
                    "Transaction ID not available for settled swap"
                );
            });
        });
    });

    describe("Send to Lightning", () => {
        describe("Submarine Swaps", () => {
            it("should create a submarine swap", async () => {
                // arrange
                vi.spyOn(
                    swapProvider,
                    "createSubmarineSwap"
                ).mockResolvedValueOnce(createSubmarineSwapResponse);

                // act
                const pendingSwap = await swaps.createSubmarineSwap({
                    invoice: mock.invoice.address,
                });

                // assert
                expect(pendingSwap.status).toEqual("invoice.set");
                expect(pendingSwap.request).toEqual(createSubmarineSwapRequest);
                expect(pendingSwap.response).toEqual(
                    createSubmarineSwapResponse
                );
            });

            it("should get correct swap status", async () => {
                // arrange
                vi.spyOn(
                    swapProvider,
                    "createSubmarineSwap"
                ).mockResolvedValueOnce(createSubmarineSwapResponse);
                vi.spyOn(swapProvider, "getSwapStatus").mockResolvedValueOnce({
                    status: "swap.created",
                });

                // act
                const pendingSwap = await swaps.createSubmarineSwap({
                    invoice: mock.invoice.address,
                });

                // assert
                expect(swaps.getSwapStatus).toBeInstanceOf(Function);
                const status = await swaps.getSwapStatus(pendingSwap.id);
                expect(status.status).toBe("swap.created");
            });
        });

        describe("Sending Lightning Payments", () => {
            it("should send a Lightning payment", async () => {
                // arrange
                const pendingSwap = mockSubmarineSwap;
                vi.spyOn(wallet, "sendBitcoin").mockResolvedValueOnce(
                    mock.txid
                );
                vi.spyOn(swaps, "createSubmarineSwap").mockResolvedValueOnce(
                    pendingSwap
                );
                vi.spyOn(swaps, "waitForSwapSettlement").mockResolvedValueOnce({
                    preimage: mock.preimage,
                });
                // act
                const result = await swaps.sendLightningPayment({
                    invoice: mock.invoice.address,
                });
                // assert
                expect(wallet.sendBitcoin).toHaveBeenCalledWith({
                    address: mock.address.ark,
                    amount: mock.invoice.amount,
                });
                expect(result.amount).toBe(mock.invoice.amount);
                expect(result.preimage).toBe(mock.preimage);
                expect(result.txid).toBe(mock.txid);
            });
        });

        describe("Decoding lightning invoices", () => {
            it("should decode a lightning invoice", async () => {
                // act
                const decoded = decodeInvoice(mock.invoice.address);
                // assert
                expect(decoded.expiry).toBe(mock.invoice.expiry);
                expect(decoded.amountSats).toBe(mock.invoice.amount);
                expect(decoded.description).toBe(mock.invoice.description);
                expect(decoded.paymentHash).toBe(mock.invoice.paymentHash);
            });

            it("should throw on invalid Lightning invoice", async () => {
                // act
                const invoice = "lntb30m1invalid";
                // assert
                expect(() => decodeInvoice(invoice)).toThrow();
            });
        });
    });

    describe("Ark to BTC Chain Swaps", () => {
        describe("arkToBtc", () => {
            it("should throw if amount is not > 0", async () => {
                // act & assert
                await expect(
                    swaps.arkToBtc({
                        btcAddress: mock.address.btc,
                        senderLockAmount: 0,
                    })
                ).rejects.toThrow("Invalid lock amount");
                await expect(
                    swaps.arkToBtc({
                        btcAddress: mock.address.btc,
                        senderLockAmount: -1,
                    })
                ).rejects.toThrow("Invalid lock amount");
            });

            it("should throw if toAddress is empty", async () => {
                // act & assert
                await expect(
                    swaps.arkToBtc({
                        btcAddress: "",
                        senderLockAmount: mock.amount,
                    })
                ).rejects.toThrow("Destination address is required");
            });
        });

        describe("claimBtc", () => {
            it("should throw error when toAddress is missing", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockArkBtcChainSwap,
                    toAddress: undefined,
                };

                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );

                // act & assert
                await expect(swaps.claimBtc(pendingSwap)).rejects.toThrow(
                    "Destination address is required"
                );
            });

            it("should throw error when swap tree in claim details is missing", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockArkBtcChainSwap,
                    response: {
                        ...mockArkBtcChainSwap.response,
                        claimDetails: {
                            ...mockArkBtcChainSwap.response.claimDetails,
                            swapTree: undefined,
                        },
                    },
                };

                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );

                // act & assert
                await expect(swaps.claimBtc(pendingSwap)).rejects.toThrow(
                    "Missing swap tree in claim details"
                );
            });

            it("should throw error when server public key in claim details is missing", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockArkBtcChainSwap,
                    response: {
                        ...mockArkBtcChainSwap.response,
                        claimDetails: {
                            ...mockArkBtcChainSwap.response.claimDetails,
                            serverPublicKey: "",
                        },
                    },
                };

                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );

                // act & assert
                await expect(swaps.claimBtc(pendingSwap)).rejects.toThrow(
                    "Missing server public key in claim details"
                );
            });
        });

        describe("createChainSwap", () => {
            it("should create a chain swap from Ark to Btc", async () => {
                // arrange
                vi.spyOn(swapProvider, "createChainSwap").mockResolvedValueOnce(
                    createArkBtcChainSwapResponse
                );

                // act
                const pendingSwap = await swaps.createChainSwap({
                    to: "BTC",
                    from: "ARK",
                    feeSatsPerByte: 1,
                    senderLockAmount: mock.amount,
                    toAddress: mock.address.btc,
                });

                // assert
                expect(pendingSwap.request.from).toBe("ARK");
                expect(pendingSwap.request.to).toBe("BTC");
                expect(pendingSwap.request.userLockAmount).toBe(mock.amount);
                expect(pendingSwap.request.preimageHash).toHaveLength(64);
                expect(pendingSwap.response.id).toBe(mock.id);
                expect(pendingSwap.response.lockupDetails.lockupAddress).toBe(
                    mock.address.ark
                );
                expect(pendingSwap.status).toEqual("swap.created");
                expect(pendingSwap.toAddress).toBe(mock.address.btc);
            });
        });

        describe("createVHTLCScript", () => {
            it("should create a VHTLC script for Ark to Btc", () => {
                // act
                const { vhtlcScript, vhtlcAddress } = swaps.createVHTLCScript({
                    network: "regtest",
                    preimageHash: mockPreimageHash,
                    receiverPubkey: compressedPubkeys.boltz,
                    senderPubkey: compressedPubkeys.alice,
                    serverPubkey: hex.encode(mock.pubkeys.server),
                    timeoutBlockHeights: {
                        refund: 17,
                        unilateralClaim: 21,
                        unilateralRefund: 42,
                        unilateralRefundWithoutReceiver: 63,
                    },
                });

                // assert
                expect(vhtlcScript).toBeDefined();
                expect(vhtlcScript.pkScript).toBeDefined();
                expect(vhtlcAddress).toBeDefined();
                expect(vhtlcAddress).toContain("tark");
            });
        });

        describe("getFees (chain)", () => {
            it("should get fees for Ark to Btc chain swap", async () => {
                // arrange
                const mockFees: ChainFeesResponse = {
                    minerFees: {
                        server: 50,
                        user: {
                            claim: 21,
                            lockup: 30,
                        },
                    },
                    percentage: 0.5,
                };
                vi.spyOn(swapProvider, "getChainFees").mockResolvedValueOnce(
                    mockFees
                );

                // act
                const fees = await swaps.getFees("ARK", "BTC");

                // assert
                expect(fees).toEqual(mockFees);
                expect(swapProvider.getChainFees).toHaveBeenCalledWith(
                    "ARK",
                    "BTC"
                );
            });
        });

        describe("getLimits (chain)", () => {
            it("should get limits for Ark to Btc chain swap", async () => {
                // arrange
                const mockLimits: LimitsResponse = {
                    min: 10000,
                    max: 1000000,
                };
                vi.spyOn(swapProvider, "getChainLimits").mockResolvedValueOnce(
                    mockLimits
                );

                // act
                const limits = await swaps.getLimits("ARK", "BTC");

                // assert
                expect(limits).toEqual(mockLimits);
                expect(swapProvider.getChainLimits).toHaveBeenCalledWith(
                    "ARK",
                    "BTC"
                );
            });
        });

        describe("getSwapStatus", () => {
            it("should get correct swap status", async () => {
                // arrange
                vi.spyOn(swapProvider, "getSwapStatus").mockResolvedValueOnce({
                    status: "swap.created",
                });

                // act
                const status = await swaps.getSwapStatus(mock.id);

                // assert
                expect(status.status).toBe("swap.created");
            });
        });

        describe("quoteSwap", () => {
            it("should quote a chain swap", async () => {
                // arrange
                vi.spyOn(swapProvider, "getChainQuote").mockResolvedValueOnce({
                    amount: mock.amount,
                });
                vi.spyOn(swapProvider, "postChainQuote").mockResolvedValueOnce(
                    {}
                );

                // act
                const amount = await swaps.quoteSwap(mock.id);

                // assert
                expect(amount).toEqual(mock.amount);
            });
        });

        describe("verifyChainSwap", () => {
            it("should verify a chain swap successfully", async () => {
                // arrange
                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );
                vi.spyOn(swaps, "createVHTLCScript").mockReturnValueOnce({
                    vhtlcScript: {} as any,
                    vhtlcAddress: mock.address.ark,
                });

                const pendingSwap: PendingChainSwap = {
                    ...mockArkBtcChainSwap,
                    response: createArkBtcChainSwapResponse,
                };

                // act & assert
                await expect(
                    swaps.verifyChainSwap({
                        to: "BTC",
                        from: "ARK",
                        swap: pendingSwap,
                        arkInfo: mockArkInfo,
                    })
                ).resolves.toBe(true);
            });

            it("should throw error if lockup address doesn't match", async () => {
                // arrange
                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );
                vi.spyOn(swaps, "createVHTLCScript").mockReturnValueOnce({
                    vhtlcScript: {} as any,
                    vhtlcAddress: "different-address",
                });

                const pendingSwap: PendingChainSwap = {
                    ...mockArkBtcChainSwap,
                    response: createArkBtcChainSwapResponse,
                };

                // act & assert
                await expect(
                    swaps.verifyChainSwap({
                        to: "BTC",
                        from: "ARK",
                        swap: pendingSwap,
                        arkInfo: mockArkInfo,
                    })
                ).rejects.toThrow(
                    "Boltz is trying to scam us (invalid address)"
                );
            });
        });

        describe("waitAndClaimBtc", () => {
            it("should resolve with txid when transaction is claimed", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockArkBtcChainSwap,
                };
                vi.spyOn(swaps, "claimBtc").mockResolvedValue();
                vi.spyOn(swapProvider, "getSwapStatus").mockResolvedValueOnce({
                    status: "transaction.claimed",
                    transaction: { id: mock.id, hex: mock.hex },
                });
                vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                    async (_id, callback) => {
                        // Simulate status updates
                        setTimeout(
                            () => callback("transaction.server.mempool", {}),
                            10
                        );
                        setTimeout(
                            () => callback("transaction.claimed", {}),
                            20
                        );
                    }
                );

                // act
                const resultPromise = swaps.waitAndClaimBtc(pendingSwap);

                // assert
                await expect(resultPromise).resolves.toEqual({ txid: mock.id });
            });

            it("should reject with SwapExpiredError when swap expires", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockArkBtcChainSwap,
                };
                vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                    async (_id, callback) => {
                        // Simulate swap expiration
                        setTimeout(() => callback("swap.expired", {}), 10);
                    }
                );

                // act
                const resultPromise = swaps.waitAndClaimBtc(pendingSwap);

                // assert
                await expect(resultPromise).rejects.toThrow(
                    "The swap has expired"
                );
            });

            it("should reject with TransactionFailedError when transaction fails", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockArkBtcChainSwap,
                };
                vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                    async (_id, callback) => {
                        // Simulate transaction failure
                        setTimeout(
                            () => callback("transaction.failed", {}),
                            10
                        );
                    }
                );

                // act
                const resultPromise = swaps.waitAndClaimBtc(pendingSwap);

                // assert
                await expect(resultPromise).rejects.toThrow(
                    "Error during swap."
                );
            });

            it("should reject with TransactionRefundedError when transaction is refunded", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockArkBtcChainSwap,
                };
                vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                    async (_id, callback) => {
                        // Simulate transaction refund
                        setTimeout(
                            () => callback("transaction.refunded", {}),
                            10
                        );
                    }
                );

                // act
                const resultPromise = swaps.waitAndClaimBtc(pendingSwap);

                // assert
                await expect(resultPromise).rejects.toThrow(
                    "The transaction has been refunded."
                );
            });
        });
    });

    describe("BTC to Ark Chain Swaps", () => {
        describe("btcToArk", () => {
            it("should throw if amount is 0", async () => {
                // act & assert
                await expect(
                    swaps.btcToArk({
                        senderLockAmount: 0,
                    })
                ).rejects.toThrow("Invalid lock amount");
            });

            it("should throw if amount is < 0", async () => {
                // act & assert
                await expect(
                    swaps.btcToArk({
                        senderLockAmount: -1,
                    })
                ).rejects.toThrow("Invalid lock amount");
            });

            it("should return address and amount", async () => {
                // arrange
                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );
                vi.spyOn(swapProvider, "createChainSwap").mockResolvedValueOnce(
                    createBtcArkChainSwapResponse
                );
                vi.spyOn(swaps, "verifyChainSwap").mockResolvedValueOnce(true);
                vi.spyOn(swaps, "waitAndClaimArk").mockResolvedValueOnce({
                    txid: mock.txid,
                });
                vi.spyOn(swaps, "getSwapStatus").mockResolvedValueOnce({
                    status: "transaction.claimed",
                });

                // act
                const result = await swaps.btcToArk({
                    senderLockAmount: mock.amount,
                });

                // assert
                expect(result).toHaveProperty("btcAddress", mock.address.btc);
            });
        });

        describe("claimArk", () => {
            it("should throw error when toAddress is missing", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockBtcArkChainSwap,
                    toAddress: undefined,
                };

                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );

                // act & assert
                await expect(swaps.claimArk(pendingSwap)).rejects.toThrow(
                    "Destination address is required"
                );
            });

            it("should throw error when timeouts in claim details is missing", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockBtcArkChainSwap,
                    response: {
                        ...mockBtcArkChainSwap.response,
                        claimDetails: {
                            ...mockBtcArkChainSwap.response.claimDetails,
                            timeouts: undefined,
                        },
                    },
                };

                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );

                // act & assert
                await expect(swaps.claimArk(pendingSwap)).rejects.toThrow(
                    "Missing timeouts in claim details"
                );
            });

            it("should throw error when server public key in claim details is missing", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockBtcArkChainSwap,
                    response: {
                        ...mockBtcArkChainSwap.response,
                        claimDetails: {
                            ...mockBtcArkChainSwap.response.claimDetails,
                            serverPublicKey: "",
                        },
                    },
                };

                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );

                // act & assert
                await expect(swaps.claimArk(pendingSwap)).rejects.toThrow(
                    "Missing server public key in claim details"
                );
            });

            it("should throw error when no spendable VTXOs found", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockBtcArkChainSwap,
                    preimage: hex.encode(mockPreimage),
                };
                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );
                vi.spyOn(swaps, "createVHTLCScript").mockReturnValueOnce(
                    mockBtcArkVHTLC
                );
                vi.spyOn(indexerProvider, "getVtxos").mockResolvedValueOnce({
                    vtxos: [],
                });

                // act & assert
                await expect(swaps.claimArk(pendingSwap)).rejects.toThrow(
                    "No spendable virtual coins found"
                );
            });
        });

        describe("createChainSwap", () => {
            it("should create a chain swap from Btc to Ark", async () => {
                // arrange
                const btcToArkResponse = {
                    ...createBtcArkChainSwapResponse,
                    lockupDetails: {
                        ...createBtcArkChainSwapResponse.lockupDetails,
                        lockupAddress: "bc1q-mock-btc-address",
                    },
                };
                vi.spyOn(swapProvider, "createChainSwap").mockResolvedValueOnce(
                    btcToArkResponse
                );

                // act
                const pendingSwap = await swaps.createChainSwap({
                    to: "ARK",
                    from: "BTC",
                    feeSatsPerByte: 1,
                    senderLockAmount: mock.amount,
                    toAddress: mock.address.ark,
                });

                // assert
                expect(pendingSwap.request.to).toBe("ARK");
                expect(pendingSwap.request.from).toBe("BTC");
                expect(pendingSwap.request.userLockAmount).toBe(mock.amount);
                expect(pendingSwap.response.lockupDetails.lockupAddress).toBe(
                    "bc1q-mock-btc-address"
                );
            });
        });

        describe("createVHTLCScript", () => {
            it("should create a VHTLC script for Btc to Ark", () => {
                // act
                const { vhtlcScript, vhtlcAddress } = swaps.createVHTLCScript({
                    network: "regtest",
                    preimageHash: mockPreimageHash,
                    receiverPubkey: compressedPubkeys.alice,
                    senderPubkey: compressedPubkeys.boltz,
                    serverPubkey: hex.encode(mock.pubkeys.server),
                    timeoutBlockHeights: {
                        refund: 17,
                        unilateralClaim: 21,
                        unilateralRefund: 42,
                        unilateralRefundWithoutReceiver: 63,
                    },
                });

                // assert
                expect(vhtlcScript).toBeDefined();
                expect(vhtlcScript.pkScript).toBeDefined();
                expect(vhtlcAddress).toBeDefined();
                expect(vhtlcAddress).toContain("tark");
            });
        });

        describe("getFees (chain)", () => {
            it("should get fees for Btc to Ark chain swap", async () => {
                // arrange
                const mockFees: ChainFeesResponse = {
                    minerFees: {
                        server: 50,
                        user: {
                            claim: 21,
                            lockup: 30,
                        },
                    },
                    percentage: 0.5,
                };
                vi.spyOn(swapProvider, "getChainFees").mockResolvedValueOnce(
                    mockFees
                );

                // act
                const fees = await swaps.getFees("BTC", "ARK");

                // assert
                expect(fees).toEqual(mockFees);
                expect(swapProvider.getChainFees).toHaveBeenCalledWith(
                    "BTC",
                    "ARK"
                );
            });
        });

        describe("getLimits (chain)", () => {
            it("should get limits for Btc to Ark chain swap", async () => {
                // arrange
                const mockLimits: LimitsResponse = {
                    min: 10000,
                    max: 1000000,
                };
                vi.spyOn(swapProvider, "getChainLimits").mockResolvedValueOnce(
                    mockLimits
                );

                // act
                const limits = await swaps.getLimits("BTC", "ARK");

                // assert
                expect(limits).toEqual(mockLimits);
                expect(swapProvider.getChainLimits).toHaveBeenCalledWith(
                    "BTC",
                    "ARK"
                );
            });
        });

        describe("quoteSwap", () => {
            it("should quote a chain swap", async () => {
                // arrange
                vi.spyOn(swapProvider, "getChainQuote").mockResolvedValueOnce({
                    amount: mock.amount,
                });
                vi.spyOn(swapProvider, "postChainQuote").mockResolvedValueOnce(
                    {}
                );

                // act
                const amount = await swaps.quoteSwap(mock.id);

                // assert
                expect(amount).toEqual(mock.amount);
            });
        });

        describe("verifyChainSwap", () => {
            it("should verify a chain swap successfully", async () => {
                // arrange
                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );
                vi.spyOn(swaps, "createVHTLCScript").mockReturnValueOnce({
                    vhtlcScript: {} as any,
                    vhtlcAddress: mock.address.ark,
                });

                const pendingSwap: PendingChainSwap = {
                    ...mockBtcArkChainSwap,
                    response: createBtcArkChainSwapResponse,
                };

                // act & assert
                await expect(
                    swaps.verifyChainSwap({
                        to: "ARK",
                        from: "BTC",
                        swap: pendingSwap,
                        arkInfo: mockArkInfo,
                    })
                ).resolves.toBe(true);
            });

            it("should throw error if claim address doesn't match", async () => {
                // arrange
                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );
                vi.spyOn(swaps, "createVHTLCScript").mockReturnValueOnce({
                    vhtlcScript: {} as any,
                    vhtlcAddress: mock.address.ark + "...",
                });

                const pendingSwap: PendingChainSwap = {
                    ...mockBtcArkChainSwap,
                    response: createBtcArkChainSwapResponse,
                };

                // act & assert
                await expect(
                    swaps.verifyChainSwap({
                        to: "ARK",
                        from: "BTC",
                        swap: pendingSwap,
                        arkInfo: mockArkInfo,
                    })
                ).rejects.toThrow(
                    "Boltz is trying to scam us (invalid address)"
                );
            });
        });

        describe("waitAndClaimArk", () => {
            it("should resolve with txid when transaction is claimed", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockBtcArkChainSwap,
                };
                vi.spyOn(swaps, "claimArk").mockResolvedValue();
                vi.spyOn(swapProvider, "getSwapStatus").mockResolvedValueOnce({
                    status: "transaction.claimed",
                    transaction: { id: mock.id, hex: mock.hex },
                });
                vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                    async (_id, callback) => {
                        // Simulate status updates
                        setTimeout(
                            () => callback("transaction.server.mempool", {}),
                            10
                        );
                        setTimeout(
                            () => callback("transaction.claimed", {}),
                            20
                        );
                    }
                );

                // act
                const resultPromise = swaps.waitAndClaimArk(pendingSwap);

                // assert
                await expect(resultPromise).resolves.toEqual({ txid: mock.id });
            });

            it("should reject with SwapExpiredError when swap expires", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockBtcArkChainSwap,
                };
                vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                    async (_id, callback) => {
                        // Simulate swap expiration
                        setTimeout(() => callback("swap.expired", {}), 10);
                    }
                );

                // act
                const resultPromise = swaps.waitAndClaimArk(pendingSwap);

                // assert
                await expect(resultPromise).rejects.toThrow(
                    "The swap has expired"
                );
            });

            it("should reject with TransactionFailedError when transaction fails", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockBtcArkChainSwap,
                };
                vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                    async (_id, callback) => {
                        // Simulate transaction failure
                        setTimeout(
                            () => callback("transaction.failed", {}),
                            10
                        );
                    }
                );

                // act
                const resultPromise = swaps.waitAndClaimArk(pendingSwap);

                // assert
                await expect(resultPromise).rejects.toThrow(
                    "Error during swap."
                );
            });

            it("should reject with TransactionRefundedError when transaction is refunded", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockBtcArkChainSwap,
                };
                vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                    async (_id, callback) => {
                        // Simulate transaction refund
                        setTimeout(
                            () => callback("transaction.refunded", {}),
                            10
                        );
                    }
                );

                // act
                const resultPromise = swaps.waitAndClaimArk(pendingSwap);

                // assert
                await expect(resultPromise).rejects.toThrow(
                    "The transaction has been refunded."
                );
            });
        });
    });

    describe("Swap Storage and History", () => {
        beforeEach(() => {
            // Mock the swap repository methods
            mockSwapRepository.saveSwap.mockResolvedValue();
            mockSwapRepository.getAllSwaps.mockImplementation(
                async (filter: any) => {
                    if (filter?.type === "reverse") {
                        return [];
                    }
                    if (filter?.type === "submarine") {
                        return [];
                    }
                    if (filter?.type === "chain") {
                        return [];
                    }
                    return [];
                }
            );
        });

        describe("getPendingReverseSwaps", () => {
            it("should return empty array when no reverse swaps exist", async () => {
                // act
                const result = await swaps.getPendingReverseSwaps();

                // assert
                expect(result).toEqual([]);
                expect(mockSwapRepository.getAllSwaps).toHaveBeenCalledWith({
                    type: "reverse",
                });
            });

            it("should return only reverse swaps with swap.created status", async () => {
                // arrange
                const mockReverseSwaps: PendingReverseSwap[] = [
                    {
                        ...mockReverseSwap,
                        id: "swap1",
                        status: "swap.created",
                    },
                    {
                        ...mockReverseSwap,
                        id: "swap2",
                        status: "invoice.settled",
                    },
                    {
                        ...mockReverseSwap,
                        id: "swap3",
                        status: "swap.created",
                    },
                ];

                mockSwapRepository.getAllSwaps.mockImplementation(
                    async (filter: any) => {
                        if (filter?.type === "reverse") {
                            return mockReverseSwaps;
                        }
                        return [];
                    }
                );

                // act
                const result = await swaps.getPendingReverseSwaps();

                // assert
                expect(result).toHaveLength(2);
                expect(result[0].id).toBe("swap1");
                expect(result[1].id).toBe("swap3");
                expect(
                    result.every((swap) => swap.status === "swap.created")
                ).toBe(true);
            });
        });

        describe("getPendingSubmarineSwaps", () => {
            it("should return empty array when no submarine swaps exist", async () => {
                // act
                const result = await swaps.getPendingSubmarineSwaps();

                // assert
                expect(result).toEqual([]);
                expect(mockSwapRepository.getAllSwaps).toHaveBeenCalledWith({
                    type: "submarine",
                });
            });

            it("should return only submarine swaps with invoice.set status", async () => {
                // arrange
                const mockSubmarineSwaps: PendingSubmarineSwap[] = [
                    {
                        ...mockSubmarineSwap,
                        id: "swap1",
                        status: "invoice.set",
                    },
                    {
                        ...mockSubmarineSwap,
                        id: "swap2",
                    },
                    {
                        ...mockSubmarineSwap,
                        id: "swap3",
                        status: "invoice.set",
                    },
                ];

                mockSwapRepository.getAllSwaps.mockImplementation(
                    async (filter: any) => {
                        if (filter?.type === "submarine") {
                            return mockSubmarineSwaps;
                        }
                        return [];
                    }
                );

                // act
                const result = await swaps.getPendingSubmarineSwaps();

                // assert
                expect(result).toHaveLength(2);
                expect(result[0].id).toBe("swap1");
                expect(result[1].id).toBe("swap3");
                expect(
                    result.every((swap) => swap.status === "invoice.set")
                ).toBe(true);
            });
        });

        describe("getPendingChainSwaps", () => {
            it("should return empty array when no chain swaps exist", async () => {
                // act
                const result = await swaps.getPendingChainSwaps();

                // assert
                expect(result).toEqual([]);
                expect(mockSwapRepository.getAllSwaps).toHaveBeenCalledWith({
                    type: "chain",
                });
            });

            it("should return only chain swaps with swap.created status", async () => {
                // arrange
                const mockChainSwaps: PendingChainSwap[] = [
                    {
                        ...mockArkBtcChainSwap,
                        id: "swap1",
                        status: "swap.created",
                    },
                    {
                        ...mockArkBtcChainSwap,
                        id: "swap2",
                        status: "transaction.claimed",
                    },
                    {
                        ...mockArkBtcChainSwap,
                        id: "swap3",
                        status: "swap.created",
                    },
                ];

                mockSwapRepository.getAllSwaps.mockImplementation(
                    async (filter: any) => {
                        if (filter?.type === "chain") {
                            return mockChainSwaps;
                        }
                        return [];
                    }
                );

                // act
                const result = await swaps.getPendingChainSwaps();

                // assert
                expect(result).toHaveLength(2);
                expect(result[0].id).toBe("swap1");
                expect(result[1].id).toBe("swap3");
                expect(
                    result.every((swap) => swap.status === "swap.created")
                ).toBe(true);
            });
        });

        describe("getSwapHistory", () => {
            it("should return empty array when no swaps exist", async () => {
                // act
                const result = await swaps.getSwapHistory();

                // assert
                expect(result).toEqual([]);
                expect(mockSwapRepository.getAllSwaps).toHaveBeenCalledWith({
                    type: "reverse",
                });
                expect(mockSwapRepository.getAllSwaps).toHaveBeenCalledWith({
                    type: "submarine",
                });
                expect(mockSwapRepository.getAllSwaps).toHaveBeenCalledWith({
                    type: "chain",
                });
            });

            it("should return all swaps sorted by creation date (newest first)", async () => {
                // arrange
                const now = Date.now();
                const mockReverseSwaps: PendingReverseSwap[] = [
                    {
                        ...mockReverseSwap,
                        id: "reverse1",
                        createdAt: now - 3000, // oldest
                    },
                    {
                        ...mockReverseSwap,
                        id: "reverse2",
                        createdAt: now - 1000,
                        status: "invoice.settled",
                    },
                ];

                const mockSubmarineSwaps: PendingSubmarineSwap[] = [
                    {
                        ...mockSubmarineSwap,
                        id: "submarine1",
                        createdAt: now - 2000,
                        status: "invoice.set",
                    },
                    {
                        ...mockSubmarineSwap,
                        id: "submarine2",
                        createdAt: now, // newest overall
                        status: "swap.created",
                    },
                ];

                const mockChainSwaps: PendingChainSwap[] = [
                    {
                        ...mockArkBtcChainSwap,
                        id: "chain1",
                        createdAt: now - 500,
                    },
                ];

                mockSwapRepository.getAllSwaps.mockImplementation(
                    async (filter: any) => {
                        if (filter?.type === "reverse") {
                            return mockReverseSwaps;
                        }
                        if (filter?.type === "submarine") {
                            return mockSubmarineSwaps;
                        }
                        if (filter?.type === "chain") {
                            return mockChainSwaps;
                        }
                        return [];
                    }
                );

                // act
                const result = await swaps.getSwapHistory();

                // assert
                expect(result).toHaveLength(5);
                // Should be sorted by createdAt desc (newest first)
                expect(result[0].id).toBe("submarine2"); // newest
                expect(result[1].id).toBe("chain1");
                expect(result[2].id).toBe("reverse2");
                expect(result[3].id).toBe("submarine1");
                expect(result[4].id).toBe("reverse1"); // oldest

                // Verify the sort order
                for (let i = 0; i < result.length - 1; i++) {
                    expect(result[i].createdAt).toBeGreaterThanOrEqual(
                        result[i + 1].createdAt
                    );
                }
            });

            it("should handle mixed swap types and statuses correctly", async () => {
                // arrange
                const now = Date.now();
                const mockReverseSwaps: PendingReverseSwap[] = [
                    {
                        ...mockReverseSwap,
                        createdAt: now - 1000,
                        preimage: "preimage1",
                        response: {
                            ...createReverseSwapResponse,
                            id: "reverse1",
                        },
                        status: "transaction.confirmed",
                    },
                ];

                const mockSubmarineSwaps: PendingSubmarineSwap[] = [
                    {
                        ...mockSubmarineSwap,
                        createdAt: now,
                        response: {
                            ...createSubmarineSwapResponse,
                            id: "submarine1",
                        },
                        status: "transaction.failed",
                    },
                ];

                mockSwapRepository.getAllSwaps.mockImplementation(
                    async (filter: any) => {
                        if (filter?.type === "reverse") {
                            return mockReverseSwaps;
                        }
                        if (filter?.type === "submarine") {
                            return mockSubmarineSwaps;
                        }
                        return [];
                    }
                );

                // act
                const result = await swaps.getSwapHistory();

                // assert
                expect(result).toHaveLength(2);
                expect(result[0].type).toBe("submarine");
                expect(result[1].type).toBe("reverse");
            });
        });

        describe("swap persistence during operations", () => {
            it("should save reverse swap when creating lightning invoice", async () => {
                // arrange
                vi.spyOn(swaps, "createReverseSwap").mockResolvedValueOnce(
                    mockReverseSwap
                );

                // act
                await swaps.createLightningInvoice({ amount: mock.amount });

                // assert
                expect(swaps.createReverseSwap).toHaveBeenCalledWith({
                    amount: mock.amount,
                });
            });

            it("should save submarine swap when creating swap", async () => {
                // arrange
                vi.spyOn(
                    swapProvider,
                    "createSubmarineSwap"
                ).mockResolvedValueOnce(createSubmarineSwapResponse);

                // act
                const result = await swaps.createSubmarineSwap({
                    invoice: mock.invoice.address,
                });

                // assert
                expect(mockSwapRepository.saveSwap).toHaveBeenCalledWith(
                    expect.objectContaining({
                        type: "submarine",
                        status: "invoice.set",
                        request: expect.objectContaining({
                            invoice: mock.invoice.address,
                        }),
                        response: createSubmarineSwapResponse,
                    })
                );
                expect(result.type).toBe("submarine");
                expect(result.status).toBe("invoice.set");
            });

            it("should save reverse swap when creating reverse swap", async () => {
                // arrange
                vi.spyOn(
                    swapProvider,
                    "createReverseSwap"
                ).mockResolvedValueOnce(createReverseSwapResponse);

                // act
                const result = await swaps.createReverseSwap({
                    amount: mock.invoice.amount,
                });

                // assert
                expect(mockSwapRepository.saveSwap).toHaveBeenCalledWith(
                    expect.objectContaining({
                        type: "reverse",
                        status: "swap.created",
                        request: expect.objectContaining({
                            invoiceAmount: mock.invoice.amount,
                        }),
                        response: createReverseSwapResponse,
                    })
                );
                expect(result.type).toBe("reverse");
                expect(result.status).toBe("swap.created");
            });
        });

        describe("refreshSwapsStatus", () => {
            it("should refresh status of all non-final chain swaps", async () => {
                // arrange
                const mockChainSwaps: PendingChainSwap[] = [
                    {
                        ...mockBtcArkChainSwap,
                        id: "swap1",
                        status: "swap.created",
                    },
                    {
                        ...mockBtcArkChainSwap,
                        id: "swap2",
                        status: "transaction.claimed",
                    },
                    {
                        ...mockBtcArkChainSwap,
                        id: "swap3",
                        status: "transaction.server.mempool",
                    },
                ];

                mockSwapRepository.getAllSwaps.mockImplementation(
                    async (filter: any) => {
                        if (filter?.type === "chain") {
                            return mockChainSwaps;
                        }
                        return [];
                    }
                );

                vi.spyOn(swapProvider, "getSwapStatus")
                    .mockResolvedValueOnce({
                        status: "transaction.server.confirmed",
                    })
                    .mockResolvedValueOnce({ status: "transaction.claimed" })
                    .mockResolvedValueOnce({ status: "transaction.claimed" });

                // act
                await swaps.refreshSwapsStatus();

                // wait for async operations to complete
                await new Promise((resolve) => setTimeout(resolve, 100));

                // assert
                expect(swapProvider.getSwapStatus).toHaveBeenCalledTimes(2);
                // swap2 should not be refreshed as it's already in final status
                expect(swapProvider.getSwapStatus).toHaveBeenCalledWith(
                    "swap1"
                );
                expect(swapProvider.getSwapStatus).toHaveBeenCalledWith(
                    "swap3"
                );
            });
        });
    });

    describe("Swap Enrichment and Validation Helpers", () => {
        describe("enrichReverseSwapPreimage", () => {
            it("should enrich reverse swap with valid preimage", () => {
                // Create a preimage and compute its hash
                const preimageBytes = randomBytes(32);
                const preimage = hex.encode(preimageBytes);
                const preimageHash = hex.encode(sha256(preimageBytes));

                const swap: PendingReverseSwap = {
                    ...mockReverseSwap,
                    preimage: "", // Empty preimage (restored swap)
                    request: {
                        ...mockReverseSwap.request,
                        preimageHash, // Set expected hash
                    },
                };

                const result = swaps.enrichReverseSwapPreimage(swap, preimage);

                expect(result.preimage).toBe(preimage);
                expect(result).toBe(swap); // Same reference
            });

            it("should throw error for mismatched preimage", () => {
                const swap: PendingReverseSwap = {
                    ...mockReverseSwap,
                    preimage: "", // Empty preimage (restored swap)
                    request: {
                        ...mockReverseSwap.request,
                        preimageHash: "a".repeat(64), // Some hash
                    },
                };

                const wrongPreimage = "b".repeat(64); // Won't match

                expect(() =>
                    swaps.enrichReverseSwapPreimage(swap, wrongPreimage)
                ).toThrow("Preimage does not match swap");
            });
        });

        describe("enrichSubmarineSwapInvoice", () => {
            it("should enrich submarine swap with valid invoice", () => {
                const swap: PendingSubmarineSwap = {
                    ...mockSubmarineSwap,
                    request: {
                        ...mockSubmarineSwap.request,
                        invoice: "", // Empty invoice (restored swap)
                    },
                };

                // Use the valid mock invoice
                const invoice = mock.invoice.address;
                const result = swaps.enrichSubmarineSwapInvoice(swap, invoice);

                expect(result.request.invoice).toBe(invoice);
                expect(result).toBe(swap); // Same reference
            });

            it("should throw error for invalid invoice format", () => {
                const swap: PendingSubmarineSwap = {
                    ...mockSubmarineSwap,
                    request: {
                        ...mockSubmarineSwap.request,
                        invoice: "",
                    },
                };

                expect(() =>
                    swaps.enrichSubmarineSwapInvoice(swap, "invalid-invoice")
                ).toThrow("Invalid Lightning invoice");
            });
        });
    });
});
