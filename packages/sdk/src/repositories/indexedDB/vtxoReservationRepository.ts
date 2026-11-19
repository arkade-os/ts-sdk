import {
    reservationOutpointSetKey,
    type StoredVtxoReservation,
    type VtxoReservationRepository,
} from "../vtxoReservationRepository";
import type { Outpoint } from "../../wallet";
import { awaitTransaction, promisifyRequest } from "./idbUtils";
import { createManagedConnection, type ManagedConnection } from "./managedConnection";

const STORE = "reservations";

export class IndexedDBVtxoReservationRepository
    implements VtxoReservationRepository, AsyncDisposable
{
    readonly version = 2 as const;
    private readonly connection: ManagedConnection;

    constructor(dbName: string) {
        this.connection = createManagedConnection(dbName, 1, (db) => {
            db.createObjectStore(STORE, { keyPath: "id" });
        });
    }

    async getReservations(): Promise<StoredVtxoReservation[]> {
        const db = await this.connection.get();
        return promisifyRequest(db.transaction(STORE).objectStore(STORE).getAll());
    }

    async saveReservation(reservation: StoredVtxoReservation): Promise<void> {
        const db = await this.connection.get();
        const transaction = db.transaction(STORE, "readwrite");
        transaction.objectStore(STORE).put(reservation);
        await awaitTransaction(transaction);
    }

    async deleteReservation(id: string): Promise<void> {
        const db = await this.connection.get();
        const transaction = db.transaction(STORE, "readwrite");
        transaction.objectStore(STORE).delete(id);
        await awaitTransaction(transaction);
    }

    async deleteReservationIfMatches(id: string, expected: readonly Outpoint[]): Promise<boolean> {
        const expectedKey = reservationOutpointSetKey(expected);
        const db = await this.connection.get();
        const transaction = db.transaction(STORE, "readwrite");
        const store = transaction.objectStore(STORE);
        let deleted = false;
        const request = store.get(id);
        request.onsuccess = () => {
            const current = request.result as StoredVtxoReservation | undefined;
            if (!current || reservationOutpointSetKey(current.outpoints) !== expectedKey) return;
            store.delete(id);
            deleted = true;
        };
        await awaitTransaction(transaction);
        return deleted;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.connection[Symbol.asyncDispose]();
    }
}
