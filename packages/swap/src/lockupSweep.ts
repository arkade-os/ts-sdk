/**
 * Sweep every refundable RFQ lockup from wallet state alone.
 *
 * `requestLightningSend` / `requestOnchainSend` register each lockup with the
 * wallet's contract manager before handing back an address to fund
 * (`lockupContract.ts`), and the row's params carry every script-level fact —
 * including the committed `sender` key and `refundLocktime`. On an HD wallet
 * the sender signer re-derives from the seed. Put together, a stalled send is
 * recoverable with NOTHING persisted by the application: enumerate the rows,
 * rebuild each covenant from its stored params, match its sender to a wallet
 * descriptor, and push the `refundWithoutReceiver` leaf once the CLTV has
 * matured.
 *
 * Two families fall out as `no-signer`, correctly: swaps made under
 * `randomSwapSecrets()` (their sender key exists only in the swap record, not
 * the seed) and receive-direction lockups (their `sender` is the solver — the
 * trader's way out of a receive is the claim, never this refund).
 *
 * The wall clock is only an optimistic gate for `pending`: seconds-based
 * locktimes mature against chain time, so a push right at the boundary can
 * still be rejected server-side — rerun the sweep.
 */
import {
    RestArkProvider,
    RestIndexerProvider,
    VHTLCV2ContractHandler,
    isHDWalletCapable,
    type Identity,
    type IWallet,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";

import { SWAP_LOCKUP_CONTRACT_KIND, SWAP_LOCKUP_CONTRACT_TYPE } from "./lockupContract";
import {
    LockupNeedsRecoveryError,
    findLockupVtxos,
    pushRefundWithoutReceiver,
    type RefundArkProvider,
    type RefundIndexer,
} from "./refund";

export interface LockupSweepReport {
    /** Refunds pushed this run, one aggregate transaction per lockup. */
    refunded: { address: string; arkTxid: string; amount: number }[];
    /** Funded lockups whose `refundLocktime` has not matured yet. */
    pending: { address: string; refundLocktime: number }[];
    /** Funded lockups holding swept outputs — run the wallet's VTXO recovery
     * first, then sweep again. Outpoints are `txid:vout`. */
    needsRecovery: { address: string; outpoints: string[] }[];
    /** `no-signer`: no wallet descriptor derives the row's `sender` (a
     * random-secrets swap, or a receive lockup whose sender is the solver).
     * `empty`: nothing funded at the lockup — filled, refunded, or never
     * funded. */
    skipped: { address: string; reason: "no-signer" | "empty" }[];
}

/**
 * Recover stalled sends using only what the SDK already persisted.
 *
 * Safe to run on every wallet start: a lockup whose swap completed holds no
 * outputs and is skipped as `empty`, and a premature push never happens —
 * immature lockups land in `pending`.
 */
export async function sweepRefundableLockups(
    wallet: IWallet,
    arkServerUrl: string,
    opts: {
        /** Descriptors probed past the allocation watermark, for restores
         * whose local state predates some swaps. Passed through to
         * `getUsedSigningDescriptors`. */
        lookAhead?: number;
        /** Unix seconds used for the maturity gate; defaults to wall clock. */
        nowSeconds?: number;
        /** Test seams; default to REST providers over `arkServerUrl`. */
        ark?: RefundArkProvider;
        indexer?: RefundIndexer;
    } = {},
): Promise<LockupSweepReport> {
    const ark = opts.ark ?? new RestArkProvider(arkServerUrl);
    const indexer = opts.indexer ?? new RestIndexerProvider(arkServerUrl);
    const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);

    const manager = await wallet.getContractManager();
    const rows = (await manager.getContracts()).filter(
        (row) =>
            row.type === SWAP_LOCKUP_CONTRACT_TYPE &&
            row.metadata?.kind === SWAP_LOCKUP_CONTRACT_KIND,
    );

    // Every signer the wallet can re-derive, indexed by x-only pubkey, so each
    // row's committed `sender` finds its signer without allocating anything.
    const signers = new Map<string, Identity>();
    if (isHDWalletCapable(wallet)) {
        const descriptors = await wallet.getUsedSigningDescriptors(
            opts.lookAhead === undefined ? undefined : { lookAhead: opts.lookAhead },
        );
        for (const descriptor of descriptors) {
            const signer = await wallet.signerForDescriptor(descriptor);
            signers.set(hex.encode(await signer.xOnlyPublicKey()), signer);
        }
    }

    const report: LockupSweepReport = {
        refunded: [],
        pending: [],
        needsRecovery: [],
        skipped: [],
    };

    for (const row of rows) {
        const script = VHTLCV2ContractHandler.createScript(row.params);
        const signer = signers.get(hex.encode(script.options.sender));
        if (!signer) {
            report.skipped.push({ address: row.address, reason: "no-signer" });
            continue;
        }

        const vtxos = await findLockupVtxos(indexer, script.pkScript);
        if (vtxos.length === 0) {
            report.skipped.push({ address: row.address, reason: "empty" });
            continue;
        }

        const refundLocktime = Number(script.options.refundLocktime);
        if (now < refundLocktime) {
            report.pending.push({ address: row.address, refundLocktime });
            continue;
        }

        try {
            const { arkTxid, amount } = await pushRefundWithoutReceiver(ark, {
                script,
                sender: signer,
                vtxos,
            });
            report.refunded.push({ address: row.address, arkTxid, amount });
        } catch (error) {
            if (error instanceof LockupNeedsRecoveryError) {
                report.needsRecovery.push({
                    address: row.address,
                    outpoints: [...error.outpoints],
                });
                continue;
            }
            throw error;
        }
    }

    return report;
}
