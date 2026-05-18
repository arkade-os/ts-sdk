import { RealmLike } from "../../src/repositories/realm/types";

// In-memory RealmLike for tests. Stores shallow copies as row objects and
// returns those same references from objects()/filtered(), so delete() can
// match by identity. Supports `col == $n` predicates joined by AND / OR.

const PK_FIELD: Record<string, string> = {
    ArkVirtualTx: "txid",
    ArkIntent: "intentTxId",
    ArkVtxoBranch: "pk",
};
const pkOf = (name: string, o: Record<string, unknown>): string =>
    String(o[PK_FIELD[name] ?? "pk"]);

type Row = Record<string, unknown>;

function withFiltered(rows: Row[]): Row[] {
    const arr = rows as Row[] & {
        filtered: (q: string, ...a: unknown[]) => Row[];
    };
    arr.filtered = (q: string, ...a: unknown[]) => {
        const matched = arr.filter((row) =>
            q.split(/\s+AND\s+/i).every((clause) =>
                clause
                    .replace(/[()]/g, "")
                    .split(/\s+OR\s+/i)
                    .some((c) => {
                        const m = c.trim().match(/(\w+)\s*==\s*\$(\d+)/);
                        if (!m) return true;
                        return row[m[1]] === a[Number(m[2])];
                    })
            )
        );
        return withFiltered(matched);
    };
    return arr;
}

export function createMockRealm(): RealmLike {
    const colls = new Map<string, Map<string, Row>>();
    const coll = (n: string): Map<string, Row> => {
        let c = colls.get(n);
        if (!c) {
            c = new Map();
            colls.set(n, c);
        }
        return c;
    };

    return {
        write(fn: () => void): void {
            fn();
        },
        objects<T = Row>(name: string): T[] {
            return withFiltered([...coll(name).values()]) as unknown as T[];
        },
        create(
            name: string,
            values: Record<string, unknown>,
            _mode?: string
        ): void {
            void _mode;
            coll(name).set(pkOf(name, values), { ...values });
        },
        delete(objs: unknown): void {
            const arr = Array.isArray(objs)
                ? (objs as Row[])
                : [...(objs as Iterable<Row>)];
            for (const target of arr)
                for (const c of colls.values())
                    for (const [k, row] of c) if (row === target) c.delete(k);
        },
    } as unknown as RealmLike;
}
