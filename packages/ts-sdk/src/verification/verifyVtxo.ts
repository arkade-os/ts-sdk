import type { VirtualCoin } from "../wallet";
import { verifyCommitmentAnchors, VtxoVerificationUnavailableError } from "./anchor";
import { verifyClaimedLeaf, verifyGraphSegments } from "./graph";
import { parseVtxoProof, VtxoProofError } from "./proof";
import { verifyProofSignatures } from "./signatures";
import type {
    VtxoChainSource,
    VtxoProofSource,
    VtxoVerificationIssue,
    VtxoVerificationOptions,
    VtxoVerificationResult,
    VtxoVerificationServerInfo,
} from "./types";

const DEFAULT_MIN_CONFIRMATION_DEPTH = 6;
const MAX_ISSUES = 100;

export async function verifyVtxo(
    vtxo: VirtualCoin,
    proofSource: VtxoProofSource,
    chainSource: VtxoChainSource,
    _serverInfo: VtxoVerificationServerInfo,
    options: VtxoVerificationOptions = {},
): Promise<VtxoVerificationResult> {
    const outpoint = { txid: vtxo.txid, vout: vtxo.vout };
    const minConfirmationDepth = options.minConfirmationDepth ?? DEFAULT_MIN_CONFIRMATION_DEPTH;
    if (!Number.isInteger(minConfirmationDepth) || minConfirmationDepth < 0) {
        throw new Error("minConfirmationDepth must be a non-negative integer");
    }

    if (vtxo.isPreconfirmed) {
        return {
            status: "preconfirmed",
            outpoint,
            commitmentTxids: vtxo.commitmentTxIds ?? [],
            chainLength: 0,
            issues: [],
            partialChecks: {},
        };
    }

    let proof;
    try {
        proof = await parseVtxoProof(outpoint, proofSource);
    } catch (error) {
        if (error instanceof VtxoProofError) {
            return {
                status: error.kind,
                outpoint,
                commitmentTxids: [],
                chainLength: 0,
                issues: [{ code: error.code, message: error.message }],
            };
        }
        return {
            status: "unavailable",
            outpoint,
            commitmentTxids: [],
            chainLength: 0,
            issues: [{ code: "proof_unavailable", message: message(error) }],
        };
    }

    const base = {
        outpoint,
        commitmentTxids: proof.commitmentTxids,
        chainLength: proof.transactions.size,
    };
    const localIssues = bounded([
        ...verifyClaimedLeaf(vtxo, proof),
        ...verifyGraphSegments(proof),
        ...verifyProofSignatures(proof),
    ]);
    if (localIssues.length > 0) {
        return { status: "invalid", ...base, issues: localIssues };
    }

    try {
        const anchors = await verifyCommitmentAnchors(proof, chainSource, minConfirmationDepth);
        const issues = bounded(anchors.issues);
        if (issues.length > 0) {
            return { status: "invalid", ...base, issues };
        }
        return {
            status: "confirmed",
            ...base,
            confirmationDepth: anchors.confirmationDepth,
            issues: [],
        };
    } catch (error) {
        if (error instanceof VtxoVerificationUnavailableError) {
            return {
                status: "unavailable",
                ...base,
                issues: [{ code: error.code, message: error.message }],
            };
        }
        return {
            status: "unavailable",
            ...base,
            issues: [{ code: "anchor_unavailable", message: message(error) }],
        };
    }
}

function bounded(issues: VtxoVerificationIssue[]): VtxoVerificationIssue[] {
    if (issues.length <= MAX_ISSUES) return issues;
    return [
        ...issues.slice(0, MAX_ISSUES),
        {
            code: "issues_truncated",
            message: `Verification produced more than ${MAX_ISSUES} issues`,
        },
    ];
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
