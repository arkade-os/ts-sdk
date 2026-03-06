import type {
    GetSwapsFilter,
    PendingSwap,
    SwapRepository,
} from "../swap-repository";

/**
 * Realm-based implementation of SwapRepository.
 *
 * Since `realm` is a peer dependency and not installed in this package,
 * the Realm instance is typed as `any`. Consumers must open Realm with
 * the schemas from `./schemas.ts` and pass the instance to the constructor.
 *
 * Realm handles schema creation on open, so `ensureInit()` is a no-op.
 * The consumer owns the Realm lifecycle — `[Symbol.asyncDispose]` is a no-op.
 */
export class RealmSwapRepository implements SwapRepository {
    readonly version = 1 as const;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(private readonly realm: any) {}

    // ── Lifecycle ──────────────────────────────────────────────────────

    private async ensureInit(): Promise<void> {
        // Realm handles schema on open — nothing to initialise.
    }

    async [Symbol.asyncDispose](): Promise<void> {
        // no-op — consumer owns the Realm lifecycle
    }

    // ── Swap operations ────────────────────────────────────────────────

    async saveSwap<T extends PendingSwap>(swap: T): Promise<void> {
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
                "modified"
            );
        });
    }

    async deleteSwap(id: string): Promise<void> {
        await this.ensureInit();
        this.realm.write(() => {
            const toDelete = this.realm
                .objects("BoltzSwap")
                .filtered("id == $0", id);
            if (toDelete.length > 0) {
                this.realm.delete(toDelete);
            }
        });
    }

    async getAllSwaps<T extends PendingSwap>(
        filter?: GetSwapsFilter
    ): Promise<T[]> {
        await this.ensureInit();

        // Early return for empty array filters (no possible matches)
        if (
            (Array.isArray(filter?.id) && filter!.id.length === 0) ||
            (Array.isArray(filter?.status) && filter!.status.length === 0) ||
            (Array.isArray(filter?.type) && filter!.type.length === 0)
        ) {
            return [];
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let results: any = this.realm.objects("BoltzSwap");

        if (filter) {
            const filterParts: string[] = [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const filterArgs: any[] = [];
            let argIndex = 0;

            argIndex = this.addFilterCondition(
                filterParts,
                filterArgs,
                "id",
                filter.id,
                argIndex
            );
            argIndex = this.addFilterCondition(
                filterParts,
                filterArgs,
                "status",
                filter.status,
                argIndex
            );
            this.addFilterCondition(
                filterParts,
                filterArgs,
                "type",
                filter.type,
                argIndex
            );

            if (filterParts.length > 0) {
                const query = filterParts.join(" AND ");
                results = results.filtered(query, ...filterArgs);
            }
        }

        if (filter?.orderBy === "createdAt") {
            const reverse = filter.orderDirection === "desc";
            results = results.sorted("createdAt", reverse);
        }

        return [...results].map(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (obj: any) => JSON.parse(obj.data) as T
        );
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args: any[],
        column: string,
        value: string | string[] | undefined,
        argIndex: number
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
