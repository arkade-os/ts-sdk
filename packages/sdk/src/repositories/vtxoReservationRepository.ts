import type { Outpoint } from "../wallet";

export interface StoredVtxoReservation {
    id: string;
    outpoints: Outpoint[];
}

/** Single-writer holds; only the owning application can establish when release is safe. */
export interface VtxoReservationRepository {
    readonly version: 1;
    getReservations(): Promise<StoredVtxoReservation[]>;
    saveReservation(reservation: StoredVtxoReservation): Promise<void>;
    deleteReservation(id: string): Promise<void>;
}
