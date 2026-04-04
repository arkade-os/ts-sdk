import crypto from "node:crypto";
import type { CovenantEntry, CovenantRegistration, CovenantStatus } from "./types.js";

const entries = new Map<string, CovenantEntry>();

export function addCovenant(
    registration: CovenantRegistration,
    taprootAddress: string
): CovenantEntry {
    const id = crypto.randomUUID();
    const entry: CovenantEntry = {
        id,
        registration,
        taprootAddress,
        status: "watching",
        createdAt: Date.now(),
    };
    entries.set(id, entry);
    return entry;
}

export function getCovenant(id: string): CovenantEntry | undefined {
    return entries.get(id);
}

export function getWatchingCovenants(): CovenantEntry[] {
    return [...entries.values()].filter((e) => e.status === "watching");
}

export function updateStatus(
    id: string,
    status: CovenantStatus,
    extra?: Partial<Pick<CovenantEntry, "utxo" | "claimTxid" | "error">>
): void {
    const entry = entries.get(id);
    if (!entry) return;
    entry.status = status;
    if (extra) Object.assign(entry, extra);
}
