import type { RelativeTimelock } from "@arkade-os/sdk";

export interface CovenantRegistration {
    /** Hex-encoded x-only sender pubkey */
    sender: string;
    /** Hex-encoded x-only receiver pubkey */
    receiver: string;
    /** Hex-encoded x-only server pubkey */
    server: string;
    /** Hex-encoded 32-byte preimage (not hash) */
    preimage: string;
    /** Bech32/bech32m destination address */
    claimAddress: string;
    /** Sats the covenant enforces on output 0 */
    expectedAmount: number;
    /** Absolute locktime for refund-without-receiver path */
    refundLocktime: number;
    /** Relative delay for unilateral claim path */
    unilateralClaimDelay: RelativeTimelockJSON;
    /** Relative delay for unilateral refund path */
    unilateralRefundDelay: RelativeTimelockJSON;
    /** Relative delay for unilateral refund-without-receiver path */
    unilateralRefundWithoutReceiverDelay: RelativeTimelockJSON;
}

export interface RelativeTimelockJSON {
    type: "blocks" | "seconds";
    value: number;
}

export type CovenantStatus = "watching" | "claiming" | "claimed" | "failed";

export interface CovenantEntry {
    id: string;
    registration: CovenantRegistration;
    /** Taproot address derived from the CovVHTLC script */
    taprootAddress: string;
    status: CovenantStatus;
    /** UTXO that was found (once detected) */
    utxo?: { txid: string; vout: number; value: number };
    /** Claim transaction ID (once broadcast) */
    claimTxid?: string;
    /** Error message if claim failed */
    error?: string;
    createdAt: number;
}

export interface EsploraUtxo {
    txid: string;
    vout: number;
    value: number;
    status: {
        confirmed: boolean;
        block_height?: number;
    };
}

export interface Config {
    esploraUrl: string;
    introspectorUrl: string;
    port: number;
    pollIntervalMs: number;
    network: "regtest" | "signet" | "mainnet";
}
