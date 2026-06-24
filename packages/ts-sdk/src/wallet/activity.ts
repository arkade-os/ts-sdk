import { hex } from "@scure/base";
import type { ArkTransaction } from "./index";
import { AssetId } from "../extension/asset/assetId";

/** One transaction's participation in one logical action. A tx may return several. */
export interface GroupMembership {
    /**
     * Stable id of the action; txs sharing it group together. Third-party
     * resolvers should namespace it (`"vendor:thing"`) to avoid colliding with
     * other resolvers' groups; the built-ins use `boarding:`/`exit:`/`mint:`.
     */
    groupId: string;
    /** Human label for the action, e.g. "Dice game". */
    label?: string;
    /** App category for icon/filtering, e.g. "game". Namespace across vendors to avoid clashes. */
    kind?: string;
    /**
     * Free-form row data (renderer-defined). When several resolvers tag the same
     * tx+group, this is shallow-merged with earlier-resolver-wins on key
     * collision — namespace keys (e.g. `swap.status`) to avoid clobbering.
     */
    metadata?: Record<string, unknown>;
    /**
     * This tx's contribution to THIS group, in sats; defaults to the tx's full
     * net amount. Set it to split a batched tx across the groups it touches —
     * omitting it on a multi-group tx attributes the full amount to each group.
     */
    amount?: number;
}

/** A pluggable resolver. Registered by id; `prepare()` refreshes correlation data. */
export interface ActivityResolver {
    /**
     * Registry key — override or remove by it. Namespace it (`"vendor:games"`)
     * so independent libraries don't clobber each other; `use()` overwrites
     * silently on a duplicate id.
     */
    id: string;
    /**
     * Load fresh correlation data (swaps, games…) before `resolve` runs. A
     * rejection is isolated — the resolver then contributes no memberships.
     */
    prepare?(): Promise<void>;
    /** Pure and synchronous. The groups this tx belongs to, or undefined to leave it plain. */
    resolve(tx: ArkTransaction): GroupMembership[] | undefined;
}

/** The label/kind/metadata an activity carries — the non-id, non-amount part of a {@link GroupMembership}. */
export interface ActivityIntent {
    /** Human label for the action, e.g. "Dice game". */
    label?: string;
    /** App category for icon/filtering, e.g. "game". */
    kind?: string;
    /** Free-form row data, shallow-merged across the group's resolvers (first-writer-wins). */
    metadata?: Record<string, unknown>;
}

/** One logical activity: the projection of all txs sharing a groupId. */
export interface Activity {
    /** The groupId, or the tx's own key when ungrouped. */
    id: string;
    /** Merged intent for the group, if any resolver tagged it. */
    intent?: ActivityIntent;
    /** Member txs, oldest-first. */
    txs: ArkTransaction[];
    /** Net amount across the group, in sats — always sats, never asset units (sum of members' attributed amounts). */
    amount: number;
    /** Earliest member createdAt (ms since epoch). */
    createdAt: number;
    /** True once every member tx is settled. */
    settled: boolean;
}

/**
 * Pure grouping engine: project a flat tx list into activities via resolvers.
 * Mirrors `buildTransactionHistory` — no I/O beyond the resolvers' own `prepare()`.
 *
 * - A tx with no memberships becomes its own single-member activity (= the flat row).
 * - Memberships are unioned across resolvers and bucketed by `groupId`; a tx may join
 *   several groups (Ark batching). Same-group memberships (across resolvers) merge:
 *   `label`/`kind` first-defined-wins (resolver order), `metadata` shallow-merged.
 * - A member's contribution defaults to the tx's full amount, or `membership.amount`
 *   when given (so a batched tx splits across the groups it touches).
 * - A resolver that throws in resolve() or rejects in prepare() is isolated and
 *   contributes no memberships, so one bad resolver never breaks the whole history.
 */
export async function buildActivities(
    txs: ArkTransaction[],
    resolvers: ActivityResolver[],
): Promise<Activity[]> {
    // Isolate prepare() like resolve(): a resolver that fails to load its
    // correlation data contributes no memberships, rather than throwing away
    // the whole history.
    await Promise.all(
        resolvers.map(async (r) => {
            try {
                await r.prepare?.();
            } catch {
                // a failed prepare leaves this resolver with stale/empty data
            }
        }),
    );

    const keyOf = (tx: ArkTransaction) =>
        tx.key.arkTxid || tx.key.commitmentTxid || tx.key.boardingTxid;

    const merge = (a: GroupMembership, b: GroupMembership): GroupMembership => ({
        groupId: a.groupId,
        label: a.label ?? b.label,
        kind: a.kind ?? b.kind,
        metadata: { ...b.metadata, ...a.metadata },
        amount: a.amount ?? b.amount,
    });

    type Bucket = {
        intent?: Activity["intent"];
        members: { tx: ArkTransaction; amount: number }[];
    };
    const buckets = new Map<string, Bucket>();

    for (const tx of txs) {
        // Collect this tx's memberships, deduping by groupId so two resolvers tagging
        // the same tx+group merge into one membership (rather than counting the tx twice).
        const perGroup = new Map<string, GroupMembership>();
        for (const r of resolvers) {
            let ms: GroupMembership[] | undefined;
            try {
                ms = r.resolve(tx);
            } catch {
                ms = undefined; // one bad tag must not break the whole history
            }
            for (const m of ms ?? []) {
                const existing = perGroup.get(m.groupId);
                perGroup.set(m.groupId, existing ? merge(existing, m) : { ...m });
            }
        }

        if (perGroup.size === 0) {
            buckets.set(keyOf(tx), { members: [{ tx, amount: tx.amount }] });
            continue;
        }
        for (const m of perGroup.values()) {
            const b = buckets.get(m.groupId) ?? { members: [] };
            b.intent = {
                label: b.intent?.label ?? m.label,
                kind: b.intent?.kind ?? m.kind,
                metadata: { ...m.metadata, ...b.intent?.metadata },
            };
            b.members.push({ tx, amount: m.amount ?? tx.amount });
            buckets.set(m.groupId, b);
        }
    }

    const latest = (a: Activity) => Math.max(...a.txs.map((t) => t.createdAt));
    return [...buckets.entries()]
        .map(([id, b]): Activity => {
            const members = [...b.members].sort((x, y) => x.tx.createdAt - y.tx.createdAt);
            return {
                id,
                intent: b.intent,
                txs: members.map((x) => x.tx),
                amount: members.reduce((s, x) => s + x.amount, 0),
                createdAt: members[0].tx.createdAt,
                settled: members.every((x) => x.tx.settled),
            };
        })
        .sort((a, c) => latest(c) - latest(a));
}

/** Holds activity resolvers keyed by id. Built-in resolvers are pre-registered on the wallet. */
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

/** Built-in resolver: labels collaborative exits (VTXOs forfeited to chain in a batch). */
export function collabExitResolver(): ActivityResolver {
    return {
        id: "collab-exit",
        resolve(tx) {
            if (tx.tag !== "exit") return undefined;
            return [
                {
                    groupId: `exit:${tx.key.commitmentTxid}`,
                    label: "Collaborative exit",
                    kind: "exit",
                },
            ];
        },
    };
}

/**
 * Built-in resolver: labels the genesis transaction of a minted asset. An asset
 * id encodes its genesis txid, so a tx is the mint of an asset exactly when it
 * carries that asset and its `arkTxid` is the asset's genesis. Reissues and
 * transfers carry the asset but key off a different genesis, so they are left
 * plain.
 */
export function assetMintResolver(): ActivityResolver {
    return {
        id: "asset-mint",
        resolve(tx) {
            if (!tx.assets?.length || !tx.key.arkTxid) return undefined;
            const minted = tx.assets.filter((a) => {
                try {
                    return hex.encode(AssetId.fromString(a.assetId).txid) === tx.key.arkTxid;
                } catch {
                    return false;
                }
            });
            if (minted.length === 0) return undefined;
            return minted.map((a) => ({
                groupId: `mint:${a.assetId}`,
                label: "Asset mint",
                kind: "asset-mint",
                metadata: { assetId: a.assetId, amount: a.amount.toString() },
            }));
        },
    };
}

/**
 * A registry pre-populated with the SDK's built-in resolvers: `boarding`,
 * `collab-exit`, and `asset-mint`.
 */
export function createDefaultActivityRegistry(): ActivityRegistry {
    const registry = new ActivityRegistry();
    registry.use(boardingResolver());
    registry.use(collabExitResolver());
    registry.use(assetMintResolver());
    return registry;
}
