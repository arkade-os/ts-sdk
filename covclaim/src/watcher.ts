/**
 * Polls esplora for UTXOs at registered covenant taproot addresses.
 * When a UTXO appears, triggers the claim flow.
 */

import type { Config, EsploraUtxo } from "./types.js";
import { getWatchingCovenants, updateStatus } from "./store.js";
import { claimCovenant } from "./claimer.js";

let watcherInterval: ReturnType<typeof setInterval> | null = null;

export function startWatcher(config: Config): void {
    if (watcherInterval) return;

    console.log(
        `[watcher] polling every ${config.pollIntervalMs}ms at ${config.esploraUrl}`
    );

    watcherInterval = setInterval(() => poll(config), config.pollIntervalMs);
    // Run immediately on start
    poll(config);
}

export function stopWatcher(): void {
    if (watcherInterval) {
        clearInterval(watcherInterval);
        watcherInterval = null;
    }
}

async function poll(config: Config): Promise<void> {
    const covenants = getWatchingCovenants();
    if (covenants.length === 0) return;

    for (const entry of covenants) {
        try {
            const utxos = await fetchUtxos(
                config.esploraUrl,
                entry.taprootAddress
            );

            if (utxos.length === 0) continue;

            // Use the first confirmed UTXO, or first unconfirmed if none confirmed
            const utxo =
                utxos.find((u) => u.status.confirmed) ?? utxos[0];

            console.log(
                `[watcher] found UTXO for covenant ${entry.id}: ${utxo.txid}:${utxo.vout} (${utxo.value} sats)`
            );

            updateStatus(entry.id, "claiming", { utxo });

            const txid = await claimCovenant(entry, utxo, config);

            console.log(
                `[watcher] claimed covenant ${entry.id}: txid=${txid}`
            );
            updateStatus(entry.id, "claimed", { claimTxid: txid });
        } catch (err) {
            const message =
                err instanceof Error ? err.message : String(err);
            console.error(
                `[watcher] failed to claim covenant ${entry.id}: ${message}`
            );
            updateStatus(entry.id, "failed", { error: message });
        }
    }
}

async function fetchUtxos(
    esploraUrl: string,
    address: string
): Promise<EsploraUtxo[]> {
    const res = await fetch(`${esploraUrl}/api/address/${address}/utxo`);
    if (!res.ok) {
        throw new Error(
            `Failed to fetch UTXOs for ${address}: ${res.statusText}`
        );
    }
    return res.json();
}
