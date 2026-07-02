import type { RealmLike, RealmResults } from "@arkade-os/sdk/repositories/realm";
import {
    BoltzSwap,
    GetSwapsFilter,
    hasImpossibleSwapsFilter,
    SwapRepository,
} from "../swap-repository";

interface BoltzSwapRecord {
    id: string;
    type: string;
    status: string;
    createdAt: number;
    data: string;
}

/**
 * Realm-based implementation of SwapRepository.
 *
 * `realm` is a peer dependency and not installed in this package; consumers
 * open Realm with the schemas from `./schemas.ts` and pass the instance to
 * the constructor, where it is validated against the shared `RealmLike`
 * shape exported by `@arkade-os/sdk`.
 *
 * Realm handles schema creation on open, so `ensureInit()` is a no-op.
 * The consumer owns the Realm lifecycle — `[Symbol.asyncDispose]` is a no-op.
 */
export class RealmSwapRepository implements SwapRepository {
    readonly version = 1 as const;

    constructor(private readonly realm: RealmLike) {}

    // ── Lifecycle ──────────────────────────────────────────────────────

    private async ensureInit(): Promise<void> {
        // Realm handles schema on open — nothing to initialise.
    }

    async [Symbol.asyncDispose](): Promise<void> {
        // no-op — consumer owns the Realm lifecycle
    }

    // ── Swap operations ────────────────────────────────────────────────

    async saveSwap<T extends BoltzSwap>(swap: T): Promise<void> {
        await this.ensureInit();
        this.realm.write(() => {
            this.realm.create(
                "BoltzSwap",
                {
                    id: swap.id,
                    type: swap.type,
                    status: swap.status,
                    createdAt: swap.createdAt,
                    data: JSON.stringify(swap),
                },
                "modified",
            );
        });
    }

    async deleteSwap(id: string): Promise<void> {
        await this.ensureInit();
        this.realm.write(() => {
            const toDelete = this.realm.objects("BoltzSwap").filtered("id == $0", id);
            if (toDelete.length > 0) {
                this.realm.delete(toDelete);
            }
        });
    }

    async getAllSwaps<T extends BoltzSwap>(filter?: GetSwapsFilter): Promise<T[]> {
        await this.ensureInit();

        if (hasImpossibleSwapsFilter(filter)) return [];

        let results: RealmResults<BoltzSwapRecord> =
            this.realm.objects<BoltzSwapRecord>("BoltzSwap");

        if (filter) {
            const filterParts: string[] = [];
            const filterArgs: unknown[] = [];
            let argIndex = 0;

            argIndex = this.addFilterCondition(filterParts, filterArgs, "id", filter.id, argIndex);
            argIndex = this.addFilterCondition(
                filterParts,
                filterArgs,
                "status",
                filter.status,
                argIndex,
            );
            this.addFilterCondition(filterParts, filterArgs, "type", filter.type, argIndex);

            if (filterParts.length > 0) {
                const query = filterParts.join(" AND ");
                results = results.filtered(query, ...filterArgs);
            }
        }

        if (filter?.orderBy === "createdAt") {
            const reverse = filter.orderDirection === "desc";
            results = results.sorted("createdAt", reverse);
        }

        return [...results].map((obj) => JSON.parse(obj.data) as T);
    }

    async clear(): Promise<void> {
        await this.ensureInit();
        this.realm.write(() => {
            this.realm.delete(this.realm.objects("BoltzSwap"));
        });
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private addFilterCondition(
        parts: string[],
        args: unknown[],
        column: string,
        value: string | string[] | undefined,
        argIndex: number,
    ): number {
        if (value === undefined) return argIndex;

        if (Array.isArray(value)) {
            if (value.length === 0) return argIndex;
            const placeholders = value.map((_, i) => `$${argIndex + i}`);
            parts.push(`${column} IN {${placeholders.join(", ")}}`);
            args.push(...value);
            return argIndex + value.length;
        } else {
            parts.push(`${column} == $${argIndex}`);
            args.push(value);
            return argIndex + 1;
        }
    }
}
