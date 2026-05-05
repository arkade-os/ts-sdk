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
    BoltzReverseSwap,
    BoltzSubmarineSwap,
    BoltzChainSwap,
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
import {
    createVHTLCScript as createVHTLCScriptReal,
    refundVHTLCwithOffchainTx,
} from "../src/utils/vhtlc";
import { BoltzRefundError } from "../src/errors";

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

// Mock vhtlc utils — passthrough except refundVHTLCwithOffchainTx
vi.mock("../src/utils/vhtlc", async () => {
    const actual =
        await vi.importActual<typeof import("../src/utils/vhtlc")>(
            "../src/utils/vhtlc"
        );
    return {
        ...actual,
        refundVHTLCwithOffchainTx: vi.fn().mockResolvedValue(undefined),
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
        // Prod-shaped Boltz Ark VHTLC timeouts:
        //   refund — absolute Unix timestamp; 2023-11-14 in the past so the
        //     default test case has CLTV satisfied (joinBatch path).
        //   unilateral* — BIP68 relative delays (seconds, ≥ 512 type-flag).
        timeoutBlockHeights: {
            refund: 1700000000,
            unilateralClaim: 266752,
            unilateralRefund: 432128,
            unilateralRefundWithoutReceiver: 518656,
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
            refund: 1700000000,
            unilateralClaim: 266752,
            unilateralRefund: 432128,
            unilateralRefundWithoutReceiver: 518656,
        },
    };

    const mockReverseSwap: BoltzReverseSwap = {
        id: mock.id,
        type: "reverse",
        createdAt: Math.floor(Date.now() / 1000),
        preimage: hex.encode(randomBytes(20)),
        request: createReverseSwapRequest,
        response: createReverseSwapResponse,
        status: "swap.created",
    };

    const mockSubmarineSwap: BoltzSubmarineSwap = {
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

    const mockArkBtcChainSwap: BoltzChainSwap = {
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

    const mockBtcArkChainSwap: BoltzChainSwap = {
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
            send: vi.fn(),
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
                const pendingSwap: BoltzReverseSwap = {
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
                const pendingSwap: BoltzReverseSwap = {
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
                const pendingSwap: BoltzReverseSwap = {
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
                    /VHTLC address mismatch. Expected/
                );
            });

            it("should throw error when no spendable VTXOs found after 3 attempts", async () => {
                vi.useFakeTimers();
                try {
                    // arrange
                    const pendingSwap: BoltzReverseSwap = {
                        id: mock.id,
                        type: "reverse",
                        createdAt: Date.now(),
                        preimage: hex.encode(preimage),
                        request: createReverseSwapRequest,
                        response: {
                            ...createReverseSwapResponse,
                            lockupAddress: mockVHTLC.vhtlcAddress,
                        },
                        status: "swap.created",
                    };
                    vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                        mockArkInfo
                    );
                    vi.spyOn(swaps, "createVHTLCScript").mockReturnValueOnce(
                        mockVHTLC
                    );
                    vi.spyOn(indexerProvider, "getVtxos").mockResolvedValue({
                        vtxos: [],
                    });

                    const promise = swaps.claimVHTLC(pendingSwap);
                    // attach a no-op handler so the rejection isn't flagged as
                    // unhandled while the fake timers are advancing
                    promise.catch(() => {});

                    await vi.advanceTimersByTimeAsync(1000); // fail + 500ms + fails + 500ms + fails and throws

                    // act & assert
                    await expect(promise).rejects.toThrow(
                        `Swap ${mock.id}: no spendable virtual coins found`
                    );
                } finally {
                    vi.useRealTimers();
                }
            });

            it("should retry getVtxos and succeed when a VTXO appears on a later attempt", async () => {
                vi.useFakeTimers();
                try {
                    // arrange
                    const pendingSwap: BoltzReverseSwap = {
                        id: mock.id,
                        type: "reverse",
                        createdAt: Date.now(),
                        preimage: hex.encode(preimage),
                        request: createReverseSwapRequest,
                        response: {
                            ...createReverseSwapResponse,
                            lockupAddress: mockVHTLC.vhtlcAddress,
                        },
                        status: "swap.created",
                    };
                    vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                        mockArkInfo
                    );
                    vi.spyOn(swaps, "createVHTLCScript").mockReturnValueOnce(
                        mockVHTLC
                    );
                    vi.mocked(wallet.getAddress).mockResolvedValue(
                        mock.address.ark
                    );

                    // recoverable VTXO — takes the joinBatch path
                    const vtxo = {
                        txid: hex.encode(randomBytes(32)),
                        vout: 0,
                        value: mock.amount,
                        status: {
                            confirmed: true,
                            blockHeight: 100,
                            blockHash: "abc",
                        },
                        virtualStatus: { state: "swept" as const },
                        isSpent: false,
                        isUnrolled: false,
                        createdAt: new Date(),
                    };
                    vi.spyOn(indexerProvider, "getVtxos")
                        .mockResolvedValueOnce({ vtxos: [] })
                        .mockResolvedValueOnce({ vtxos: [vtxo] as any });

                    const joinBatchSpy = vi
                        .spyOn(swaps as any, "joinBatch")
                        .mockResolvedValue(undefined);

                    // act
                    const promise = swaps.claimVHTLC(pendingSwap);
                    promise.catch(() => {});

                    // first getVtxos returns empty → wait 500ms → second returns VTXO
                    await vi.advanceTimersByTimeAsync(500);

                    // assert
                    await expect(promise).resolves.toBeUndefined();
                    expect(indexerProvider.getVtxos).toHaveBeenCalledTimes(2);
                    expect(joinBatchSpy).toHaveBeenCalledOnce();
                    expect(mockSwapRepository.saveSwap).toHaveBeenCalledWith(
                        expect.objectContaining({
                            id: mock.id,
                            status: "transaction.claimed",
                        })
                    );
                } finally {
                    vi.useRealTimers();
                }
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
                vi.spyOn(wallet, "send").mockResolvedValueOnce(mock.txid);
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
                expect(wallet.send).toHaveBeenCalledWith({
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
                const pendingSwap: BoltzChainSwap = {
                    ...mockArkBtcChainSwap,
                    toAddress: undefined,
                };

                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );

                // act & assert
                await expect(swaps.claimBtc(pendingSwap)).rejects.toThrow(
                    `Swap ${mockArkBtcChainSwap.id}: destination address is required`
                );
            });

            it("should throw error when swap tree in claim details is missing", async () => {
                // arrange
                const pendingSwap: BoltzChainSwap = {
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
                    `Swap ${mockArkBtcChainSwap.id}: missing swap tree in claim details`
                );
            });

            it("should throw error when server public key in claim details is missing", async () => {
                // arrange
                const pendingSwap: BoltzChainSwap = {
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
                    `Swap ${mockArkBtcChainSwap.id}: missing server public key in claim details`
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
                        refund: 1778741659,
                        unilateralClaim: 266752,
                        unilateralRefund: 432128,
                        unilateralRefundWithoutReceiver: 518656,
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

                const pendingSwap: BoltzChainSwap = {
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

                const pendingSwap: BoltzChainSwap = {
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
                const pendingSwap: BoltzChainSwap = {
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
                const pendingSwap: BoltzChainSwap = {
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
                const pendingSwap: BoltzChainSwap = {
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
                const pendingSwap: BoltzChainSwap = {
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
                const pendingSwap: BoltzChainSwap = {
                    ...mockBtcArkChainSwap,
                    toAddress: undefined,
                };

                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );

                // act & assert
                await expect(swaps.claimArk(pendingSwap)).rejects.toThrow(
                    `Swap ${mockBtcArkChainSwap.id}: destination address is required`
                );
            });

            it("should throw error when timeouts in claim details is missing", async () => {
                // arrange
                const pendingSwap: BoltzChainSwap = {
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
                    `Swap ${mockBtcArkChainSwap.id}: missing timeouts in claim details`
                );
            });

            it("should throw error when server public key in claim details is missing", async () => {
                // arrange
                const pendingSwap: BoltzChainSwap = {
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
                    `Swap ${mockBtcArkChainSwap.id}: missing server public key in claim details`
                );
            });

            it("should throw error when no spendable VTXOs found after 3 attempts", async () => {
                vi.useFakeTimers();
                try {
                    // arrange
                    const pendingSwap: BoltzChainSwap = {
                        ...mockBtcArkChainSwap,
                        preimage: hex.encode(mockPreimage),
                    };
                    vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                        mockArkInfo
                    );
                    vi.spyOn(swaps, "createVHTLCScript").mockReturnValueOnce(
                        mockBtcArkVHTLC
                    );
                    vi.spyOn(indexerProvider, "getVtxos").mockResolvedValue({
                        vtxos: [],
                    });

                    const promise = swaps.claimArk(pendingSwap);
                    // attach a no-op handler so the rejection isn't flagged as
                    // unhandled while the fake timers are advancing
                    promise.catch(() => {});

                    await vi.advanceTimersByTimeAsync(1000); // fail + 500ms + fails + 500ms + fails and throws

                    // act & assert
                    await expect(promise).rejects.toThrow(
                        `Swap ${mockBtcArkChainSwap.id}: no spendable virtual coins found`
                    );
                } finally {
                    vi.useRealTimers();
                }
            });

            it("should retry getVtxos and succeed when a VTXO appears on a later attempt", async () => {
                vi.useFakeTimers();
                try {
                    // arrange
                    const pendingSwap: BoltzChainSwap = {
                        ...mockBtcArkChainSwap,
                        preimage: hex.encode(mockPreimage),
                    };
                    vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                        mockArkInfo
                    );
                    vi.spyOn(swaps, "createVHTLCScript").mockReturnValueOnce(
                        mockBtcArkVHTLC
                    );
                    vi.mocked(wallet.getAddress).mockResolvedValue(
                        mock.address.ark
                    );

                    // recoverable VTXO — takes the joinBatch path
                    const vtxo = {
                        txid: hex.encode(randomBytes(32)),
                        vout: 0,
                        value: mock.amount,
                        status: {
                            confirmed: true,
                            blockHeight: 100,
                            blockHash: "abc",
                        },
                        virtualStatus: { state: "swept" as const },
                        isSpent: false,
                        isUnrolled: false,
                        createdAt: new Date(),
                    };
                    vi.spyOn(indexerProvider, "getVtxos")
                        .mockResolvedValueOnce({ vtxos: [] })
                        .mockResolvedValueOnce({ vtxos: [vtxo] as any });

                    const joinBatchSpy = vi
                        .spyOn(swaps as any, "joinBatch")
                        .mockResolvedValue(undefined);
                    vi.spyOn(
                        swapProvider,
                        "getSwapStatus"
                    ).mockResolvedValueOnce({
                        status: "transaction.claimed",
                    });

                    // act
                    const promise = swaps.claimArk(pendingSwap);
                    promise.catch(() => {});

                    // first getVtxos returns empty → wait 500ms → second returns VTXO
                    await vi.advanceTimersByTimeAsync(500);

                    // assert
                    await expect(promise).resolves.toBeUndefined();
                    expect(indexerProvider.getVtxos).toHaveBeenCalledTimes(2);
                    expect(joinBatchSpy).toHaveBeenCalledOnce();
                    expect(mockSwapRepository.saveSwap).toHaveBeenCalledWith(
                        expect.objectContaining({
                            id: mockBtcArkChainSwap.id,
                            status: "transaction.claimed",
                        })
                    );
                } finally {
                    vi.useRealTimers();
                }
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
                        refund: 1778741659,
                        unilateralClaim: 266752,
                        unilateralRefund: 432128,
                        unilateralRefundWithoutReceiver: 518656,
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

                const pendingSwap: BoltzChainSwap = {
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

                const pendingSwap: BoltzChainSwap = {
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
                const pendingSwap: BoltzChainSwap = {
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
                const pendingSwap: BoltzChainSwap = {
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
                const pendingSwap: BoltzChainSwap = {
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
                const pendingSwap: BoltzChainSwap = {
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
                const mockReverseSwaps: BoltzReverseSwap[] = [
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
                const mockSubmarineSwaps: BoltzSubmarineSwap[] = [
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
                const mockChainSwaps: BoltzChainSwap[] = [
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
                const mockReverseSwaps: BoltzReverseSwap[] = [
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

                const mockSubmarineSwaps: BoltzSubmarineSwap[] = [
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

                const mockChainSwaps: BoltzChainSwap[] = [
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
                const mockReverseSwaps: BoltzReverseSwap[] = [
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

                const mockSubmarineSwaps: BoltzSubmarineSwap[] = [
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
                const mockChainSwaps: BoltzChainSwap[] = [
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

                const swap: BoltzReverseSwap = {
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
                const swap: BoltzReverseSwap = {
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
                const swap: BoltzSubmarineSwap = {
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
                const swap: BoltzSubmarineSwap = {
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

    describe("restoreSwaps", () => {
        const mockLeaf = { version: 0, output: "" };
        const mockTree = {
            claimLeaf: mockLeaf,
            refundLeaf: mockLeaf,
            refundWithoutBoltzLeaf: mockLeaf,
            unilateralClaimLeaf: mockLeaf,
            unilateralRefundLeaf: mockLeaf,
            unilateralRefundWithoutBoltzLeaf: mockLeaf,
        };
        const mockDetails = {
            tree: mockTree,
            amount: 50000,
            keyIndex: 0,
            lockupAddress: "mock-lockup",
            serverPublicKey: compressedPubkeys.boltz,
            timeoutBlockHeight: 100,
        };

        const pendingReverse = {
            id: "rev-pending",
            type: "reverse" as const,
            to: "ARK" as const,
            from: "BTC" as const,
            status: "swap.created",
            createdAt: 1000,
            preimageHash: hex.encode(sha256(randomBytes(32))),
            claimDetails: mockDetails,
        };

        const finalReverse = {
            ...pendingReverse,
            id: "rev-final",
            status: "invoice.settled",
        };

        const pendingSubmarine = {
            id: "sub-pending",
            type: "submarine" as const,
            to: "BTC" as const,
            from: "ARK" as const,
            status: "transaction.mempool",
            createdAt: 2000,
            preimageHash: hex.encode(sha256(randomBytes(32))),
            refundDetails: mockDetails,
        };

        const finalSubmarine = {
            ...pendingSubmarine,
            id: "sub-final",
            status: "transaction.claimed",
        };

        const pendingChain = {
            id: "chain-pending",
            type: "chain" as const,
            to: "BTC" as const,
            from: "ARK" as const,
            status: "transaction.server.mempool",
            createdAt: 3000,
            preimageHash: hex.encode(sha256(randomBytes(32))),
            refundDetails: {
                ...mockDetails,
                tree: mockTree,
            },
        };

        const finalChain = {
            ...pendingChain,
            id: "chain-final",
            status: "transaction.claimed",
        };

        const mockFees = {
            submarine: { percentage: 0.1, minerFees: 100 },
            reverse: {
                percentage: 0.25,
                minerFees: { lockup: 50, claim: 50 },
            },
        };

        it("should include terminal swaps in results without extra API fetches", async () => {
            const restoreSpy = vi
                .spyOn(swapProvider, "restoreSwaps")
                .mockResolvedValueOnce([
                    finalReverse,
                    finalSubmarine,
                    finalChain,
                ]);
            const getPreimageSpy = vi.spyOn(swapProvider, "getSwapPreimage");
            vi.spyOn(swapProvider, "getFees").mockResolvedValueOnce(
                mockFees as any
            );

            const result = await swaps.restoreSwaps();

            expect(restoreSpy).toHaveBeenCalledOnce();
            // Terminal submarine swaps should NOT trigger a preimage fetch
            expect(getPreimageSpy).not.toHaveBeenCalled();
            // Terminal swaps are still returned so callers can rebuild full history
            expect(result.reverseSwaps).toHaveLength(1);
            expect(result.submarineSwaps).toHaveLength(1);
            expect(result.chainSwaps).toHaveLength(1);
        });

        it("should restore swaps that are still pending", async () => {
            vi.spyOn(swapProvider, "restoreSwaps").mockResolvedValueOnce([
                pendingReverse,
                pendingSubmarine,
                pendingChain,
            ]);
            vi.spyOn(swapProvider, "getSwapPreimage").mockResolvedValueOnce({
                preimage: hex.encode(randomBytes(32)),
            });
            vi.spyOn(swapProvider, "getFees").mockResolvedValueOnce(
                mockFees as any
            );

            const result = await swaps.restoreSwaps();

            expect(result.reverseSwaps).toHaveLength(1);
            expect(result.reverseSwaps[0].id).toBe("rev-pending");
            expect(result.submarineSwaps).toHaveLength(1);
            expect(result.submarineSwaps[0].id).toBe("sub-pending");
            expect(result.chainSwaps).toHaveLength(1);
            expect(result.chainSwaps[0].id).toBe("chain-pending");
        });

        it("should restore both terminal and pending swaps from a mixed set", async () => {
            vi.spyOn(swapProvider, "restoreSwaps").mockResolvedValueOnce([
                finalReverse,
                pendingReverse,
                finalSubmarine,
                pendingSubmarine,
                finalChain,
                pendingChain,
            ]);
            // Only pendingSubmarine triggers a preimage fetch (finalSubmarine is terminal)
            vi.spyOn(swapProvider, "getSwapPreimage").mockResolvedValueOnce({
                preimage: hex.encode(randomBytes(32)),
            });
            vi.spyOn(swapProvider, "getFees").mockResolvedValueOnce(
                mockFees as any
            );

            const result = await swaps.restoreSwaps();

            expect(result.reverseSwaps).toHaveLength(2);
            expect(result.reverseSwaps.map((s) => s.id)).toContain("rev-final");
            expect(result.reverseSwaps.map((s) => s.id)).toContain(
                "rev-pending"
            );
            expect(result.submarineSwaps).toHaveLength(2);
            expect(result.submarineSwaps.map((s) => s.id)).toContain(
                "sub-final"
            );
            expect(result.submarineSwaps.map((s) => s.id)).toContain(
                "sub-pending"
            );
            expect(result.chainSwaps).toHaveLength(2);
            expect(result.chainSwaps.map((s) => s.id)).toContain("chain-final");
            expect(result.chainSwaps.map((s) => s.id)).toContain(
                "chain-pending"
            );
        });

        it("should not call getSwapPreimage for final submarine swaps", async () => {
            const getPreimageSpy = vi.spyOn(swapProvider, "getSwapPreimage");
            vi.spyOn(swapProvider, "restoreSwaps").mockResolvedValueOnce([
                finalSubmarine,
            ]);
            vi.spyOn(swapProvider, "getFees").mockResolvedValueOnce({} as any);

            await swaps.restoreSwaps();

            expect(getPreimageSpy).not.toHaveBeenCalled();
        });
    });

    describe("refundVHTLC — VTXO selection", () => {
        const lockupTxid = hex.encode(randomBytes(32));
        const otherTxid = hex.encode(randomBytes(32));

        const makeVtxo = (txid: string, vout: number) => ({
            txid,
            vout,
            value: 50000,
            status: { confirmed: true, blockHeight: 100, blockHash: "abc" },
            virtualStatus: { state: "swept" as const },
            isSpent: false,
            isUnrolled: false,
            createdAt: new Date(),
        });

        const refundableSwap: BoltzSubmarineSwap = {
            ...mockSubmarineSwap,
            status: "invoice.failedToPay",
        };

        const mockRefundSelection = (args: {
            spendable?: any[];
            recoverable?: any[];
            all?: any[];
        }) => {
            const spendable = args.spendable ?? [];
            const recoverable = args.recoverable ?? [];
            const all = args.all ?? [
                ...new Map(
                    [...spendable, ...recoverable].map((vtxo) => [
                        `${vtxo.txid}:${vtxo.vout}`,
                        vtxo,
                    ])
                ).values(),
            ];

            vi.mocked(indexerProvider.getVtxos).mockImplementation(
                async (opts: any) => {
                    if (opts?.spendableOnly) return { vtxos: spendable } as any;
                    if (opts?.recoverableOnly)
                        return { vtxos: recoverable } as any;
                    return { vtxos: all } as any;
                }
            );
        };

        beforeEach(() => {
            vi.mocked(arkProvider.getInfo).mockResolvedValue(mockArkInfo);
            vi.mocked(wallet.getAddress).mockResolvedValue(mock.address.ark);

            // stub createVHTLCScript to return matching address
            vi.spyOn(swaps as any, "createVHTLCScript").mockReturnValue({
                vhtlcScript: {
                    claimScript: new Uint8Array([1]),
                    pkScript: new Uint8Array([2]),
                    refund: () => [{}, new Uint8Array([3]), 0xc0] as any,
                    refundWithoutReceiver: () =>
                        [{}, new Uint8Array([4]), 0xc0] as any,
                    encode: () => [] as any,
                    options: {
                        refundLocktime:
                            refundableSwap.response.timeoutBlockHeights.refund,
                    },
                },
                vhtlcAddress: refundableSwap.response.address,
            });

            // Default: refundLocktime is a past timestamp (mock data), so
            // CLTV is satisfied via wall-clock check — no chain-height query.

            // stub the actual refund call so we don't need real crypto
            vi.spyOn(swaps as any, "joinBatch").mockResolvedValue(undefined);
        });

        it("should refund a recoverable VTXO even when spendableOnly is empty", async () => {
            const vtxo = makeVtxo(lockupTxid, 0);

            mockRefundSelection({
                recoverable: [vtxo],
            });

            await swaps.refundVHTLC(refundableSwap);

            const joinBatch = vi.mocked((swaps as any).joinBatch);
            expect(joinBatch).toHaveBeenCalledOnce();
            expect(joinBatch.mock.calls[0][1].txid).toBe(lockupTxid);
            expect(indexerProvider.getVtxos).toHaveBeenCalledWith(
                expect.objectContaining({ recoverableOnly: true })
            );
        });

        it("should refund all unspent VTXOs at the contract address", async () => {
            const vtxoA = makeVtxo(lockupTxid, 0);
            const vtxoB = makeVtxo(otherTxid, 1);

            mockRefundSelection({
                recoverable: [vtxoA, vtxoB],
            });

            await swaps.refundVHTLC(refundableSwap);

            const joinBatch = vi.mocked((swaps as any).joinBatch);
            expect(joinBatch).toHaveBeenCalledTimes(2);
            expect(joinBatch.mock.calls[0][1].txid).toBe(lockupTxid);
            expect(joinBatch.mock.calls[1][1].txid).toBe(otherTxid);
        });

        it("should process every refundable VTXO returned by the indexer", async () => {
            const recoverableVtxo = makeVtxo(lockupTxid, 0);
            const spendableVtxo = {
                ...makeVtxo(otherTxid, 1),
                virtualStatus: { state: "settled" as const },
            };

            mockRefundSelection({
                spendable: [spendableVtxo],
                recoverable: [recoverableVtxo],
            });

            await swaps.refundVHTLC(refundableSwap);

            const joinBatch = vi.mocked((swaps as any).joinBatch);
            expect(joinBatch).toHaveBeenCalledTimes(2);
            expect(joinBatch.mock.calls[0][1].txid).toBe(otherTxid);
            expect(joinBatch.mock.calls[1][1].txid).toBe(lockupTxid);
        });

        it("should throw when all VTXOs are spent", async () => {
            const spentVtxo = { ...makeVtxo(lockupTxid, 0), isSpent: true };

            mockRefundSelection({
                all: [spentVtxo],
            });

            await expect(swaps.refundVHTLC(refundableSwap)).rejects.toThrow(
                /VHTLC is already spent/
            );
        });

        it("should throw when no VTXOs exist at the address", async () => {
            mockRefundSelection({});

            await expect(swaps.refundVHTLC(refundableSwap)).rejects.toThrow(
                /VHTLC not found/
            );
        });

        it("should not misclassify non-spent non-refundable VTXOs as spent", async () => {
            const pendingVtxo = {
                ...makeVtxo(lockupTxid, 0),
                virtualStatus: { state: "preconfirmed" as const },
            };

            mockRefundSelection({
                all: [pendingVtxo],
            });

            await expect(swaps.refundVHTLC(refundableSwap)).rejects.toThrow(
                /no refundable VTXOs yet/
            );
        });

        it("should not query Boltz status — selection is local only", async () => {
            const vtxo = makeVtxo(lockupTxid, 0);

            mockRefundSelection({
                recoverable: [vtxo],
            });
            const statusSpy = vi.spyOn(swapProvider, "getSwapStatus");

            await swaps.refundVHTLC(refundableSwap);

            expect(statusSpy).not.toHaveBeenCalled();
        });

        describe("non-recoverable VTXOs (Boltz-signing branch)", () => {
            const makeNonRecoverableVtxo = (txid: string, vout: number) => ({
                txid,
                vout,
                value: 50000,
                status: {
                    confirmed: true,
                    blockHeight: 100,
                    blockHash: "abc",
                },
                virtualStatus: { state: "settled" as const },
                isSpent: false,
                isUnrolled: false,
                createdAt: new Date(),
            });

            // Pre-CLTV: refundLocktime is a future Unix timestamp so the
            // Boltz 3-of-3 path is attempted for non-recoverable VTXOs.
            const futureRefundTimestamp = Math.floor(Date.now() / 1000) + 86400;
            const refundableSwapPreCltv: BoltzSubmarineSwap = {
                ...refundableSwap,
                response: {
                    ...refundableSwap.response,
                    timeoutBlockHeights: {
                        ...refundableSwap.response.timeoutBlockHeights,
                        refund: futureRefundTimestamp,
                    },
                },
            };

            it("should call refundVHTLCwithOffchainTx for each non-recoverable VTXO", async () => {
                const vtxoA = makeNonRecoverableVtxo(lockupTxid, 0);
                const vtxoB = makeNonRecoverableVtxo(otherTxid, 1);

                mockRefundSelection({
                    spendable: [vtxoA, vtxoB],
                });

                await swaps.refundVHTLC(refundableSwapPreCltv);

                const mockRefund = vi.mocked(refundVHTLCwithOffchainTx);
                expect(mockRefund).toHaveBeenCalledTimes(2);
                expect((mockRefund.mock.calls[0][6] as any).txid).toBe(
                    lockupTxid
                );
                expect((mockRefund.mock.calls[1][6] as any).txid).toBe(
                    otherTxid
                );
            });

            it("should refund single non-recoverable VTXO via Boltz co-signing", async () => {
                const vtxo = makeNonRecoverableVtxo(lockupTxid, 0);

                mockRefundSelection({
                    spendable: [vtxo],
                });

                await swaps.refundVHTLC(refundableSwapPreCltv);

                const mockRefund = vi.mocked(refundVHTLCwithOffchainTx);
                expect(mockRefund).toHaveBeenCalledOnce();
                expect(mockRefund.mock.calls[0][0]).toBe(
                    refundableSwapPreCltv.id
                );
                expect((mockRefund.mock.calls[0][6] as any).txid).toBe(
                    lockupTxid
                );
            });

            it("should skip Boltz and use joinBatch when CLTV has passed", async () => {
                // Default refundableSwap has past refund timestamp; CLTV
                // satisfied via wall-clock check → refundWithoutReceiver.
                const vtxo = makeNonRecoverableVtxo(lockupTxid, 0);

                mockRefundSelection({
                    spendable: [vtxo],
                });

                await swaps.refundVHTLC(refundableSwap);

                expect(refundVHTLCwithOffchainTx).not.toHaveBeenCalled();
                const joinBatch = vi.mocked((swaps as any).joinBatch);
                expect(joinBatch).toHaveBeenCalledOnce();
                // isRecoverable arg must be false for non-recoverable VTXOs
                expect(joinBatch.mock.calls[0][4]).toBe(false);
            });

            it("should fall back to joinBatch when Boltz rejects and CLTV has since passed", async () => {
                const vtxo = makeNonRecoverableVtxo(lockupTxid, 0);

                mockRefundSelection({
                    spendable: [vtxo],
                });

                // Boltz rejects the refund
                vi.mocked(refundVHTLCwithOffchainTx).mockRejectedValueOnce(
                    new BoltzRefundError("outpoint mismatch")
                );

                // Re-check uses wall-clock time; advance Date.now() between
                // the initial check (pre-CLTV) and the re-check (post-CLTV).
                const dateSpy = vi.spyOn(Date, "now");
                dateSpy.mockReturnValueOnce(
                    (futureRefundTimestamp - 60) * 1000
                );
                dateSpy.mockReturnValueOnce(
                    (futureRefundTimestamp + 60) * 1000
                );

                await swaps.refundVHTLC(refundableSwapPreCltv);

                const joinBatch = vi.mocked((swaps as any).joinBatch);
                expect(joinBatch).toHaveBeenCalledOnce();
                expect(joinBatch.mock.calls[0][4]).toBe(false);
            });

            it("should skip when Boltz rejects and CLTV still not passed", async () => {
                const vtxo = makeNonRecoverableVtxo(lockupTxid, 0);

                mockRefundSelection({
                    spendable: [vtxo],
                });

                vi.mocked(refundVHTLCwithOffchainTx).mockRejectedValueOnce(
                    new BoltzRefundError("outpoint mismatch")
                );

                // Pre-CLTV the whole way through (future refund timestamp,
                // current wall-clock isn't mocked).

                await swaps.refundVHTLC(refundableSwapPreCltv);

                const joinBatch = vi.mocked((swaps as any).joinBatch);
                expect(joinBatch).not.toHaveBeenCalled();
                expect(mockSwapRepository.saveSwap).toHaveBeenCalledWith(
                    expect.objectContaining({ refunded: false })
                );
            });

            it("should re-throw non-Boltz errors without fallback", async () => {
                const vtxo = makeNonRecoverableVtxo(lockupTxid, 0);

                mockRefundSelection({
                    spendable: [vtxo],
                });

                vi.mocked(refundVHTLCwithOffchainTx).mockRejectedValueOnce(
                    new Error("local signing failure")
                );

                await expect(
                    swaps.refundVHTLC(refundableSwapPreCltv)
                ).rejects.toThrow(/local signing failure/);
            });
        });

        it("should skip a recoverable VTXO when pre-CLTV", async () => {
            const futureRefund = Math.floor(Date.now() / 1000) + 86400;
            const preCltvSwap: BoltzSubmarineSwap = {
                ...refundableSwap,
                response: {
                    ...refundableSwap.response,
                    timeoutBlockHeights: {
                        ...refundableSwap.response.timeoutBlockHeights,
                        refund: futureRefund,
                    },
                },
            };
            const vtxo = makeVtxo(lockupTxid, 0);

            mockRefundSelection({
                recoverable: [vtxo],
            });

            await swaps.refundVHTLC(preCltvSwap);

            const joinBatch = vi.mocked((swaps as any).joinBatch);
            expect(joinBatch).not.toHaveBeenCalled();
            expect(mockSwapRepository.saveSwap).toHaveBeenCalledWith(
                expect.objectContaining({ refunded: false })
            );
        });

        it("should fail early on VHTLC address mismatch", async () => {
            // return a mismatched address from createVHTLCScript
            vi.spyOn(swaps as any, "createVHTLCScript").mockReturnValue({
                vhtlcScript: { claimScript: new Uint8Array([1]) },
                vhtlcAddress: "ark1-wrong-address",
            });

            await expect(swaps.refundVHTLC(refundableSwap)).rejects.toThrow(
                /VHTLC address mismatch/
            );

            // should not reach indexer or any refund call
            expect(indexerProvider.getVtxos).not.toHaveBeenCalled();
        });
    });

    describe("inspectSubmarineRecovery", () => {
        const lockupTxid = hex.encode(randomBytes(32));

        const makeVtxo = (
            txid: string,
            vout: number,
            value = 50000,
            isSpent = false,
            virtualState: "swept" | "settled" | "preconfirmed" = "swept"
        ) => ({
            txid,
            vout,
            value,
            status: { confirmed: true, blockHeight: 100, blockHash: "abc" },
            virtualStatus: { state: virtualState },
            isSpent,
            isUnrolled: false,
            createdAt: new Date(),
        });

        const claimedSwap: BoltzSubmarineSwap = {
            ...mockSubmarineSwap,
            id: "claimed-swap-id",
            status: "transaction.claimed",
        };

        const failedSwap: BoltzSubmarineSwap = {
            ...mockSubmarineSwap,
            id: "failed-swap-id",
            status: "invoice.failedToPay",
        };

        const mockSelection = (args: {
            spendable?: any[];
            recoverable?: any[];
            all?: any[];
        }) => {
            const spendable = args.spendable ?? [];
            const recoverable = args.recoverable ?? [];
            const all = args.all ?? [
                ...new Map(
                    [...spendable, ...recoverable].map((vtxo) => [
                        `${vtxo.txid}:${vtxo.vout}`,
                        vtxo,
                    ])
                ).values(),
            ];
            vi.mocked(indexerProvider.getVtxos).mockImplementation(
                async (opts: any) => {
                    if (opts?.spendableOnly) return { vtxos: spendable } as any;
                    if (opts?.recoverableOnly)
                        return { vtxos: recoverable } as any;
                    return { vtxos: all } as any;
                }
            );
        };

        beforeEach(() => {
            vi.mocked(arkProvider.getInfo).mockResolvedValue(mockArkInfo);
            vi.mocked(wallet.getAddress).mockResolvedValue(mock.address.ark);

            vi.spyOn(swaps as any, "createVHTLCScript").mockReturnValue({
                vhtlcScript: {
                    claimScript: new Uint8Array([1]),
                    pkScript: new Uint8Array([2]),
                    refund: () => [{}, new Uint8Array([3]), 0xc0] as any,
                    refundWithoutReceiver: () =>
                        [{}, new Uint8Array([4]), 0xc0] as any,
                    encode: () => [] as any,
                    options: {
                        refundLocktime:
                            claimedSwap.response.timeoutBlockHeights.refund,
                    },
                },
                vhtlcAddress: claimedSwap.response.address,
            });
        });

        // Helpers for picking a refund timestamp relative to wall clock.
        const pastRefund = () => Math.floor(Date.now() / 1000) - 1;
        const futureRefund = () => Math.floor(Date.now() / 1000) + 86400;

        const swapWithRefund = (
            base: BoltzSubmarineSwap,
            refund: number
        ): BoltzSubmarineSwap => ({
            ...base,
            response: {
                ...base.response,
                timeoutBlockHeights: {
                    ...base.response.timeoutBlockHeights,
                    refund,
                },
            },
        });

        it("returns recoverable for transaction.claimed plus post-CLTV VTXO", async () => {
            mockSelection({ recoverable: [makeVtxo(lockupTxid, 0, 75000)] });
            const refund = pastRefund();
            const swap = swapWithRefund(claimedSwap, refund);

            const info = await swaps.inspectSubmarineRecovery(swap);

            expect(info.status).toBe("recoverable");
            expect(info.swap).toBe(swap);
            expect(info.vtxoCount).toBe(1);
            expect(info.amountSats).toBe(75000);
            expect(info.refundLocktime).toBe(refund);
        });

        it("returns recoverable for failed refundable status plus post-CLTV VTXO", async () => {
            mockSelection({ recoverable: [makeVtxo(lockupTxid, 0, 30000)] });
            const swap = swapWithRefund(failedSwap, pastRefund());

            const info = await swaps.inspectSubmarineRecovery(swap);

            expect(info.status).toBe("recoverable");
            expect(info.swap.id).toBe("failed-swap-id");
            expect(info.amountSats).toBe(30000);
        });

        it("sums amount across multiple unspent VTXOs", async () => {
            mockSelection({
                recoverable: [
                    makeVtxo(lockupTxid, 0, 30000),
                    makeVtxo(lockupTxid, 1, 20000),
                ],
            });
            const swap = swapWithRefund(claimedSwap, pastRefund());

            const info = await swaps.inspectSubmarineRecovery(swap);

            expect(info.status).toBe("recoverable");
            expect(info.vtxoCount).toBe(2);
            expect(info.amountSats).toBe(50000);
        });

        it("returns pre_cltv when unspent VTXOs exist but locktime hasn't passed", async () => {
            mockSelection({ recoverable: [makeVtxo(lockupTxid, 0)] });
            const swap = swapWithRefund(claimedSwap, futureRefund());

            const info = await swaps.inspectSubmarineRecovery(swap);

            expect(info.status).toBe("pre_cltv");
            expect(info.vtxoCount).toBe(1);
        });

        it("returns recoverable pre-CLTV when VTXOs can use Boltz 3-of-3 refund", async () => {
            mockSelection({
                spendable: [makeVtxo(lockupTxid, 0, 50000, false, "settled")],
            });
            const swap = swapWithRefund(claimedSwap, futureRefund());

            const info = await swaps.inspectSubmarineRecovery(swap);

            expect(info.status).toBe("recoverable");
            expect(info.vtxoCount).toBe(1);
        });

        it("compares refund against wall-clock Unix time, never chain height", async () => {
            // Regression: the legacy block-height locktime path queried
            // swapProvider.getChainHeight(). Boltz Ark VHTLCs always encode
            // refund as a Unix timestamp, so the wall-clock check is the
            // only path. This test pins that by failing if we ever reach
            // for the chain tip again.
            const swap = swapWithRefund(claimedSwap, pastRefund());
            mockSelection({ recoverable: [makeVtxo(lockupTxid, 0)] });
            const chainHeightSpy = vi.spyOn(swapProvider, "getChainHeight");

            const info = await swaps.inspectSubmarineRecovery(swap);

            expect(info.status).toBe("recoverable");
            expect(chainHeightSpy).not.toHaveBeenCalled();
        });

        it("returns none when the address has no VTXOs at all", async () => {
            mockSelection({});

            const info = await swaps.inspectSubmarineRecovery(claimedSwap);

            expect(info.status).toBe("none");
            expect(info.vtxoCount).toBe(0);
            expect(info.amountSats).toBe(0);
        });

        it("returns already_spent when every VTXO at the address is spent", async () => {
            const spent = makeVtxo(lockupTxid, 0, 50000, true);
            mockSelection({ all: [spent] });

            const info = await swaps.inspectSubmarineRecovery(claimedSwap);

            expect(info.status).toBe("already_spent");
            expect(info.vtxoCount).toBe(0);
        });

        it("returns invalid_swap for pending statuses without hitting the indexer", async () => {
            const pendingSwap: BoltzSubmarineSwap = {
                ...mockSubmarineSwap,
                status: "transaction.mempool",
            };

            const info = await swaps.inspectSubmarineRecovery(pendingSwap);

            expect(info.status).toBe("invalid_swap");
            expect(info.error).toMatch(/transaction\.mempool/);
            expect(indexerProvider.getVtxos).not.toHaveBeenCalled();
            expect(arkProvider.getInfo).not.toHaveBeenCalled();
        });

        it("returns invalid_swap when VHTLC address can't be reconstructed", async () => {
            vi.spyOn(swaps as any, "createVHTLCScript").mockReturnValue({
                vhtlcScript: { claimScript: new Uint8Array([1]) },
                vhtlcAddress: "ark1-wrong-address",
            });

            const info = await swaps.inspectSubmarineRecovery(claimedSwap);

            expect(info.status).toBe("invalid_swap");
            expect(info.error).toMatch(/address mismatch/i);
            expect(info.vtxoCount).toBe(0);
        });

        it("does not mutate the repository", async () => {
            mockSelection({ recoverable: [makeVtxo(lockupTxid, 0)] });

            await swaps.inspectSubmarineRecovery(claimedSwap);

            expect(mockSwapRepository.saveSwap).not.toHaveBeenCalled();
            expect(mockSwapRepository.deleteSwap).not.toHaveBeenCalled();
        });
    });

    describe("scanRecoverableSubmarineSwaps", () => {
        const lockupTxid = hex.encode(randomBytes(32));
        const makeVtxo = (
            txid: string,
            vout: number,
            script: string,
            value = 50000
        ) => ({
            txid,
            vout,
            value,
            script,
            status: { confirmed: true, blockHeight: 100, blockHash: "abc" },
            virtualStatus: { state: "swept" as const },
            isSpent: false,
            isUnrolled: false,
            createdAt: new Date(),
        });

        const claimedSwap: BoltzSubmarineSwap = {
            ...mockSubmarineSwap,
            id: "claimed-swap-id",
            status: "transaction.claimed",
        };
        const failedSwap: BoltzSubmarineSwap = {
            ...mockSubmarineSwap,
            id: "failed-swap-id",
            status: "invoice.failedToPay",
        };
        const pendingSwap: BoltzSubmarineSwap = {
            ...mockSubmarineSwap,
            id: "pending-swap-id",
            status: "transaction.mempool",
        };

        beforeEach(() => {
            // Repo is asked only for type:"submarine"; non-submarine swaps
            // never reach scan, so test harness only needs to return
            // submarine candidates plus a pending one to exercise filtering.
            vi.mocked(mockSwapRepository.getAllSwaps).mockImplementation(
                async (filter: any) => {
                    expect(filter).toEqual({ type: "submarine" });
                    return [claimedSwap, failedSwap, pendingSwap];
                }
            );

            vi.mocked(arkProvider.getInfo).mockResolvedValue(mockArkInfo);

            // The two valid candidates reconstruct to distinct scripts so the
            // batched indexer response can be mapped back per swap.
            let scriptByte = 1;
            vi.spyOn(swaps as any, "createVHTLCScript").mockImplementation(
                () => {
                    const pkScript = new Uint8Array([scriptByte++]);
                    return {
                        vhtlcScript: {
                            claimScript: new Uint8Array([1]),
                            pkScript,
                            refund: () =>
                                [{}, new Uint8Array([3]), 0xc0] as any,
                            refundWithoutReceiver: () =>
                                [{}, new Uint8Array([4]), 0xc0] as any,
                            encode: () => [] as any,
                            options: {
                                refundLocktime:
                                    claimedSwap.response.timeoutBlockHeights
                                        .refund,
                            },
                        },
                        vhtlcAddress: claimedSwap.response.address,
                    };
                }
            );

            vi.mocked(indexerProvider.getVtxos).mockImplementation(
                async (opts: any) => {
                    if (opts?.spendableOnly) return { vtxos: [] } as any;
                    if (opts?.recoverableOnly) return { vtxos: [] } as any;
                    throw new Error("scan should not issue diagnostic queries");
                }
            );
        });

        it("includes transaction.claimed and refundable failure statuses", async () => {
            const results = await swaps.scanRecoverableSubmarineSwaps();

            const ids = results.map((r) => r.swap.id);
            expect(ids).toContain("claimed-swap-id");
            expect(ids).toContain("failed-swap-id");
        });

        it("excludes pending statuses before inspecting", async () => {
            await swaps.scanRecoverableSubmarineSwaps();

            expect((swaps as any).createVHTLCScript).toHaveBeenCalledTimes(2);
            expect(indexerProvider.getVtxos).toHaveBeenCalledTimes(2);
        });

        it("batches indexer discovery into one spendable and one recoverable query", async () => {
            await swaps.scanRecoverableSubmarineSwaps();

            expect(arkProvider.getInfo).toHaveBeenCalledTimes(1);
            expect(indexerProvider.getVtxos).toHaveBeenCalledTimes(2);
            expect(indexerProvider.getVtxos).toHaveBeenNthCalledWith(1, {
                scripts: ["01", "02"],
                spendableOnly: true,
            });
            expect(indexerProvider.getVtxos).toHaveBeenNthCalledWith(2, {
                scripts: ["01", "02"],
                recoverableOnly: true,
            });
        });

        it("maps batched VTXOs back to the owning swap by script", async () => {
            vi.mocked(indexerProvider.getVtxos).mockImplementation(
                async (opts: any) => {
                    if (opts?.spendableOnly) return { vtxos: [] } as any;
                    if (opts?.recoverableOnly) {
                        return {
                            vtxos: [makeVtxo(lockupTxid, 0, "01", 25000)],
                        } as any;
                    }
                    throw new Error("scan should not issue diagnostic queries");
                }
            );

            const results = await swaps.scanRecoverableSubmarineSwaps();
            const claimed = results.find(
                (r) => r.swap.id === "claimed-swap-id"
            );
            const failed = results.find((r) => r.swap.id === "failed-swap-id");

            expect(claimed).toMatchObject({
                status: "recoverable",
                vtxoCount: 1,
                amountSats: 25000,
            });
            expect(failed).toMatchObject({
                status: "none",
                vtxoCount: 0,
                amountSats: 0,
            });
        });

        it("only loads submarine swaps from the repository", async () => {
            await swaps.scanRecoverableSubmarineSwaps();

            expect(mockSwapRepository.getAllSwaps).toHaveBeenCalledWith({
                type: "submarine",
            });
        });

        it("does not mutate the repository", async () => {
            await swaps.scanRecoverableSubmarineSwaps();

            expect(mockSwapRepository.saveSwap).not.toHaveBeenCalled();
            expect(mockSwapRepository.deleteSwap).not.toHaveBeenCalled();
            expect(mockSwapRepository.clear).not.toHaveBeenCalled();
        });
    });

    describe("recoverSubmarineFunds + recoverAllSubmarineFunds", () => {
        const lockupTxid = hex.encode(randomBytes(32));

        const makeVtxo = (txid: string, vout: number) => ({
            txid,
            vout,
            value: 50000,
            status: { confirmed: true, blockHeight: 100, blockHash: "abc" },
            virtualStatus: { state: "swept" as const },
            isSpent: false,
            isUnrolled: false,
            createdAt: new Date(),
        });

        const claimedSwap: BoltzSubmarineSwap = {
            ...mockSubmarineSwap,
            id: "claimed-swap-id",
            status: "transaction.claimed",
        };
        const failedSwap: BoltzSubmarineSwap = {
            ...mockSubmarineSwap,
            id: "failed-swap-id",
            status: "invoice.failedToPay",
        };

        beforeEach(() => {
            vi.mocked(arkProvider.getInfo).mockResolvedValue(mockArkInfo);
            vi.mocked(wallet.getAddress).mockResolvedValue(mock.address.ark);

            vi.spyOn(swaps as any, "createVHTLCScript").mockReturnValue({
                vhtlcScript: {
                    claimScript: new Uint8Array([1]),
                    pkScript: new Uint8Array([2]),
                    refund: () => [{}, new Uint8Array([3]), 0xc0] as any,
                    refundWithoutReceiver: () =>
                        [{}, new Uint8Array([4]), 0xc0] as any,
                    encode: () => [] as any,
                    options: {
                        refundLocktime:
                            claimedSwap.response.timeoutBlockHeights.refund,
                    },
                },
                vhtlcAddress: claimedSwap.response.address,
            });

            // Default: refundLocktime is a past timestamp (mock data) →
            // CLTV satisfied via wall-clock check, joinBatch path.
            vi.spyOn(swaps as any, "joinBatch").mockResolvedValue(undefined);

            vi.mocked(indexerProvider.getVtxos).mockImplementation(
                async (opts: any) => {
                    if (opts?.spendableOnly) return { vtxos: [] } as any;
                    if (opts?.recoverableOnly)
                        return { vtxos: [makeVtxo(lockupTxid, 0)] } as any;
                    return { vtxos: [makeVtxo(lockupTxid, 0)] } as any;
                }
            );
        });

        describe("recoverSubmarineFunds", () => {
            it("delegates to refundVHTLC and refunds the unspent VTXO", async () => {
                await swaps.recoverSubmarineFunds(claimedSwap);

                const joinBatch = vi.mocked((swaps as any).joinBatch);
                expect(joinBatch).toHaveBeenCalledOnce();
                expect(joinBatch.mock.calls[0][1].txid).toBe(lockupTxid);
            });

            it("does not mutate refundable/refunded flags on a transaction.claimed swap", async () => {
                await swaps.recoverSubmarineFunds(claimedSwap);

                // Flag-skip gate prevents updateSubmarineSwapStatus from
                // running on success-status swaps, so the repository is
                // never touched during stranded-fund recovery.
                expect(mockSwapRepository.saveSwap).not.toHaveBeenCalled();
            });

            it("still updates flags for legitimate failure-status refunds", async () => {
                await swaps.recoverSubmarineFunds(failedSwap);

                expect(mockSwapRepository.saveSwap).toHaveBeenCalledWith(
                    expect.objectContaining({
                        refundable: true,
                        refunded: true,
                    })
                );
            });
        });

        describe("recoverAllSubmarineFunds", () => {
            it("returns one result per swap, marking successful recoveries", async () => {
                const results = await swaps.recoverAllSubmarineFunds([
                    claimedSwap,
                    failedSwap,
                ]);

                expect(results).toEqual([
                    {
                        swapId: "claimed-swap-id",
                        recovered: true,
                        skipped: false,
                    },
                    {
                        swapId: "failed-swap-id",
                        recovered: true,
                        skipped: false,
                    },
                ]);
                expect(arkProvider.getInfo).toHaveBeenCalledTimes(1);
            });

            it("reports per-swap errors without aborting the batch", async () => {
                // Fail the first swap deterministically: address mismatch
                // occurs only for `claimedSwap` because we override
                // createVHTLCScript per-call.
                const createVHTLCScriptSpy = vi.spyOn(
                    swaps as any,
                    "createVHTLCScript"
                );
                createVHTLCScriptSpy.mockImplementationOnce(() => ({
                    vhtlcScript: { claimScript: new Uint8Array([1]) },
                    vhtlcAddress: "ark1-wrong-address",
                }));

                const results = await swaps.recoverAllSubmarineFunds([
                    claimedSwap,
                    failedSwap,
                ]);

                expect(results).toHaveLength(2);
                expect(results[0]).toMatchObject({
                    swapId: "claimed-swap-id",
                    recovered: false,
                    skipped: false,
                });
                expect(results[0].error).toMatch(/address mismatch/i);
                expect(results[1]).toEqual({
                    swapId: "failed-swap-id",
                    recovered: true,
                    skipped: false,
                });
            });

            it("returns an empty array when given no swaps", async () => {
                const results = await swaps.recoverAllSubmarineFunds([]);
                expect(results).toEqual([]);
            });

            it("flags skipped (not recovered) when refundVHTLC sweeps nothing", async () => {
                // Pre-CLTV recoverable VTXO → refundVHTLC returns
                // { swept: 0, skipped: 1 } without throwing. Aggregator must
                // surface that as recovered:false / skipped:true rather than
                // misreporting a successful sweep.
                const preCltvFailed: BoltzSubmarineSwap = {
                    ...failedSwap,
                    response: {
                        ...failedSwap.response,
                        timeoutBlockHeights: {
                            ...failedSwap.response.timeoutBlockHeights,
                            refund: Math.floor(Date.now() / 1000) + 86400,
                        },
                    },
                };

                const results = await swaps.recoverAllSubmarineFunds([
                    preCltvFailed,
                ]);

                expect(results).toEqual([
                    {
                        swapId: "failed-swap-id",
                        recovered: false,
                        skipped: true,
                    },
                ]);
                const joinBatch = vi.mocked((swaps as any).joinBatch);
                expect(joinBatch).not.toHaveBeenCalled();
            });
        });
    });

    // =========================================================================
    // Regressions: VHTLC refund readiness uses wall-clock time, not chain
    // height. Boltz Ark VHTLCs encode `refund` as an absolute Unix timestamp.
    // =========================================================================
    describe("Submarine refund readiness — timestamp vs chain height", () => {
        const lockupTxid = hex.encode(randomBytes(32));

        const makeVtxo = (txid: string, vout: number, value = 50000) => ({
            txid,
            vout,
            value,
            status: { confirmed: true, blockHeight: 100, blockHash: "abc" },
            virtualStatus: { state: "settled" as const },
            isSpent: false,
            isUnrolled: false,
            createdAt: new Date(),
        });

        const failedSwap: BoltzSubmarineSwap = {
            ...mockSubmarineSwap,
            id: "regression-failed-swap-id",
            status: "invoice.failedToPay",
        };

        const swapWithRefund = (refund: number): BoltzSubmarineSwap => ({
            ...failedSwap,
            response: {
                ...failedSwap.response,
                timeoutBlockHeights: {
                    ...failedSwap.response.timeoutBlockHeights,
                    refund,
                },
            },
        });

        beforeEach(() => {
            vi.mocked(arkProvider.getInfo).mockResolvedValue(mockArkInfo);
            vi.mocked(wallet.getAddress).mockResolvedValue(mock.address.ark);

            vi.spyOn(swaps as any, "createVHTLCScript").mockReturnValue({
                vhtlcScript: {
                    claimScript: new Uint8Array([1]),
                    pkScript: new Uint8Array([2]),
                    refund: () => [{}, new Uint8Array([3]), 0xc0] as any,
                    refundWithoutReceiver: () =>
                        [{}, new Uint8Array([4]), 0xc0] as any,
                    encode: () => [] as any,
                    options: {
                        refundLocktime:
                            failedSwap.response.timeoutBlockHeights.refund,
                    },
                },
                vhtlcAddress: failedSwap.response.address,
            });
            vi.spyOn(swaps as any, "joinBatch").mockResolvedValue(undefined);
            vi.mocked(indexerProvider.getVtxos).mockImplementation(
                async (opts: any) => {
                    if (opts?.spendableOnly) return { vtxos: [] } as any;
                    if (opts?.recoverableOnly)
                        return { vtxos: [makeVtxo(lockupTxid, 0)] } as any;
                    return { vtxos: [makeVtxo(lockupTxid, 0)] } as any;
                }
            );
        });

        it("refundVHTLC evaluates CLTV against Date.now(), not chain height", async () => {
            // Refund timestamp 1 second in the past per mocked Date.now().
            const refundTs = 1_800_000_000;
            const dateSpy = vi.spyOn(Date, "now");
            dateSpy.mockReturnValue((refundTs + 1) * 1000);
            const chainHeightSpy = vi.spyOn(swapProvider, "getChainHeight");

            const swap = swapWithRefund(refundTs);
            const outcome = await swaps.refundVHTLC(swap);

            // CLTV satisfied → joinBatch path; no Boltz 3-of-3 attempt.
            expect(outcome.swept).toBe(1);
            expect(outcome.skipped).toBe(0);
            expect(refundVHTLCwithOffchainTx).not.toHaveBeenCalled();
            expect(chainHeightSpy).not.toHaveBeenCalled();
        });

        it("refundVHTLC defers when wall clock is below the refund timestamp", async () => {
            const refundTs = 1_800_000_000;
            const dateSpy = vi.spyOn(Date, "now");
            dateSpy.mockReturnValue((refundTs - 1) * 1000);
            const chainHeightSpy = vi.spyOn(swapProvider, "getChainHeight");

            // Use a recoverable VTXO so the Boltz 3-of-3 path is blocked
            // (canRecoverViaBoltz3of3 returns false) — the only outcome is
            // a deferred skip when CLTV hasn't been reached.
            vi.mocked(indexerProvider.getVtxos).mockImplementation(
                async (opts: any) => {
                    if (opts?.recoverableOnly) {
                        return {
                            vtxos: [
                                {
                                    ...makeVtxo(lockupTxid, 0),
                                    virtualStatus: {
                                        state: "swept" as const,
                                    },
                                },
                            ],
                        } as any;
                    }
                    return { vtxos: [] } as any;
                }
            );

            const swap = swapWithRefund(refundTs);
            const outcome = await swaps.refundVHTLC(swap);

            expect(outcome.swept).toBe(0);
            expect(outcome.skipped).toBe(1);
            expect(chainHeightSpy).not.toHaveBeenCalled();
        });

        it("scanRecoverableSubmarineSwaps does not query chain height", async () => {
            vi.mocked(mockSwapRepository.getAllSwaps).mockResolvedValue([
                swapWithRefund(1_800_000_000),
            ]);
            vi.mocked(indexerProvider.getVtxos).mockImplementation(
                async (opts: any) => {
                    if (opts?.spendableOnly) return { vtxos: [] } as any;
                    if (opts?.recoverableOnly) return { vtxos: [] } as any;
                    throw new Error("scan should not issue diagnostic queries");
                }
            );
            const chainHeightSpy = vi.spyOn(swapProvider, "getChainHeight");

            await swaps.scanRecoverableSubmarineSwaps();

            expect(chainHeightSpy).not.toHaveBeenCalled();
        });

        it("recoverAllSubmarineFunds does not query chain height", async () => {
            const refundTs = 1_800_000_000;
            const dateSpy = vi.spyOn(Date, "now");
            dateSpy.mockReturnValue((refundTs + 1) * 1000);
            const chainHeightSpy = vi.spyOn(swapProvider, "getChainHeight");

            const results = await swaps.recoverAllSubmarineFunds([
                swapWithRefund(refundTs),
            ]);

            expect(results[0]).toMatchObject({ recovered: true });
            expect(chainHeightSpy).not.toHaveBeenCalled();
        });

        it("handles prod-shaped Boltz Ark VHTLC timeouts (timestamp + BIP68 seconds)", () => {
            // refund: absolute Unix timestamp (mainnet-shaped, ~2026-05-14).
            // unilateral*: BIP68 relative delays in seconds, multiples of 512.
            const prodTimeouts = {
                refund: 1778741659,
                unilateralClaim: 266752,
                unilateralRefund: 432128,
                unilateralRefundWithoutReceiver: 518656,
            };
            // Sanity-check: BIP68 type-flag boundary is 512.
            expect(prodTimeouts.unilateralClaim).toBeGreaterThanOrEqual(512);
            expect(prodTimeouts.unilateralRefund).toBeGreaterThanOrEqual(512);
            expect(
                prodTimeouts.unilateralRefundWithoutReceiver
            ).toBeGreaterThanOrEqual(512);
            expect(prodTimeouts.unilateralClaim % 512).toBe(0);
            expect(prodTimeouts.unilateralRefund % 512).toBe(0);
            expect(prodTimeouts.unilateralRefundWithoutReceiver % 512).toBe(0);

            // The real script builder accepts prod values without throwing.
            // Bypass the describe-scoped createVHTLCScript spy.
            expect(() =>
                createVHTLCScriptReal({
                    network: "regtest",
                    preimageHash: mockPreimageHash,
                    receiverPubkey: compressedPubkeys.boltz,
                    senderPubkey: compressedPubkeys.alice,
                    serverPubkey: hex.encode(mock.pubkeys.server),
                    timeoutBlockHeights: prodTimeouts,
                })
            ).not.toThrow();
        });
    });
});
