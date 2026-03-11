import {
    SwapError,
    SwapExpiredError,
    InvoiceExpiredError,
    InvoiceFailedToPayError,
    TransactionFailedError,
    TransactionLockupFailedError,
    TransactionRefundedError,
} from "./errors";
import {
    ArkAddress,
    ArkProvider,
    IndexerProvider,
    IWallet,
    VHTLC,
    ArkInfo,
    isRecoverable,
    ArkTxInput,
    Identity,
} from "@arkade-os/sdk";
import type {
    Chain,
    LimitsResponse,
    FeesResponse,
    ChainFeesResponse,
    PendingChainSwap,
    PendingReverseSwap,
    PendingSubmarineSwap,
    PendingSwap,
    ArkadeSwapsConfig,
    CreateLightningInvoiceRequest,
    CreateLightningInvoiceResponse,
    SendLightningPaymentRequest,
    SendLightningPaymentResponse,
    ArkToBtcResponse,
    BtcToArkResponse,
} from "./types";
import {
    BoltzSwapProvider,
    BoltzSwapStatus,
    GetSwapStatusResponse,
    CreateSubmarineSwapRequest,
    CreateReverseSwapRequest,
    CreateChainSwapRequest,
    isSubmarineFinalStatus,
    isReverseFinalStatus,
    isChainFinalStatus,
    isRestoredReverseSwap,
    isRestoredSubmarineSwap,
    isRestoredChainSwap,
} from "./boltz-swap-provider";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { TransactionOutput } from "@scure/btc-signer/psbt.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { Address, OutScript, SigHash, Transaction } from "@scure/btc-signer";
import { NETWORK } from "@scure/btc-signer/utils.js";
import { create as createMusig } from "./utils/musig";
import {
    deserializeSwapTree,
    tweakMusig,
    detectSwapOutput,
    constructClaimTransaction,
    targetFee,
    REGTEST_NETWORK,
    MUTINYNET_NETWORK,
} from "./utils/boltz-swap-tx";
import { decodeInvoice, getInvoicePaymentHash } from "./utils/decoding";
import { normalizeToXOnlyKey } from "./utils/signatures";
import {
    extractInvoiceAmount,
    extractTimeLockFromLeafOutput,
} from "./utils/restoration";
import { SwapManager, SwapManagerClient } from "./swap-manager";
import {
    saveSwap,
    updateReverseSwapStatus,
    updateSubmarineSwapStatus,
    enrichReverseSwapPreimage,
    enrichSubmarineSwapInvoice,
} from "./utils/swap-helpers";
import { logger } from "./logger";
import { IndexedDbSwapRepository } from "./repositories/IndexedDb/swap-repository";
import { SwapRepository } from "./repositories/swap-repository";
import { claimVHTLCIdentity } from "./utils/identity";
import {
    claimVHTLCwithOffchainTx,
    createVHTLCScript,
    joinBatch,
    refundVHTLCwithOffchainTx,
} from "./utils/vhtlc";

export class ArkadeSwaps {
    readonly wallet: IWallet;
    readonly arkProvider: ArkProvider;
    readonly swapProvider: BoltzSwapProvider;
    readonly indexerProvider: IndexerProvider;
    readonly swapManager: SwapManager | null = null;
    readonly swapRepository: SwapRepository;

    constructor(config: ArkadeSwapsConfig) {
        if (!config.wallet) throw new Error("Wallet is required.");
        if (!config.swapProvider) throw new Error("Swap provider is required.");

        this.wallet = config.wallet;
        // Prioritize wallet providers, fallback to config providers for backward compatibility
        const arkProvider =
            (config.wallet as any).arkProvider ?? config.arkProvider;
        if (!arkProvider)
            throw new Error(
                "Ark provider is required either in wallet or config."
            );
        this.arkProvider = arkProvider;

        const indexerProvider =
            (config.wallet as any).indexerProvider ?? config.indexerProvider;
        if (!indexerProvider)
            throw new Error(
                "Indexer provider is required either in wallet or config."
            );
        this.indexerProvider = indexerProvider;

        this.swapProvider = config.swapProvider;

        // Initialize SwapRepository
        if (config.swapRepository) {
            this.swapRepository = config.swapRepository;
        } else {
            this.swapRepository = new IndexedDbSwapRepository();
        }

        // Initialize SwapManager if config is provided
        // - true: use defaults
        // - object: use provided config
        // - false/undefined: disabled
        if (config.swapManager) {
            const swapManagerConfig =
                config.swapManager === true ? {} : config.swapManager;

            // Extract autostart (defaults to true) before passing to SwapManager
            const shouldAutostart = swapManagerConfig.autoStart ?? true;

            this.swapManager = new SwapManager(
                this.swapProvider,
                swapManagerConfig
            );

            // Set up callbacks for all swap types
            this.swapManager.setCallbacks({
                claim: async (swap: PendingReverseSwap) => {
                    await this.claimVHTLC(swap);
                },
                refund: async (swap: PendingSubmarineSwap) => {
                    await this.refundVHTLC(swap);
                },
                claimArk: async (swap: PendingChainSwap) => {
                    await this.claimArk(swap);
                },
                claimBtc: async (swap: PendingChainSwap) => {
                    await this.claimBtc(swap);
                },
                refundArk: async (swap: PendingChainSwap) => {
                    await this.refundArk(swap);
                },
                signServerClaim: async (swap: PendingChainSwap) => {
                    await this.signCooperativeClaimForServer(swap);
                },
                saveSwap: async (swap: PendingSwap) => {
                    await saveSwap(swap, {
                        saveReverseSwap: this.savePendingReverseSwap.bind(this),
                        saveSubmarineSwap:
                            this.savePendingSubmarineSwap.bind(this),
                        saveChainSwap: this.savePendingChainSwap.bind(this),
                    });
                },
            });

            // Autostart if configured (defaults to true)
            if (shouldAutostart) {
                // Start in background without blocking constructor
                this.startSwapManager().catch((error) => {
                    logger.error("Failed to autostart SwapManager:", error);
                });
            }
        }
    }

    // =========================================================================
    // Storage helpers
    // =========================================================================

    private async savePendingReverseSwap(
        swap: PendingReverseSwap
    ): Promise<void> {
        await this.swapRepository.saveSwap(swap);
    }

    private async savePendingSubmarineSwap(
        swap: PendingSubmarineSwap
    ): Promise<void> {
        await this.swapRepository.saveSwap(swap);
    }

    private async savePendingChainSwap(swap: PendingChainSwap): Promise<void> {
        await this.swapRepository.saveSwap(swap);
    }

    private async getPendingReverseSwapsFromStorage(): Promise<
        PendingReverseSwap[]
    > {
        return this.swapRepository.getAllSwaps<PendingReverseSwap>({
            type: "reverse",
        });
    }

    private async getPendingSubmarineSwapsFromStorage(): Promise<
        PendingSubmarineSwap[]
    > {
        return this.swapRepository.getAllSwaps<PendingSubmarineSwap>({
            type: "submarine",
        });
    }

    private async getPendingChainSwapsFromStorage(): Promise<
        PendingChainSwap[]
    > {
        return this.swapRepository.getAllSwaps<PendingChainSwap>({
            type: "chain",
        });
    }

    // =========================================================================
    // SwapManager lifecycle
    // =========================================================================

    /**
     * Start the background swap manager.
     * This will load all pending swaps and begin monitoring them.
     * Automatically called when SwapManager is enabled.
     */
    async startSwapManager(): Promise<void> {
        if (!this.swapManager) {
            throw new Error(
                "SwapManager is not enabled. Provide 'swapManager' config in ArkadeSwapsConfig."
            );
        }

        // Load all pending swaps from the swap repository
        const allSwaps = await this.swapRepository.getAllSwaps();

        // Start the manager with all pending swaps
        await this.swapManager.start(allSwaps);
    }

    /**
     * Stop the background swap manager.
     */
    async stopSwapManager(): Promise<void> {
        if (!this.swapManager) return;
        await this.swapManager.stop();
    }

    /**
     * Get the SwapManager instance.
     * Useful for accessing manager stats or manually controlling swaps.
     */
    getSwapManager(): SwapManagerClient | null {
        return this.swapManager;
    }

    /**
     * Dispose of resources (stops SwapManager and cleans up).
     * Can be called manually or automatically with `await using` syntax (TypeScript 5.2+).
     */
    async dispose(): Promise<void> {
        if (this.swapManager) {
            await this.stopSwapManager();
        }
    }

    /**
     * Symbol.asyncDispose for automatic cleanup with `await using` syntax.
     */
    async [Symbol.asyncDispose](): Promise<void> {
        await this.dispose();
    }

    // =========================================================================
    // Lightning: Reverse swaps (receive Lightning -> Arkade)
    // =========================================================================

    /**
     * Creates a Lightning invoice.
     * @param args - The arguments for creating a Lightning invoice.
     * @returns The response containing the created Lightning invoice.
     */
    async createLightningInvoice(
        args: CreateLightningInvoiceRequest
    ): Promise<CreateLightningInvoiceResponse> {
        const pendingSwap = await this.createReverseSwap(args);
        const decodedInvoice = decodeInvoice(pendingSwap.response.invoice);
        return {
            amount: pendingSwap.response.onchainAmount,
            expiry: decodedInvoice.expiry,
            invoice: pendingSwap.response.invoice,
            paymentHash: decodedInvoice.paymentHash,
            pendingSwap,
            preimage: pendingSwap.preimage,
        } as CreateLightningInvoiceResponse;
    }

    /**
     * Creates a reverse swap.
     * @param args - The arguments for creating a reverse swap.
     * @returns The created pending reverse swap.
     */
    async createReverseSwap(
        args: CreateLightningInvoiceRequest
    ): Promise<PendingReverseSwap> {
        // validate amount
        if (args.amount <= 0)
            throw new SwapError({ message: "Amount must be greater than 0" });

        const claimPublicKey = hex.encode(
            await this.wallet.identity.compressedPublicKey()
        );
        if (!claimPublicKey)
            throw new SwapError({
                message: "Failed to get claim public key from wallet",
            });

        // create random preimage and its hash
        const preimage = randomBytes(32);
        const preimageHash = hex.encode(sha256(preimage));
        if (!preimageHash)
            throw new SwapError({ message: "Failed to get preimage hash" });

        // build request object for reverse swap
        const swapRequest: CreateReverseSwapRequest = {
            invoiceAmount: args.amount,
            claimPublicKey,
            preimageHash,
            ...(args.description?.trim()
                ? { description: args.description.trim() }
                : {}),
        };

        // make reverse swap request
        const swapResponse =
            await this.swapProvider.createReverseSwap(swapRequest);

        const pendingSwap: PendingReverseSwap = {
            id: swapResponse.id,
            type: "reverse",
            createdAt: Math.floor(Date.now() / 1000),
            preimage: hex.encode(preimage),
            request: swapRequest,
            response: swapResponse,
            status: "swap.created",
        };

        // save pending swap to storage
        await this.savePendingReverseSwap(pendingSwap);

        // Add to swap manager if enabled
        if (this.swapManager) {
            this.swapManager.addSwap(pendingSwap);
        }

        return pendingSwap;
    }

    /**
     * Claims the VHTLC for a pending reverse swap.
     * @param pendingSwap - The pending reverse swap to claim the VHTLC.
     */
    async claimVHTLC(pendingSwap: PendingReverseSwap): Promise<void> {
        // restored swaps may not have preimage
        if (!pendingSwap.preimage)
            throw new Error("Preimage is required to claim VHTLC");

        const preimage = hex.decode(pendingSwap.preimage);
        const arkInfo = await this.arkProvider.getInfo();
        const address = await this.wallet.getAddress();

        const receiverXOnly = normalizeToXOnlyKey(
            await this.wallet.identity.xOnlyPublicKey(),
            "our",
            pendingSwap.id
        );

        const senderXOnly = normalizeToXOnlyKey(
            hex.decode(pendingSwap.response.refundPublicKey),
            "boltz",
            pendingSwap.id
        );

        const serverXOnly = normalizeToXOnlyKey(
            hex.decode(arkInfo.signerPubkey),
            "server",
            pendingSwap.id
        );

        // build expected VHTLC script
        const { vhtlcScript, vhtlcAddress } = this.createVHTLCScript({
            network: arkInfo.network,
            preimageHash: sha256(preimage),
            receiverPubkey: hex.encode(receiverXOnly),
            senderPubkey: hex.encode(senderXOnly),
            serverPubkey: hex.encode(serverXOnly),
            timeoutBlockHeights: pendingSwap.response.timeoutBlockHeights,
        });

        if (!vhtlcScript.claimScript)
            throw new Error("Failed to create VHTLC script for reverse swap");
        if (vhtlcAddress !== pendingSwap.response.lockupAddress)
            throw new Error("Boltz is trying to scam us");

        // get spendable VTXOs from the lockup address
        const { vtxos } = await this.indexerProvider.getVtxos({
            scripts: [hex.encode(vhtlcScript.pkScript)],
        });
        if (vtxos.length === 0)
            throw new Error("No spendable virtual coins found");

        const vtxo = vtxos[0];

        if (vtxo.isSpent) {
            throw new Error("VHTLC is already spent");
        }

        const input = {
            ...vtxo,
            tapLeafScript: vhtlcScript.claim(),
            tapTree: vhtlcScript.encode(),
        };

        const output = {
            amount: BigInt(vtxo.value),
            script: ArkAddress.decode(address).pkScript,
        };

        const vhtlcIdentity = claimVHTLCIdentity(
            this.wallet.identity,
            preimage
        );

        let finalStatus: BoltzSwapStatus | undefined;

        if (isRecoverable(vtxo)) {
            await this.joinBatch(vhtlcIdentity, input, output, arkInfo);
            finalStatus = "transaction.claimed";
        } else {
            await claimVHTLCwithOffchainTx(
                vhtlcIdentity,
                vhtlcScript,
                serverXOnly,
                input,
                output,
                arkInfo,
                this.arkProvider
            );
            finalStatus = (await this.getSwapStatus(pendingSwap.id)).status;
        }

        // update the pending swap on storage
        await updateReverseSwapStatus(
            pendingSwap,
            finalStatus,
            this.savePendingReverseSwap.bind(this)
        );
    }

    /**
     * Waits for the swap to be confirmed and claims the VHTLC.
     * @param pendingSwap - The pending reverse swap.
     * @returns The transaction ID of the claimed VHTLC.
     */
    async waitAndClaim(
        pendingSwap: PendingReverseSwap
    ): Promise<{ txid: string }> {
        // If SwapManager is enabled and has this swap, delegate to it
        if (
            this.swapManager &&
            (await this.swapManager.hasSwap(pendingSwap.id))
        ) {
            return this.swapManager.waitForSwapCompletion(pendingSwap.id);
        }

        // Otherwise use manual monitoring
        return new Promise<{ txid: string }>((resolve, reject) => {
            const onStatusUpdate = async (
                status: BoltzSwapStatus,
                data: any
            ) => {
                const saveStatus = (
                    additionalFields?: Partial<PendingReverseSwap>
                ) =>
                    updateReverseSwapStatus(
                        pendingSwap,
                        status,
                        this.savePendingReverseSwap.bind(this),
                        additionalFields
                    );

                switch (status) {
                    case "transaction.mempool":
                    case "transaction.confirmed":
                        await saveStatus();
                        this.claimVHTLC(pendingSwap).catch(reject);
                        break;
                    case "invoice.settled": {
                        await saveStatus();
                        const swapStatus =
                            await this.swapProvider.getReverseSwapTxId(
                                pendingSwap.id
                            );
                        const txid = swapStatus.id;

                        if (!txid || txid.trim() === "") {
                            reject(
                                new SwapError({
                                    message: `Transaction ID not available for settled swap ${pendingSwap.id}.`,
                                })
                            );
                            break;
                        }

                        resolve({ txid });
                        break;
                    }
                    case "invoice.expired":
                        await saveStatus();
                        reject(
                            new InvoiceExpiredError({
                                isRefundable: true,
                                pendingSwap,
                            })
                        );
                        break;
                    case "swap.expired":
                        await saveStatus();
                        reject(
                            new SwapExpiredError({
                                isRefundable: true,
                                pendingSwap,
                            })
                        );
                        break;
                    case "transaction.failed":
                        await saveStatus();
                        reject(
                            new TransactionFailedError({
                                message:
                                    data?.failureReason ?? "Transaction failed",
                                isRefundable: true,
                            })
                        );
                        break;
                    case "transaction.refunded":
                        await saveStatus();
                        reject(new TransactionRefundedError());
                        break;
                    default:
                        await saveStatus();
                        break;
                }
            };

            this.swapProvider
                .monitorSwap(pendingSwap.id, onStatusUpdate)
                .catch(reject);
        });
    }

    // =========================================================================
    // Lightning: Submarine swaps (send Arkade -> Lightning)
    // =========================================================================

    /**
     * Sends a Lightning payment.
     * @param args - The arguments for sending a Lightning payment.
     * @returns The result of the payment.
     */
    async sendLightningPayment(
        args: SendLightningPaymentRequest
    ): Promise<SendLightningPaymentResponse> {
        const pendingSwap = await this.createSubmarineSwap(args);

        // save pending swap to storage
        await this.savePendingSubmarineSwap(pendingSwap);
        // send funds to the swap address
        const txid = await this.wallet.sendBitcoin({
            address: pendingSwap.response.address,
            amount: pendingSwap.response.expectedAmount,
        });

        try {
            const { preimage } = await this.waitForSwapSettlement(pendingSwap);
            return {
                amount: pendingSwap.response.expectedAmount,
                preimage,
                txid,
            };
        } catch (error: any) {
            if (error.isRefundable) {
                await this.refundVHTLC(pendingSwap);
                const finalStatus = await this.getSwapStatus(pendingSwap.id);
                await updateSubmarineSwapStatus(
                    pendingSwap,
                    finalStatus.status,
                    this.savePendingSubmarineSwap.bind(this)
                );
            }
            throw new TransactionFailedError();
        }
    }

    /**
     * Creates a submarine swap.
     * @param args - The arguments for creating a submarine swap.
     * @returns The created pending submarine swap.
     */
    async createSubmarineSwap(
        args: SendLightningPaymentRequest
    ): Promise<PendingSubmarineSwap> {
        const refundPublicKey = hex.encode(
            await this.wallet.identity.compressedPublicKey()
        );
        if (!refundPublicKey)
            throw new SwapError({
                message: "Failed to get refund public key from wallet",
            });

        const invoice = args.invoice;
        if (!invoice) throw new SwapError({ message: "Invoice is required" });

        const swapRequest: CreateSubmarineSwapRequest = {
            invoice,
            refundPublicKey,
        };

        // make submarine swap request
        const swapResponse =
            await this.swapProvider.createSubmarineSwap(swapRequest);

        // create pending swap object
        const pendingSwap: PendingSubmarineSwap = {
            id: swapResponse.id,
            type: "submarine",
            createdAt: Math.floor(Date.now() / 1000),
            request: swapRequest,
            response: swapResponse,
            status: "invoice.set",
        };

        // save pending swap to storage
        await this.savePendingSubmarineSwap(pendingSwap);

        // Add to swap manager if enabled
        if (this.swapManager) {
            this.swapManager.addSwap(pendingSwap);
        }

        return pendingSwap;
    }

    /**
     * Claims the VHTLC for a pending submarine swap (aka refund).
     * @param pendingSwap - The pending submarine swap to refund the VHTLC.
     */
    async refundVHTLC(pendingSwap: PendingSubmarineSwap): Promise<void> {
        const preimageHash = pendingSwap.request.invoice
            ? getInvoicePaymentHash(pendingSwap.request.invoice)
            : pendingSwap.preimageHash;

        if (!preimageHash)
            throw new Error("Preimage hash is required to refund VHTLC");

        const vhtlcPkScript = ArkAddress.decode(
            pendingSwap.response.address
        ).pkScript;

        // get spendable VTXOs from the lockup address
        const { vtxos } = await this.indexerProvider.getVtxos({
            scripts: [hex.encode(vhtlcPkScript)],
        });
        if (vtxos.length === 0) {
            throw new Error(
                `VHTLC not found for address ${pendingSwap.response.address}`
            );
        }

        const vtxo = vtxos[0];

        if (vtxo.isSpent) {
            throw new Error("VHTLC is already spent");
        }

        // prepare variables for claiming the VHTLC
        const arkInfo = await this.arkProvider.getInfo();
        const address = await this.wallet.getAddress();
        if (!address) throw new Error("Failed to get ark address from wallet");

        const ourXOnlyPublicKey = normalizeToXOnlyKey(
            await this.wallet.identity.xOnlyPublicKey(),
            "our",
            pendingSwap.id
        );

        const serverXOnlyPublicKey = normalizeToXOnlyKey(
            hex.decode(arkInfo.signerPubkey),
            "server",
            pendingSwap.id
        );

        const boltzXOnlyPublicKey = normalizeToXOnlyKey(
            hex.decode(pendingSwap.response.claimPublicKey),
            "boltz",
            pendingSwap.id
        );

        const { vhtlcScript } = this.createVHTLCScript({
            network: arkInfo.network,
            preimageHash: hex.decode(preimageHash),
            receiverPubkey: hex.encode(boltzXOnlyPublicKey),
            senderPubkey: hex.encode(ourXOnlyPublicKey),
            serverPubkey: hex.encode(serverXOnlyPublicKey),
            timeoutBlockHeights: pendingSwap.response.timeoutBlockHeights,
        });

        if (!vhtlcScript.claimScript)
            throw new Error("Failed to create VHTLC script for submarine swap");

        const isRecoverableVtxo = isRecoverable(vtxo);

        const input = {
            ...vtxo,
            tapLeafScript: isRecoverableVtxo
                ? vhtlcScript.refundWithoutReceiver()
                : vhtlcScript.refund(),
            tapTree: vhtlcScript.encode(),
        };

        const output = {
            amount: BigInt(vtxo.value),
            script: ArkAddress.decode(address).pkScript,
        };

        if (isRecoverableVtxo) {
            await this.joinBatch(this.wallet.identity, input, output, arkInfo);
        } else {
            await refundVHTLCwithOffchainTx(
                pendingSwap.id,
                this.wallet.identity,
                this.arkProvider,
                boltzXOnlyPublicKey,
                ourXOnlyPublicKey,
                serverXOnlyPublicKey,
                input,
                output,
                arkInfo,
                this.swapProvider.refundSubmarineSwap.bind(this.swapProvider)
            );
        }

        // update the pending swap on storage
        await updateSubmarineSwapStatus(
            pendingSwap,
            pendingSwap.status, // Keep current status
            this.savePendingSubmarineSwap.bind(this),
            { refundable: true, refunded: true }
        );
    }

    /**
     * Waits for the swap settlement.
     * @param pendingSwap - The pending submarine swap.
     * @returns The status of the swap settlement.
     */
    async waitForSwapSettlement(
        pendingSwap: PendingSubmarineSwap
    ): Promise<{ preimage: string }> {
        return new Promise<{ preimage: string }>((resolve, reject) => {
            let isResolved = false;

            const onStatusUpdate = async (status: BoltzSwapStatus) => {
                if (isResolved) return;

                const saveStatus = (
                    additionalFields?: Partial<PendingSubmarineSwap>
                ) =>
                    updateSubmarineSwapStatus(
                        pendingSwap,
                        status,
                        this.savePendingSubmarineSwap.bind(this),
                        additionalFields
                    );

                switch (status) {
                    case "swap.expired":
                        isResolved = true;
                        await saveStatus({ refundable: true });
                        reject(
                            new SwapExpiredError({
                                isRefundable: true,
                                pendingSwap,
                            })
                        );
                        break;
                    case "invoice.failedToPay":
                        isResolved = true;
                        await saveStatus({ refundable: true });
                        reject(
                            new InvoiceFailedToPayError({
                                isRefundable: true,
                                pendingSwap,
                            })
                        );
                        break;
                    case "transaction.lockupFailed":
                        isResolved = true;
                        await saveStatus({ refundable: true });
                        reject(
                            new TransactionLockupFailedError({
                                isRefundable: true,
                                pendingSwap,
                            })
                        );
                        break;
                    case "transaction.claimed": {
                        isResolved = true;
                        const { preimage } =
                            await this.swapProvider.getSwapPreimage(
                                pendingSwap.id
                            );
                        await saveStatus({ preimage });
                        resolve({ preimage });
                        break;
                    }
                    default:
                        await saveStatus();
                        break;
                }
            };

            this.swapProvider
                .monitorSwap(pendingSwap.id, onStatusUpdate)
                .catch((error) => {
                    if (!isResolved) {
                        isResolved = true;
                        reject(error);
                    }
                });
        });
    }

    // =========================================================================
    // Chain swaps: ARK -> BTC
    // =========================================================================

    /**
     * Creates a chain swap from ARK to BTC.
     * @param args - Swap arguments.
     * @returns The payment details and pending chain swap.
     */
    async arkToBtc(args: {
        btcAddress: string;
        senderLockAmount?: number;
        receiverLockAmount?: number;
        feeSatsPerByte?: number;
    }): Promise<ArkToBtcResponse> {
        const pendingSwap = await this.createChainSwap({
            to: "BTC",
            from: "ARK",
            feeSatsPerByte: args.feeSatsPerByte,
            senderLockAmount: args.senderLockAmount,
            receiverLockAmount: args.receiverLockAmount,
            toAddress: args.btcAddress,
        });

        await this.verifyChainSwap({
            to: "BTC",
            from: "ARK",
            swap: pendingSwap,
            arkInfo: await this.arkProvider.getInfo(),
        }).catch((err) => {
            throw new SwapError({
                message: `Chain swap verification failed: ${err.message}`,
            });
        });

        return {
            amountToPay: pendingSwap.response.lockupDetails.amount,
            arkAddress: pendingSwap.response.lockupDetails.lockupAddress,
            pendingSwap,
        };
    }

    /**
     * Waits for the swap to be confirmed and claims BTC.
     * @param pendingSwap - The pending chain swap to monitor.
     * @returns The transaction ID of the claimed HTLC.
     */
    async waitAndClaimBtc(
        pendingSwap: PendingChainSwap
    ): Promise<{ txid: string }> {
        if (
            this.swapManager &&
            (await this.swapManager.hasSwap(pendingSwap.id))
        ) {
            const { txid } = await this.swapManager.waitForSwapCompletion(
                pendingSwap.id
            );
            return { txid };
        }
        return new Promise<{ txid: string }>((resolve, reject) => {
            let claimStarted = false;
            // Local mutable copy — accumulates fields across status
            // callbacks without mutating the caller's object.
            // Spreading from the original on every callback
            // would silently discard previously saved data.
            const swap = { ...pendingSwap };
            const onStatusUpdate = async (
                status: BoltzSwapStatus,
                data: {
                    failureReason?: string;
                }
            ) => {
                const updateSwapStatus =
                    async (): Promise<PendingChainSwap> => {
                        swap.status = status;
                        await this.savePendingChainSwap(swap);
                        return swap;
                    };
                switch (status) {
                    case "transaction.mempool":
                    case "transaction.confirmed":
                        await updateSwapStatus();
                        break;
                    case "transaction.server.mempool":
                    case "transaction.server.confirmed": {
                        const updatedSwap = await updateSwapStatus();
                        if (claimStarted) return;
                        claimStarted = true;
                        this.claimBtc(updatedSwap).catch(reject);
                        break;
                    }
                    case "transaction.claimed":
                        await updateSwapStatus();
                        const claimedStatus = await this.getSwapStatus(
                            pendingSwap.id
                        );
                        resolve({
                            txid: claimedStatus.transaction?.id ?? "",
                        });
                        break;
                    case "transaction.lockupFailed":
                        await updateSwapStatus();
                        await this.quoteSwap(swap.response.id).catch((err) => {
                            reject(
                                new SwapError({
                                    message: `Failed to renegotiate quote: ${err.message}`,
                                    isRefundable: true,
                                    pendingSwap: swap,
                                })
                            );
                        });
                        break;
                    case "swap.expired":
                        await updateSwapStatus();
                        reject(
                            new SwapExpiredError({
                                isRefundable: true,
                                pendingSwap: swap,
                            })
                        );
                        break;
                    case "transaction.failed":
                        await updateSwapStatus();
                        reject(
                            new TransactionFailedError({
                                message: data.failureReason,
                                isRefundable: true,
                            })
                        );
                        break;
                    case "transaction.refunded":
                        await updateSwapStatus();
                        reject(new TransactionRefundedError());
                        break;
                    default:
                        await updateSwapStatus();
                        break;
                }
            };

            this.swapProvider
                .monitorSwap(swap.id, onStatusUpdate)
                .catch(reject);
        });
    }

    /**
     * Claim sats on BTC chain by claiming the HTLC.
     * @param pendingSwap - The pending chain swap with BTC transaction hex.
     */
    async claimBtc(pendingSwap: PendingChainSwap): Promise<void> {
        if (!pendingSwap.toAddress)
            throw new Error("Destination address is required");

        if (!pendingSwap.response.claimDetails.swapTree)
            throw new Error("Missing swap tree in claim details");

        if (!pendingSwap.response.claimDetails.serverPublicKey)
            throw new Error("Missing server public key in claim details");

        const swapStatus = await this.getSwapStatus(pendingSwap.id);
        if (!swapStatus.transaction?.hex)
            throw new Error("BTC transaction hex is required");

        const lockupTx = Transaction.fromRaw(
            hex.decode(swapStatus.transaction.hex)
        );

        const arkInfo = await this.arkProvider.getInfo();

        const network =
            arkInfo.network === "bitcoin"
                ? NETWORK
                : arkInfo.network === "mutinynet"
                  ? MUTINYNET_NETWORK
                  : REGTEST_NETWORK;

        const swapTree = deserializeSwapTree(
            pendingSwap.response.claimDetails.swapTree
        );

        const musig = tweakMusig(
            createMusig(hex.decode(pendingSwap.ephemeralKey), [
                hex.decode(pendingSwap.response.claimDetails.serverPublicKey),
                secp256k1.getPublicKey(hex.decode(pendingSwap.ephemeralKey)),
            ]),
            swapTree.tree
        );
        const swapOutput = detectSwapOutput(musig.aggPubkey, lockupTx);

        const feeToDeliverExactAmount = BigInt(
            pendingSwap.request.serverLockAmount
                ? pendingSwap.request.serverLockAmount - pendingSwap.amount
                : 0
        );

        const claimTx = targetFee(pendingSwap.feeSatsPerByte, (fee) =>
            constructClaimTransaction(
                {
                    script: swapOutput.script!,
                    amount: swapOutput.amount!,
                    vout: swapOutput.vout!,
                    transactionId: lockupTx.id,
                },
                OutScript.encode(
                    Address(network).decode(pendingSwap.toAddress!)
                ),
                feeToDeliverExactAmount > fee ? feeToDeliverExactAmount : fee
            )
        );

        const musigMessage = musig
            .message(
                claimTx.preimageWitnessV1(
                    0,
                    [swapOutput.script!],
                    SigHash.DEFAULT,
                    [swapOutput.amount!]
                )
            )
            .generateNonce();

        const signedTxData = await this.swapProvider.postChainClaimDetails(
            pendingSwap.response.id,
            {
                preimage: pendingSwap.preimage,
                toSign: {
                    pubNonce: hex.encode(musigMessage.publicNonce),
                    transaction: claimTx.hex,
                    index: 0,
                },
            }
        );

        if (!signedTxData.pubNonce || !signedTxData.partialSignature)
            throw new Error("Invalid signature data from server");

        const musigSession = musigMessage
            .aggregateNonces([
                [
                    hex.decode(
                        pendingSwap.response.claimDetails.serverPublicKey
                    ),
                    hex.decode(signedTxData.pubNonce),
                ],
            ])
            .initializeSession();

        musigSession.addPartial(
            hex.decode(pendingSwap.response.claimDetails.serverPublicKey),
            hex.decode(signedTxData.partialSignature)
        );
        const musigSigned = musigSession.signPartial();

        claimTx.updateInput(0, {
            finalScriptWitness: [musigSigned.aggregatePartials()],
        });

        await this.swapProvider.postBtcTransaction(claimTx.hex);
    }

    /**
     * When an ARK to BTC swap fails, refund sats on ARK chain by claiming the VHTLC.
     * @param pendingSwap - The pending chain swap to refund.
     */
    async refundArk(pendingSwap: PendingChainSwap): Promise<void> {
        if (!pendingSwap.response.lockupDetails.serverPublicKey)
            throw new Error("Missing server public key in lockup details");

        if (!pendingSwap.response.lockupDetails.timeouts)
            throw new Error("Missing timeouts in lockup details");

        const arkInfo = await this.arkProvider.getInfo();

        const address = await this.wallet.getAddress();

        const ourXOnlyPublicKey = normalizeToXOnlyKey(
            await this.wallet.identity.xOnlyPublicKey(),
            "user",
            pendingSwap.id
        );

        const serverXOnlyPublicKey = normalizeToXOnlyKey(
            hex.decode(arkInfo.signerPubkey),
            "server",
            pendingSwap.id
        );

        const boltzXOnlyPublicKey = normalizeToXOnlyKey(
            hex.decode(pendingSwap.response.lockupDetails.serverPublicKey),
            "boltz",
            pendingSwap.id
        );

        const vhtlcPkScript = ArkAddress.decode(
            pendingSwap.response.lockupDetails.lockupAddress
        ).pkScript;

        // get spendable VTXOs from the lockup address
        const { vtxos } = await this.indexerProvider.getVtxos({
            scripts: [hex.encode(vhtlcPkScript)],
        });

        if (vtxos.length === 0) {
            throw new Error(
                `VHTLC not found for address ${pendingSwap.response.lockupDetails.lockupAddress}`
            );
        }

        const vtxo = vtxos[0];

        if (vtxo.isSpent) {
            throw new Error("VHTLC is already spent");
        }

        const { vhtlcAddress, vhtlcScript } = this.createVHTLCScript({
            network: arkInfo.network,
            preimageHash: hex.decode(pendingSwap.request.preimageHash),
            serverPubkey: hex.encode(serverXOnlyPublicKey),
            senderPubkey: hex.encode(ourXOnlyPublicKey),
            receiverPubkey: hex.encode(boltzXOnlyPublicKey),
            timeoutBlockHeights: pendingSwap.response.lockupDetails.timeouts!,
        });

        if (!vhtlcScript.refundScript)
            throw new Error("Failed to create VHTLC script for chain swap");

        if (pendingSwap.response.lockupDetails.lockupAddress !== vhtlcAddress) {
            throw new SwapError({
                message: "Unable to claim: invalid VHTLC address",
            });
        }

        const isRecoverableVtxo = isRecoverable(vtxo);

        const input = {
            ...vtxo,
            tapLeafScript: isRecoverableVtxo
                ? vhtlcScript.refundWithoutReceiver()
                : vhtlcScript.refund(),
            tapTree: vhtlcScript.encode(),
        };

        const output = {
            amount: BigInt(vtxo.value),
            script: ArkAddress.decode(address).pkScript,
        };

        if (isRecoverableVtxo) {
            await this.joinBatch(this.wallet.identity, input, output, arkInfo);
        } else {
            await refundVHTLCwithOffchainTx(
                pendingSwap.id,
                this.wallet.identity,
                this.arkProvider,
                boltzXOnlyPublicKey,
                ourXOnlyPublicKey,
                serverXOnlyPublicKey,
                input,
                output,
                arkInfo,
                this.swapProvider.refundChainSwap.bind(this.swapProvider)
            );
        }

        // update the pending swap on storage
        const finalStatus = await this.getSwapStatus(pendingSwap.id);
        await this.savePendingChainSwap({
            ...pendingSwap,
            status: finalStatus.status,
        });
    }

    // =========================================================================
    // Chain swaps: BTC -> ARK
    // =========================================================================

    /**
     * Creates a chain swap from BTC to ARK.
     * @param args - Swap arguments.
     * @returns The pending chain swap and payment details.
     */
    async btcToArk(args: {
        feeSatsPerByte?: number;
        senderLockAmount?: number;
        receiverLockAmount?: number;
    }): Promise<BtcToArkResponse> {
        const pendingSwap = await this.createChainSwap({
            to: "ARK",
            from: "BTC",
            feeSatsPerByte: args.feeSatsPerByte,
            senderLockAmount: args.senderLockAmount,
            receiverLockAmount: args.receiverLockAmount,
            toAddress: await this.wallet.getAddress(),
        });

        await this.verifyChainSwap({
            to: "ARK",
            from: "BTC",
            swap: pendingSwap,
            arkInfo: await this.arkProvider.getInfo(),
        }).catch((err) => {
            throw new SwapError({
                message: `Chain swap verification failed: ${err.message}`,
            });
        });

        return {
            amountToPay: pendingSwap.response.lockupDetails.amount,
            btcAddress: pendingSwap.response.lockupDetails.lockupAddress,
            pendingSwap,
        };
    }

    /**
     * Waits for the swap to be confirmed and claims ARK.
     * @param pendingSwap - The pending chain swap to monitor.
     * @returns The transaction ID of the claimed VHTLC.
     */
    async waitAndClaimArk(
        pendingSwap: PendingChainSwap
    ): Promise<{ txid: string }> {
        if (
            this.swapManager &&
            (await this.swapManager.hasSwap(pendingSwap.id))
        ) {
            const { txid } = await this.swapManager.waitForSwapCompletion(
                pendingSwap.id
            );
            return { txid };
        }
        return new Promise<{ txid: string }>((resolve, reject) => {
            let claimStarted = false;
            // Local mutable copy — accumulates fields across status
            // callbacks without mutating the caller's object. Spreading
            // from the original on every callback would silently
            // discard previously saved data.
            const swap = { ...pendingSwap };
            const onStatusUpdate = async (
                status: BoltzSwapStatus,
                data: {
                    failureReason?: string;
                }
            ) => {
                const updateSwapStatus = () => {
                    swap.status = status;
                    return this.savePendingChainSwap(swap);
                };
                switch (status) {
                    case "transaction.server.mempool":
                    case "transaction.server.confirmed":
                        await updateSwapStatus();
                        if (claimStarted) return;
                        claimStarted = true;
                        this.claimArk(swap).catch(reject);
                        break;
                    case "transaction.claimed":
                        await updateSwapStatus();
                        const claimedStatus = await this.getSwapStatus(
                            pendingSwap.id
                        );
                        resolve({
                            txid: claimedStatus.transaction?.id ?? "",
                        });
                        break;
                    case "transaction.claim.pending":
                        await updateSwapStatus();
                        await this.signCooperativeClaimForServer(swap).catch(
                            (err) => {
                                logger.error(
                                    `Failed to sign cooperative claim for ${swap.id}:`,
                                    err
                                );
                            }
                        );
                        break;
                    case "transaction.lockupFailed":
                        await updateSwapStatus();
                        await this.quoteSwap(swap.response.id).catch((err) => {
                            reject(
                                new SwapError({
                                    message: `Failed to renegotiate quote: ${err.message}`,
                                    isRefundable: false, // TODO btc refund not implemented yet
                                    pendingSwap: swap,
                                })
                            );
                        });
                        break;
                    case "swap.expired":
                        await updateSwapStatus();
                        reject(
                            new SwapExpiredError({
                                isRefundable: false, // TODO btc refund not implemented yet
                                pendingSwap: swap,
                            })
                        );
                        break;
                    case "transaction.failed":
                        await updateSwapStatus();
                        reject(
                            new TransactionFailedError({
                                message: data.failureReason,
                                isRefundable: false, // TODO btc refund not implemented yet
                            })
                        );
                        break;
                    case "transaction.refunded":
                        await updateSwapStatus();
                        reject(new TransactionRefundedError());
                        break;
                    default:
                        await updateSwapStatus();
                        break;
                }
            };

            this.swapProvider
                .monitorSwap(swap.id, onStatusUpdate)
                .catch(reject);
        });
    }

    /**
     * Claim sats on ARK chain by claiming the VHTLC.
     * Refactored to use claimVHTLCIdentity + claimVHTLCwithOffchainTx utilities.
     * @param pendingSwap - The pending chain swap.
     */
    async claimArk(pendingSwap: PendingChainSwap): Promise<void> {
        if (!pendingSwap.toAddress)
            throw new Error("Destination address is required");

        if (!pendingSwap.response.claimDetails.serverPublicKey)
            throw new Error("Missing server public key in claim details");

        if (!pendingSwap.response.claimDetails.timeouts)
            throw new Error("Missing timeouts in claim details");

        const arkInfo = await this.arkProvider.getInfo();
        const preimage = hex.decode(pendingSwap.preimage);
        const address = await this.wallet.getAddress();

        // build expected VHTLC script
        const receiverXOnlyPublicKey = normalizeToXOnlyKey(
            pendingSwap.request.claimPublicKey,
            "receiver"
        );

        const senderXOnlyPublicKey = normalizeToXOnlyKey(
            pendingSwap.response.claimDetails.serverPublicKey!,
            "sender"
        );

        const serverXOnlyPublicKey = normalizeToXOnlyKey(
            arkInfo.signerPubkey,
            "server"
        );

        const { vhtlcAddress, vhtlcScript } = this.createVHTLCScript({
            network: arkInfo.network,
            preimageHash: hex.decode(pendingSwap.request.preimageHash),
            serverPubkey: hex.encode(serverXOnlyPublicKey),
            senderPubkey: hex.encode(senderXOnlyPublicKey),
            receiverPubkey: hex.encode(receiverXOnlyPublicKey),
            timeoutBlockHeights: pendingSwap.response.claimDetails.timeouts!,
        });

        if (!vhtlcScript.claimScript)
            throw new Error("Failed to create VHTLC script for chain swap");

        if (pendingSwap.response.claimDetails.lockupAddress !== vhtlcAddress) {
            throw new SwapError({
                message: "Unable to claim: invalid VHTLC address",
            });
        }

        // get spendable VTXOs from the lockup address
        const spendableVtxos = await this.indexerProvider.getVtxos({
            scripts: [hex.encode(vhtlcScript.pkScript)],
            spendableOnly: true,
        });

        if (spendableVtxos.vtxos.length === 0)
            throw new Error("No spendable virtual coins found");

        const vtxo = spendableVtxos.vtxos[0];

        const input = {
            ...vtxo,
            tapLeafScript: vhtlcScript.claim(),
            tapTree: vhtlcScript.encode(),
        };

        const output = {
            amount: BigInt(vtxo.value),
            script: ArkAddress.decode(address).pkScript,
        };

        // Use shared identity utility for preimage witness
        const vhtlcIdentity = claimVHTLCIdentity(
            this.wallet.identity,
            preimage
        );

        if (isRecoverable(vtxo)) {
            await this.joinBatch(vhtlcIdentity, input, output, arkInfo);
        } else {
            await claimVHTLCwithOffchainTx(
                vhtlcIdentity,
                vhtlcScript,
                serverXOnlyPublicKey,
                input,
                output,
                arkInfo,
                this.arkProvider
            );
        }

        // update the pending swap on storage
        const finalStatus = await this.getSwapStatus(pendingSwap.id);
        await this.savePendingChainSwap({
            ...pendingSwap,
            status: finalStatus.status,
        });
    }

    /**
     * Sign a cooperative claim for the server in BTC => ARK swaps.
     * @param pendingSwap - The pending chain swap.
     */
    async signCooperativeClaimForServer(
        pendingSwap: PendingChainSwap
    ): Promise<void> {
        if (!pendingSwap.response.lockupDetails.swapTree)
            throw new Error("Missing swap tree in lockup details");

        if (!pendingSwap.response.lockupDetails.serverPublicKey)
            throw new Error("Missing server public key in lockup details");

        const claimDetails = await this.swapProvider.getChainClaimDetails(
            pendingSwap.id
        );

        // Verify the server key from the claim response matches the one
        // stored at swap creation. MuSig2 requires consistent keys across
        // create() and aggregateNonces(); a mismatch produces an invalid sig.
        const serverPubKey = pendingSwap.response.lockupDetails.serverPublicKey;
        if (claimDetails.publicKey !== serverPubKey) {
            throw new Error(
                `Server public key mismatch: claim response has ${claimDetails.publicKey}, expected ${serverPubKey}`
            );
        }

        const musig = tweakMusig(
            createMusig(hex.decode(pendingSwap.ephemeralKey), [
                hex.decode(serverPubKey),
                secp256k1.getPublicKey(hex.decode(pendingSwap.ephemeralKey)),
            ]),
            deserializeSwapTree(pendingSwap.response.lockupDetails.swapTree)
                .tree
        );

        const musigNonces = musig
            .message(hex.decode(claimDetails.transactionHash))
            .generateNonce()
            .aggregateNonces([
                [
                    hex.decode(
                        pendingSwap.response.lockupDetails.serverPublicKey
                    ),
                    hex.decode(claimDetails.pubNonce),
                ],
            ])
            .initializeSession();

        const partialSig = musigNonces.signPartial();

        await this.swapProvider.postChainClaimDetails(pendingSwap.response.id, {
            signature: {
                partialSignature: hex.encode(partialSig.ourPartialSignature),
                pubNonce: hex.encode(partialSig.publicNonce),
            },
        });
    }

    /**
     * Waits for a chain swap to be claimable and then claims it.
     * Dispatches to waitAndClaimArk or waitAndClaimBtc based on swap direction.
     * @param pendingSwap - The pending swap to wait for and claim.
     * @returns The transaction ID of the claim.
     */
    async waitAndClaimChain(
        pendingSwap: PendingChainSwap
    ): Promise<{ txid: string }> {
        if (pendingSwap.request.to === "ARK")
            return this.waitAndClaimArk(pendingSwap);
        if (pendingSwap.request.to === "BTC")
            return this.waitAndClaimBtc(pendingSwap);
        throw new SwapError({
            message: `Unsupported swap destination: ${pendingSwap.request.to}`,
        });
    }

    // =========================================================================
    // Chain swap creation and verification
    // =========================================================================

    /**
     * Creates a chain swap.
     * @param args - The arguments for creating a chain swap.
     * @returns The created pending chain swap.
     */
    async createChainSwap(args: {
        to: Chain;
        from: Chain;
        toAddress: string;
        feeSatsPerByte?: number;
        senderLockAmount?: number;
        receiverLockAmount?: number;
    }): Promise<PendingChainSwap> {
        const { to, from, receiverLockAmount, senderLockAmount, toAddress } =
            args;

        if (!toAddress)
            throw new SwapError({ message: "Destination address is required" });

        const feeSatsPerByte = args.feeSatsPerByte ?? 1;
        if (feeSatsPerByte <= 0)
            throw new SwapError({ message: "Invalid feeSatsPerByte" });

        let amount, serverLockAmount, userLockAmount;

        if (receiverLockAmount) {
            amount = receiverLockAmount;
            const fees = await this.getFees(from, to);
            serverLockAmount =
                receiverLockAmount +
                (fees as ChainFeesResponse).minerFees.user.claim;
        } else if (senderLockAmount) {
            amount = senderLockAmount;
            userLockAmount = senderLockAmount;
        }

        if (!amount || amount <= 0) {
            throw new SwapError({ message: "Invalid lock amount" });
        }

        // create random preimage and its hash
        const preimage = randomBytes(32);
        const preimageHash = hex.encode(sha256(preimage));
        if (!preimageHash)
            throw new SwapError({ message: "Failed to get preimage hash" });

        // ephemeral keys for BTC chain claim/refund
        const ephemeralKey = secp256k1.utils.randomSecretKey();

        const refundPublicKey =
            to === "ARK"
                ? hex.encode(secp256k1.getPublicKey(ephemeralKey))
                : hex.encode(await this.wallet.identity.compressedPublicKey());

        if (!refundPublicKey)
            throw new SwapError({
                message: "Failed to get refund public key",
            });

        const claimPublicKey =
            to === "ARK"
                ? hex.encode(await this.wallet.identity.compressedPublicKey())
                : hex.encode(secp256k1.getPublicKey(ephemeralKey));

        if (!claimPublicKey)
            throw new SwapError({
                message: "Failed to get claim public key",
            });

        const swapRequest: CreateChainSwapRequest = {
            to,
            from,
            preimageHash,
            feeSatsPerByte,
            claimPublicKey,
            refundPublicKey,
            serverLockAmount,
            userLockAmount,
        };

        const swapResponse =
            await this.swapProvider.createChainSwap(swapRequest);

        const pendingSwap: PendingChainSwap = {
            amount,
            createdAt: Math.floor(Date.now() / 1000),
            ephemeralKey: hex.encode(ephemeralKey),
            feeSatsPerByte,
            id: swapResponse.id,
            preimage: hex.encode(preimage),
            request: swapRequest,
            response: swapResponse,
            status: "swap.created",
            toAddress: args.toAddress,
            type: "chain",
        };

        await this.savePendingChainSwap(pendingSwap);

        this.swapManager?.addSwap(pendingSwap);

        return pendingSwap;
    }

    /**
     * Validates the lockup and claim addresses match the expected scripts.
     * @param args - The arguments for verifying a chain swap.
     * @returns True if the addresses match.
     */
    async verifyChainSwap(args: {
        to: Chain;
        from: Chain;
        swap: PendingChainSwap;
        arkInfo: ArkInfo;
    }): Promise<boolean> {
        const { to, from, swap, arkInfo } = args;

        if (from === "ARK") {
            if (!swap.response.lockupDetails.serverPublicKey)
                throw new Error("Missing serverPublicKey in lockup details");
            if (!swap.response.lockupDetails.timeouts)
                throw new Error("Missing timeouts in lockup details");
        }

        if (to === "ARK") {
            if (!swap.response.claimDetails.serverPublicKey)
                throw new Error("Missing serverPublicKey in claim details");
            if (!swap.response.claimDetails.timeouts)
                throw new Error("Missing timeouts in claim details");
        }

        const lockupAddress =
            to === "ARK"
                ? swap.response.claimDetails.lockupAddress
                : swap.response.lockupDetails.lockupAddress;

        const receiverPubkey =
            to === "ARK"
                ? swap.request.claimPublicKey
                : swap.response.lockupDetails.serverPublicKey!;

        const senderPubkey =
            to === "ARK"
                ? swap.response.claimDetails.serverPublicKey!
                : swap.request.refundPublicKey;

        const serverPubkey = hex.encode(
            normalizeToXOnlyKey(arkInfo.signerPubkey, "server")
        );

        const timeoutBlockHeights =
            to === "ARK"
                ? swap.response.claimDetails.timeouts!
                : swap.response.lockupDetails.timeouts!;

        const { vhtlcAddress } = this.createVHTLCScript({
            network: arkInfo.network,
            preimageHash: hex.decode(swap.request.preimageHash),
            receiverPubkey,
            senderPubkey,
            serverPubkey,
            timeoutBlockHeights,
        });

        if (lockupAddress !== vhtlcAddress) {
            throw new SwapError({
                message: "Boltz is trying to scam us (invalid address)",
            });
        }

        return true;
    }

    /**
     * Renegotiates the quote for an existing swap.
     * @param swapId - The ID of the swap.
     * @returns The accepted quote amount.
     */
    async quoteSwap(swapId: string): Promise<number> {
        const { amount } = await this.swapProvider.getChainQuote(swapId);
        await this.swapProvider.postChainQuote(swapId, { amount });
        return amount;
    }

    // =========================================================================
    // Shared utilities
    // =========================================================================

    /**
     * Joins a batch to spend the vtxo via commitment transaction.
     * @param identity - The identity to use for signing.
     * @param input - The input vtxo.
     * @param output - The output script.
     * @param arkInfo - Chain information used for building transactions.
     * @param isRecoverable - Whether the input is recoverable.
     * @returns The commitment transaction ID.
     */
    async joinBatch(
        identity: Identity,
        input: ArkTxInput,
        output: TransactionOutput,
        arkInfo: ArkInfo,
        isRecoverable = true
    ): Promise<string> {
        return joinBatch(
            this.arkProvider,
            identity,
            input,
            output,
            arkInfo,
            isRecoverable
        );
    }

    /**
     * Creates a VHTLC script for the swap.
     * Works for submarine, reverse, and chain swaps.
     */
    createVHTLCScript(args: {
        network: string;
        preimageHash: Uint8Array;
        receiverPubkey: string;
        senderPubkey: string;
        serverPubkey: string;
        timeoutBlockHeights: {
            refund: number;
            unilateralClaim: number;
            unilateralRefund: number;
            unilateralRefundWithoutReceiver: number;
        };
    }): { vhtlcScript: VHTLC.Script; vhtlcAddress: string } {
        return createVHTLCScript(args);
    }

    // =========================================================================
    // Fees, limits, and status
    // =========================================================================

    /**
     * Retrieves fees for swaps.
     * - No arguments: returns lightning (submarine/reverse) fees
     * - With (from, to) arguments: returns chain swap fees
     */
    async getFees(): Promise<FeesResponse>;
    async getFees(from: Chain, to: Chain): Promise<ChainFeesResponse>;
    async getFees(
        from?: Chain,
        to?: Chain
    ): Promise<FeesResponse | ChainFeesResponse> {
        if (from && to) {
            return this.swapProvider.getChainFees(from, to);
        }
        return this.swapProvider.getFees();
    }

    /**
     * Retrieves max and min limits for swaps.
     * - No arguments: returns lightning swap limits
     * - With (from, to) arguments: returns chain swap limits
     */
    async getLimits(): Promise<LimitsResponse>;
    async getLimits(from: Chain, to: Chain): Promise<LimitsResponse>;
    async getLimits(from?: Chain, to?: Chain): Promise<LimitsResponse> {
        if (from && to) {
            return this.swapProvider.getChainLimits(from, to);
        }
        return this.swapProvider.getLimits();
    }

    /**
     * Retrieves swap status by ID.
     * @param swapId - The ID of the swap.
     * @returns The status of the swap.
     */
    async getSwapStatus(swapId: string): Promise<GetSwapStatusResponse> {
        return this.swapProvider.getSwapStatus(swapId);
    }

    // =========================================================================
    // Storage queries
    // =========================================================================

    /**
     * Returns pending submarine swaps (those with status `invoice.set`).
     */
    async getPendingSubmarineSwaps(): Promise<PendingSubmarineSwap[]> {
        const swaps = await this.getPendingSubmarineSwapsFromStorage();
        if (!swaps) return [];
        return swaps.filter(
            (swap: PendingSubmarineSwap) => swap.status === "invoice.set"
        );
    }

    /**
     * Returns pending reverse swaps (those with status `swap.created`).
     */
    async getPendingReverseSwaps(): Promise<PendingReverseSwap[]> {
        const swaps = await this.getPendingReverseSwapsFromStorage();
        if (!swaps) return [];
        return swaps.filter(
            (swap: PendingReverseSwap) => swap.status === "swap.created"
        );
    }

    /**
     * Returns pending chain swaps (those with status `swap.created`).
     */
    async getPendingChainSwaps(): Promise<PendingChainSwap[]> {
        const swaps = await this.getPendingChainSwapsFromStorage();
        return swaps.filter((swap) => swap.status === "swap.created");
    }

    /**
     * Retrieves swap history from storage.
     * @returns Array of all swaps (reverse + submarine + chain) sorted by creation date (newest first).
     */
    async getSwapHistory(): Promise<PendingSwap[]> {
        const reverseSwaps = await this.getPendingReverseSwapsFromStorage();
        const submarineSwaps = await this.getPendingSubmarineSwapsFromStorage();
        const chainSwaps = await this.getPendingChainSwapsFromStorage();
        const allSwaps: PendingSwap[] = [
            ...(reverseSwaps || []),
            ...(submarineSwaps || []),
            ...(chainSwaps || []),
        ];
        return allSwaps.sort((a, b) => b.createdAt - a.createdAt);
    }

    /**
     * Refreshes the status of all pending swaps in the storage provider.
     */
    async refreshSwapsStatus(): Promise<void> {
        const promises: Promise<void>[] = [];

        for (const swap of await this.getPendingReverseSwapsFromStorage()) {
            if (isReverseFinalStatus(swap.status)) continue;
            promises.push(
                this.getSwapStatus(swap.id)
                    .then(({ status }) =>
                        updateReverseSwapStatus(
                            swap,
                            status,
                            this.savePendingReverseSwap.bind(this)
                        )
                    )
                    .catch((error) => {
                        logger.error(
                            `Failed to refresh swap status for ${swap.id}:`,
                            error
                        );
                    })
            );
        }
        for (const swap of await this.getPendingSubmarineSwapsFromStorage()) {
            if (isSubmarineFinalStatus(swap.status)) continue;
            promises.push(
                this.getSwapStatus(swap.id)
                    .then(({ status }) =>
                        updateSubmarineSwapStatus(
                            swap,
                            status,
                            this.savePendingSubmarineSwap.bind(this)
                        )
                    )
                    .catch((error) => {
                        logger.error(
                            `Failed to refresh swap status for ${swap.id}:`,
                            error
                        );
                    })
            );
        }
        for (const swap of await this.getPendingChainSwapsFromStorage()) {
            if (isChainFinalStatus(swap.status)) continue;
            promises.push(
                this.getSwapStatus(swap.id)
                    .then(({ status }) =>
                        this.savePendingChainSwap({ ...swap, status })
                    )
                    .catch((error) => {
                        logger.error(
                            `Failed to refresh swap status for ${swap.id}:`,
                            error
                        );
                    })
            );
        }

        await Promise.all(promises);
    }

    // =========================================================================
    // Swap restoration and enrichment
    // =========================================================================

    /**
     * Restore swaps from Boltz API.
     *
     * Note: restored swaps may lack local-only data such as the original
     * Lightning invoice or preimage. They are intended primarily for
     * display/monitoring and are not automatically wired into the SwapManager.
     */
    async restoreSwaps(boltzFees?: FeesResponse): Promise<{
        chainSwaps: PendingChainSwap[];
        reverseSwaps: PendingReverseSwap[];
        submarineSwaps: PendingSubmarineSwap[];
    }> {
        const publicKey = hex.encode(
            await this.wallet.identity.compressedPublicKey()
        );
        if (!publicKey) throw new Error("Failed to get public key from wallet");

        const fees = boltzFees ?? (await this.swapProvider.getFees());

        const chainSwaps: PendingChainSwap[] = [];
        const reverseSwaps: PendingReverseSwap[] = [];
        const submarineSwaps: PendingSubmarineSwap[] = [];

        const restoredSwaps = await this.swapProvider.restoreSwaps(publicKey);

        for (const swap of restoredSwaps) {
            const { id, createdAt, status } = swap;
            if (isRestoredReverseSwap(swap)) {
                const {
                    amount,
                    lockupAddress,
                    preimageHash,
                    serverPublicKey,
                    tree,
                } = swap.claimDetails;

                reverseSwaps.push({
                    id,
                    createdAt,
                    request: {
                        invoiceAmount: extractInvoiceAmount(amount, fees),
                        claimPublicKey: publicKey,
                        preimageHash,
                    },
                    response: {
                        id,
                        invoice: "",
                        onchainAmount: amount,
                        lockupAddress,
                        refundPublicKey: serverPublicKey,
                        timeoutBlockHeights: {
                            refund: extractTimeLockFromLeafOutput(
                                tree.refundWithoutBoltzLeaf.output
                            ),
                            unilateralClaim: extractTimeLockFromLeafOutput(
                                tree.unilateralClaimLeaf.output
                            ),
                            unilateralRefund: extractTimeLockFromLeafOutput(
                                tree.unilateralRefundLeaf.output
                            ),
                            unilateralRefundWithoutReceiver:
                                extractTimeLockFromLeafOutput(
                                    tree.unilateralRefundWithoutBoltzLeaf.output
                                ),
                        },
                    },
                    status,
                    type: "reverse",
                    preimage: "",
                } as PendingReverseSwap);
            } else if (isRestoredSubmarineSwap(swap)) {
                const { amount, lockupAddress, serverPublicKey, tree } =
                    swap.refundDetails;

                let preimage = "";
                try {
                    const data = await this.swapProvider.getSwapPreimage(
                        swap.id
                    );
                    preimage = data.preimage;
                } catch (error) {
                    logger.warn(
                        `Failed to restore preimage for submarine swap ${id}`,
                        error
                    );
                }

                submarineSwaps.push({
                    id,
                    type: "submarine",
                    createdAt,
                    preimage,
                    preimageHash: swap.preimageHash,
                    status,
                    request: {
                        invoice: "",
                        refundPublicKey: publicKey,
                    },
                    response: {
                        id,
                        address: lockupAddress,
                        expectedAmount: amount,
                        claimPublicKey: serverPublicKey,
                        timeoutBlockHeights: {
                            refund: extractTimeLockFromLeafOutput(
                                tree.refundWithoutBoltzLeaf.output
                            ),
                            unilateralClaim: extractTimeLockFromLeafOutput(
                                tree.unilateralClaimLeaf.output
                            ),
                            unilateralRefund: extractTimeLockFromLeafOutput(
                                tree.unilateralRefundLeaf.output
                            ),
                            unilateralRefundWithoutReceiver:
                                extractTimeLockFromLeafOutput(
                                    tree.unilateralRefundWithoutBoltzLeaf.output
                                ),
                        },
                    },
                } as PendingSubmarineSwap);
            } else if (isRestoredChainSwap(swap)) {
                const {
                    amount,
                    lockupAddress,
                    serverPublicKey,
                    timeoutBlockHeight,
                } = swap.refundDetails;

                chainSwaps.push({
                    id,
                    type: "chain",
                    createdAt,
                    preimage: "",
                    ephemeralKey: "",
                    feeSatsPerByte: 1,
                    amount,
                    status,
                    request: {
                        to: swap.to,
                        from: swap.from,
                        preimageHash: swap.preimageHash,
                        claimPublicKey: "",
                        feeSatsPerByte: 1,
                        refundPublicKey: "",
                        serverLockAmount: amount,
                        userLockAmount: amount,
                    },
                    response: {
                        id,
                        lockupDetails: {
                            amount,
                            lockupAddress,
                            serverPublicKey,
                            timeoutBlockHeight,
                        },
                    },
                } as PendingChainSwap);
            }
        }

        return { chainSwaps, reverseSwaps, submarineSwaps };
    }

    /**
     * Enrich a restored reverse swap with its preimage.
     */
    enrichReverseSwapPreimage(
        swap: PendingReverseSwap,
        preimage: string
    ): PendingReverseSwap {
        return enrichReverseSwapPreimage(swap, preimage);
    }

    /**
     * Enrich a restored submarine swap with its invoice.
     */
    enrichSubmarineSwapInvoice(
        swap: PendingSubmarineSwap,
        invoice: string
    ): PendingSubmarineSwap {
        return enrichSubmarineSwapInvoice(swap, invoice);
    }
}

/** @deprecated Use ArkadeSwapsConfig instead */
export type ArkadeLightningConfig = ArkadeSwapsConfig;

/** @deprecated Use ArkadeSwaps instead */
export const ArkadeLightning = ArkadeSwaps;

export interface IArkadeSwaps extends AsyncDisposable {
    startSwapManager(): Promise<void>;
    stopSwapManager(): Promise<void>;
    getSwapManager(): SwapManagerClient | null;
    createLightningInvoice(
        args: CreateLightningInvoiceRequest
    ): Promise<CreateLightningInvoiceResponse>;
    sendLightningPayment(
        args: SendLightningPaymentRequest
    ): Promise<SendLightningPaymentResponse>;
    createSubmarineSwap(
        args: SendLightningPaymentRequest
    ): Promise<PendingSubmarineSwap>;
    createReverseSwap(
        args: CreateLightningInvoiceRequest
    ): Promise<PendingReverseSwap>;
    claimVHTLC(pendingSwap: PendingReverseSwap): Promise<void>;
    refundVHTLC(pendingSwap: PendingSubmarineSwap): Promise<void>;
    waitAndClaim(pendingSwap: PendingReverseSwap): Promise<{ txid: string }>;
    waitForSwapSettlement(
        pendingSwap: PendingSubmarineSwap
    ): Promise<{ preimage: string }>;
    restoreSwaps(boltzFees?: FeesResponse): Promise<{
        chainSwaps: PendingChainSwap[];
        reverseSwaps: PendingReverseSwap[];
        submarineSwaps: PendingSubmarineSwap[];
    }>;
    arkToBtc(args: {
        btcAddress: string;
        senderLockAmount?: number;
        receiverLockAmount?: number;
        feeSatsPerByte?: number;
    }): Promise<ArkToBtcResponse>;
    waitAndClaimBtc(pendingSwap: PendingChainSwap): Promise<{ txid: string }>;
    claimBtc(pendingSwap: PendingChainSwap): Promise<void>;
    refundArk(pendingSwap: PendingChainSwap): Promise<void>;
    btcToArk(args: {
        feeSatsPerByte?: number;
        senderLockAmount?: number;
        receiverLockAmount?: number;
    }): Promise<BtcToArkResponse>;
    waitAndClaimArk(pendingSwap: PendingChainSwap): Promise<{ txid: string }>;
    claimArk(pendingSwap: PendingChainSwap): Promise<void>;
    signCooperativeClaimForServer(pendingSwap: PendingChainSwap): Promise<void>;
    waitAndClaimChain(pendingSwap: PendingChainSwap): Promise<{ txid: string }>;
    createChainSwap(args: {
        to: Chain;
        from: Chain;
        toAddress: string;
        feeSatsPerByte?: number;
        senderLockAmount?: number;
        receiverLockAmount?: number;
    }): Promise<PendingChainSwap>;
    verifyChainSwap(args: {
        to: Chain;
        from: Chain;
        swap: PendingChainSwap;
        arkInfo: ArkInfo;
    }): Promise<boolean>;
    quoteSwap(swapId: string): Promise<number>;
    joinBatch(
        identity: Identity,
        input: ArkTxInput,
        output: TransactionOutput,
        arkInfo: ArkInfo,
        isRecoverable?: boolean
    ): Promise<string>;
    createVHTLCScript(args: {
        network: string;
        preimageHash: Uint8Array;
        receiverPubkey: string;
        senderPubkey: string;
        serverPubkey: string;
        timeoutBlockHeights: {
            refund: number;
            unilateralClaim: number;
            unilateralRefund: number;
            unilateralRefundWithoutReceiver: number;
        };
    }): { vhtlcScript: VHTLC.Script; vhtlcAddress: string };
    getFees(): Promise<FeesResponse>;
    getFees(from: Chain, to: Chain): Promise<ChainFeesResponse>;
    getLimits(): Promise<LimitsResponse>;
    getLimits(from: Chain, to: Chain): Promise<LimitsResponse>;
    getPendingSubmarineSwaps(): Promise<PendingSubmarineSwap[]>;
    getPendingReverseSwaps(): Promise<PendingReverseSwap[]>;
    getPendingChainSwaps(): Promise<PendingChainSwap[]>;
    getSwapHistory(): Promise<PendingSwap[]>;
    refreshSwapsStatus(): Promise<void>;
    getSwapStatus(swapId: string): Promise<GetSwapStatusResponse>;
    enrichReverseSwapPreimage(
        swap: PendingReverseSwap,
        preimage: string
    ): PendingReverseSwap;
    enrichSubmarineSwapInvoice(
        swap: PendingSubmarineSwap,
        invoice: string
    ): PendingSubmarineSwap;
    dispose(): Promise<void>;
}
