import { TxType, type ArkTransaction } from "./index";

/** One transaction's participation in one logical action. */
export interface GroupMembership {
    /**
     * Stable id of the action; txs sharing it group together. Third-party
     * resolvers should namespace it (`"vendor:thing"`) to avoid colliding with
     * other resolvers' groups. SDK built-ins use namespaced ids such as `boarding:`.
     */
    groupId: string;
    /** Human label for the action, e.g. "Dice game". */
    label?: string;
    /** App category for icon/filtering, e.g. "game". */
    kind?: string;
    /**
     * Free-form row data. Same-group metadata is shallow-merged with
     * earlier-resolver keys winning.
     */
    metadata?: Record<string, unknown>;
    /**
     * This tx's unsigned sat contribution to this group. Defaults to the tx's
     * full amount; the builder applies direction. Use it to split a batched tx
     * across groups. Same-key receive rows paired with a sent row are treated
     * as change and excluded from `Activity.amount`.
     */
    amount?: number;
}

/** A pluggable resolver keyed by `id`. */
export interface ActivityResolver {
    /**
     * Registry key — override or remove by it. Namespace it (`"vendor:games"`)
     * so independent libraries don't clobber each other; `use()` overwrites
     * silently on a duplicate id.
     */
    id: string;
    /**
     * Load correlation data before `resolve` runs. If it rejects, this resolver
     * contributes no memberships.
     */
    prepare?(): Promise<void>;
    /** Pure and synchronous. The groups this tx belongs to, or undefined to leave it plain. */
    resolve(tx: ArkTransaction): GroupMembership[] | undefined;
}

/** The non-id, non-amount part of a {@link GroupMembership}. */
export interface ActivityIntent {
    /** Human label for the action, e.g. "Dice game". */
    label?: string;
    /** App category for icon/filtering, e.g. "game". */
    kind?: string;
    /** Free-form row data, shallow-merged across the group's resolvers (first-writer-wins). */
    metadata?: Record<string, unknown>;
}

/** One logical activity. */
export interface Activity {
    /** The groupId, or the natural tx key for untagged rows. */
    id: string;
    /** Merged intent for the group, if any resolver tagged it. */
    intent?: ActivityIntent;
    /** Member txs, oldest-first. */
    txs: ArkTransaction[];
    /** Signed net sats: positive received, negative sent; same-key change rows are excluded. */
    amount: number;
    /** Earliest member createdAt (ms since epoch). */
    createdAt: number;
    /** True once every member tx is settled. */
    settled: boolean;
}

/**
 * Project a flat tx list into activities via resolvers.
 *
 * - Untagged rows bucket by natural tx key, so send/change pairs stay together.
 * - Memberships are unioned across resolvers and bucketed by `groupId`; a tx may join
 *   several groups (Ark batching). Same-group memberships (across resolvers) merge:
 *   `label`/`kind` first-defined-wins (resolver order), `metadata` shallow-merged.
 * - Contributions are signed by tx direction; same-key received rows paired with
 *   a sent row are treated as change and excluded from the activity amount.
 * - A resolver that throws in resolve() or rejects in prepare() is isolated and
 *   contributes no memberships.
 */
export async function buildActivities(
    txs: ArkTransaction[],
    resolvers: ActivityResolver[],
): Promise<Activity[]> {
    const preparedResolvers = (
        await Promise.all(
            resolvers.map(async (r) => {
                try {
                    await r.prepare?.();
                    return r;
                } catch {
                    return undefined;
                }
            }),
        )
    ).filter((r): r is ActivityResolver => r !== undefined);

    const keyOf = (tx: ArkTransaction) =>
        tx.key.arkTxid || tx.key.commitmentTxid || tx.key.boardingTxid;

    const merge = (a: GroupMembership, b: GroupMembership): GroupMembership => ({
        groupId: a.groupId,
        label: a.label ?? b.label,
        kind: a.kind ?? b.kind,
        metadata: { ...b.metadata, ...a.metadata },
        amount: a.amount ?? b.amount,
    });

    const isSent = (tx: ArkTransaction) => tx.type === TxType.TxSent;
    const signedAmount = (tx: ArkTransaction, amount = tx.amount) => {
        const magnitude = Math.abs(amount);
        return isSent(tx) ? -magnitude : magnitude;
    };

    type Bucket = {
        intent?: Activity["intent"];
        members: { tx: ArkTransaction; amount: number }[];
    };
    const buckets = new Map<string, Bucket>();

    for (const tx of txs) {
        // Deduplicate resolver memberships by groupId for this tx.
        const perGroup = new Map<string, GroupMembership>();
        for (const r of preparedResolvers) {
            let ms: GroupMembership[] | undefined;
            try {
                ms = r.resolve(tx);
            } catch {
                ms = undefined;
            }
            for (const m of ms ?? []) {
                const existing = perGroup.get(m.groupId);
                perGroup.set(m.groupId, existing ? merge(existing, m) : { ...m });
            }
        }

        if (perGroup.size === 0) {
            const id = keyOf(tx);
            const b = buckets.get(id) ?? { members: [] };
            b.members.push({ tx, amount: signedAmount(tx) });
            buckets.set(id, b);
            continue;
        }
        for (const m of perGroup.values()) {
            const b = buckets.get(m.groupId) ?? { members: [] };
            b.intent = {
                label: b.intent?.label ?? m.label,
                kind: b.intent?.kind ?? m.kind,
                metadata: { ...m.metadata, ...b.intent?.metadata },
            };
            b.members.push({ tx, amount: signedAmount(tx, m.amount ?? tx.amount) });
            buckets.set(m.groupId, b);
        }
    }

    const netAmount = (members: { tx: ArkTransaction; amount: number }[]) => {
        const sentKeys = new Set(members.filter((x) => isSent(x.tx)).map((x) => keyOf(x.tx)));
        return members.reduce((s, x) => {
            // Same-key receives are change for sent rows.
            if (!isSent(x.tx) && sentKeys.has(keyOf(x.tx))) return s;
            return s + x.amount;
        }, 0);
    };

    const latest = (a: Activity) => a.txs[a.txs.length - 1].createdAt;
    return [...buckets.entries()]
        .map(([id, b]): Activity => {
            const members = [...b.members].sort((x, y) => x.tx.createdAt - y.tx.createdAt);
            return {
                id,
                intent: b.intent,
                txs: members.map((x) => x.tx),
                amount: netAmount(members),
                createdAt: members[0].tx.createdAt,
                settled: members.every((x) => x.tx.settled),
            };
        })
        .sort((a, c) => latest(c) - latest(a));
}

/** Resolver registry keyed by id. */
export class ActivityRegistry {
    private readonly resolvers = new Map<string, ActivityResolver>();

    /** Add a resolver, or override an existing one with the same id (kept in place). */
    use(resolver: ActivityResolver): void {
        this.resolvers.set(resolver.id, resolver);
    }

    /** Remove a resolver (built-in or custom) by id. */
    remove(id: string): void {
        this.resolvers.delete(id);
    }

    /** The registered resolver ids, in registration order. */
    list(): string[] {
        return [...this.resolvers.keys()];
    }

    /** All registered resolvers, in registration (priority) order. */
    all(): ActivityResolver[] {
        return [...this.resolvers.values()];
    }
}

/** Built-in resolver: labels on-chain boarding (deposit) transactions. */
export function boardingResolver(): ActivityResolver {
    return {
        id: "boarding",
        resolve(tx) {
            if (!tx.key.boardingTxid) return undefined;
            return [
                { groupId: `boarding:${tx.key.boardingTxid}`, label: "Deposit", kind: "boarding" },
            ];
        },
    };
}

/** Default registry with SDK built-ins. */
export function createDefaultActivityRegistry(): ActivityRegistry {
    const registry = new ActivityRegistry();
    registry.use(boardingResolver());
    return registry;
}
