import type {
    BatchStartedEvent,
    BatchFinalizedEvent,
    BatchFailedEvent,
    TreeTxEvent,
    TreeSignatureEvent,
    TreeSigningStartedEvent,
    TreeNoncesEvent,
    BatchFinalizationEvent,
    SettlementEvent,
} from "../providers/ark";
import { SettlementEventType } from "../providers/ark";
import { TxTree, type TxTreeNode } from "../tree/txTree";
import { hex } from "@scure/base";

/**
 * Batch namespace provides utilities for joining and processing batch session.
 * The batch settlement process involves multiple events, this namespace provides abstractions and types to handle them.
 * @see https://docs.arkadeos.com/learn/pillars/batch-swaps
 * @example
 * ```typescript
 * // use wallet handler or create a custom one
 * const handler = wallet.createBatchHandler(intentId, inputs, musig2session);
 *
 * const abortController = new AbortController();
 * // Get event stream from Ark provider
 * const eventStream = arkProvider.getEventStream(
 *   abortController.signal,
 *   ['your-topic-1', 'your-topic-2']
 * );
 *
 * // Join the batch and process events
 * try {
 *   const commitmentTxid = await Batch.join(eventStream, handler);
 *   console.log('Batch completed with commitment:', commitmentTxid);
 * } catch (error) {
 *   console.error('Batch processing failed:', error);
 * } finally {
 *   abortController.abort();
 * }
 * ```
 */
export namespace Batch {
    // Handler interface defines how to react to batch events
    export interface Handler {
        /**
         * Called on BatchStarted event.
         * @returns { skip: boolean } indicating whether the batch should be skipped or not.
         */
        onBatchStarted(event: BatchStartedEvent): Promise<{ skip: boolean }>;
        /**
         * Called when tree signing starts.
         * @param event The tree signing started event.
         * @param vtxoTree The unsigned VTXO tree, reconstructed from the TreeTxEvent events.
         * @returns Promise resolving to a boolean indicating whether to continue processing.
         */
        onTreeSigningStarted(
            event: TreeSigningStartedEvent,
            vtxoTree: TxTree
        ): Promise<{ skip: boolean }>;
        /**
         * Called when tree nonces are received.
         * @param event The tree nonces event.
         * @returns Promise resolving to a boolean indicating whether signing is complete.
         */
        onTreeNonces(event: TreeNoncesEvent): Promise<{ fullySigned: boolean }>;
        /**
         * Called during batch finalization.
         * @param event The batch finalization event.
         * @param vtxoTree The signed VTXO tree, reconstructed from the TreeTxEvent events.
         * @param connectorTree The connector transaction tree, reconstructed from the TreeTxEvent events.
         */
        onBatchFinalization(
            event: BatchFinalizationEvent,
            vtxoTree?: TxTree,
            connectorTree?: TxTree
        ): Promise<void>;

        onBatchFinalized?(event: BatchFinalizedEvent): Promise<void>;
        onBatchFailed?(event: BatchFailedEvent): Promise<void>;
        onTreeTxEvent?(event: TreeTxEvent): Promise<void>;
        onTreeSignatureEvent?(event: TreeSignatureEvent): Promise<void>;
    }

    /**
     * Options for the join function.
     * @param @optional abortController - The abort controller to use to abort the operation.
     * @param @optional skipVtxoTreeSigning - ignore events related to vtxo tree musig2 signing session.
     * @param @optional eventCallback - A callback to be called for each event.
     * @param eventCallback - A callback to be called for each event.
     */
    export type JoinOptions = Partial<{
        abortController: AbortController;
        skipVtxoTreeSigning: boolean;
        eventCallback: (event: SettlementEvent) => Promise<void>;
    }>;

    // State machine steps for batch session
    enum Step {
        Start = "start",
        BatchStarted = "batch_started",
        TreeSigningStarted = "tree_signing_started",
        TreeNoncesAggregated = "tree_nonces_aggregated",
        BatchFinalization = "batch_finalization",
    }

    /**
     * Start the state machine that will process the batch events and join a batch.
     * @param eventIterator - The events stream to process.
     * @param handler - How to react to events.
     * @param options - Options.
     */
    export async function join(
        eventIterator: AsyncIterableIterator<SettlementEvent>,
        handler: Handler,
        options: JoinOptions = {}
    ): Promise<string> {
        const {
            abortController,
            skipVtxoTreeSigning = false,
            eventCallback,
        } = options;

        let step = Step.Start;

        // keep track of tree transactions as they arrive
        const flatVtxoTree: TxTreeNode[] = [];
        const flatConnectorTree: TxTreeNode[] = [];
        // once everything is collected, the TxTree objects are created
        let vtxoTree: TxTree | undefined = undefined;
        let connectorTree: TxTree | undefined = undefined;

        for await (const event of eventIterator) {
            if (abortController?.signal.aborted) {
                throw new Error("canceled");
            }

            if (eventCallback) {
                // don't wait for the callback to complete and ignore errors
                eventCallback(event).catch(() => {});
            }

            switch (event.type) {
                case SettlementEventType.BatchStarted: {
                    const e = event as BatchStartedEvent;
                    const { skip } = await handler.onBatchStarted(e);

                    if (!skip) {
                        step = Step.BatchStarted;

                        if (skipVtxoTreeSigning) {
                            // skip TxTree events and musig2 signatures and nonces
                            step = Step.TreeNoncesAggregated;
                        }
                    }
                    continue;
                }

                case SettlementEventType.BatchFinalized: {
                    if (step !== Step.BatchFinalization) {
                        continue;
                    }

                    if (handler.onBatchFinalized) {
                        await handler.onBatchFinalized(event);
                    }
                    return event.commitmentTxid;
                }

                case SettlementEventType.BatchFailed: {
                    if (handler.onBatchFailed) {
                        await handler.onBatchFailed(event);
                        continue;
                    }

                    throw new Error(event.reason);
                }

                case SettlementEventType.TreeTx: {
                    if (
                        step !== Step.BatchStarted &&
                        step !== Step.TreeNoncesAggregated
                    ) {
                        continue;
                    }

                    // batchIndex 0 = vtxo tree, batchIndex 1 = connector tree
                    if (event.batchIndex === 0) {
                        flatVtxoTree.push(event.chunk);
                    } else {
                        flatConnectorTree.push(event.chunk);
                    }

                    if (handler.onTreeTxEvent) {
                        await handler.onTreeTxEvent(event);
                    }
                    continue;
                }

                case SettlementEventType.TreeSignature: {
                    if (step !== Step.TreeNoncesAggregated) {
                        continue;
                    }

                    if (!vtxoTree) {
                        throw new Error("vtxo tree not initialized");
                    }

                    // push signature to the vtxo tree
                    const tapKeySig = hex.decode(event.signature);
                    vtxoTree.update(event.txid, (tx) => {
                        tx.updateInput(0, {
                            tapKeySig,
                        });
                    });

                    if (handler.onTreeSignatureEvent) {
                        await handler.onTreeSignatureEvent(event);
                    }
                    continue;
                }

                case SettlementEventType.TreeSigningStarted: {
                    if (step !== Step.BatchStarted) {
                        continue;
                    }

                    // create vtxo tree from collected chunks
                    vtxoTree = TxTree.create(flatVtxoTree);

                    const { skip } = await handler.onTreeSigningStarted(
                        event,
                        vtxoTree
                    );

                    if (!skip) {
                        step = Step.TreeSigningStarted;
                    }
                    continue;
                }

                case SettlementEventType.TreeNonces: {
                    if (step !== Step.TreeSigningStarted) {
                        continue;
                    }

                    const { fullySigned } = await handler.onTreeNonces(event);
                    if (fullySigned) {
                        step = Step.TreeNoncesAggregated;
                    }
                    continue;
                }

                case SettlementEventType.BatchFinalization: {
                    if (step !== Step.TreeNoncesAggregated) {
                        continue;
                    }

                    // Build vtxo tree if it hasn't been built yet
                    if (!vtxoTree && flatVtxoTree.length > 0) {
                        vtxoTree = TxTree.create(flatVtxoTree);
                    }

                    if (!vtxoTree && !skipVtxoTreeSigning) {
                        throw new Error("vtxo tree not initialized");
                    }

                    // Build connector tree if we have chunks
                    if (flatConnectorTree.length > 0) {
                        connectorTree = TxTree.create(flatConnectorTree);
                    }

                    await handler.onBatchFinalization(
                        event,
                        vtxoTree,
                        connectorTree
                    );

                    step = Step.BatchFinalization;
                    continue;
                }

                default:
                    // unknown event type, continue
                    continue;
            }
        }

        // iterator closed without finalization, something went wrong
        throw new Error("event stream closed");
    }
}
