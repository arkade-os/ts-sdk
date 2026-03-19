import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { ArkadeSwaps } from "../../src/arkade-swaps";
import {
    BoltzSwapProvider,
    BoltzSwapStatus,
    CreateSubmarineSwapRequest,
} from "../../src/boltz-swap-provider";
import type {
    PendingReverseSwap,
    PendingSubmarineSwap,
    ArkadeSwapsConfig,
} from "../../src/types";
import {
    RestArkProvider,
    RestIndexerProvider,
    Identity,
    Wallet,
    SingleKey,
    EsploraProvider,
    ArkNote,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { decodeInvoice } from "../../src/utils/decoding";
import { pubECDSA, sha256 } from "@scure/btc-signer/utils.js";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const lncli = "docker exec -i lnd lncli --network=regtest";
const bccli = "docker exec -t bitcoin bitcoin-cli -regtest";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const generateBlocks = async (numBlocks = 1) => {
    await execAsync(`nigiri rpc --generate ${numBlocks}`);
};

// Lightning helpers
const cancelInvoice = async (r_hash: string) => {
    return execAsync(`${lncli} cancelinvoice ${r_hash}`);
};

const payInvoice = async (invoice: string) => {
    return execAsync(`${lncli} payinvoice --force ${invoice}`);
};

const getNewLightningInvoice = async (
    amount: number
): Promise<{ invoice: string; r_hash: string }> => {
    const { stdout } = await execAsync(`${lncli} addinvoice --amt ${amount}`);
    const output = stdout.trim();
    const { payment_request, r_hash } = JSON.parse(output);
    return { invoice: payment_request, r_hash };
};

// BTC helpers
const fundBtcAddress = async (address: string, amount: number) => {
    await execAsync(`${bccli} sendtoaddress ${address} ${amount / 1e8}`);
    await waitForBtcTxConfirmation(address);
};

const getBtcAddress = async (): Promise<string> => {
    const { stdout } = await execAsync(`${bccli} getnewaddress`);
    return stdout.trim();
};

const getBtcAddressFunds = async (address: string): Promise<number> => {
    const { stdout } = await execAsync(
        `curl -s http://localhost:3000/address/${address}`
    );
    const outputJson = JSON.parse(stdout);
    return (
        outputJson.chain_stats.funded_txo_sum -
        outputJson.chain_stats.spent_txo_sum +
        outputJson.mempool_stats.funded_txo_sum -
        outputJson.mempool_stats.spent_txo_sum
    );
};

const getBtcAddressTxs = async (address: string): Promise<number> => {
    const { stdout } = await execAsync(
        `curl -s http://localhost:3000/address/${address}`
    );
    const outputJson = JSON.parse(stdout);
    return outputJson.chain_stats.tx_count + outputJson.mempool_stats.tx_count;
};

const getBtcAddressTxUtxos = async (address: string): Promise<any[]> => {
    const { stdout } = await execAsync(
        `curl -s http://localhost:3000/address/${address}/utxo`
    );
    return JSON.parse(stdout);
};

const waitForBtcTxConfirmation = async (address: string, timeout = 10_000) => {
    await generateBlocks(1);
    await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            clearInterval(intervalId);
            reject(new Error("Timed out waiting for Btc explorer to update"));
        }, timeout);
        const intervalId = setInterval(async () => {
            const txs = await getBtcAddressTxs(address);
            if (txs === 1) {
                clearTimeout(timeoutId);
                clearInterval(intervalId);
                resolve(true);
            }
        }, 500);
    });
};

const waitForBtcTxClaimed = async (address: string, timeout = 10_000) => {
    await generateBlocks(1);
    await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            clearInterval(intervalId);
            reject(new Error("Timed out waiting for Btc explorer to update"));
        }, timeout);
        const intervalId = setInterval(async () => {
            const utxos = await getBtcAddressTxUtxos(address);
            if (utxos.length === 0) {
                clearTimeout(timeoutId);
                clearInterval(intervalId);
                resolve(true);
            }
        }, 500);
    });
};

const waitForBalance = async (
    getBalance: () => Promise<{ available: number }>,
    minAmount: number,
    timeout = 5_000
): Promise<void> => {
    await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            clearInterval(intervalId);
            reject(new Error("Timed out waiting for balance"));
        }, timeout);
        const intervalId = setInterval(async () => {
            try {
                const balance = await getBalance();
                if (balance.available >= minAmount) {
                    clearTimeout(timeoutId);
                    clearInterval(intervalId);
                    resolve(true);
                }
            } catch (err) {
                clearTimeout(timeoutId);
                clearInterval(intervalId);
                reject(err);
            }
        }, 500);
    });
};

/**
 * Wait until at least one VTXO from the given wallet is in `settled` state.
 * This is used instead of a fixed sleep to avoid the race where a slow CI
 * runner hasn't finished the round yet when we try to spend.
 */
const waitForSettled = async (
    getVtxos: () => Promise<{ virtualStatus: { state: string } }[]>,
    timeout = 15_000
): Promise<void> => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const vtxos = await getVtxos();
        if (vtxos.some((v) => v.virtualStatus.state === "settled")) return;
        await sleep(500);
    }
    throw new Error("Timed out waiting for VTXO to reach settled state");
};

describe("ArkadeSwaps", () => {
    let indexerProvider: RestIndexerProvider;
    let swapProvider: BoltzSwapProvider;
    let arkProvider: RestArkProvider;
    let swaps: ArkadeSwaps;
    let identity: Identity;
    let wallet: Wallet;

    let aliceSecKey: Uint8Array;
    let aliceCompressedPubKey: string;
    let fundedWallet: Wallet;

    const arkUrl = "http://localhost:7070";

    const fundWallet = async (amount: number): Promise<void> => {
        await fundedWallet.send({
            address: await wallet.getAddress(),
            amount,
        });

        // Wait until the funds are reflected in the wallet balance
        await waitForBalance(() => wallet.getBalance(), amount, 5_000);
    };

    const waitForSwapStatus = async (
        swapId: string,
        intendedStatus: BoltzSwapStatus,
        timeout = 3_000
    ): Promise<void> => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const { status } = await swapProvider.getSwapStatus(swapId);
            if (status === intendedStatus) return;
            await sleep(200);
        }
        throw new Error(
            `Swap did not reach status ${intendedStatus} within timeout`
        );
    };

    // Funded wallet setup
    beforeAll(async () => {
        fundedWallet = await Wallet.create({
            identity: SingleKey.fromRandomBytes(),
            arkServerUrl: arkUrl,
            settlementConfig: false,
        });

        const amount = 1_000_000;

        const { stdout: arknote } = await execAsync(
            `docker exec -t arkd arkd note --amount ${amount}`
        );

        await fundedWallet.settle({
            inputs: [ArkNote.fromString(arknote.trim())],
            outputs: [
                {
                    address: await fundedWallet.getAddress(),
                    amount: BigInt(amount),
                },
            ],
        });

        await waitForBalance(() => fundedWallet.getBalance(), amount, 5_000);
    }, 120_000);

    beforeEach(async () => {
        // Create identity
        aliceSecKey = schnorr.utils.randomSecretKey();
        aliceCompressedPubKey = hex.encode(pubECDSA(aliceSecKey, true));
        identity = SingleKey.fromPrivateKey(aliceSecKey);

        // Create providers
        arkProvider = new RestArkProvider(arkUrl);
        indexerProvider = new RestIndexerProvider(arkUrl);
        swapProvider = new BoltzSwapProvider({ network: "regtest" });

        // Create wallet
        wallet = await Wallet.create({
            identity,
            arkServerUrl: arkUrl,
            settlementConfig: false,
            onchainProvider: new EsploraProvider("http://localhost:3000", {
                forcePolling: true,
                pollingInterval: 2000,
            }),
        });

        // Create ArkadeSwaps instance (disable SwapManager for manual swap tests)
        swaps = new ArkadeSwaps({
            wallet,
            swapProvider,
            arkProvider,
            indexerProvider,
            swapManager: false,
        });

        // Mock console.error to avoid polluting test output
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    describe("Initialization", () => {
        it("should be instantiated with wallet and swap provider", () => {
            expect(
                () =>
                    new ArkadeSwaps({
                        wallet,
                        arkProvider,
                        swapProvider,
                        indexerProvider,
                    })
            ).not.toThrow();
        });

        it("should fail to instantiate without required config", async () => {
            const config: ArkadeSwapsConfig = {
                wallet,
                arkProvider,
                swapProvider,
                indexerProvider,
            };

            expect(
                () =>
                    new ArkadeSwaps({
                        ...config,
                        wallet: null as any,
                    })
            ).toThrow("Wallet is required.");

            expect(
                () =>
                    new ArkadeSwaps({
                        ...config,
                        swapProvider: null as any,
                    })
            ).toThrow("Swap provider is required.");
        });

        it("should default to wallet instances without required config", async () => {
            expect(
                () =>
                    new ArkadeSwaps({
                        wallet,
                        swapProvider,
                        indexerProvider,
                        arkProvider: null as any,
                    })
            ).not.toThrow();
            expect(
                () =>
                    new ArkadeSwaps({
                        wallet,
                        arkProvider,
                        swapProvider,
                        indexerProvider: null as any,
                    })
            ).not.toThrow();
        });

        it("should have expected interface methods", () => {
            // Lightning methods
            expect(swaps.claimVHTLC).toBeInstanceOf(Function);
            expect(swaps.createLightningInvoice).toBeInstanceOf(Function);
            expect(swaps.createReverseSwap).toBeInstanceOf(Function);
            expect(swaps.createSubmarineSwap).toBeInstanceOf(Function);
            expect(swaps.createVHTLCScript).toBeInstanceOf(Function);
            expect(swaps.getFees).toBeInstanceOf(Function);
            expect(swaps.getLimits).toBeInstanceOf(Function);
            expect(swaps.getPendingSubmarineSwaps).toBeInstanceOf(Function);
            expect(swaps.getPendingReverseSwaps).toBeInstanceOf(Function);
            expect(swaps.getSwapHistory).toBeInstanceOf(Function);
            expect(swaps.getSwapStatus).toBeInstanceOf(Function);
            expect(swaps.refreshSwapsStatus).toBeInstanceOf(Function);
            expect(swaps.refundVHTLC).toBeInstanceOf(Function);
            expect(swaps.sendLightningPayment).toBeInstanceOf(Function);
            expect(swaps.waitAndClaim).toBeInstanceOf(Function);
            expect(swaps.waitForSwapSettlement).toBeInstanceOf(Function);
            // Chain methods
            expect(swaps.arkToBtc).toBeInstanceOf(Function);
            expect(swaps.btcToArk).toBeInstanceOf(Function);
            expect(swaps.createChainSwap).toBeInstanceOf(Function);
            expect(swaps.verifyChainSwap).toBeInstanceOf(Function);
            expect(swaps.waitAndClaimArk).toBeInstanceOf(Function);
            expect(swaps.waitAndClaimBtc).toBeInstanceOf(Function);
            expect(swaps.claimBtc).toBeInstanceOf(Function);
            expect(swaps.claimArk).toBeInstanceOf(Function);
            expect(swaps.getPendingChainSwaps).toBeInstanceOf(Function);
            expect(swaps.quoteSwap).toBeInstanceOf(Function);
        });
    });

    // ==========================================
    // Lightning Operations
    // ==========================================

    describe("Lightning: Fees and Limits", () => {
        it("should fetch fees", async () => {
            const fees = await swaps.getFees();
            expect(typeof fees.reverse.percentage).toBe("number");
            expect(typeof fees.reverse.minerFees.claim).toBe("number");
            expect(typeof fees.reverse.minerFees.lockup).toBe("number");
            expect(typeof fees.submarine.percentage).toBe("number");
            expect(typeof fees.submarine.minerFees).toBe("number");
        });

        it("should fetch limits", async () => {
            const limits = await swaps.getLimits();
            expect(typeof limits.min).toBe("number");
            expect(typeof limits.max).toBe("number");
        });
    });

    describe("Lightning: Receive from Lightning", () => {
        describe("createLightningInvoice", () => {
            it("should throw if amount is not > 0", async () => {
                await expect(
                    swaps.createLightningInvoice({ amount: 0 })
                ).rejects.toThrow("Amount must be greater than 0");

                await expect(
                    swaps.createLightningInvoice({ amount: -1 })
                ).rejects.toThrow("Amount must be greater than 0");
            });

            it("should create a valid Lightning invoice", async () => {
                const amount = 2100;
                const result = await swaps.createLightningInvoice({ amount });
                const decodeInvoiceResult = decodeInvoice(result.invoice);
                expect(decodeInvoiceResult.amountSats).toBe(amount);
            });

            it("should create a Lightning invoice with description", async () => {
                const amount = 1000;
                const description = "Test payment description";
                const result = await swaps.createLightningInvoice({
                    amount,
                    description,
                });
                const decodeInvoiceResult = decodeInvoice(result.invoice);
                expect(decodeInvoiceResult.amountSats).toBe(amount);
                expect(decodeInvoiceResult.description).toBe(description);
            });

            it("should return a valid response object", async () => {
                const amount = 1500;
                const description = "Another test payment";
                const result = await swaps.createLightningInvoice({
                    amount,
                    description,
                });
                expect(result.expiry).toBeTypeOf("number");
                expect(result.invoice).toMatch(/^lnbcrt/);
                expect(result.paymentHash).toHaveLength(64);
                expect(result.preimage).toHaveLength(64);
            });

            it("should create a invoice with minimal amount", async () => {
                const { min: amount } = await swaps.getLimits();
                const description = "Another test payment";
                const result = await swaps.createLightningInvoice({
                    amount,
                    description,
                });
                expect(result.expiry).toBeTypeOf("number");
                expect(result.invoice).toMatch(/^lnbcrt/);
                expect(result.paymentHash).toHaveLength(64);
                expect(result.preimage).toHaveLength(64);
            });
        });

        describe("createReverseSwap", () => {
            it("should create a reverse swap", async () => {
                const amount = 1000;
                const description = "Test reverse swap";
                const pendingSwap = await swaps.createReverseSwap({
                    amount,
                    description,
                });

                const preimageHash = hex.encode(
                    sha256(hex.decode(pendingSwap.preimage))
                );

                expect(pendingSwap.status).toEqual("swap.created");
                expect(pendingSwap.preimage).toHaveLength(64);
                expect(pendingSwap.request.invoiceAmount).toEqual(amount);
                expect(pendingSwap.request.preimageHash).toBe(preimageHash);
                expect(pendingSwap.request.description).toEqual(description);
                expect(pendingSwap.request.claimPublicKey).toEqual(
                    aliceCompressedPubKey
                );
                expect(pendingSwap.response).toHaveProperty("id");
                expect(pendingSwap.response.invoice).toMatch(/^lnbcrt/);
                expect(pendingSwap.response.lockupAddress).toMatch(/^tark1/);
                expect(pendingSwap.response).toHaveProperty("refundPublicKey");
                expect(pendingSwap.response.onchainAmount).toBeLessThan(amount);
            });

            it("should get correct swap status", async () => {
                const amount = 1000;
                const pendingSwap = await swaps.createReverseSwap({ amount });
                expect(swaps.getSwapStatus).toBeInstanceOf(Function);
                const status = await swaps.getSwapStatus(pendingSwap.id);
                expect(status.status).toBe("swap.created");
            });

            it("should pass description to swap provider when creating reverse swap", async () => {
                const amount = 1000;
                const description = "Test reverse swap description";
                const pendingSwap = await swaps.createReverseSwap({
                    amount,
                    description,
                });
                const decodeInvoiceResult = decodeInvoice(
                    pendingSwap.response.invoice
                );
                expect(decodeInvoiceResult.amountSats).toBe(amount);
                expect(decodeInvoiceResult.description).toBe(description);
            });

            it(
                "should increase balance when invoice is paid",
                { timeout: 10_000 },
                async () => {
                    const amount = 1000;
                    const balanceBefore = await wallet.getBalance();
                    const pendingSwap = await swaps.createReverseSwap({
                        amount,
                    });

                    sleep(1000).then(() =>
                        payInvoice(pendingSwap.response.invoice).catch((err) =>
                            console.error("Error paying invoice:", err)
                        )
                    );

                    await swaps.waitAndClaim(pendingSwap);
                    await sleep(2000);
                    const balanceAfter = await wallet.getBalance();
                    expect(balanceAfter.available).toBeGreaterThan(
                        balanceBefore.available
                    );
                }
            );
        });

        describe("waitAndClaim", () => {
            it("should claim a reverse swap when invoice is settled", async () => {
                const pendingSwap = await swaps.createReverseSwap({
                    amount: 1000,
                });
                sleep(1000).then(() =>
                    payInvoice(pendingSwap.response.invoice).catch((err) =>
                        console.error("Error paying invoice:", err)
                    )
                );
                const response = await swaps.waitAndClaim(pendingSwap);
                expect(response).toHaveProperty("txid");
                expect(response.txid).toHaveLength(64);
            });
        });
    });

    describe("Lightning: Send to Lightning", () => {
        describe("sendLightningPayment", () => {
            it("should send a Lightning payment", async () => {
                const amount = 1000;
                const fundAmount = amount + 10;
                await fundWallet(fundAmount);
                const balanceBefore = await wallet.getBalance();
                const { invoice, r_hash } =
                    await getNewLightningInvoice(amount);

                const result = await swaps.sendLightningPayment({ invoice });

                const preimageHash = hex.encode(
                    sha256(hex.decode(result.preimage))
                );

                expect(result.amount).toBeGreaterThan(amount);
                expect(result.txid).toHaveLength(64);
                expect(r_hash).toBe(preimageHash);
                expect(balanceBefore.available).toEqual(fundAmount);
                const balanceAfter = await wallet.getBalance();
                expect(balanceAfter.available).toBeLessThan(
                    balanceBefore.available - amount
                );
            });

            it("should send a Lightning payment with minimal amount", async () => {
                const { min: amount } = await swaps.getLimits();
                const fundAmount = amount + 10;
                await fundWallet(fundAmount);
                const balanceBefore = await wallet.getBalance();
                const { invoice, r_hash } =
                    await getNewLightningInvoice(amount);

                const result = await swaps.sendLightningPayment({ invoice });

                const preimageHash = hex.encode(
                    sha256(hex.decode(result.preimage))
                );

                expect(result.amount).toBeGreaterThan(amount);
                expect(result.txid).toHaveLength(64);
                expect(r_hash).toBe(preimageHash);
                expect(balanceBefore.available).toEqual(fundAmount);
                const balanceAfter = await wallet.getBalance();
                expect(balanceAfter.available).toBeLessThan(
                    balanceBefore.available - amount
                );
            });
        });

        describe("createSubmarineSwap", () => {
            it("should create a submarine swap", async () => {
                const amount = 1000;
                const expectedAmount = amount + 1;
                const { invoice } = await getNewLightningInvoice(amount);
                expect(invoice).toContain("lnbcrt");

                const expectedRequest: CreateSubmarineSwapRequest = {
                    refundPublicKey: aliceCompressedPubKey,
                    invoice,
                };

                const pendingSwap = await swaps.createSubmarineSwap({
                    invoice,
                });

                const { request, response, status } = pendingSwap;
                expect(status).toEqual("invoice.set");
                expect(request).toEqual(expectedRequest);
                expect(response.address).toMatch(/^tark1/);
                expect(response.expectedAmount).toBe(expectedAmount);
                expect(response.timeoutBlockHeights).toBeDefined();
                expect(response.timeoutBlockHeights.refund).toBeTypeOf(
                    "number"
                );
                expect(response.timeoutBlockHeights.unilateralClaim).toBeTypeOf(
                    "number"
                );
                expect(
                    response.timeoutBlockHeights.unilateralRefund
                ).toBeTypeOf("number");
                expect(
                    response.timeoutBlockHeights.unilateralRefundWithoutReceiver
                ).toBeTypeOf("number");
            });

            it("should get correct swap status", async () => {
                const amount = 1000;
                const { invoice } = await getNewLightningInvoice(amount);
                const pendingSwap = await swaps.createSubmarineSwap({
                    invoice,
                });
                const status = await swaps.getSwapStatus(pendingSwap.id);
                expect(status.status).toBe("invoice.set");
            });
        });

        describe("waitForSwapSettlement", () => {
            it("should return preimage", async () => {
                const amount = 1000;
                const fundAmount = amount + 10;
                await fundWallet(fundAmount);
                const { invoice, r_hash } =
                    await getNewLightningInvoice(amount);

                const pendingSwap = await swaps.createSubmarineSwap({
                    invoice,
                });

                await wallet.send({
                    address: pendingSwap.response.address,
                    amount: pendingSwap.response.expectedAmount,
                });

                const { preimage } =
                    await swaps.waitForSwapSettlement(pendingSwap);

                const preimageHash = hex.encode(sha256(hex.decode(preimage)));

                expect(preimage).toBeDefined();
                expect(preimage).toHaveLength(64);
                expect(preimageHash).toBe(r_hash);
            });
        });

        describe("refundVHTLC", () => {
            it(
                "should automatically refund failed submarine swap",
                { timeout: 120_000 },
                async () => {
                    const amount = 1000;
                    const fundAmount = amount + 10;
                    await fundWallet(fundAmount);

                    const res = await getNewLightningInvoice(amount);
                    await cancelInvoice(res.r_hash);

                    await expect(
                        swaps.sendLightningPayment({
                            invoice: res.invoice,
                        })
                    ).rejects.toThrow();

                    await sleep(1000);

                    const swapHistory = await swaps.getSwapHistory();
                    expect(swapHistory.length).toBeGreaterThanOrEqual(1);
                    const failedSwap = swapHistory[0] as PendingSubmarineSwap;
                    expect(failedSwap.status).toBe("invoice.failedToPay");
                }
            );

            it.skip(
                "should recover swept VHTLCs",
                { timeout: 120_000 },
                async () => {
                    const amount = 1000;
                    const fundAmount = 2 * amount;
                    await fundWallet(fundAmount);
                    const res = await getNewLightningInvoice(amount);
                    await cancelInvoice(res.r_hash);

                    const pendingSwap = await swaps.createSubmarineSwap({
                        invoice: res.invoice,
                    });

                    await wallet.send({
                        address: pendingSwap.response.address,
                        amount: pendingSwap.response.expectedAmount,
                    });

                    await sleep(1000);

                    const intermediateBalance = await wallet.getBalance();

                    await generateBlocks(21);
                    await sleep(30_000);

                    await swaps.refundVHTLC(pendingSwap);
                    await sleep(1500);

                    expect(intermediateBalance.available).toEqual(
                        fundAmount - pendingSwap.response.expectedAmount
                    );
                    const balance = await wallet.getBalance();
                    expect(balance.available).toBe(fundAmount);
                }
            );
        });
    });

    // ==========================================
    // Chain Operations
    // ==========================================

    describe("Chain: Fees and Limits", () => {
        it("should fetch fees for Ark to Btc chain swap", async () => {
            const fees = await swaps.getFees("ARK", "BTC");
            expect(typeof fees.percentage).toBe("number");
            expect(typeof fees.minerFees.server).toBe("number");
            expect(typeof fees.minerFees.user.claim).toBe("number");
            expect(typeof fees.minerFees.user.lockup).toBe("number");
        });

        it("should fetch fees for Btc to Ark chain swap", async () => {
            const fees = await swaps.getFees("BTC", "ARK");
            expect(typeof fees.percentage).toBe("number");
            expect(typeof fees.minerFees.server).toBe("number");
            expect(typeof fees.minerFees.user.claim).toBe("number");
            expect(typeof fees.minerFees.user.lockup).toBe("number");
        });

        it("should fetch limits for Ark to Btc chain swap", async () => {
            const limits = await swaps.getLimits("ARK", "BTC");
            expect(typeof limits.min).toBe("number");
            expect(typeof limits.max).toBe("number");
        });

        it("should fetch limits for Btc to Ark chain swap", async () => {
            const limits = await swaps.getLimits("BTC", "ARK");
            expect(typeof limits.min).toBe("number");
            expect(typeof limits.max).toBe("number");
        });
    });

    describe("Chain: Ark to Btc swap", () => {
        describe("arkToBtc", () => {
            it("should throw on invalid Btc address", async () => {
                await expect(
                    swaps.arkToBtc({
                        btcAddress: "",
                        senderLockAmount: 21000,
                    })
                ).rejects.toThrow("Destination address is required");
            });

            it("should throw on invalid amount", async () => {
                await expect(
                    swaps.arkToBtc({
                        senderLockAmount: 0,
                        btcAddress: await getBtcAddress(),
                    })
                ).rejects.toThrow("Invalid lock amount");
            });

            it("should create a ark payment with senderLockAmount", async () => {
                const amountSats = 21000;
                const fundAmount = amountSats + 2100;
                await fundWallet(fundAmount);

                const response = await swaps.arkToBtc({
                    btcAddress: await getBtcAddress(),
                    senderLockAmount: amountSats,
                });

                expect(response).toHaveProperty("arkAddress");
                expect(response).toHaveProperty("amountToPay");
                expect(response).toHaveProperty("pendingSwap");
                expect(response.pendingSwap).toHaveProperty("id");
                expect(response.pendingSwap).toHaveProperty("request");
                expect(response.pendingSwap).toHaveProperty("response");
                expect(response.pendingSwap).toHaveProperty("preimage");
                expect(response.pendingSwap).toHaveProperty("createdAt");
                expect(response.pendingSwap).toHaveProperty("ephemeralKey");
                expect(response.pendingSwap).toHaveProperty("feeSatsPerByte");
                expect(response.arkAddress.length).toBeGreaterThan(21);
                expect(response.amountToPay).toEqual(amountSats);
            });

            it("should create a ark payment with receiverLockAmount", async () => {
                const amountSats = 21000;
                const fundAmount = amountSats + 2100;
                await fundWallet(fundAmount);

                const response = await swaps.arkToBtc({
                    receiverLockAmount: amountSats,
                    btcAddress: await getBtcAddress(),
                });

                expect(response).toHaveProperty("arkAddress");
                expect(response).toHaveProperty("amountToPay");
                expect(response).toHaveProperty("pendingSwap");
                expect(response.arkAddress.length).toBeGreaterThan(21);
                expect(response.amountToPay).toBeGreaterThan(amountSats);
            });

            it(
                "should perform Ark to Btc chain swap successfully",
                { timeout: 10_000 },
                async () => {
                    const amountSats = 21000;
                    const fundAmount = amountSats + 2100;
                    const btcAddress = await getBtcAddress();
                    await fundWallet(fundAmount);
                    const initialArkBalance = await wallet.getBalance();
                    const initialBtcTxs = await getBtcAddressTxs(btcAddress);

                    const { arkAddress, amountToPay, pendingSwap } =
                        await swaps.arkToBtc({
                            receiverLockAmount: amountSats,
                            btcAddress,
                        });

                    await wallet.send({
                        address: arkAddress,
                        amount: amountToPay,
                    });

                    await swaps.waitAndClaimBtc(pendingSwap);
                    await waitForBtcTxConfirmation(btcAddress);

                    expect(pendingSwap.type).toEqual("chain");
                    expect(pendingSwap.toAddress).toEqual(btcAddress);
                    expect(pendingSwap.request.to).toEqual("BTC");
                    expect(pendingSwap.request.from).toEqual("ARK");
                    expect(pendingSwap.request.refundPublicKey).toEqual(
                        aliceCompressedPubKey
                    );

                    const finalArkBalance = await wallet.getBalance();
                    expect(finalArkBalance.available).toBeLessThan(
                        initialArkBalance.available
                    );

                    const finalBtcTxs = await getBtcAddressTxs(btcAddress);
                    expect(initialBtcTxs).toEqual(0);
                    expect(finalBtcTxs).toEqual(1);

                    const { status } = await swaps.getSwapStatus(
                        pendingSwap.id
                    );
                    expect(status).toEqual("transaction.claimed");
                }
            );

            it(
                "should perform a Ark to Btc chain swap with minimal amount",
                { timeout: 10_000 },
                async () => {
                    const { min: amountSats } = await swaps.getLimits(
                        "ARK",
                        "BTC"
                    );
                    const fundAmount = amountSats + 2100;
                    const btcAddress = await getBtcAddress();
                    await fundWallet(fundAmount);

                    const { arkAddress, amountToPay, pendingSwap } =
                        await swaps.arkToBtc({
                            receiverLockAmount: amountSats,
                            btcAddress,
                        });

                    await wallet.send({
                        address: arkAddress,
                        amount: amountToPay,
                    });

                    await swaps.waitAndClaimBtc(pendingSwap);
                    await waitForBtcTxConfirmation(btcAddress);

                    expect(pendingSwap.type).toEqual("chain");
                    expect(pendingSwap.request.to).toEqual("BTC");
                    expect(pendingSwap.request.from).toEqual("ARK");

                    const { status } = await swaps.getSwapStatus(
                        pendingSwap.id
                    );
                    expect(status).toEqual("transaction.claimed");
                }
            );
        });

        describe("createChainSwap (Ark to Btc)", () => {
            it(
                "should send exact amount to btc address",
                { timeout: 10_000 },
                async () => {
                    const amountSats = 4000;
                    const fundAmount = 5000;
                    const toAddress = await getBtcAddress();
                    await fundWallet(fundAmount);

                    const swap = await swaps.createChainSwap({
                        to: "BTC",
                        from: "ARK",
                        feeSatsPerByte: 1,
                        receiverLockAmount: amountSats,
                        toAddress,
                    });

                    await wallet.send({
                        address: swap.response.lockupDetails.lockupAddress,
                        amount: swap.response.lockupDetails.amount,
                    });

                    await swaps.waitAndClaimBtc(swap);

                    await waitForBalance(
                        async () => ({
                            available: await getBtcAddressFunds(toAddress),
                        }),
                        1,
                        5_000
                    );

                    const finalArkBalance = await wallet.getBalance();
                    expect(finalArkBalance.available).toEqual(
                        fundAmount - swap.response.lockupDetails.amount
                    );

                    const btcBalance = await getBtcAddressFunds(toAddress);
                    expect(btcBalance).toEqual(amountSats);
                }
            );

            it(
                "should send less than amount to btc address",
                { timeout: 10_000 },
                async () => {
                    const amountSats = 4000;
                    const fundAmount = 5000;
                    const toAddress = await getBtcAddress();
                    await fundWallet(fundAmount);

                    const swap = await swaps.createChainSwap({
                        to: "BTC",
                        from: "ARK",
                        feeSatsPerByte: 1,
                        senderLockAmount: amountSats,
                        toAddress,
                    });

                    await wallet.send({
                        address: swap.response.lockupDetails.lockupAddress,
                        amount: swap.response.lockupDetails.amount,
                    });

                    await swaps.waitAndClaimBtc(swap);

                    await waitForBalance(
                        async () => ({
                            available: await getBtcAddressFunds(toAddress),
                        }),
                        1,
                        5_000
                    );

                    const finalArkBalance = await wallet.getBalance();
                    expect(finalArkBalance.available).toEqual(
                        fundAmount - amountSats
                    );

                    const btcBalance = await getBtcAddressFunds(toAddress);
                    expect(btcBalance).toBeLessThan(amountSats);
                    expect(btcBalance).toBeGreaterThan(0);
                }
            );

            it(
                "should automatically refund if Ark to Btc chain swap fails",
                { timeout: 10_000 },
                async () => {
                    const amountSats = 21000;
                    const fundAmount = 23000;
                    const sendAmount = 10000;
                    await fundWallet(fundAmount);
                    const toAddress = await getBtcAddress();

                    const swap = await swaps.createChainSwap({
                        to: "BTC",
                        from: "ARK",
                        feeSatsPerByte: 1,
                        senderLockAmount: amountSats,
                        toAddress,
                    });

                    await wallet.send({
                        address: swap.response.lockupDetails.lockupAddress,
                        amount: sendAmount,
                    });

                    await waitForSwapStatus(
                        swap.id,
                        "transaction.lockupFailed"
                    );

                    const afterSwapBalance = await wallet.getBalance();

                    await swaps.refundArk(swap);

                    await waitForBalance(
                        () => wallet.getBalance(),
                        fundAmount,
                        2000
                    );

                    const afterRefundBalance = await wallet.getBalance();

                    expect(afterSwapBalance.available).toEqual(
                        fundAmount - sendAmount
                    );
                    expect(afterRefundBalance.available).toEqual(fundAmount);
                }
            );
        });
    });

    describe("Chain: Btc to Ark swap", () => {
        describe("btcToArk", () => {
            it("should throw on invalid amount", async () => {
                await expect(
                    swaps.btcToArk({
                        receiverLockAmount: 0,
                    })
                ).rejects.toThrow("Invalid lock amount");
            });

            it("should generate a btc payment with senderLockAmount", async () => {
                const amountSats = 21000;
                const response = await swaps.btcToArk({
                    senderLockAmount: amountSats,
                });
                expect(response).toHaveProperty("btcAddress");
                expect(response).toHaveProperty("amountToPay");
                expect(response).toHaveProperty("pendingSwap");
                expect(response.btcAddress.length).toBeGreaterThan(21);
                expect(response.amountToPay).toEqual(amountSats);
            });

            it("should generate a btc payment with receiverLockAmount", async () => {
                const amountSats = 21000;
                const response = await swaps.btcToArk({
                    receiverLockAmount: amountSats,
                });
                expect(response).toHaveProperty("btcAddress");
                expect(response).toHaveProperty("amountToPay");
                expect(response).toHaveProperty("pendingSwap");
                expect(response.btcAddress.length).toBeGreaterThan(21);
                expect(response.amountToPay).toBeGreaterThan(amountSats);
            });

            it("serverLockAmount should be amount + claim fees", async () => {
                const amountSats = 21000;
                const fees = await swaps.getFees("BTC", "ARK");
                const response = await swaps.btcToArk({
                    receiverLockAmount: amountSats,
                });
                expect(response.pendingSwap.request.serverLockAmount).toEqual(
                    amountSats + fees.minerFees.user.claim
                );
            });

            it(
                "should perform Btc to Ark chain swap successfully",
                { timeout: 10_000 },
                async () => {
                    const amountSats = 21000;
                    const { btcAddress, amountToPay, pendingSwap } =
                        await swaps.btcToArk({
                            receiverLockAmount: amountSats,
                        });

                    await fundBtcAddress(btcAddress, amountToPay);
                    await swaps.waitAndClaimArk(pendingSwap);

                    const balance = await wallet.getBalance();
                    expect(balance.available).toEqual(amountSats);
                }
            );

            it(
                "should help Boltz claim the HTLC",
                { timeout: 20_000 },
                async () => {
                    const amountSats = 21000;
                    const { btcAddress, amountToPay, pendingSwap } =
                        await swaps.btcToArk({
                            receiverLockAmount: amountSats,
                        });

                    await fundBtcAddress(btcAddress, amountToPay);
                    const initialBalance = await getBtcAddressFunds(btcAddress);
                    expect(initialBalance).toBeGreaterThan(0);

                    await swaps.waitAndClaimArk(pendingSwap);

                    const balance = await wallet.getBalance();
                    expect(balance.available).toEqual(amountSats);

                    await waitForBtcTxClaimed(btcAddress);
                }
            );

            it(
                "should perform Btc to Ark chain swap with minimal amount",
                { timeout: 10_000 },
                async () => {
                    const { min: amountSats } = await swaps.getLimits(
                        "BTC",
                        "ARK"
                    );
                    const { btcAddress, amountToPay, pendingSwap } =
                        await swaps.btcToArk({
                            receiverLockAmount: amountSats,
                        });

                    await fundBtcAddress(btcAddress, amountToPay);
                    await swaps.waitAndClaimArk(pendingSwap);

                    const balance = await wallet.getBalance();
                    expect(balance.available).toEqual(amountSats);
                }
            );
        });

        describe("createChainSwap (Btc to Ark)", () => {
            it(
                "should send exact amount to ark address",
                { timeout: 10_000 },
                async () => {
                    const amountSats = 4000;
                    const { btcAddress, amountToPay, pendingSwap } =
                        await swaps.btcToArk({
                            receiverLockAmount: amountSats,
                        });

                    await fundBtcAddress(btcAddress, amountToPay);
                    await swaps.waitAndClaimArk(pendingSwap);

                    const balance = await wallet.getBalance();
                    expect(balance.available).toEqual(amountSats);
                }
            );

            it(
                "should send less than amount to ark address",
                { timeout: 10_000 },
                async () => {
                    const amountSats = 4000;
                    const { btcAddress, amountToPay, pendingSwap } =
                        await swaps.btcToArk({
                            senderLockAmount: amountSats,
                        });

                    await fundBtcAddress(btcAddress, amountToPay);
                    await swaps.waitAndClaimArk(pendingSwap);

                    const balance = await wallet.getBalance();
                    expect(balance.available).toBeLessThan(amountSats);
                    expect(balance.available).toBeGreaterThan(0);
                }
            );
        });
    });

    // ==========================================
    // Swap Storage and History (unified)
    // ==========================================

    describe("Swap Storage and History", () => {
        beforeEach(async () => {
            await swaps.swapRepository.clear();
        });

        describe("getPendingReverseSwaps", () => {
            it("should return empty array when no reverse swaps exist", async () => {
                const result = await swaps.getPendingReverseSwaps();
                expect(result).toEqual([]);
            });

            it("should return reverse swap", async () => {
                const pendingSwap = await swaps.createReverseSwap({
                    amount: 1000,
                });
                const result = await swaps.getPendingReverseSwaps();
                expect(result).toHaveLength(1);
                expect(result[0]).toEqual(pendingSwap);
            });

            it("should save reverse swap when creating lightning invoice", async () => {
                const amount = 1000;
                await swaps.createLightningInvoice({ amount });
                const pendingSwaps = await swaps.getPendingReverseSwaps();
                expect(pendingSwaps).toHaveLength(1);
                expect(pendingSwaps[0].type).toBe("reverse");
                expect(pendingSwaps[0].status).toBe("swap.created");
                expect(pendingSwaps[0].request.invoiceAmount).toBe(amount);
            });

            it("should save reverse swap when receiving on lightning", async () => {
                const amount = 1000;
                const pendingSwap = await swaps.createReverseSwap({ amount });

                sleep(1000).then(() =>
                    payInvoice(pendingSwap.response.invoice).catch((err) =>
                        console.error("Error paying invoice:", err)
                    )
                );

                await swaps.waitAndClaim(pendingSwap);

                const pendingSwaps = await swaps.getPendingReverseSwaps();
                expect(pendingSwaps).toHaveLength(0);

                const swapHistory = await swaps.getSwapHistory();
                expect(swapHistory.length).toBeGreaterThanOrEqual(1);

                const swap = swapHistory[0] as PendingReverseSwap;
                expect(swap.request.invoiceAmount).toBe(amount);
                expect(swap.status).toBe("invoice.settled");
                expect(swap.type).toBe("reverse");
            });
        });

        describe("getPendingSubmarineSwaps", () => {
            it("should return empty array when no submarine swaps exist", async () => {
                const result = await swaps.getPendingSubmarineSwaps();
                expect(result).toEqual([]);
            });

            it("should return only submarine swaps with invoice.set status", async () => {
                const { invoice } = await getNewLightningInvoice(1000);
                const pendingSwap = await swaps.createSubmarineSwap({
                    invoice,
                });
                const result = await swaps.getPendingSubmarineSwaps();
                expect(result).toHaveLength(1);
                expect(result[0]).toEqual(pendingSwap);
            });

            it("should save submarine swap when sending lightning payment", async () => {
                const amount = 1000;
                const fundAmount = amount + 10;
                await fundWallet(fundAmount);
                const { invoice } = await getNewLightningInvoice(amount);

                await swaps.sendLightningPayment({ invoice });

                const pendingSwaps = await swaps.getPendingSubmarineSwaps();
                expect(pendingSwaps).toHaveLength(0);

                const swapHistory = await swaps.getSwapHistory();
                expect(swapHistory.length).toBeGreaterThanOrEqual(1);

                const swap = swapHistory[0] as PendingSubmarineSwap;
                expect(swap.status).toBe("transaction.claimed");
                expect(swap.request.invoice).toBe(invoice);
                expect(swap.type).toBe("submarine");
            });
        });

        describe("getPendingChainSwaps", () => {
            it("should return empty array when no chain swaps exist", async () => {
                const result = await swaps.getPendingChainSwaps();
                expect(result).toEqual([]);
            });

            it("should return the swap when createChainSwap is called for Ark to Btc", async () => {
                const pendingSwap = await swaps.createChainSwap({
                    to: "BTC",
                    from: "ARK",
                    feeSatsPerByte: 1,
                    senderLockAmount: 10_000,
                    toAddress: await getBtcAddress(),
                });
                const result = await swaps.getPendingChainSwaps();
                expect(result).toHaveLength(1);
                expect(result[0]).toEqual(pendingSwap);
            });

            it("should return the swap when createChainSwap is called for Btc to Ark", async () => {
                const pendingSwap = await swaps.createChainSwap({
                    to: "ARK",
                    from: "BTC",
                    feeSatsPerByte: 1,
                    senderLockAmount: 10_000,
                    toAddress: await wallet.getAddress(),
                });
                const result = await swaps.getPendingChainSwaps();
                expect(result).toHaveLength(1);
                expect(result[0]).toEqual(pendingSwap);
            });
        });

        describe("getSwapHistory", () => {
            it("should return empty array when no swaps exist", async () => {
                const result = await swaps.getSwapHistory();
                expect(result).toEqual([]);
            });

            it(
                "should return all swaps sorted by creation date (newest first)",
                { timeout: 10_000 },
                async () => {
                    const { invoice: invoice1 } =
                        await getNewLightningInvoice(1000);

                    await swaps.createSubmarineSwap({ invoice: invoice1 });
                    await sleep(1000);
                    await swaps.createReverseSwap({ amount: 2000 });
                    await sleep(1000);
                    await swaps.createReverseSwap({ amount: 3000 });

                    const result = await swaps.getSwapHistory();
                    expect(result).toHaveLength(3);
                    expect(result[0].type).toBe("reverse");
                    expect(result[1].type).toBe("reverse");
                    expect(result[2].type).toBe("submarine");

                    for (let i = 0; i < result.length - 1; i++) {
                        expect(result[i].createdAt).toBeGreaterThanOrEqual(
                            result[i + 1].createdAt
                        );
                    }
                }
            );

            it("should handle mixed swap types and statuses correctly", async () => {
                const { invoice } = await getNewLightningInvoice(1000);
                await swaps.createSubmarineSwap({ invoice });
                await sleep(10);
                await swaps.createReverseSwap({ amount: 2000 });

                const result = await swaps.getSwapHistory();
                expect(result).toHaveLength(2);
                expect(result[0].type).toBe("reverse");
                expect(result[1].type).toBe("submarine");
            });
        });
    });

    // ==========================================
    // Default wallet settings (VtxoManager enabled)
    // ==========================================

    describe("Default wallet settings (VtxoManager enabled)", () => {
        it(
            "should receive from Lightning with VtxoManager enabled",
            { timeout: 15_000 },
            async () => {
                const defaultWallet = await Wallet.create({
                    identity: SingleKey.fromPrivateKey(
                        schnorr.utils.randomSecretKey()
                    ),
                    arkServerUrl: arkUrl,
                    // no settlementConfig — VtxoManager enabled by default
                });

                try {
                    const defaultSwaps = new ArkadeSwaps({
                        wallet: defaultWallet,
                        swapProvider,
                        arkProvider: new RestArkProvider(arkUrl),
                        indexerProvider: new RestIndexerProvider(arkUrl),
                        swapManager: false,
                    });

                    const amount = 1000;
                    const pendingSwap = await defaultSwaps.createReverseSwap({
                        amount,
                    });

                    sleep(1000).then(() =>
                        payInvoice(pendingSwap.response.invoice).catch((err) =>
                            console.error("Error paying invoice:", err)
                        )
                    );

                    const result = await defaultSwaps.waitAndClaim(pendingSwap);
                    expect(result).toHaveProperty("txid");
                    expect(result.txid).toHaveLength(64);

                    const balance = await defaultWallet.getBalance();
                    expect(balance.available).toBeGreaterThan(0);
                } finally {
                    await defaultWallet.dispose();
                }
            }
        );

        it(
            "should send to Lightning with VtxoManager enabled",
            { timeout: 45_000 },
            async () => {
                // When VtxoManager is enabled, its SSE subscription causes
                // the ARK server to auto-include new VTXOs in the next
                // scheduled round. We must let that round complete (by
                // generating blocks) before spending the resulting VTXOs.
                const defaultWallet = await Wallet.create({
                    identity: SingleKey.fromPrivateKey(
                        schnorr.utils.randomSecretKey()
                    ),
                    arkServerUrl: arkUrl,
                    // default settlementConfig — VtxoManager starts enabled
                });

                try {
                    const defaultSwaps = new ArkadeSwaps({
                        wallet: defaultWallet,
                        swapProvider,
                        arkProvider: new RestArkProvider(arkUrl),
                        indexerProvider: new RestIndexerProvider(arkUrl),
                        swapManager: false,
                    });

                    // Fund the wallet via the shared funded wallet
                    const amount = 1000;
                    const fundAmount = amount + 10;
                    await fundedWallet.send({
                        address: await defaultWallet.getAddress(),
                        amount: fundAmount,
                    });
                    await waitForBalance(
                        () => defaultWallet.getBalance(),
                        fundAmount,
                        5_000
                    );

                    // Let the server's scheduled round process the auto-
                    // registered VTXO (ARKD_ROUND_INTERVAL=10 blocks).
                    // We poll for settled state rather than sleeping a fixed
                    // duration — on slow CI the round can take longer than
                    // 3 s, leaving VTXOs preconfirmed and causing arkd to
                    // reject the PSBT with INVALID_PSBT_INPUT (5): missing
                    // tapscript spend sig.
                    await sleep(1000);
                    await generateBlocks(10);
                    await waitForSettled(
                        () => defaultWallet.getVtxos(),
                        15_000
                    );

                    const { invoice } = await getNewLightningInvoice(amount);
                    const result = await defaultSwaps.sendLightningPayment({
                        invoice,
                    });

                    expect(result.txid).toHaveLength(64);

                    const balance = await defaultWallet.getBalance();
                    expect(balance.available).toBeLessThan(fundAmount);
                } finally {
                    await defaultWallet.dispose();
                }
            }
        );
    });
});
