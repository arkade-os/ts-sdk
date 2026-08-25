import type { Intent } from "../intent";
import type { Outpoint, Recipient } from ".";
import type { TxTreeNode } from "../tree/txTree";

/** Opaque runtime correlation token plus the runtime-selected proof expiry. */
export interface PreparedBoardingRegistration {
    status: "ready";
    handle: string;
    registerExpireAt: number;
}

export type BoardingPreparationResult =
    | PreparedBoardingRegistration
    | { status: "release_required"; handle: string; deleteExpireAt: number }
    | { status: "blocked"; reason: string }
    | { status: "finalized"; commitmentTxid: string };

export interface ValidatedBoardingBatch {
    batchId: string;
    batchExpiry: bigint;
    unsignedCommitmentTx: string;
    vtxoTree: readonly TxTreeNode[];
    expectedRecipients: readonly Recipient[];
}

export type BoardingRegisterResult =
    | { status: "registered"; intentId: string }
    | { status: "definitely_not_submitted" }
    | { status: "ambiguous" };
export type BoardingCommitmentResult = { status: "submitted" } | { status: "ambiguous" };
export type BoardingReleaseResult = { status: "released" } | { status: "ambiguous" };

/** External signer/submission boundary; it does not own the batch lifecycle. */
export interface BoardingSigningAdapter {
    readonly publicKey: Uint8Array;
    prepareRegistration(request: {
        inputs: readonly Outpoint[];
        recipients: readonly Recipient[];
    }): Promise<BoardingPreparationResult>;
    registerIntent(request: {
        handle: string;
        psbt: string;
        inputIndexes: readonly number[];
        message: Intent.RegisterMessage;
    }): Promise<BoardingRegisterResult>;
    submitCommitment(request: {
        handle: string;
        psbt: string;
        inputIndexes: readonly number[];
        signedForfeits: readonly string[];
        validatedBatch: ValidatedBoardingBatch;
    }): Promise<BoardingCommitmentResult>;
    releaseIntent(request: {
        handle: string;
        psbt: string;
        inputIndexes: readonly number[];
        message: Intent.DeleteMessage;
    }): Promise<BoardingReleaseResult>;
}
