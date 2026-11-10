export interface SolverHealthScope {
    readonly network: string;
    readonly direction: string;
}

export interface SolverHealthEntry {
    readonly failures: number;
    readonly lastFailureAt: number;
}

export interface SolverHealthStorage {
    load(scope: SolverHealthScope): unknown | Promise<unknown>;
    save(
        scope: SolverHealthScope,
        records: Readonly<Record<string, SolverHealthEntry>>,
    ): void | Promise<void>;
}

export interface SolverHealth {
    deprioritized(scope: SolverHealthScope): Promise<string[]>;
    record(
        scope: SolverHealthScope,
        solverId: string,
        outcome: "success" | "failure",
    ): Promise<void>;
}

const QUIET_MS = 30 * 60_000;
const cooldown = (failures: number): number =>
    failures < 2 ? 0 : Math.min(60_000 * 2 ** Math.min(failures - 2, 4), 15 * 60_000);

/** Session-local by default; inject storage to retain per-network/direction quote reliability.
 * Two failures demote for one minute, doubling to fifteen; thirty quiet minutes forget the streak.
 * onChange reports active demotion changes, so one failure need not restart a live preview.
 * A verified quote clears it. Storage errors are advisory; acceptance never updates this state. */
export function createSolverHealth(
    options: { storage?: SolverHealthStorage; now?: () => number; onChange?: () => void } = {},
): SolverHealth {
    const now = options.now ?? (() => Date.now());
    const memory = new Map<string, Readonly<Record<string, SolverHealthEntry>>>();
    const keyOf = (scope: SolverHealthScope) => JSON.stringify([scope.network, scope.direction]);
    const storage: SolverHealthStorage = options.storage ?? {
        load: (scope) => memory.get(keyOf(scope)),
        save: (scope, records) => {
            memory.set(keyOf(scope), records);
        },
    };
    const pending = new Map<string, Promise<void>>();
    const active = (records: Record<string, SolverHealthEntry>, timestamp: number): string[] =>
        Object.keys(records).filter(
            (id) => timestamp < records[id].lastFailureAt + cooldown(records[id].failures),
        );
    const read = async (scope: SolverHealthScope): Promise<Record<string, SolverHealthEntry>> => {
        try {
            const value = await storage.load(scope);
            if (!value || typeof value !== "object" || Array.isArray(value)) return {};
            const timestamp = now();
            return Object.fromEntries(
                Object.entries(value).flatMap(([id, entry]) => {
                    if (!entry || typeof entry !== "object") return [];
                    const { failures, lastFailureAt } = entry as {
                        failures?: unknown;
                        lastFailureAt?: unknown;
                    };
                    return typeof failures === "number" &&
                        Number.isSafeInteger(failures) &&
                        failures > 0 &&
                        failures <= 32 &&
                        typeof lastFailureAt === "number" &&
                        Number.isFinite(lastFailureAt) &&
                        lastFailureAt >= 0 &&
                        lastFailureAt <= timestamp &&
                        timestamp - lastFailureAt < QUIET_MS
                        ? [[id, { failures, lastFailureAt }]]
                        : [];
                }),
            );
        } catch {
            return {};
        }
    };
    return {
        deprioritized: async (scope) => {
            await pending.get(keyOf(scope));
            const records = await read(scope);
            const timestamp = now();
            return active(records, timestamp);
        },
        record: (scope, solverId, outcome) => {
            const key = keyOf(scope);
            const update = (pending.get(key) ?? Promise.resolve()).then(async () => {
                let records = await read(scope);
                const before = JSON.stringify(active(records, now()).sort());
                if (outcome === "success") delete records[solverId];
                else
                    records = {
                        ...records,
                        [solverId]: {
                            failures: Math.min((records[solverId]?.failures ?? 0) + 1, 32),
                            lastFailureAt: now(),
                        },
                    };
                try {
                    await storage.save(scope, records);
                    if (before !== JSON.stringify(active(records, now()).sort()))
                        options.onChange?.();
                } catch {
                    // Reliability is advisory and must not turn a verified quote into a failure.
                }
            });
            pending.set(key, update);
            return update.finally(() => {
                if (pending.get(key) === update) pending.delete(key);
            });
        },
    };
}
