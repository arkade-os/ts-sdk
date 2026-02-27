import { Contract, ContractState } from "../../contracts/types";
import { ContractFilter, ContractRepository } from "../contractRepository";

/**
 * Realm-based implementation of ContractRepository.
 *
 * Since `realm` is a peer dependency and not installed in this package,
 * the Realm instance is typed as `any`. Consumers must open Realm with
 * the schemas from `./schemas.ts` and pass the instance to the constructor.
 *
 * Realm handles schema creation on open, so `ensureInit()` is a no-op.
 * The consumer owns the Realm lifecycle — `[Symbol.asyncDispose]` is a no-op.
 */
export class RealmContractRepository implements ContractRepository {
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

    // ── Clear ──────────────────────────────────────────────────────────

    async clear(): Promise<void> {
        await this.ensureInit();
        this.realm.write(() => {
            this.realm.delete(this.realm.objects("ArkContract"));
        });
    }

    // ── Contract management ────────────────────────────────────────────

    async getContracts(filter?: ContractFilter): Promise<Contract[]> {
        await this.ensureInit();

        let results = this.realm.objects("ArkContract");

        if (filter) {
            const filterParts: string[] = [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const filterArgs: any[] = [];

            let argIndex = 0;
            argIndex = this.addFilterCondition(
                filterParts,
                filterArgs,
                "script",
                filter.script,
                argIndex
            );
            argIndex = this.addFilterCondition(
                filterParts,
                filterArgs,
                "state",
                filter.state,
                argIndex
            );
            argIndex = this.addFilterCondition(
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

        return [...results].map(contractObjectToDomain);
    }

    async saveContract(contract: Contract): Promise<void> {
        await this.ensureInit();
        this.realm.write(() => {
            this.realm.create(
                "ArkContract",
                {
                    script: contract.script,
                    address: contract.address,
                    type: contract.type,
                    state: contract.state,
                    paramsJson: JSON.stringify(contract.params),
                    createdAt: contract.createdAt,
                    expiresAt: contract.expiresAt ?? null,
                    label: contract.label ?? null,
                    metadataJson: contract.metadata
                        ? JSON.stringify(contract.metadata)
                        : null,
                },
                "modified"
            );
        });
    }

    async deleteContract(script: string): Promise<void> {
        await this.ensureInit();
        this.realm.write(() => {
            const toDelete = this.realm
                .objects("ArkContract")
                .filtered("script == $0", script);
            this.realm.delete(toDelete);
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
            const conditions = value.map((_, i) => {
                return `${column} == $${argIndex + i}`;
            });
            parts.push(`(${conditions.join(" OR ")})`);
            args.push(...value);
            return argIndex + value.length;
        } else {
            parts.push(`${column} == $${argIndex}`);
            args.push(value);
            return argIndex + 1;
        }
    }
}

// ── Realm object → Domain converter ──────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function contractObjectToDomain(obj: any): Contract {
    const contract: Contract = {
        script: obj.script,
        address: obj.address,
        type: obj.type,
        state: obj.state as ContractState,
        params: JSON.parse(obj.paramsJson),
        createdAt: obj.createdAt,
    };

    if (obj.expiresAt !== null && obj.expiresAt !== undefined) {
        contract.expiresAt = obj.expiresAt;
    }
    if (obj.label !== null && obj.label !== undefined) {
        contract.label = obj.label;
    }
    if (obj.metadataJson !== null && obj.metadataJson !== undefined) {
        contract.metadata = JSON.parse(obj.metadataJson);
    }

    return contract;
}
