import {
    SwapError,
    SwapExpiredError,
    InvoiceExpiredError,
    InvoiceFailedToPayError,
    TransactionFailedError,
    TransactionLockupFailedError,
    TransactionRefundedError,
    BoltzRefundError,
    QuoteRejectedError,
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
    VirtualCoin,
    getNetwork,
    type NetworkName,
} from "@arkade-os/sdk";
import type {
    Chain,
    Network,
    LimitsResponse,
    FeesResponse,
    ChainFeesResponse,
    BoltzChainSwap,
    BoltzReverseSwap,
    BoltzSubmarineSwap,
    BoltzSwap,
    ArkadeSwapsConfig,
    ArkadeSwapsCreateConfig,
    ChainArkRefundOutcome,
    CreateLightningInvoiceRequest,
    CreateLightningInvoiceResponse,
    SendLightningPaymentRequest,
    SendLightningPaymentResponse,
    OptimisticSendLightningPaymentResponse,
    ArkToBtcResponse,
    BtcToArkResponse,
    SubmarineRecoveryInfo,
    SubmarineRecoveryResult,
    SubmarineRefundOutcome,
} from "./types";
import {
    BoltzSwapProvider,
    BoltzSwapStatus,
    GetSwapStatusResponse,
    CreateSubmarineSwapRequest,
    CreateReverseSwapRequest,
    CreateChainSwapRequest,
    isSubmarineFinalStatus,
    isSubmarineSuccessStatus,
    isSubmarineRefundableStatus,
    hasSubmarineStatusReached,
    type SubmarineProgressionStatus,
    isReverseFinalStatus,
    isChainFinalStatus,
    isRestoredReverseSwap,
    isRestoredSubmarineSwap,
    isRestoredChainSwap,
} from "./boltz-swap-provider";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { hex } from "@scure/base";
import { TransactionOutput } from "@scure/btc-signer/psbt.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { Address, OutScript, SigHash, Transaction } from "@scure/btc-signer";
import { equalBytes } from "@scure/btc-signer/utils.js";
import { create as createMusig } from "./utils/musig";
import {
    deserializeSwapTree,
    tweakMusig,
    detectSwapOutput,
    constructClaimTransaction,
    targetFee,
    p2trScript,
    toXOnly,
    assertChainHtlcLeaves,
} from "./utils/boltz-swap-tx";
import { decodeInvoice, getInvoicePaymentHash } from "./utils/decoding";
import { normalizeToXOnlyKey } from "./utils/signatures";
import { extractInvoiceAmount, resolveVhtlcTimeouts } from "./utils/restoration";
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
    candidateServerPubkeys,
    claimVHTLCwithOffchainTx,
    createVHTLCScript,
    joinBatch,
    refundVHTLCwithOffchainTx,
    refundWithoutReceiverVHTLCwithOffchainTx,
    type VhtlcTimeouts,
} from "./utils/vhtlc";

type SubmarineVHTLCDiagnostic = {
    totalVtxoCount: number;
    allSpent: boolean;
};

type SubmarineVHTLCContext = {
    arkInfo: ArkInfo;
    vhtlcScript: VHTLC.Script;
    vhtlcAddress: string;
    vhtlcPkScriptHex: string;
    /**
     * VHTLC timeout fields from the Boltz response. `refund` is an absolute
     * Unix timestamp (CLTV); the unilateral fields are BIP68 relative delays.
     */
    vhtlcTimeouts: NonNullable<BoltzSubmarineSwap["response"]["timeoutBlockHeights"]>;
    ourXOnlyPublicKey: Uint8Array;
    serverXOnlyPublicKey: Uint8Array;
    boltzXOnlyPublicKey: Uint8Array;
};

type SubmarineVHTLCLookup = SubmarineVHTLCContext & {
    refundableVtxos: VirtualCoin[];
    diagnostic?: SubmarineVHTLCDiagnostic;
};

type SubmarineScanPrepared =
    | {
          swap: BoltzSubmarineSwap;
          context: SubmarineVHTLCContext;
      }
    | {
          swap: BoltzSubmarineSwap;
          error: string;
      };

/**
 * Loop-invariant inputs shared by every `refundWithoutReceiver` settlement in a
 * single refund pass. Bundled so {@link ArkadeSwaps.settleRefundWithoutReceiver}
 * needs only the per-VTXO coin alongside it.
 */
type RefundWithoutReceiverContext = {
    arkInfo: ArkInfo;
    vhtlcScript: VHTLC.Script;
    serverXOnlyPublicKey: Uint8Array;
    refundWithoutReceiverLeaf: ArkTxInput["tapLeafScript"];
    outputScript: Uint8Array;
};

const dedupeVtxos = (vtxos: VirtualCoin[]): VirtualCoin[] => [
    ...new Map(vtxos.map((vtxo) => [`${vtxo.txid}:${vtxo.vout}`, vtxo] as const)).values(),
];

const hasNonEmptyString = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0;

const canRecoverViaBoltz3of3 = (
    refundableVtxos: VirtualCoin[],
    swap: BoltzSubmarineSwap,
): boolean => {
    const hasRequiredSwapMetadata =
        hasNonEmptyString(swap.id) &&
        hasNonEmptyString(swap.request.refundPublicKey) &&
        hasNonEmptyString(swap.response.address) &&
        hasNonEmptyString(swap.response.claimPublicKey) &&
        !!swap.response.timeoutBlockHeights;

    if (!hasRequiredSwapMetadata) return false;

    // Pre-CLTV Boltz co-signing only works for normal spendable VTXOs.
    // Swept/recoverable VTXOs must wait for refundWithoutReceiver.
    return refundableVtxos.some((vtxo) => !vtxo.isSpent && !isRecoverable(vtxo));
};

/**
 * Boltz Ark VHTLCs encode `refund` as an absolute Unix timestamp (CLTV with
 * timestamp semantics). Compare against wall-clock seconds; never against
 * chain tip height.
 */
const isSubmarineRefundLocktimeReached = (refundTimestamp: number): boolean =>
    Math.floor(Date.now() / 1000) >= refundTimestamp;

// Retry policy for fetching the lockup VTXO when claiming a swap: the indexer
// may lag behind the on-chain lockup tx, so retry a few times before giving up.
const CLAIM_VTXO_RETRY_ATTEMPTS = 3;
const CLAIM_VTXO_RETRY_DELAY_MS = 500;

// Build the QuoteSwapOptions for an autopilot renegotiation. The type marks
// `claimDetails.amount` as required, but a swap restored from older persisted
// formats may lack it — in that case, fall through without a floor (the
// repository lookup will then resolve no_baseline and abort the renegotiation).
const quoteOptionsForSwap = (swap: BoltzChainSwap): QuoteSwapOptions | undefined => {
    const amount = swap.response?.claimDetails?.amount;
    return typeof amount === "number" ? { minAcceptableAmount: amount } : undefined;
};

/**
 * Unified entry point for Lightning and chain swaps between Arkade, Lightning Network, and Bitcoin.
 *
 * Orchestrates submarine swaps (Arkade → Lightning), reverse swaps (Lightning → Arkade),
 * and chain swaps (ARK ↔ BTC) through the Boltz swap protocol.
 *
 * Optionally integrates SwapManager for autonomous background monitoring, auto-claiming,
 * and auto-refunding of swaps.
 */
export class ArkadeSwaps {
    /** The Arkade wallet instance used for signing and address generation. */
    readonly wallet: IWallet;
    /** Provider for Ark protocol operations (VTXO management, batch joining). */
    readonly arkProvider: ArkProvider;
    /** Boltz API client for creating and monitoring swaps. */
    readonly swapProvider: BoltzSwapProvider;
    /** Provider for querying VTXO state on the Ark indexer. */
    readonly indexerProvider: IndexerProvider;
    /** Background swap monitor, or null if not enabled. */
    readonly swapManager: SwapManager | null = null;
    /** Storage backend for persisting swap data. */
    readonly swapRepository: SwapRepository;

    /**
     * Creates an ArkadeSwaps instance, auto-detecting the network from the wallet's Ark server.
     * If no `swapProvider` is given, one is created automatically using the detected network.
     *
     * This is the recommended way to initialize ArkadeSwaps.
     *
     * @param config - Configuration options. swapProvider is auto-created from the wallet's network if omitted.
     * @returns A fully initialized ArkadeSwaps instance.
     *
     * @example
     * ```ts
     * const swaps = await ArkadeSwaps.create({
     *   wallet,
     *   swapManager: true,
     * });
     * ```
     */
    static async create(config: ArkadeSwapsCreateConfig): Promise<ArkadeSwaps> {
        if (config.swapProvider) {
            return new ArkadeSwaps(config as ArkadeSwapsConfig);
        }

        const arkProvider = config.arkProvider ?? (config.wallet as any).arkProvider;
        if (!arkProvider) throw new Error("Ark provider is required either in wallet or config.");

        const arkInfo = await arkProvider.getInfo();
        const network = arkInfo.network as Network;
        const swapProvider = new BoltzSwapProvider({ network });

        return new ArkadeSwaps({ ...config, swapProvider });
    }

    constructor(config: ArkadeSwapsConfig) {
        if (!config.wallet) throw new Error("Wallet is required.");
        if (!config.swapProvider) throw new Error("Swap provider is required.");

        this.wallet = config.wallet;
        // Prioritize wallet providers, fallback to config providers for backward compatibility
        const arkProvider = config.arkProvider ?? (config.wallet as any).arkProvider;
        if (!arkProvider) throw new Error("Ark provider is required either in wallet or config.");
        this.arkProvider = arkProvider;

        const indexerProvider = config.indexerProvider ?? (config.wallet as any).indexerProvider;
        if (!indexerProvider)
            throw new Error("Indexer provider is required either in wallet or config.");
        this.indexerProvider = indexerProvider;

        this.swapProvider = config.swapProvider;

        // Initialize SwapRepository
        if (config.swapRepository) {
            this.swapRepository = config.swapRepository;
        } else {
            this.swapRepository = new IndexedDbSwapRepository();
        }

        // Initialize SwapManager (enabled by default)
        // - true/undefined: use defaults
        // - object: use provided config
        // - false: disabled
        if (config.swapManager !== false) {
            const swapManagerConfig =
                !config.swapManager || config.swapManager === true ? {} : config.swapManager;

            // Extract autostart (defaults to true) before passing to SwapManager
            const shouldAutostart = swapManagerConfig.autoStart ?? true;

            this.swapManager = new SwapManager(this.swapProvider, swapManagerConfig);

            // Set up callbacks for all swap types
            this.swapManager.setCallbacks({
                claim: async (swap: BoltzReverseSwap) => {
                    await this.claimVHTLC(swap);
                },
                refund: async (swap: BoltzSubmarineSwap) => {
                    await this.refundVHTLC(swap);
                },
                claimArk: (swap: BoltzChainSwap) => this.claimArk(swap),
                claimBtc: (swap: BoltzChainSwap) => this.claimBtc(swap),
                refundArk: async (swap: BoltzChainSwap) => {
                    return this.refundArk(swap);
                },
                signServerClaim: async (swap: BoltzChainSwap) => {
                    await this.signCooperativeClaimForServer(swap);
                },
                saveSwap: async (swap: BoltzSwap) => {
                    await saveSwap(swap, {
                        saveReverseSwap: this.savePendingReverseSwap.bind(this),
                        saveSubmarineSwap: this.savePendingSubmarineSwap.bind(this),
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

    private async savePendingReverseSwap(swap: BoltzReverseSwap): Promise<void> {
        await this.swapRepository.saveSwap(swap);
    }

    private async savePendingSubmarineSwap(swap: BoltzSubmarineSwap): Promise<void> {
        await this.swapRepository.saveSwap(swap);
    }

    private async savePendingChainSwap(swap: BoltzChainSwap): Promise<void> {
        await this.swapRepository.saveSwap(swap);
    }

    private async getPendingReverseSwapsFromStorage(): Promise<BoltzReverseSwap[]> {
        return this.swapRepository.getAllSwaps<BoltzReverseSwap>({
            type: "reverse",
        });
    }

    private async getPendingSubmarineSwapsFromStorage(): Promise<BoltzSubmarineSwap[]> {
        return this.swapRepository.getAllSwaps<BoltzSubmarineSwap>({
            type: "submarine",
        });
    }

    private async getPendingChainSwapsFromStorage(): Promise<BoltzChainSwap[]> {
        return this.swapRepository.getAllSwaps<BoltzChainSwap>({
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
                "SwapManager is not enabled. Provide 'swapManager' config in ArkadeSwapsConfig.",
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
    /**
     * Reset all swap state: stops the SwapManager and clears the swap repository.
     *
     * **Destructive** — any swap in a non-terminal state will lose its
     * refund/claim path. Intended for wallet-reset / dev / test scenarios only.
     */
    async reset(): Promise<void> {
        await this.dispose();
        await this.swapRepository.clear();
    }

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
     * Creates a Lightning invoice via a reverse swap (Lightning → Arkade).
     * @param args.amount - Invoice amount in satoshis.
     * @param args.description - Optional description for the BOLT11 invoice.
     * @returns Object containing the BOLT11 invoice, payment hash, preimage, and pending swap for monitoring.
     * @throws {SwapError} If amount is <= 0 or wallet key retrieval fails.
     */
    async createLightningInvoice(
        args: CreateLightningInvoiceRequest,
    ): Promise<CreateLightningInvoiceResponse> {
        const pendingSwap = await this.createReverseSwap(args);
        const decodedInvoice = decodeInvoice(pendingSwap.response.invoice);
        return {
            amount: pendingSwap.response.onchainAmount,
            expiry: decodedInvoice.expiry,
            timestamp: decodedInvoice.timestamp,
            invoice: pendingSwap.response.invoice,
            paymentHash: decodedInvoice.paymentHash,
            pendingSwap,
            preimage: pendingSwap.preimage,
        } as CreateLightningInvoiceResponse;
    }

    /**
     * Creates a reverse swap (Lightning → Arkade) and saves it to storage.
     * @param args.amount - Amount in satoshis for the reverse swap.
     * @param args.description - Optional invoice description.
     * @returns The pending reverse swap, added to SwapManager if enabled.
     * @throws {SwapError} If amount is <= 0 or key retrieval fails.
     */
    async createReverseSwap(args: CreateLightningInvoiceRequest): Promise<BoltzReverseSwap> {
        // validate amount
        if (args.amount <= 0) throw new SwapError({ message: "Amount must be greater than 0" });

        const claimPublicKey = hex.encode(await this.wallet.identity.compressedPublicKey());
        if (!claimPublicKey)
            throw new SwapError({
                message: "Failed to get claim public key from wallet",
            });

        // create random preimage and its hash
        const preimage = randomBytes(32);
        const preimageHash = hex.encode(sha256(preimage));
        if (!preimageHash) throw new SwapError({ message: "Failed to get preimage hash" });

        // build request object for reverse swap. A BOLT11 invoice carries
        // either a description or a description hash, never both, so prefer
        // descriptionHash when present and drop the plaintext description.
        // Gate on `!== undefined` (not truthiness) so a present-but-invalid
        // hash like "" is forwarded and rejected by the provider's hex check,
        // rather than silently falling back to the description.
        const swapRequest: CreateReverseSwapRequest = {
            invoiceAmount: args.amount,
            claimPublicKey,
            preimageHash,
            ...(args.descriptionHash !== undefined
                ? { descriptionHash: args.descriptionHash }
                : args.description?.trim()
                  ? { description: args.description.trim() }
                  : {}),
        };

        // make reverse swap request
        const swapResponse = await this.swapProvider.createReverseSwap(swapRequest);

        const decodedInvoice = decodeInvoice(swapResponse.invoice);
        if (decodedInvoice.paymentHash !== preimageHash) {
            throw new SwapError({ message: "Preimage hash does not match invoice payment hash" });
        }

        const pendingSwap: BoltzReverseSwap = {
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
     * Claims the VHTLC for a pending reverse swap, transferring locked funds to the wallet.
     * @param pendingSwap - The reverse swap whose VHTLC should be claimed.
     * @throws {Error} If preimage is missing, VHTLC script creation fails, or no spendable VTXOs found.
     */
    async claimVHTLC(pendingSwap: BoltzReverseSwap): Promise<void> {
        // restored swaps may not have preimage
        if (!pendingSwap.preimage)
            throw new Error(`Swap ${pendingSwap.id}: preimage is required to claim VHTLC`);

        const {
            refundPublicKey,
            lockupAddress,
            timeoutBlockHeights: vhtlcTimeouts,
        } = pendingSwap.response;
        if (!refundPublicKey || !lockupAddress || !vhtlcTimeouts)
            throw new Error(`Swap ${pendingSwap.id}: incomplete reverse swap response`);

        const preimage = hex.decode(pendingSwap.preimage);
        const arkInfo = await this.arkProvider.getInfo();
        const address = await this.wallet.getAddress();

        const receiverXOnly = normalizeToXOnlyKey(
            await this.wallet.identity.xOnlyPublicKey(),
            "our",
            pendingSwap.id,
        );

        const senderXOnly = normalizeToXOnlyKey(
            hex.decode(refundPublicKey),
            "boltz",
            pendingSwap.id,
        );

        // Reconstruct the VHTLC across the current and deprecated server signers
        // and match the stored lockup address, so a swap created before a planned
        // server-signer rotation still resolves — and we recover the original
        // signer (`serverXOnly`) to use downstream for the claim leaf.
        const { vhtlcScript, serverXOnlyPublicKey: serverXOnly } = this.resolveVHTLCForLockup({
            arkInfo,
            preimageHash: sha256(preimage),
            receiverPubkey: hex.encode(receiverXOnly),
            senderPubkey: hex.encode(senderXOnly),
            timeoutBlockHeights: vhtlcTimeouts,
            lockupAddress,
            swapId: pendingSwap.id,
        });

        // Retry while waiting for an *actionable* (unspent) VTXO to appear at
        // the VHTLC script. A spent VTXO showing up early must not abort the
        // wait, so we break only once the unspent subset is non-empty. The
        // last raw response is kept so the post-retry branch can distinguish
        // "not found" from "already spent" for diagnostics.
        let unspentVtxos: VirtualCoin[] = [];
        let rawVtxos: VirtualCoin[] = [];
        for (let attempt = 1; attempt <= CLAIM_VTXO_RETRY_ATTEMPTS; attempt++) {
            const result = await this.indexerProvider.getVtxos({
                scripts: [hex.encode(vhtlcScript.pkScript)],
            });
            rawVtxos = result.vtxos;
            unspentVtxos = result.vtxos.filter((vtxo) => !vtxo.isSpent);
            if (unspentVtxos.length > 0) {
                break;
            }
            if (attempt < CLAIM_VTXO_RETRY_ATTEMPTS) {
                await new Promise((resolve) => setTimeout(resolve, CLAIM_VTXO_RETRY_DELAY_MS));
            }
        }

        if (unspentVtxos.length === 0) {
            if (rawVtxos.length === 0) {
                throw new Error(`Swap ${pendingSwap.id}: no spendable virtual coins found`);
            }
            throw new Error(`Swap ${pendingSwap.id}: VHTLC is already spent`);
        }

        const vhtlcIdentity = claimVHTLCIdentity(this.wallet.identity, preimage);
        const outputScript = ArkAddress.decode(address).pkScript;

        // Asymmetry with `refundArk` is deliberate: this path is all-or-
        // throw. Each VTXO is still attempted independently (so an early
        // failure doesn't strand later VTXOs at the lockup), and any
        // failures are surfaced as a single aggregate error after the
        // loop. The swap status is saved only on full success — a
        // partial claim leaves the swap in its current Boltz-driven
        // status (e.g. `transaction.confirmed`) so the caller / Boltz
        // status flow can retry the whole call. We don't track a
        // {swept, skipped} outcome here because — unlike the
        // `swap.expired` terminal status that triggers `refundArk` —
        // the reverse-claim path is still receiving live Boltz status
        // transitions, and the SwapManager owns retry via those.
        const claimErrors: { vtxo: VirtualCoin; error: Error }[] = [];
        let usedOffchainClaim = false;
        for (const vtxo of unspentVtxos) {
            const input = {
                ...vtxo,
                tapLeafScript: vhtlcScript.claim(),
                tapTree: vhtlcScript.encode(),
            };
            const output = {
                amount: BigInt(vtxo.value),
                script: outputScript,
            };

            try {
                if (isRecoverable(vtxo)) {
                    await this.joinBatch(vhtlcIdentity, input, output, arkInfo);
                } else {
                    await claimVHTLCwithOffchainTx(
                        vhtlcIdentity,
                        vhtlcScript,
                        serverXOnly,
                        input,
                        output,
                        arkInfo,
                        this.arkProvider,
                    );
                    usedOffchainClaim = true;
                }
            } catch (error) {
                claimErrors.push({ vtxo, error: error as Error });
            }
        }

        if (claimErrors.length > 0) {
            const details = claimErrors
                .map(({ vtxo, error }) => `${vtxo.txid}:${vtxo.vout} (${error.message})`)
                .join("; ");
            throw new Error(
                `Swap ${pendingSwap.id}: failed to claim ${claimErrors.length}/${unspentVtxos.length} VTXOs: ${details}`,
            );
        }

        const finalStatus: BoltzSwapStatus = usedOffchainClaim
            ? (await this.getSwapStatus(pendingSwap.id)).status
            : "transaction.claimed";

        // update the pending swap on storage
        await updateReverseSwapStatus(
            pendingSwap,
            finalStatus,
            this.savePendingReverseSwap.bind(this),
        );
    }

    /**
     * Waits for a reverse swap to be confirmed and claims the VHTLC.
     * Delegates to SwapManager if enabled, otherwise monitors via WebSocket.
     * @param pendingSwap - The reverse swap to monitor and claim.
     * @returns The transaction ID of the claimed VHTLC.
     * @throws {InvoiceExpiredError} If the Lightning invoice expires.
     * @throws {SwapExpiredError} If the swap exceeds its time limit.
     * @throws {TransactionFailedError} If the on-chain transaction fails.
     */
    async waitAndClaim(pendingSwap: BoltzReverseSwap): Promise<{ txid: string }> {
        // If SwapManager is enabled and has this swap, delegate to it
        if (this.swapManager && (await this.swapManager.hasSwap(pendingSwap.id))) {
            return this.swapManager.waitForSwapCompletion(pendingSwap.id);
        }

        // Otherwise use manual monitoring
        return new Promise<{ txid: string }>((resolve, reject) => {
            const onStatusUpdate = async (status: BoltzSwapStatus, data: any) => {
                const saveStatus = (additionalFields?: Partial<BoltzReverseSwap>) =>
                    updateReverseSwapStatus(
                        pendingSwap,
                        status,
                        this.savePendingReverseSwap.bind(this),
                        additionalFields,
                    );

                switch (status) {
                    case "transaction.mempool":
                    case "transaction.confirmed":
                        await saveStatus();
                        this.claimVHTLC(pendingSwap).catch(reject);
                        break;
                    case "invoice.settled": {
                        await saveStatus();
                        const swapStatus = await this.swapProvider.getReverseSwapTxId(
                            pendingSwap.id,
                        );
                        const txid = swapStatus.id;

                        if (!txid || txid.trim() === "") {
                            reject(
                                new SwapError({
                                    message: `Transaction ID not available for settled swap ${pendingSwap.id}.`,
                                }),
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
                            }),
                        );
                        break;
                    case "swap.expired":
                        await saveStatus();
                        reject(
                            new SwapExpiredError({
                                isRefundable: true,
                                pendingSwap,
                            }),
                        );
                        break;
                    case "transaction.failed":
                        await saveStatus();
                        reject(
                            new TransactionFailedError({
                                message: data?.failureReason ?? "Transaction failed",
                                isRefundable: true,
                            }),
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

            this.swapProvider.monitorSwap(pendingSwap.id, onStatusUpdate).catch(reject);
        });
    }

    // =========================================================================
    // Lightning: Submarine swaps (send Arkade -> Lightning)
    // =========================================================================

    /**
     * Sends a Lightning payment via a submarine swap (Arkade → Lightning).
     * Creates the swap, sends funds, and waits for settlement (or, with
     * `waitFor: "funded"`, only until the lockup transaction is observed —
     * see {@link SendLightningPaymentRequest.waitFor}). Auto-refunds on
     * failures observed before the promise resolves.
     * @param args.invoice - BOLT11 Lightning invoice to pay.
     * @param args.waitFor - "settled" (default) resolves with the preimage at
     * "transaction.claimed"; "funded" resolves without a preimage as soon as
     * the payment is in flight.
     * @returns The amount paid, preimage (proof of payment, unless resolved
     * at "funded"), and transaction ID.
     * @throws {TransactionFailedError} If the payment fails (auto-refunds if possible).
     * @remarks With `waitFor: "funded"`, failures observed *after* the promise
     * resolves are only persisted to the repository (refundable flag) — the
     * active auto-refund in this method is no longer reachable. Keep the
     * SwapManager enabled so late failures are refunded automatically;
     * without it the caller must recover via {@link restoreSwaps} /
     * {@link recoverSubmarineFunds}.
     *
     * Note on types: the overloads narrow on the `waitFor` literal, so a
     * request stored in a variable typed as `SendLightningPaymentRequest`
     * widens the result to {@link OptimisticSendLightningPaymentResponse}
     * (optional preimage) even on the default settled path.
     */
    async sendLightningPayment(
        args: SendLightningPaymentRequest & { waitFor?: "settled" },
    ): Promise<SendLightningPaymentResponse>;
    async sendLightningPayment(
        args: SendLightningPaymentRequest,
    ): Promise<OptimisticSendLightningPaymentResponse>;
    async sendLightningPayment(
        args: SendLightningPaymentRequest,
    ): Promise<OptimisticSendLightningPaymentResponse> {
        const pendingSwap = await this.createSubmarineSwap(args);
        if (!pendingSwap.response.address)
            throw new Error(`Swap ${pendingSwap.id}: missing address in submarine swap response`);

        // save pending swap to storage
        await this.savePendingSubmarineSwap(pendingSwap);
        // send funds to the swap address
        const txid = await this.wallet.send({
            address: pendingSwap.response.address,
            amount: pendingSwap.response.expectedAmount,
        });

        try {
            if (args.waitFor === "funded") {
                if (!this.swapManager) {
                    logger.warn(
                        `Swap ${pendingSwap.id}: sendLightningPayment with waitFor "funded" but ` +
                            `SwapManager is disabled — a failure after this promise resolves is ` +
                            `only persisted as refundable, not auto-refunded; recover via ` +
                            `restoreSwaps/recoverSubmarineFunds`,
                    );
                }
                await this.waitForSwapFunded(pendingSwap);
                return {
                    amount: pendingSwap.response.expectedAmount,
                    txid,
                };
            }
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
                    this.savePendingSubmarineSwap.bind(this),
                );
            }
            throw new TransactionFailedError();
        }
    }

    /**
     * Creates a submarine swap (Arkade → Lightning) and saves it to storage.
     * @param args.invoice - BOLT11 Lightning invoice to pay.
     * @returns The pending submarine swap, added to SwapManager if enabled.
     * @throws {SwapError} If invoice is missing or key retrieval fails.
     */
    async createSubmarineSwap(args: SendLightningPaymentRequest): Promise<BoltzSubmarineSwap> {
        const refundPublicKey = hex.encode(await this.wallet.identity.compressedPublicKey());
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
        const swapResponse = await this.swapProvider.createSubmarineSwap(swapRequest);

        // create pending swap object
        const pendingSwap: BoltzSubmarineSwap = {
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
     * Reconstruct a submarine swap's VHTLC script from stored data. This does
     * not query the indexer, so bulk scans can build every script first and
     * then use batched VTXO lookups.
     *
     * @throws {Error} If preimage hash is unavailable, the swap response is
     *   incomplete, the script can't be built, or the reconstructed address
     *   doesn't match the one Boltz returned.
     */
    private async buildSubmarineVHTLCContext(
        swap: BoltzSubmarineSwap,
        arkInfo?: ArkInfo,
    ): Promise<SubmarineVHTLCContext> {
        const preimageHash = swap.request.invoice
            ? getInvoicePaymentHash(swap.request.invoice)
            : swap.preimageHash;
        if (!preimageHash)
            throw new Error(`Swap ${swap.id}: preimage hash is required to refund VHTLC`);

        const resolvedArkInfo = arkInfo ?? (await this.arkProvider.getInfo());

        const ourXOnlyPublicKey = normalizeToXOnlyKey(
            await this.wallet.identity.xOnlyPublicKey(),
            "our",
            swap.id,
        );
        const { claimPublicKey, timeoutBlockHeights: vhtlcTimeouts } = swap.response;
        if (!claimPublicKey || !vhtlcTimeouts)
            throw new Error(`Swap ${swap.id}: incomplete submarine swap response`);

        const boltzXOnlyPublicKey = normalizeToXOnlyKey(
            hex.decode(claimPublicKey),
            "boltz",
            swap.id,
        );

        const lockupAddress = swap.response.address;
        if (!lockupAddress)
            throw new Error(`Swap ${swap.id}: missing lockup address in submarine swap response`);

        // Match the stored lockup address across current + deprecated signers so
        // a swap that straddles a server-signer rotation still resolves to its
        // original VHTLC (and the original signer threaded downstream).
        const { vhtlcScript, serverXOnlyPublicKey } = this.resolveVHTLCForLockup({
            arkInfo: resolvedArkInfo,
            preimageHash: hex.decode(preimageHash),
            receiverPubkey: hex.encode(boltzXOnlyPublicKey),
            senderPubkey: hex.encode(ourXOnlyPublicKey),
            timeoutBlockHeights: vhtlcTimeouts,
            lockupAddress,
            swapId: swap.id,
        });
        const vhtlcAddress = lockupAddress;

        // Use the locally-reconstructed script, not the Boltz response
        // address. The VHTLC script is unique per swap, so every refundable
        // VTXO at this script belongs to this swap.
        const vhtlcPkScriptHex = hex.encode(vhtlcScript.pkScript);

        return {
            arkInfo: resolvedArkInfo,
            vhtlcScript,
            vhtlcAddress,
            vhtlcPkScriptHex,
            vhtlcTimeouts,
            ourXOnlyPublicKey,
            serverXOnlyPublicKey,
            boltzXOnlyPublicKey,
        };
    }

    /**
     * Reconstruct a submarine swap's VHTLC script from stored data and look
     * up its VTXOs at the indexer. Side-effect free; shared by `refundVHTLC`
     * (spending path) and `inspectSubmarineRecovery` (diagnostic path).
     *
     * `refundableVtxos` merges spendable + recoverable indexer queries
     * (deduped by outpoint). When that set is empty, a third query
     * populates `diagnostic` so callers can distinguish "never funded",
     * "already spent", and "preconfirmed-only".
     */
    private async lookupSubmarineVHTLC(
        swap: BoltzSubmarineSwap,
        arkInfo?: ArkInfo,
    ): Promise<SubmarineVHTLCLookup> {
        const context = await this.buildSubmarineVHTLCContext(swap, arkInfo);
        // Query VTXOs using the locally-reconstructed script (not the Boltz
        // response address). The indexer
        // exposes "spendable" and "recoverable" VTXOs through separate
        // filters, so merge both views.
        const [spendableResult, recoverableResult] = await Promise.all([
            this.indexerProvider.getVtxos({
                scripts: [context.vhtlcPkScriptHex],
                spendableOnly: true,
            }),
            this.indexerProvider.getVtxos({
                scripts: [context.vhtlcPkScriptHex],
                recoverableOnly: true,
            }),
        ]);
        const refundableVtxos = dedupeVtxos([...spendableResult.vtxos, ...recoverableResult.vtxos]);

        // Only query "all VTXOs" when the refundable set is empty — that's
        // the only path where we need to distinguish empty cases.
        let diagnostic: SubmarineVHTLCDiagnostic | undefined;
        if (refundableVtxos.length === 0) {
            const { vtxos: allVtxos } = await this.indexerProvider.getVtxos({
                scripts: [context.vhtlcPkScriptHex],
            });
            diagnostic = {
                totalVtxoCount: allVtxos.length,
                allSpent: allVtxos.length > 0 && allVtxos.every((vtxo) => vtxo.isSpent),
            };
        }

        return {
            ...context,
            refundableVtxos,
            diagnostic,
        };
    }

    private submarineRecoveryInfoFromLookup(
        swap: BoltzSubmarineSwap,
        lookup: Pick<SubmarineVHTLCLookup, "vhtlcTimeouts" | "refundableVtxos" | "diagnostic">,
    ): SubmarineRecoveryInfo {
        const { refundableVtxos, diagnostic, vhtlcTimeouts } = lookup;

        if (refundableVtxos.length > 0) {
            const cltvSatisfied = isSubmarineRefundLocktimeReached(vhtlcTimeouts.refund);
            const amountSats = refundableVtxos.reduce((sum, vtxo) => sum + Number(vtxo.value), 0);
            const isRecoverable = cltvSatisfied || canRecoverViaBoltz3of3(refundableVtxos, swap);
            return {
                swap,
                status: isRecoverable ? "recoverable" : "pre_cltv",
                vtxoCount: refundableVtxos.length,
                amountSats,
                refundLocktime: vhtlcTimeouts.refund,
            };
        }

        // No refundable VTXOs. If diagnostic was not fetched (bulk scan path),
        // classify this as "none" without issuing a third indexer query.
        if (!diagnostic || diagnostic.totalVtxoCount === 0) {
            return {
                swap,
                status: "none",
                vtxoCount: 0,
                amountSats: 0,
                refundLocktime: vhtlcTimeouts.refund,
            };
        }
        if (diagnostic.allSpent) {
            return {
                swap,
                status: "already_spent",
                vtxoCount: 0,
                amountSats: 0,
                refundLocktime: vhtlcTimeouts.refund,
            };
        }
        // VTXOs exist but none refundable — preconfirmed-only state.
        return {
            swap,
            status: "none",
            vtxoCount: 0,
            amountSats: 0,
            refundLocktime: vhtlcTimeouts.refund,
        };
    }

    /**
     * Refunds the VHTLC for a failed submarine swap, returning locked funds to the wallet.
     * Uses multi-party signatures (user + Boltz + server) for non-recoverable VTXOs.
     * @param pendingSwap - The submarine swap to refund.
     * @returns Counts of VTXOs swept vs. deferred. A return value of `{ swept: 0, skipped: N }`
     *          means the call was a no-op — callers should not treat it as a successful refund.
     * @throws {Error} If preimage hash is unavailable, VHTLC not found, or already spent.
     */
    async refundVHTLC(
        pendingSwap: BoltzSubmarineSwap,
        cachedArkInfo?: ArkInfo,
    ): Promise<SubmarineRefundOutcome> {
        const address = await this.wallet.getAddress();
        if (!address) throw new Error("Failed to get ark address from wallet");

        const {
            arkInfo,
            vhtlcScript,
            vhtlcTimeouts,
            ourXOnlyPublicKey,
            serverXOnlyPublicKey,
            boltzXOnlyPublicKey,
            refundableVtxos,
            diagnostic,
        } = await this.lookupSubmarineVHTLC(pendingSwap, cachedArkInfo);

        if (refundableVtxos.length === 0) {
            if (!diagnostic || diagnostic.totalVtxoCount === 0) {
                throw new Error(
                    `Swap ${pendingSwap.id}: VHTLC not found for address ${pendingSwap.response.address}`,
                );
            }
            if (diagnostic.allSpent) {
                throw new Error(`Swap ${pendingSwap.id}: VHTLC is already spent`);
            }
            throw new Error(`Swap ${pendingSwap.id}: VHTLC has no refundable VTXOs yet`);
        }

        const outputScript = ArkAddress.decode(address).pkScript;
        const refundWithoutReceiverLeaf = vhtlcScript.refundWithoutReceiver();
        const refundContext: RefundWithoutReceiverContext = {
            arkInfo,
            vhtlcScript,
            serverXOnlyPublicKey,
            refundWithoutReceiverLeaf,
            outputScript,
        };

        // Refund every unspent VTXO at the contract address.
        const { swept: sweptCount, skipped: skippedCount } = await this.refundVtxos({
            swapId: pendingSwap.id,
            vtxos: refundableVtxos,
            refundLocktime: vhtlcTimeouts.refund,
            refundContext,
            boltzXOnlyPublicKey,
            ourXOnlyPublicKey,
            refundViaBoltz: this.swapProvider.refundSubmarineSwap.bind(this.swapProvider),
        });

        // Skip the flag update when this is a manual recovery on a
        // successfully-claimed swap (e.g. user accidentally double-funded
        // the lockup address). Flipping refunded:true on a
        // transaction.claimed swap would muddle its history. Legitimate
        // failure-refund statuses still update normally.
        if (!isSubmarineSuccessStatus(pendingSwap.status)) {
            const fullyRefunded = skippedCount === 0;
            await updateSubmarineSwapStatus(
                pendingSwap,
                pendingSwap.status, // Keep current status
                this.savePendingSubmarineSwap.bind(this),
                { refundable: true, refunded: fullyRefunded },
            );
        }

        return { swept: sweptCount, skipped: skippedCount };
    }

    /**
     * Inspect a submarine swap's lockup address for recoverable funds.
     *
     * Side-effect free. Returns a structured snapshot the UI can use to
     * decide whether to offer the user a recovery action — it will not
     * trigger any signing or persistence.
     *
     * Only `transaction.claimed` (success with possible stranded extras)
     * and refundable failure statuses are recovery candidates. Pending
     * statuses (`invoice.set`, `transaction.mempool`, …) are returned as
     * `invalid_swap`; this API is for recovery, not a generic VTXO probe.
     *
     * @param swap - The submarine swap to inspect.
     */
    async inspectSubmarineRecovery(swap: BoltzSubmarineSwap): Promise<SubmarineRecoveryInfo> {
        if (!isSubmarineSuccessStatus(swap.status) && !isSubmarineRefundableStatus(swap.status)) {
            return {
                swap,
                status: "invalid_swap",
                vtxoCount: 0,
                amountSats: 0,
                refundLocktime: swap.response.timeoutBlockHeights?.refund,
                error: `Swap status ${swap.status} is not a recovery candidate`,
            };
        }

        let lookup;
        try {
            lookup = await this.lookupSubmarineVHTLC(swap);
        } catch (err) {
            return {
                swap,
                status: "invalid_swap",
                vtxoCount: 0,
                amountSats: 0,
                refundLocktime: swap.response.timeoutBlockHeights?.refund,
                error: err instanceof Error ? err.message : String(err),
            };
        }

        return this.submarineRecoveryInfoFromLookup(swap, lookup);
    }

    /**
     * Scan all locally-known submarine swaps for recoverable VHTLC funds.
     *
     * Loads submarine swaps from the repository, filters to recovery
     * candidates (`transaction.claimed` plus refundable failure
     * statuses), reconstructs their scripts, and performs one batched
     * spendable query plus one batched recoverable query. Pending swaps are
     * skipped entirely — they appear in the local repository but cannot
     * be in a recovery state yet.
     *
     * Side-effect free: does not mutate the repository, does not sign,
     * and does not query Boltz swap status.
     */
    async scanRecoverableSubmarineSwaps(): Promise<SubmarineRecoveryInfo[]> {
        const submarineSwaps = await this.swapRepository.getAllSwaps<BoltzSubmarineSwap>({
            type: "submarine",
        });

        const candidates = submarineSwaps.filter(
            (swap) =>
                isSubmarineSuccessStatus(swap.status) || isSubmarineRefundableStatus(swap.status),
        );

        let arkInfo: ArkInfo | undefined;
        let arkInfoError: string | undefined;
        if (candidates.length > 0) {
            try {
                arkInfo = await this.arkProvider.getInfo();
            } catch (err) {
                arkInfoError = err instanceof Error ? err.message : String(err);
            }
        }

        const prepared: SubmarineScanPrepared[] = await Promise.all(
            candidates.map(async (swap) => {
                if (arkInfoError) {
                    return {
                        swap,
                        error: arkInfoError,
                    };
                }

                try {
                    return {
                        swap,
                        context: await this.buildSubmarineVHTLCContext(swap, arkInfo),
                    };
                } catch (err) {
                    return {
                        swap,
                        error: err instanceof Error ? err.message : String(err),
                    };
                }
            }),
        );

        const valid = prepared.filter(
            (item): item is Extract<SubmarineScanPrepared, { context: unknown }> =>
                "context" in item,
        );
        const scripts = [...new Set(valid.map(({ context }) => context.vhtlcPkScriptHex))];

        const refundableByScript = new Map<string, VirtualCoin[]>();
        if (scripts.length > 0) {
            const [spendableResult, recoverableResult] = await Promise.all([
                this.indexerProvider.getVtxos({
                    scripts,
                    spendableOnly: true,
                }),
                this.indexerProvider.getVtxos({
                    scripts,
                    recoverableOnly: true,
                }),
            ]);

            for (const vtxo of dedupeVtxos([
                ...spendableResult.vtxos,
                ...recoverableResult.vtxos,
            ])) {
                const script = vtxo.script?.toLowerCase();
                if (!script) continue;
                const existing = refundableByScript.get(script) ?? [];
                existing.push(vtxo);
                refundableByScript.set(script, existing);
            }
        }

        return prepared.map((item) => {
            if ("error" in item) {
                return {
                    swap: item.swap,
                    status: "invalid_swap" as const,
                    vtxoCount: 0,
                    amountSats: 0,
                    refundLocktime: item.swap.response.timeoutBlockHeights?.refund,
                    error: item.error,
                };
            }

            const refundableVtxos =
                refundableByScript.get(item.context.vhtlcPkScriptHex.toLowerCase()) ?? [];
            return this.submarineRecoveryInfoFromLookup(item.swap, {
                ...item.context,
                refundableVtxos,
            });
        });
    }

    /**
     * Recover funds locked at a single submarine swap's VHTLC address.
     *
     * Thin wrapper around `refundVHTLC` for callers that have already
     * confirmed (e.g. via `inspectSubmarineRecovery`) that funds are
     * present. Centralises the spending logic in one place — flag-write
     * behavior matches `refundVHTLC` (no-op for `transaction.claimed`,
     * normal flag updates for failure statuses).
     */
    async recoverSubmarineFunds(
        swap: BoltzSubmarineSwap,
        arkInfo?: ArkInfo,
    ): Promise<SubmarineRefundOutcome> {
        return this.refundVHTLC(swap, arkInfo);
    }

    /**
     * Recover funds for a batch of submarine swaps.
     *
     * Each swap's recovery is independent — a failure on one swap does
     * not abort the rest, and the caller receives a per-swap result so
     * they can present partial outcomes in the UI. Recovery runs
     * sequentially to avoid hammering Boltz / the indexer with parallel
     * batch joins.
     */
    async recoverAllSubmarineFunds(
        swaps: BoltzSubmarineSwap[],
    ): Promise<SubmarineRecoveryResult[]> {
        const results: SubmarineRecoveryResult[] = [];
        let arkInfo: ArkInfo | undefined;
        try {
            if (swaps.length > 0) {
                arkInfo = await this.arkProvider.getInfo();
            }
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            return swaps.map((swap) => ({
                swapId: swap.id,
                recovered: false,
                skipped: false,
                error,
            }));
        }

        for (const swap of swaps) {
            try {
                const outcome = await this.recoverSubmarineFunds(swap, arkInfo);
                results.push({
                    swapId: swap.id,
                    recovered: outcome.swept > 0,
                    skipped: outcome.skipped > 0,
                });
            } catch (err) {
                results.push({
                    swapId: swap.id,
                    recovered: false,
                    skipped: false,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
        return results;
    }

    /**
     * Waits for a submarine swap's Lightning payment to settle.
     * Resolves only at the terminal "transaction.claimed" status, once Boltz
     * has swept the HTLC. To resolve as soon as the payment is in flight, use
     * {@link waitForSwapFunded} instead.
     * @param pendingSwap - The submarine swap to monitor.
     * @returns The preimage from the settled Lightning payment (proof of payment).
     * @throws {SwapExpiredError} If the swap expires.
     * @throws {InvoiceFailedToPayError} If Boltz fails to route the payment.
     * @throws {TransactionLockupFailedError} If the lockup transaction fails.
     */
    async waitForSwapSettlement(pendingSwap: BoltzSubmarineSwap): Promise<{ preimage: string }> {
        // Without a funded-target the internal wait only resolves at
        // "transaction.claimed", where the preimage is always present.
        return this.waitForSubmarineSwap(pendingSwap) as Promise<{ preimage: string }>;
    }

    /**
     * Waits until a submarine swap is funded: resolves as soon as the lockup
     * transaction is observed ("transaction.mempool" or any later status in
     * the lifecycle — statuses can be skipped since subscriptions report only
     * the current one). The sender's funds are committed and the swap is
     * refundable from this point, which is when most Lightning wallets show
     * a payment as "sent".
     *
     * Monitoring continues in the background until the swap reaches a
     * terminal status, persisting updates to the repository (the preimage on
     * claim, the refundable flag on failure), but this promise no longer
     * rejects once resolved — acting on a late failure is the caller's
     * responsibility (the SwapManager handles it automatically when enabled).
     * @param pendingSwap - The submarine swap to monitor.
     * @throws {SwapExpiredError} If the swap expires before funding.
     * @throws {InvoiceFailedToPayError} If Boltz fails to route the payment.
     * @throws {TransactionLockupFailedError} If the lockup transaction fails.
     */
    async waitForSwapFunded(pendingSwap: BoltzSubmarineSwap): Promise<void> {
        await this.waitForSubmarineSwap(pendingSwap, "transaction.mempool");
    }

    /**
     * Shared wait machinery: monitors the swap and resolves at the terminal
     * "transaction.claimed" status (with the preimage) or, when `resolveAt`
     * is given, as soon as that status — or any later one in the successful
     * progression — is observed (without a preimage).
     */
    private async waitForSubmarineSwap(
        pendingSwap: BoltzSubmarineSwap,
        resolveAt?: SubmarineProgressionStatus,
    ): Promise<{ preimage?: string }> {
        return new Promise<{ preimage?: string }>((resolve, reject) => {
            // A terminal status was processed — stop handling updates. An
            // optimistic resolution deliberately does NOT set this: the
            // monitor keeps persisting subsequent statuses (refundable flag
            // on failure, preimage on claim) so the stored swap doesn't go
            // stale for SwapManager / restoreSwaps.
            let isFinal = false;
            // The promise was resolved or rejected, possibly optimistically.
            let isSettled = false;

            const onStatusUpdate = async (status: BoltzSwapStatus) => {
                if (isFinal) return;

                // Persistence must never leave the outer promise pending: a
                // failed write is logged and the repository self-heals on the
                // next status update or refreshSwapsStatus.
                const saveStatus = async (additionalFields?: Partial<BoltzSubmarineSwap>) => {
                    try {
                        await updateSubmarineSwapStatus(
                            pendingSwap,
                            status,
                            this.savePendingSubmarineSwap.bind(this),
                            additionalFields,
                        );
                    } catch (error) {
                        logger.error(
                            `Swap ${pendingSwap.id}: failed to persist status "${status}": ${error}`,
                        );
                    }
                };

                // After an optimistic resolution, reject/resolve below are
                // no-ops on the already-settled promise; only persistence
                // still takes effect.
                switch (status) {
                    case "swap.expired":
                        isFinal = true;
                        isSettled = true;
                        await saveStatus({ refundable: true });
                        reject(
                            new SwapExpiredError({
                                isRefundable: true,
                                pendingSwap,
                            }),
                        );
                        break;
                    case "invoice.failedToPay":
                        isFinal = true;
                        isSettled = true;
                        await saveStatus({ refundable: true });
                        reject(
                            new InvoiceFailedToPayError({
                                isRefundable: true,
                                pendingSwap,
                            }),
                        );
                        break;
                    case "transaction.lockupFailed":
                        isFinal = true;
                        isSettled = true;
                        await saveStatus({ refundable: true });
                        reject(
                            new TransactionLockupFailedError({
                                isRefundable: true,
                                pendingSwap,
                            }),
                        );
                        break;
                    case "transaction.claimed": {
                        // Flags are set before the awaits so a status arriving
                        // mid-await isn't double-processed; the try/catch
                        // guarantees the promise still completes if the
                        // preimage fetch fails.
                        isFinal = true;
                        isSettled = true;
                        try {
                            const { preimage } = await this.swapProvider.getSwapPreimage(
                                pendingSwap.id,
                            );
                            await saveStatus({ preimage });
                            resolve({ preimage });
                        } catch (error) {
                            logger.error(
                                `Swap ${pendingSwap.id}: failed to fetch preimage on claim: ${error}`,
                            );
                            reject(error);
                        }
                        break;
                    }
                    default:
                        await saveStatus();
                        // Optimistic resolution: the swap is not settled yet, but
                        // the caller opted in to resolve at this point of the
                        // lifecycle. "At or beyond" because the subscription only
                        // reports the current status — intermediate statuses can
                        // be skipped and would otherwise never be observed.
                        if (resolveAt && hasSubmarineStatusReached(status, resolveAt)) {
                            isSettled = true;
                            resolve({ preimage: undefined });
                        }
                        break;
                }
            };

            this.swapProvider
                .monitorSwap(pendingSwap.id, (status) => {
                    // monitorSwap doesn't await the callback, so a persistence
                    // failure here (e.g. after the promise already settled
                    // optimistically) must not become an unhandled rejection.
                    onStatusUpdate(status).catch((error) =>
                        logger.error(
                            `Swap ${pendingSwap.id}: error handling status "${status}": ${error}`,
                        ),
                    );
                })
                .catch((error) => {
                    if (!isSettled) {
                        isFinal = true;
                        isSettled = true;
                        reject(error);
                    } else {
                        // Already resolved optimistically — stop processing
                        // updates; the stored swap may go stale until
                        // SwapManager / restoreSwaps reconciles it.
                        isFinal = true;
                        logger.warn(
                            `Swap ${pendingSwap.id}: monitor failed after settlement: ${error}`,
                        );
                    }
                });
        });
    }

    // =========================================================================
    // Chain swaps: ARK -> BTC
    // =========================================================================

    /**
     * Creates a chain swap from ARK to BTC.
     * @param args.btcAddress - Destination Bitcoin address.
     * @param args.senderLockAmount - Exact amount sender locks (receiver gets less after fees). Specify this OR receiverLockAmount.
     * @param args.receiverLockAmount - Exact amount receiver gets (sender pays more). Specify this OR senderLockAmount.
     * @param args.feeSatsPerByte - Fee rate for the BTC claim transaction (default: 1).
     * @returns The ARK lockup address, amount to pay, and pending swap.
     * @throws {SwapError} If chain swap verification fails.
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
    async waitAndClaimBtc(pendingSwap: BoltzChainSwap): Promise<{ txid: string }> {
        if (this.swapManager && (await this.swapManager.hasSwap(pendingSwap.id))) {
            const { txid } = await this.swapManager.waitForSwapCompletion(pendingSwap.id);
            return { txid };
        }
        return new Promise<{ txid: string }>((resolve, reject) => {
            let claimStarted = false;
            // Holds the BTC claim we broadcast — its txid is the swap's
            // on-chain completion. getSwapStatus does not surface it at
            // transaction.claimed, so resolve from the claim instead.
            let claimPromise: Promise<{ txid: string }> | undefined;
            // Local mutable copy — accumulates fields across status
            // callbacks without mutating the caller's object.
            // Spreading from the original on every callback
            // would silently discard previously saved data.
            const swap = { ...pendingSwap };
            const onStatusUpdate = async (
                status: BoltzSwapStatus,
                data: {
                    failureReason?: string;
                },
            ) => {
                const updateSwapStatus = async (): Promise<BoltzChainSwap> => {
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
                        claimPromise = this.claimBtc(updatedSwap);
                        claimPromise.catch(reject);
                        break;
                    }
                    case "transaction.claimed": {
                        await updateSwapStatus();
                        const txid = await this.resolveChainClaimTxid(pendingSwap.id, claimPromise);
                        if (!txid) {
                            reject(
                                new SwapError({
                                    message: `Transaction ID not available for claimed swap ${pendingSwap.id}.`,
                                }),
                            );
                            break;
                        }
                        resolve({ txid });
                        break;
                    }
                    case "transaction.lockupFailed":
                        await updateSwapStatus();
                        await this.quoteSwap(swap.response.id, quoteOptionsForSwap(swap)).catch(
                            (err) => {
                                reject(
                                    new SwapError({
                                        message: `Failed to renegotiate quote: ${err.message}`,
                                        isRefundable: true,
                                        pendingSwap: swap,
                                        cause: err,
                                    }),
                                );
                            },
                        );
                        break;
                    case "swap.expired":
                        await updateSwapStatus();
                        reject(
                            new SwapExpiredError({
                                isRefundable: true,
                                pendingSwap: swap,
                            }),
                        );
                        break;
                    case "transaction.failed":
                        await updateSwapStatus();
                        // Refundable terminal failure — attach the pending swap so a
                        // no-manager caller can drive `refundArk(pendingSwap)` off the
                        // handle's `failed` event (the SwapManager path refunds itself).
                        reject(
                            new TransactionFailedError({
                                message: data.failureReason,
                                isRefundable: true,
                                pendingSwap: swap,
                            }),
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

            this.swapProvider.monitorSwap(swap.id, onStatusUpdate).catch(reject);
        });
    }

    /**
     * Claim sats on BTC chain by claiming the HTLC.
     *
     * The claim output is `swapOutput.amount − max(feeToDeliverExactAmount, targetFee)`.
     *
     * @param pendingSwap - The pending chain swap with BTC transaction hex.
     * @returns The BTC transaction ID of the claim.
     */
    async claimBtc(pendingSwap: BoltzChainSwap): Promise<{ txid: string }> {
        if (!pendingSwap.toAddress)
            throw new Error(`Swap ${pendingSwap.id}: destination address is required`);

        if (!pendingSwap.response.claimDetails.swapTree)
            throw new Error(`Swap ${pendingSwap.id}: missing swap tree in claim details`);

        if (!pendingSwap.response.claimDetails.serverPublicKey)
            throw new Error(`Swap ${pendingSwap.id}: missing server public key in claim details`);

        const swapStatus = await this.getSwapStatus(pendingSwap.id);
        if (!swapStatus.transaction?.hex)
            throw new Error(`Swap ${pendingSwap.id}: BTC transaction hex is required`);

        const lockupTx = Transaction.fromRaw(hex.decode(swapStatus.transaction.hex));

        const arkInfo = await this.arkProvider.getInfo();

        const network = getNetwork(arkInfo.network as NetworkName);

        const swapTree = deserializeSwapTree(pendingSwap.response.claimDetails.swapTree);

        const musig = tweakMusig(
            createMusig(hex.decode(pendingSwap.ephemeralKey), [
                hex.decode(pendingSwap.response.claimDetails.serverPublicKey),
                secp256k1.getPublicKey(hex.decode(pendingSwap.ephemeralKey)),
            ]),
            swapTree.tree,
        );
        const swapOutput = detectSwapOutput(musig.aggPubkey, lockupTx);

        const feeToDeliverExactAmount = BigInt(
            pendingSwap.request.serverLockAmount
                ? pendingSwap.request.serverLockAmount - pendingSwap.amount
                : 0,
        );

        const claimTx = targetFee(pendingSwap.feeSatsPerByte, (fee) =>
            constructClaimTransaction(
                {
                    script: swapOutput.script!,
                    amount: swapOutput.amount!,
                    vout: swapOutput.vout!,
                    transactionId: lockupTx.id,
                },
                OutScript.encode(Address(network).decode(pendingSwap.toAddress!)),
                feeToDeliverExactAmount > fee ? feeToDeliverExactAmount : fee,
            ),
        );

        const musigMessage = musig
            .message(
                claimTx.preimageWitnessV1(0, [swapOutput.script!], SigHash.DEFAULT, [
                    swapOutput.amount!,
                ]),
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
            },
        );

        if (!signedTxData.pubNonce || !signedTxData.partialSignature)
            throw new Error(`Swap ${pendingSwap.id}: invalid signature data from server`);

        const musigSession = musigMessage
            .aggregateNonces([
                [
                    hex.decode(pendingSwap.response.claimDetails.serverPublicKey),
                    hex.decode(signedTxData.pubNonce),
                ],
            ])
            .initializeSession();

        musigSession.addPartial(
            hex.decode(pendingSwap.response.claimDetails.serverPublicKey),
            hex.decode(signedTxData.partialSignature),
        );
        const musigSigned = musigSession.signPartial();

        claimTx.updateInput(0, {
            finalScriptWitness: [musigSigned.aggregatePartials()],
        });

        await this.swapProvider.postBtcTransaction(claimTx.hex);

        // The BTC claim transaction we broadcast is the swap's on-chain
        // completion; its id is the txid callers expect from waitAndClaimBtc.
        return { txid: claimTx.id };
    }

    /**
     * When an ARK to BTC swap fails, refund every unspent VTXO at the chain
     * swap's ARK lockup address.
     *
     * Path selection per VTXO:
     * - CLTV elapsed, live VTXO → `refundWithoutReceiver` offchain (sender +
     *   server, no Boltz, no batch round).
     * - CLTV elapsed, swept VTXO → `refundWithoutReceiver` via `joinBatch`
     *   (a swept VTXO is no longer a live leaf).
     * - Pre-CLTV recoverable → skipped (Boltz can't co-sign swept-batch refund).
     * - Pre-CLTV non-recoverable → cooperative 3-of-3 refund via Boltz.
     *
     * @param pendingSwap - The pending chain swap to refund.
     * @returns Counts of VTXOs swept vs. deferred. A `swept: 0` outcome means
     *          the call was a no-op — callers should retry after CLTV.
     */
    async refundArk(pendingSwap: BoltzChainSwap): Promise<ChainArkRefundOutcome> {
        if (!pendingSwap.response.lockupDetails.serverPublicKey)
            throw new Error(`Swap ${pendingSwap.id}: missing server public key in lockup details`);

        if (!pendingSwap.response.lockupDetails.timeouts)
            throw new Error(`Swap ${pendingSwap.id}: missing timeouts in lockup details`);

        const arkInfo = await this.arkProvider.getInfo();

        const address = await this.wallet.getAddress();

        const ourXOnlyPublicKey = normalizeToXOnlyKey(
            await this.wallet.identity.xOnlyPublicKey(),
            "user",
            pendingSwap.id,
        );

        const boltzXOnlyPublicKey = normalizeToXOnlyKey(
            hex.decode(pendingSwap.response.lockupDetails.serverPublicKey),
            "boltz",
            pendingSwap.id,
        );

        // Resolve across current + deprecated signers so a swap locked under a
        // now-rotated signer still refunds; preserve the SwapError contract on a
        // total mismatch.
        let vhtlcScript: VHTLC.Script;
        let serverXOnlyPublicKey: Uint8Array;
        try {
            ({ vhtlcScript, serverXOnlyPublicKey } = this.resolveVHTLCForLockup({
                arkInfo,
                preimageHash: hex.decode(pendingSwap.request.preimageHash),
                senderPubkey: hex.encode(ourXOnlyPublicKey),
                receiverPubkey: hex.encode(boltzXOnlyPublicKey),
                timeoutBlockHeights: pendingSwap.response.lockupDetails.timeouts!,
                lockupAddress: pendingSwap.response.lockupDetails.lockupAddress,
                swapId: pendingSwap.id,
            }));
        } catch (error) {
            throw new SwapError({
                message:
                    error instanceof Error
                        ? error.message
                        : "Unable to refund: invalid VHTLC address",
            });
        }

        const { vtxos } = await this.indexerProvider.getVtxos({
            scripts: [hex.encode(vhtlcScript.pkScript)],
        });

        if (vtxos.length === 0) {
            throw new Error(
                `Swap ${pendingSwap.id}: VHTLC not found for address ${pendingSwap.response.lockupDetails.lockupAddress}`,
            );
        }

        const unspentVtxos = vtxos.filter((vtxo) => !vtxo.isSpent);
        if (unspentVtxos.length === 0) {
            throw new Error(`Swap ${pendingSwap.id}: VHTLC is already spent`);
        }

        const outputScript = ArkAddress.decode(address).pkScript;
        const refundWithoutReceiverLeaf = vhtlcScript.refundWithoutReceiver();
        const refundLocktime = pendingSwap.response.lockupDetails.timeouts!.refund;
        const refundContext: RefundWithoutReceiverContext = {
            arkInfo,
            vhtlcScript,
            serverXOnlyPublicKey,
            refundWithoutReceiverLeaf,
            outputScript,
        };

        const { swept: sweptCount, skipped: skippedCount } = await this.refundVtxos({
            swapId: pendingSwap.id,
            vtxos: unspentVtxos,
            refundLocktime,
            refundContext,
            boltzXOnlyPublicKey,
            ourXOnlyPublicKey,
            refundViaBoltz: this.swapProvider.refundChainSwap.bind(this.swapProvider),
        });

        // update the pending swap on storage
        const finalStatus = await this.getSwapStatus(pendingSwap.id);
        await this.savePendingChainSwap({
            ...pendingSwap,
            status: finalStatus.status,
        });

        return { swept: sweptCount, skipped: skippedCount };
    }

    // =========================================================================
    // Chain swaps: BTC -> ARK
    // =========================================================================

    /**
     * Creates a chain swap from BTC to ARK.
     * @param args.feeSatsPerByte - Fee rate for BTC transactions (default: 1).
     * @param args.senderLockAmount - Exact BTC amount to lock. Specify this OR receiverLockAmount.
     * @param args.receiverLockAmount - Exact ARK amount to receive. Specify this OR senderLockAmount.
     * @returns The BTC lockup address, amount to pay, and pending swap.
     * @throws {SwapError} If chain swap verification fails.
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
    async waitAndClaimArk(pendingSwap: BoltzChainSwap): Promise<{ txid: string }> {
        if (this.swapManager && (await this.swapManager.hasSwap(pendingSwap.id))) {
            const { txid } = await this.swapManager.waitForSwapCompletion(pendingSwap.id);
            return { txid };
        }
        return new Promise<{ txid: string }>((resolve, reject) => {
            let claimStarted = false;
            // Holds the ARK claim we submit — its txid is the swap's
            // on-chain completion. getSwapStatus does not surface it at
            // transaction.claimed, so resolve from the claim instead.
            let claimPromise: Promise<{ txid: string }> | undefined;
            // Local mutable copy — accumulates fields across status
            // callbacks without mutating the caller's object. Spreading
            // from the original on every callback would silently
            // discard previously saved data.
            const swap = { ...pendingSwap };
            const onStatusUpdate = async (
                status: BoltzSwapStatus,
                data: {
                    failureReason?: string;
                },
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
                        claimPromise = this.claimArk(swap);
                        claimPromise.catch(reject);
                        break;
                    case "transaction.claimed": {
                        await updateSwapStatus();
                        const txid = await this.resolveChainClaimTxid(pendingSwap.id, claimPromise);
                        if (!txid) {
                            reject(
                                new SwapError({
                                    message: `Transaction ID not available for claimed swap ${pendingSwap.id}.`,
                                }),
                            );
                            break;
                        }
                        resolve({ txid });
                        break;
                    }
                    case "transaction.claim.pending":
                        await updateSwapStatus();
                        await this.signCooperativeClaimForServer(swap).catch((err) => {
                            logger.error(`Failed to sign cooperative claim for ${swap.id}:`, err);
                        });
                        break;
                    case "transaction.lockupFailed":
                        await updateSwapStatus();
                        await this.quoteSwap(swap.response.id, quoteOptionsForSwap(swap)).catch(
                            (err) => {
                                reject(
                                    new SwapError({
                                        message: `Failed to renegotiate quote: ${err.message}`,
                                        isRefundable: false, // TODO btc refund not implemented yet
                                        pendingSwap: swap,
                                        cause: err,
                                    }),
                                );
                            },
                        );
                        break;
                    case "swap.expired":
                        await updateSwapStatus();
                        reject(
                            new SwapExpiredError({
                                isRefundable: false, // TODO btc refund not implemented yet
                                pendingSwap: swap,
                            }),
                        );
                        break;
                    case "transaction.failed":
                        await updateSwapStatus();
                        reject(
                            new TransactionFailedError({
                                message: data.failureReason,
                                isRefundable: false, // TODO btc refund not implemented yet
                            }),
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

            this.swapProvider.monitorSwap(swap.id, onStatusUpdate).catch(reject);
        });
    }

    /**
     * Claim sats on ARK chain by claiming the VHTLC.
     * Refactored to use claimVHTLCIdentity + claimVHTLCwithOffchainTx utilities.
     * @param pendingSwap - The pending chain swap.
     * @returns The Ark transaction ID of the claim.
     */
    async claimArk(pendingSwap: BoltzChainSwap): Promise<{ txid: string }> {
        if (!pendingSwap.toAddress)
            throw new Error(`Swap ${pendingSwap.id}: destination address is required`);

        if (!pendingSwap.response.claimDetails.serverPublicKey)
            throw new Error(`Swap ${pendingSwap.id}: missing server public key in claim details`);

        if (!pendingSwap.response.claimDetails.timeouts)
            throw new Error(`Swap ${pendingSwap.id}: missing timeouts in claim details`);

        const arkInfo = await this.arkProvider.getInfo();
        const preimage = hex.decode(pendingSwap.preimage);
        const address = await this.wallet.getAddress();

        // build expected VHTLC script
        const receiverXOnlyPublicKey = normalizeToXOnlyKey(
            pendingSwap.request.claimPublicKey,
            "receiver",
        );

        const senderXOnlyPublicKey = normalizeToXOnlyKey(
            pendingSwap.response.claimDetails.serverPublicKey!,
            "sender",
        );

        // Resolve across current + deprecated signers so a chain swap locked
        // under a now-rotated signer still claims; preserve the SwapError
        // contract on a total mismatch.
        let vhtlcScript: VHTLC.Script;
        let serverXOnlyPublicKey: Uint8Array;
        try {
            ({ vhtlcScript, serverXOnlyPublicKey } = this.resolveVHTLCForLockup({
                arkInfo,
                preimageHash: hex.decode(pendingSwap.request.preimageHash),
                senderPubkey: hex.encode(senderXOnlyPublicKey),
                receiverPubkey: hex.encode(receiverXOnlyPublicKey),
                timeoutBlockHeights: pendingSwap.response.claimDetails.timeouts!,
                lockupAddress: pendingSwap.response.claimDetails.lockupAddress,
                swapId: pendingSwap.id,
            }));
        } catch (error) {
            throw new SwapError({
                message:
                    error instanceof Error
                        ? error.message
                        : "Unable to claim: invalid VHTLC address",
            });
        }

        let vtxo;
        for (let attempt = 1; attempt <= CLAIM_VTXO_RETRY_ATTEMPTS; attempt++) {
            const spendableVtxos = await this.indexerProvider.getVtxos({
                scripts: [hex.encode(vhtlcScript.pkScript)],
                spendableOnly: true,
            });
            if (spendableVtxos.vtxos.length > 0) {
                vtxo = spendableVtxos.vtxos[0];
                break;
            }
            if (attempt < CLAIM_VTXO_RETRY_ATTEMPTS) {
                await new Promise((resolve) => setTimeout(resolve, CLAIM_VTXO_RETRY_DELAY_MS));
            }
        }

        if (!vtxo) {
            throw new Error(`Swap ${pendingSwap.id}: no spendable virtual coins found`);
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

        // Use shared identity utility for preimage witness
        const vhtlcIdentity = claimVHTLCIdentity(this.wallet.identity, preimage);

        // The claim transaction we broadcast is the swap's on-chain completion;
        // its id is the txid callers expect back from waitAndClaimArk.
        const txid = isRecoverable(vtxo)
            ? await this.joinBatch(vhtlcIdentity, input, output, arkInfo)
            : await claimVHTLCwithOffchainTx(
                  vhtlcIdentity,
                  vhtlcScript,
                  serverXOnlyPublicKey,
                  input,
                  output,
                  arkInfo,
                  this.arkProvider,
              );

        // update the pending swap on storage
        const finalStatus = await this.getSwapStatus(pendingSwap.id);
        await this.savePendingChainSwap({
            ...pendingSwap,
            status: finalStatus.status,
        });

        return { txid };
    }

    /**
     * Resolve the on-chain txid for a chain swap at completion.
     *
     * The claim transaction we broadcast (claimBtc/claimArk) carries the real
     * on-chain txid; getSwapStatus does not surface it at transaction.claimed.
     * Prefer the claim's txid and fall back to the provider status only for
     * resumed swaps where we never ran the claim ourselves (claimPromise is
     * undefined). Returns undefined when no usable txid is available, so
     * callers never resolve with the Boltz swap id in place of a real txid.
     */
    private async resolveChainClaimTxid(
        swapId: string,
        claimPromise?: Promise<{ txid: string }>,
    ): Promise<string | undefined> {
        if (claimPromise) {
            // The claim's own rejection is surfaced separately; swallow it here
            // and fall through to the provider status as a last resort.
            const claimTxid = await claimPromise.then(
                (res) => res.txid,
                () => undefined,
            );
            if (claimTxid && claimTxid.trim() !== "") return claimTxid;
        }
        const txid = (await this.getSwapStatus(swapId)).transaction?.id;
        return txid && txid.trim() !== "" ? txid : undefined;
    }

    /**
     * Sign a cooperative claim for the server in BTC => ARK swaps.
     * @param pendingSwap - The pending chain swap.
     */
    async signCooperativeClaimForServer(pendingSwap: BoltzChainSwap): Promise<void> {
        if (!pendingSwap.response.lockupDetails.swapTree)
            throw new Error(`Swap ${pendingSwap.id}: missing swap tree in lockup details`);

        if (!pendingSwap.response.lockupDetails.serverPublicKey)
            throw new Error(`Swap ${pendingSwap.id}: missing server public key in lockup details`);

        const claimDetails = await this.swapProvider.getChainClaimDetails(pendingSwap.id);

        // Verify the server key from the claim response matches the one
        // stored at swap creation. MuSig2 requires consistent keys across
        // create() and aggregateNonces(); a mismatch produces an invalid sig.
        const serverPubKey = pendingSwap.response.lockupDetails.serverPublicKey;
        if (claimDetails.publicKey !== serverPubKey) {
            throw new Error(
                `Swap ${pendingSwap.id}: server public key mismatch — claim response has ${claimDetails.publicKey}, expected ${serverPubKey}`,
            );
        }

        const musig = tweakMusig(
            createMusig(hex.decode(pendingSwap.ephemeralKey), [
                hex.decode(serverPubKey),
                secp256k1.getPublicKey(hex.decode(pendingSwap.ephemeralKey)),
            ]),
            deserializeSwapTree(pendingSwap.response.lockupDetails.swapTree).tree,
        );

        const musigNonces = musig
            .message(hex.decode(claimDetails.transactionHash))
            .generateNonce()
            .aggregateNonces([
                [
                    hex.decode(pendingSwap.response.lockupDetails.serverPublicKey),
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
    async waitAndClaimChain(pendingSwap: BoltzChainSwap): Promise<{ txid: string }> {
        if (pendingSwap.request.to === "ARK") return this.waitAndClaimArk(pendingSwap);
        if (pendingSwap.request.to === "BTC") return this.waitAndClaimBtc(pendingSwap);
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
    }): Promise<BoltzChainSwap> {
        const { to, from, receiverLockAmount, senderLockAmount, toAddress } = args;

        if (!toAddress) throw new SwapError({ message: "Destination address is required" });

        const feeSatsPerByte = args.feeSatsPerByte ?? 1;
        if (feeSatsPerByte <= 0) throw new SwapError({ message: "Invalid feeSatsPerByte" });

        let amount, serverLockAmount, userLockAmount;

        if (receiverLockAmount) {
            amount = receiverLockAmount;
            const fees = await this.getFees(from, to);
            serverLockAmount =
                receiverLockAmount + (fees as ChainFeesResponse).minerFees.user.claim;
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
        if (!preimageHash) throw new SwapError({ message: "Failed to get preimage hash" });

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

        const swapResponse = await this.swapProvider.createChainSwap(swapRequest);

        const pendingSwap: BoltzChainSwap = {
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
        swap: BoltzChainSwap;
        arkInfo: ArkInfo;
    }): Promise<boolean> {
        const { to, from, swap, arkInfo } = args;

        if (from === "ARK") {
            if (!swap.response.lockupDetails.serverPublicKey)
                throw new Error(`Swap ${swap.id}: missing serverPublicKey in lockup details`);
            if (!swap.response.lockupDetails.timeouts)
                throw new Error(`Swap ${swap.id}: missing timeouts in lockup details`);
        }

        if (to === "ARK") {
            if (!swap.response.claimDetails.serverPublicKey)
                throw new Error(`Swap ${swap.id}: missing serverPublicKey in claim details`);
            if (!swap.response.claimDetails.timeouts)
                throw new Error(`Swap ${swap.id}: missing timeouts in claim details`);
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

        const serverPubkey = hex.encode(normalizeToXOnlyKey(arkInfo.signerPubkey, "server"));

        const vhtlcTimeouts =
            to === "ARK"
                ? swap.response.claimDetails.timeouts!
                : swap.response.lockupDetails.timeouts!;

        const { vhtlcAddress } = this.createVHTLCScript({
            network: arkInfo.network,
            preimageHash: hex.decode(swap.request.preimageHash),
            receiverPubkey,
            senderPubkey,
            serverPubkey,
            timeoutBlockHeights: vhtlcTimeouts,
        });

        if (lockupAddress !== vhtlcAddress) {
            throw new SwapError({
                message: "Boltz is trying to scam us (invalid address)",
            });
        }

        this.verifyBtcChainHtlc({ to, swap, arkNetwork: arkInfo.network });

        return true;
    }

    /**
     * Verifies the BTC-side Taproot HTLC of a chain swap before funds are
     * committed: the lockup address must bind to MuSig2(boltz, user) over
     * Boltz's leaves, and those leaves must enforce the agreed preimage hash,
     * direction-specific keys, leaf version, and absolute refund CLTV.
     */
    private verifyBtcChainHtlc(args: {
        to: Chain;
        swap: BoltzChainSwap;
        arkNetwork: string;
    }): void {
        const { to, swap, arkNetwork } = args;

        // The BTC side is the details object opposite the verified ARK side.
        const btcDetails = to === "ARK" ? swap.response.lockupDetails : swap.response.claimDetails;

        if (!btcDetails.swapTree)
            throw new SwapError({ message: `Swap ${swap.id}: missing swap tree in BTC details` });
        if (!btcDetails.serverPublicKey)
            throw new SwapError({
                message: `Swap ${swap.id}: missing server public key in BTC details`,
            });
        if (typeof btcDetails.timeoutBlockHeight !== "number")
            throw new SwapError({
                message: `Swap ${swap.id}: missing timeout block height in BTC details`,
            });

        const network = getNetwork(arkNetwork as NetworkName);
        const swapTree = deserializeSwapTree(btcDetails.swapTree);
        const ephemeralPub = secp256k1.getPublicKey(hex.decode(swap.ephemeralKey));

        // boltz first, no sorting — matches claimBtc and NArk ComputeAggregateKey.
        const musig = tweakMusig(
            createMusig(hex.decode(swap.ephemeralKey), [
                hex.decode(btcDetails.serverPublicKey),
                ephemeralPub,
            ]),
            swapTree.tree,
        );

        const expectedScript = OutScript.encode(Address(network).decode(btcDetails.lockupAddress));
        if (!equalBytes(p2trScript(musig.aggPubkey), expectedScript))
            throw new SwapError({ message: "Boltz is trying to scam us (invalid BTC address)" });

        const boltzXOnly = toXOnly(hex.decode(btcDetails.serverPublicKey));
        const userXOnly = toXOnly(ephemeralPub);
        try {
            assertChainHtlcLeaves(swapTree, {
                preimageHash160: ripemd160(hex.decode(swap.request.preimageHash)),
                claimXOnly: to === "ARK" ? boltzXOnly : userXOnly,
                refundXOnly: to === "ARK" ? userXOnly : boltzXOnly,
                timeoutBlockHeight: btcDetails.timeoutBlockHeight,
            });
        } catch (err) {
            throw new SwapError({
                message: `Boltz is trying to scam us (invalid BTC HTLC: ${(err as Error).message})`,
            });
        }
    }

    /**
     * Renegotiates the quote for an existing chain swap. Convenience wrapper
     * over `getSwapQuote` + `acceptSwapQuote` with a safety floor.
     *
     * The floor is resolved in order:
     *   1. `options.minAcceptableAmount` if provided.
     *   2. The original `response.claimDetails.amount` of the stored
     *      pending swap (Boltz-confirmed server-lock amount at creation).
     *   3. Otherwise throws `QuoteRejectedError({ reason: "no_baseline" })`.
     *
     * `options.maxSlippageBps` (default 0) relaxes the floor by basis points.
     * Quotes ≤ 0 are always rejected. On rejection the acceptance is NOT
     * posted to Boltz.
     *
     * Prefer `getSwapQuote` / `acceptSwapQuote` for callers that want to
     * inspect the quote before committing.
     *
     * @param swapId - The ID of the swap.
     * @param options - Optional floor and slippage configuration.
     * @returns The accepted quote amount.
     * @throws QuoteRejectedError if the quote is non-positive, below the
     *     effective floor, or no baseline is available.
     */
    async quoteSwap(swapId: string, options?: QuoteSwapOptions): Promise<number> {
        const effectiveFloor = await this.resolveEffectiveFloor(swapId, options);
        const amount = await this.getSwapQuote(swapId);
        this.validateQuote(amount, effectiveFloor);
        await this.swapProvider.postChainQuote(swapId, { amount });
        return amount;
    }

    /**
     * Fetches a renegotiated quote from Boltz without accepting it.
     * Pair with `acceptSwapQuote` to commit a specific value.
     */
    async getSwapQuote(swapId: string): Promise<number> {
        const { amount } = await this.swapProvider.getChainQuote(swapId);
        return amount;
    }

    /**
     * Accepts a quote amount for an existing chain swap, after validating it
     * against the configured floor. See `quoteSwap` for floor-resolution rules.
     *
     * @throws QuoteRejectedError if `amount` ≤ 0, below the effective floor,
     *     or no baseline is available.
     */
    async acceptSwapQuote(
        swapId: string,
        amount: number,
        options?: QuoteSwapOptions,
    ): Promise<number> {
        const effectiveFloor = await this.resolveEffectiveFloor(swapId, options);
        this.validateQuote(amount, effectiveFloor);
        await this.swapProvider.postChainQuote(swapId, { amount });
        return amount;
    }

    private async resolveEffectiveFloor(
        swapId: string,
        options?: QuoteSwapOptions,
    ): Promise<number> {
        this.validateQuoteOptions(options);
        const floor = await this.resolveQuoteFloor(swapId, options);
        const slippageBps = options?.maxSlippageBps ?? 0;
        // Subtract-then-floor instead of multiply-then-divide: the original
        // `floor * 10000` form loses precision once `floor` exceeds
        // ~9e11 sats (above MAX_SAFE_INTEGER after multiply by 10000).
        const effectiveFloor = Math.floor(floor - (floor * slippageBps) / 10000);
        // Reject when slippage (or a tiny baseline) drives the floor to 0:
        // a 0 floor lets any positive Boltz quote through, silently restoring
        // the blind-accept behaviour this guard exists to prevent.
        if (effectiveFloor < 1) {
            throw new TypeError(
                `Invalid quote configuration: maxSlippageBps=${slippageBps} reduces floor ${floor} below 1 sat`,
            );
        }
        return effectiveFloor;
    }

    private async resolveQuoteFloor(swapId: string, options?: QuoteSwapOptions): Promise<number> {
        if (options?.minAcceptableAmount !== undefined) {
            return options.minAcceptableAmount;
        }
        const swaps = await this.swapRepository.getAllSwaps<BoltzChainSwap>({
            id: swapId,
            type: "chain",
        });
        const stored = swaps[0];
        // Defensive: persisted swaps from older formats may not have a
        // populated claimDetails.amount even though the type marks it required.
        const amount = stored?.response?.claimDetails?.amount;
        if (typeof amount !== "number") {
            throw new QuoteRejectedError({ reason: "no_baseline" });
        }
        return amount;
    }

    private validateQuoteOptions(options?: QuoteSwapOptions): void {
        if (options?.minAcceptableAmount !== undefined) {
            const v = options.minAcceptableAmount;
            // Reject 0: it would short-circuit the floor to 0 and let any
            // positive Boltz quote through, silently restoring the old
            // blind-accept behaviour the guard is meant to prevent.
            if (!Number.isInteger(v) || v <= 0) {
                throw new TypeError(
                    `Invalid minAcceptableAmount: ${v} — must be a positive integer`,
                );
            }
        }
        if (options?.maxSlippageBps !== undefined) {
            const v = options.maxSlippageBps;
            if (!Number.isInteger(v) || v < 0 || v > 10000) {
                throw new TypeError(
                    `Invalid maxSlippageBps: ${v} — must be an integer in [0, 10000]`,
                );
            }
        }
    }

    private validateQuote(amount: number, effectiveFloor: number): void {
        // Guard against non-finite / fractional / above-MAX_SAFE_INTEGER values
        // before the `> 0` and `< floor` comparisons: Infinity passes `> 0` and
        // fails `< floor`, so without this check it would slip through to
        // postChainQuote. Satoshi amounts must be safe positive integers.
        if (!Number.isSafeInteger(amount)) {
            throw new QuoteRejectedError({
                reason: "non_safe_integer",
                quotedAmount: amount,
            });
        }
        if (amount <= 0) {
            throw new QuoteRejectedError({
                reason: "non_positive",
                quotedAmount: amount,
            });
        }
        if (amount < effectiveFloor) {
            throw new QuoteRejectedError({
                reason: "below_floor",
                quotedAmount: amount,
                floor: effectiveFloor,
            });
        }
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
        isRecoverable = true,
    ): Promise<string> {
        return joinBatch(this.arkProvider, identity, input, output, arkInfo, isRecoverable);
    }

    /**
     * Settle a `refundWithoutReceiver` (sender + server, no Boltz) refund for a
     * single VTXO whose CLTV refund locktime has elapsed.
     *
     * A live VTXO settles the leaf with an offchain Ark tx — no batch round. A
     * swept (recoverable) VTXO is no longer a live leaf, so it can only be
     * reclaimed by re-registering it into a batch.
     */
    private async settleRefundWithoutReceiver(
        ctx: RefundWithoutReceiverContext,
        vtxo: VirtualCoin,
    ): Promise<void> {
        const input = {
            ...vtxo,
            tapLeafScript: ctx.refundWithoutReceiverLeaf,
            tapTree: ctx.vhtlcScript.encode(),
        };
        const output = { amount: BigInt(vtxo.value), script: ctx.outputScript };
        if (isRecoverable(vtxo)) {
            await this.joinBatch(this.wallet.identity, input, output, ctx.arkInfo, true);
        } else {
            await refundWithoutReceiverVHTLCwithOffchainTx(
                this.wallet.identity,
                ctx.vhtlcScript,
                ctx.serverXOnlyPublicKey,
                input,
                output,
                ctx.arkInfo,
                this.arkProvider,
            );
        }
    }

    /**
     * Refund every VTXO at a swap's VHTLC address back to the wallet, shared by
     * {@link ArkadeSwaps.refundVHTLC} (submarine) and {@link ArkadeSwaps.refundArk}
     * (chain). Path selection per VTXO:
     * - CLTV elapsed → `refundWithoutReceiver` (offchain for a live VTXO, via a
     *   batch round for a swept one — see {@link settleRefundWithoutReceiver}).
     * - Pre-CLTV recoverable → skipped (Boltz can't co-sign a swept-batch refund).
     * - Pre-CLTV non-recoverable → cooperative 3-of-3 refund via Boltz, falling
     *   back to `refundWithoutReceiver` offchain if Boltz rejects after the
     *   locktime has since elapsed.
     *
     * @returns Counts of VTXOs swept vs. deferred.
     */
    private async refundVtxos(params: {
        swapId: string;
        vtxos: VirtualCoin[];
        refundLocktime: number;
        refundContext: RefundWithoutReceiverContext;
        boltzXOnlyPublicKey: Uint8Array;
        ourXOnlyPublicKey: Uint8Array;
        refundViaBoltz: Parameters<typeof refundVHTLCwithOffchainTx>[9];
    }): Promise<{ swept: number; skipped: number }> {
        const {
            swapId,
            vtxos,
            refundLocktime,
            refundContext,
            boltzXOnlyPublicKey,
            ourXOnlyPublicKey,
            refundViaBoltz,
        } = params;
        const { vhtlcScript, serverXOnlyPublicKey, arkInfo, outputScript } = refundContext;

        // Throttle between Boltz API calls to avoid 429 rate-limiting.
        let boltzCallCount = 0;
        let sweptCount = 0;
        let skippedCount = 0;

        for (const vtxo of vtxos) {
            const isRecoverableVtxo = isRecoverable(vtxo);
            const output = { amount: BigInt(vtxo.value), script: outputScript };

            // Re-evaluate the locktime per iteration so a CLTV that elapses
            // mid-loop is observed by every branch. Once it has passed, the
            // refundWithoutReceiver leaf is spendable — settle it offchain for a
            // live VTXO, or via a batch round for a swept one.
            if (isSubmarineRefundLocktimeReached(refundLocktime)) {
                await this.settleRefundWithoutReceiver(refundContext, vtxo);
                sweptCount++;
                continue;
            }

            // Pre-CLTV: recoverable VTXOs can't use the Boltz 3-of-3 path
            // (Boltz can't co-sign a swept-batch refund), so we must wait.
            if (isRecoverableVtxo) {
                logger.error(
                    `Swap ${swapId}: recoverable VTXO ${vtxo.txid}:${vtxo.vout} ` +
                        `cannot be refunded yet — refundWithoutReceiver locktime has not passed ` +
                        `(refundLocktime=${refundLocktime}, ` +
                        `currentTimestamp=${Math.floor(Date.now() / 1000)}). ` +
                        `Refund will be retried after locktime.`,
                );
                skippedCount++;
                continue;
            }

            // Pre-CLTV, non-recoverable: try the 3-of-3 refund via Boltz.
            const input = {
                ...vtxo,
                tapLeafScript: vhtlcScript.refund(),
                tapTree: vhtlcScript.encode(),
            };
            try {
                if (boltzCallCount > 0) {
                    await new Promise((r) => setTimeout(r, 2000));
                }
                // Count attempts, not successes — a thrown call still consumed
                // Boltz's rate-limit slot, so the next attempt must observe the
                // throttle even when the previous one failed.
                boltzCallCount++;
                await refundVHTLCwithOffchainTx(
                    swapId,
                    this.wallet.identity,
                    this.arkProvider,
                    boltzXOnlyPublicKey,
                    ourXOnlyPublicKey,
                    serverXOnlyPublicKey,
                    input,
                    output,
                    arkInfo,
                    refundViaBoltz,
                );
                sweptCount++;
            } catch (error) {
                // Only fall back for Boltz-side rejections (e.g. outpoint
                // mismatch after an Ark round). Re-throw anything else.
                if (!(error instanceof BoltzRefundError)) {
                    throw error;
                }

                // Re-check the locktime — wall clock may have advanced while
                // talking to Boltz.
                if (!isSubmarineRefundLocktimeReached(refundLocktime)) {
                    logger.error(
                        `Swap ${swapId}: Boltz rejected VTXO outpoint and ` +
                            `refundWithoutReceiver locktime has not passed yet ` +
                            `(currentTimestamp=${Math.floor(Date.now() / 1000)}, ` +
                            `locktime=${refundLocktime}). ` +
                            `Refund will be retried after locktime.`,
                    );
                    skippedCount++;
                    continue;
                }

                logger.warn(
                    `Swap ${swapId}: Boltz rejected VTXO outpoint, ` +
                        `falling back to refundWithoutReceiver offchain`,
                );
                // Past CLTV and non-recoverable (recoverable VTXOs are skipped
                // pre-CLTV) → settle offchain, same as the primary post-CLTV path.
                await this.settleRefundWithoutReceiver(refundContext, vtxo);
                sweptCount++;
            }
        }

        return { swept: sweptCount, skipped: skippedCount };
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
        timeoutBlockHeights: VhtlcTimeouts;
    }): { vhtlcScript: VHTLC.Script; vhtlcAddress: string } {
        return createVHTLCScript(args);
    }

    /**
     * Reconstruct a swap's VHTLC by matching the persisted `lockupAddress`
     * against the current and deprecated server signers, returning the matched
     * script together with the server key it was minted under.
     *
     * Recovery paths (claim/refund/lookup) must use this instead of building the
     * VHTLC from the current signer alone: a swap created before a planned arkd
     * signer rotation is locked to a now-deprecated signer, so the current key
     * would yield the wrong address and strand the funds. The returned
     * `serverXOnlyPublicKey` is the original (possibly deprecated) key and MUST
     * be threaded into downstream signing/verification.
     *
     * Throws a descriptive mismatch error when no candidate reproduces the
     * lockup address (e.g. the swap predates an already-pruned deprecated
     * signer) — replacing the previous current-signer-only equality check.
     */
    private resolveVHTLCForLockup(args: {
        arkInfo: ArkInfo;
        preimageHash: Uint8Array;
        receiverPubkey: string;
        senderPubkey: string;
        timeoutBlockHeights: VhtlcTimeouts;
        lockupAddress: string;
        swapId: string;
    }): { vhtlcScript: VHTLC.Script; serverXOnlyPublicKey: Uint8Array } {
        // Probe the current signer first (the no-rotation fast path, so an
        // un-rotated swap reconstructs in a single build), then each deprecated
        // signer, returning the first whose address reproduces the stored
        // lockup address.
        const candidates = candidateServerPubkeys(args.arkInfo);
        for (const serverPubkey of candidates) {
            const { vhtlcScript, vhtlcAddress } = this.createVHTLCScript({
                network: args.arkInfo.network,
                preimageHash: args.preimageHash,
                receiverPubkey: args.receiverPubkey,
                senderPubkey: args.senderPubkey,
                serverPubkey,
                timeoutBlockHeights: args.timeoutBlockHeights,
            });
            if (vhtlcAddress !== args.lockupAddress) continue;
            // A returned address match means the script was built (the real
            // builder throws otherwise). Keep one defense-in-depth check here —
            // replacing the per-call-site guards that used to live at each
            // caller — so a future VHTLC version that derives a valid address
            // with no spend leaves fails loud here instead of at signing time.
            if (!vhtlcScript.claimScript && !vhtlcScript.refundScript) {
                throw new Error(
                    `Swap ${args.swapId}: VHTLC address matched but claim/refund script leaves are empty`,
                );
            }
            return {
                vhtlcScript,
                // The matched (possibly deprecated) key must flow into downstream
                // signing/verification: arkd signs a deprecated-signer input with
                // the deprecated key, so the claim/refund leaf checks use it.
                serverXOnlyPublicKey: normalizeToXOnlyKey(
                    hex.decode(serverPubkey),
                    "server",
                    args.swapId,
                ),
            };
        }
        throw new Error(
            `Swap ${args.swapId}: VHTLC address mismatch. Expected ${args.lockupAddress}; ` +
                `no current or deprecated server signer (${candidates.length} candidate(s) tried) ` +
                `reproduced it`,
        );
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
    async getFees(from?: Chain, to?: Chain): Promise<FeesResponse | ChainFeesResponse> {
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
    async getPendingSubmarineSwaps(): Promise<BoltzSubmarineSwap[]> {
        const swaps = await this.getPendingSubmarineSwapsFromStorage();
        if (!swaps) return [];
        return swaps.filter((swap: BoltzSubmarineSwap) => swap.status === "invoice.set");
    }

    /**
     * Returns pending reverse swaps (those with status `swap.created`).
     */
    async getPendingReverseSwaps(): Promise<BoltzReverseSwap[]> {
        const swaps = await this.getPendingReverseSwapsFromStorage();
        if (!swaps) return [];
        return swaps.filter((swap: BoltzReverseSwap) => swap.status === "swap.created");
    }

    /**
     * Returns pending chain swaps (those with status `swap.created`).
     */
    async getPendingChainSwaps(): Promise<BoltzChainSwap[]> {
        const swaps = await this.getPendingChainSwapsFromStorage();
        return swaps.filter((swap) => swap.status === "swap.created");
    }

    /**
     * Retrieves swap history from storage.
     * @returns Array of all swaps (reverse + submarine + chain) sorted by creation date (newest first).
     */
    async getSwapHistory(): Promise<BoltzSwap[]> {
        const reverseSwaps = await this.getPendingReverseSwapsFromStorage();
        const submarineSwaps = await this.getPendingSubmarineSwapsFromStorage();
        const chainSwaps = await this.getPendingChainSwapsFromStorage();
        const allSwaps: BoltzSwap[] = [
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
                            this.savePendingReverseSwap.bind(this),
                        ),
                    )
                    .catch((error) => {
                        logger.error(`Failed to refresh swap status for ${swap.id}:`, error);
                    }),
            );
        }
        for (const swap of await this.getPendingSubmarineSwapsFromStorage()) {
            if (isSubmarineFinalStatus(swap.status)) continue;
            promises.push(
                this.getSwapStatus(swap.id)
                    .then(async ({ status }) => {
                        // A swap that settled while no monitor was attached
                        // (e.g. a "funded" optimistic send followed by an app
                        // restart) has no stored preimage yet — fetch it so
                        // the repository carries the proof of payment. Never
                        // fail the status update over a missing preimage.
                        let additionalFields: Partial<BoltzSubmarineSwap> | undefined;
                        if (isSubmarineSuccessStatus(status) && !swap.preimage) {
                            try {
                                const { preimage } = await this.swapProvider.getSwapPreimage(
                                    swap.id,
                                );
                                additionalFields = { preimage };
                            } catch (error) {
                                logger.warn(
                                    `Failed to fetch preimage for settled swap ${swap.id}:`,
                                    error,
                                );
                            }
                        }
                        await updateSubmarineSwapStatus(
                            swap,
                            status,
                            this.savePendingSubmarineSwap.bind(this),
                            additionalFields,
                        );
                    })
                    .catch((error) => {
                        logger.error(`Failed to refresh swap status for ${swap.id}:`, error);
                    }),
            );
        }
        for (const swap of await this.getPendingChainSwapsFromStorage()) {
            if (isChainFinalStatus(swap.status)) continue;
            promises.push(
                this.getSwapStatus(swap.id)
                    .then(({ status }) => this.savePendingChainSwap({ ...swap, status }))
                    .catch((error) => {
                        logger.error(`Failed to refresh swap status for ${swap.id}:`, error);
                    }),
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
        chainSwaps: BoltzChainSwap[];
        reverseSwaps: BoltzReverseSwap[];
        submarineSwaps: BoltzSubmarineSwap[];
    }> {
        const publicKey = hex.encode(await this.wallet.identity.compressedPublicKey());
        if (!publicKey) throw new Error("Failed to get public key from wallet");

        const fees = boltzFees ?? (await this.swapProvider.getFees());

        const chainSwaps: BoltzChainSwap[] = [];
        const reverseSwaps: BoltzReverseSwap[] = [];
        const submarineSwaps: BoltzSubmarineSwap[] = [];

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
                    timeoutBlockHeights,
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
                        invoice: swap.invoice ?? "",
                        onchainAmount: amount,
                        lockupAddress,
                        refundPublicKey: serverPublicKey,
                        timeoutBlockHeights: resolveVhtlcTimeouts(tree, timeoutBlockHeights),
                    },
                    status,
                    type: "reverse",
                    preimage: "",
                } as BoltzReverseSwap);
            } else if (isRestoredSubmarineSwap(swap)) {
                const { amount, lockupAddress, serverPublicKey, tree, timeoutBlockHeights } =
                    swap.refundDetails;

                let preimage = "";
                // Skip preimage fetch for terminal swaps — nothing actionable
                // and it avoids unnecessary API calls / 429s.
                if (!isSubmarineFinalStatus(status)) {
                    try {
                        const data = await this.swapProvider.getSwapPreimage(swap.id);
                        preimage = data.preimage;
                    } catch (error) {
                        logger.warn(`Failed to restore preimage for submarine swap ${id}`, error);
                    }
                }

                submarineSwaps.push({
                    id,
                    type: "submarine",
                    createdAt,
                    preimage,
                    preimageHash: swap.preimageHash,
                    status,
                    request: {
                        invoice: swap.invoice ?? "",
                        refundPublicKey: publicKey,
                    },
                    response: {
                        id,
                        address: lockupAddress,
                        expectedAmount: amount,
                        claimPublicKey: serverPublicKey,
                        timeoutBlockHeights: resolveVhtlcTimeouts(tree, timeoutBlockHeights),
                    },
                } as BoltzSubmarineSwap);
            } else if (isRestoredChainSwap(swap)) {
                const refundDetails = swap.refundDetails;
                if (!refundDetails) continue;

                const {
                    amount,
                    lockupAddress,
                    serverPublicKey,
                    timeoutBlockHeight,
                    tree,
                    timeoutBlockHeights,
                } = refundDetails;

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
                            timeouts: resolveVhtlcTimeouts(tree, timeoutBlockHeights),
                        },
                    },
                } as BoltzChainSwap);
            }
        }

        return { chainSwaps, reverseSwaps, submarineSwaps };
    }

    /**
     * Enrich a restored reverse swap with its preimage.
     */
    enrichReverseSwapPreimage(swap: BoltzReverseSwap, preimage: string): BoltzReverseSwap {
        return enrichReverseSwapPreimage(swap, preimage);
    }

    /**
     * Enrich a restored submarine swap with its invoice.
     */
    enrichSubmarineSwapInvoice(swap: BoltzSubmarineSwap, invoice: string): BoltzSubmarineSwap {
        return enrichSubmarineSwapInvoice(swap, invoice);
    }
}

/** Options controlling acceptance of a renegotiated chain-swap quote. */
export type QuoteSwapOptions = {
    /**
     * Hard floor on the accepted quote (in sats). When provided, skips the
     * repository lookup. Pass the original `response.claimDetails.amount`
     * to require the renegotiated amount to be no worse than what Boltz
     * confirmed at swap creation.
     */
    minAcceptableAmount?: number;
    /**
     * Slippage tolerance in basis points, applied to the floor. Default 0
     * (strict). E.g. 100 allows accepting quotes within 1% below the floor.
     */
    maxSlippageBps?: number;
};

/** @deprecated Use ArkadeSwapsConfig instead */
export type ArkadeLightningConfig = ArkadeSwapsConfig;

/** @deprecated Use ArkadeSwaps instead */
export const ArkadeLightning = ArkadeSwaps;

/** Public interface for ArkadeSwaps, defining all swap operations available to consumers. */
export interface IArkadeSwaps extends AsyncDisposable {
    startSwapManager(): Promise<void>;
    stopSwapManager(): Promise<void>;
    getSwapManager(): SwapManagerClient | null;
    createLightningInvoice(
        args: CreateLightningInvoiceRequest,
    ): Promise<CreateLightningInvoiceResponse>;
    sendLightningPayment(
        args: SendLightningPaymentRequest & { waitFor?: "settled" },
    ): Promise<SendLightningPaymentResponse>;
    sendLightningPayment(
        args: SendLightningPaymentRequest,
    ): Promise<OptimisticSendLightningPaymentResponse>;
    createSubmarineSwap(args: SendLightningPaymentRequest): Promise<BoltzSubmarineSwap>;
    createReverseSwap(args: CreateLightningInvoiceRequest): Promise<BoltzReverseSwap>;
    claimVHTLC(pendingSwap: BoltzReverseSwap): Promise<void>;
    refundVHTLC(pendingSwap: BoltzSubmarineSwap): Promise<SubmarineRefundOutcome>;
    inspectSubmarineRecovery(swap: BoltzSubmarineSwap): Promise<SubmarineRecoveryInfo>;
    scanRecoverableSubmarineSwaps(): Promise<SubmarineRecoveryInfo[]>;
    recoverSubmarineFunds(swap: BoltzSubmarineSwap): Promise<SubmarineRefundOutcome>;
    recoverAllSubmarineFunds(swaps: BoltzSubmarineSwap[]): Promise<SubmarineRecoveryResult[]>;
    waitAndClaim(pendingSwap: BoltzReverseSwap): Promise<{ txid: string }>;
    waitForSwapSettlement(pendingSwap: BoltzSubmarineSwap): Promise<{ preimage: string }>;
    waitForSwapFunded(pendingSwap: BoltzSubmarineSwap): Promise<void>;
    restoreSwaps(boltzFees?: FeesResponse): Promise<{
        chainSwaps: BoltzChainSwap[];
        reverseSwaps: BoltzReverseSwap[];
        submarineSwaps: BoltzSubmarineSwap[];
    }>;
    arkToBtc(args: {
        btcAddress: string;
        senderLockAmount?: number;
        receiverLockAmount?: number;
        feeSatsPerByte?: number;
    }): Promise<ArkToBtcResponse>;
    waitAndClaimBtc(pendingSwap: BoltzChainSwap): Promise<{ txid: string }>;
    claimBtc(pendingSwap: BoltzChainSwap): Promise<{ txid: string }>;
    refundArk(pendingSwap: BoltzChainSwap): Promise<ChainArkRefundOutcome>;
    btcToArk(args: {
        feeSatsPerByte?: number;
        senderLockAmount?: number;
        receiverLockAmount?: number;
    }): Promise<BtcToArkResponse>;
    waitAndClaimArk(pendingSwap: BoltzChainSwap): Promise<{ txid: string }>;
    claimArk(pendingSwap: BoltzChainSwap): Promise<{ txid: string }>;
    signCooperativeClaimForServer(pendingSwap: BoltzChainSwap): Promise<void>;
    waitAndClaimChain(pendingSwap: BoltzChainSwap): Promise<{ txid: string }>;
    createChainSwap(args: {
        to: Chain;
        from: Chain;
        toAddress: string;
        feeSatsPerByte?: number;
        senderLockAmount?: number;
        receiverLockAmount?: number;
    }): Promise<BoltzChainSwap>;
    verifyChainSwap(args: {
        to: Chain;
        from: Chain;
        swap: BoltzChainSwap;
        arkInfo: ArkInfo;
    }): Promise<boolean>;
    quoteSwap(swapId: string, options?: QuoteSwapOptions): Promise<number>;
    getSwapQuote(swapId: string): Promise<number>;
    acceptSwapQuote(swapId: string, amount: number, options?: QuoteSwapOptions): Promise<number>;
    joinBatch(
        identity: Identity,
        input: ArkTxInput,
        output: TransactionOutput,
        arkInfo: ArkInfo,
        isRecoverable?: boolean,
    ): Promise<string>;
    createVHTLCScript(args: {
        network: string;
        preimageHash: Uint8Array;
        receiverPubkey: string;
        senderPubkey: string;
        serverPubkey: string;
        timeoutBlockHeights: VhtlcTimeouts;
    }): { vhtlcScript: VHTLC.Script; vhtlcAddress: string };
    getFees(): Promise<FeesResponse>;
    getFees(from: Chain, to: Chain): Promise<ChainFeesResponse>;
    getLimits(): Promise<LimitsResponse>;
    getLimits(from: Chain, to: Chain): Promise<LimitsResponse>;
    getPendingSubmarineSwaps(): Promise<BoltzSubmarineSwap[]>;
    getPendingReverseSwaps(): Promise<BoltzReverseSwap[]>;
    getPendingChainSwaps(): Promise<BoltzChainSwap[]>;
    getSwapHistory(): Promise<BoltzSwap[]>;
    refreshSwapsStatus(): Promise<void>;
    getSwapStatus(swapId: string): Promise<GetSwapStatusResponse>;
    enrichReverseSwapPreimage(swap: BoltzReverseSwap, preimage: string): BoltzReverseSwap;
    enrichSubmarineSwapInvoice(swap: BoltzSubmarineSwap, invoice: string): BoltzSubmarineSwap;
    /**
     * Reset all swap state: stops the SwapManager and clears the swap repository.
     *
     * **Destructive** — any swap in a non-terminal state will lose its
     * refund/claim path. Intended for wallet-reset / dev / test scenarios only.
     */
    reset(): Promise<void>;
    dispose(): Promise<void>;
}
