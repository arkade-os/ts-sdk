import type { Outpoint } from "../wallet";

export interface StoredVtxoReservation {
    id: string;
    outpoints: Outpoint[];
}

export function reservationOutpointSetKey(outpoints: readonly Outpoint[]): string {
    return outpoints
        .map(({ txid, vout }) => `${txid}:${vout}`)
        .sort()
        .join("|");
}

/** Single-writer holds; only the owning application can establish when release is safe. */
export interface VtxoReservationRepository {
    readonly version: 2;
    getReservations(): Promise<StoredVtxoReservation[]>;
    saveReservation(reservation: StoredVtxoReservation): Promise<void>;
    deleteReservation(id: string): Promise<void>;
    /** Compare and delete atomically; resolve true only after the matching delete commits. */
    deleteReservationIfMatches(id: string, expected: readonly Outpoint[]): Promise<boolean>;
}
