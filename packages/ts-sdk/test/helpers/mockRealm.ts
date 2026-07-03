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

// Tracks whether a row Proxy has been deleted. Real Realm invalidates deleted
// objects: reading any property afterwards throws. The mock reproduces that so
// the conformance suite catches code that reads fields off already-deleted rows
// (a React Native-only failure mode invisible with a plain-object mock).
const invalidated = new WeakSet<Row>();

function makeRow(data: Row): Row {
    const proxy = new Proxy(data, {
        get(target, prop, receiver) {
            if (invalidated.has(proxy)) {
                throw new Error("Accessing object which has been invalidated or deleted");
            }
            return Reflect.get(target, prop, receiver);
        },
    });
    return proxy;
}

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
                        const m = c.trim().match(/^(\w+)\s*==\s*\$(\d+)$/);
                        // Fail loudly rather than matching everything: an
                        // unrecognized predicate shape means the mock can't
                        // faithfully emulate the query, and a silent match would
                        // hide real query/schema mismatches from the tests.
                        if (!m) {
                            throw new Error(
                                `mockRealm: unsupported filtered() clause: "${c.trim()}"`,
                            );
                        }
                        return row[m[1]] === a[Number(m[2])];
                    }),
            ),
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
        create(name: string, values: Record<string, unknown>, _mode?: string): void {
            void _mode;
            coll(name).set(pkOf(name, values), makeRow({ ...values }));
        },
        delete(objs: unknown): void {
            const arr = Array.isArray(objs) ? (objs as Row[]) : [...(objs as Iterable<Row>)];
            for (const target of arr)
                for (const c of colls.values())
                    for (const [k, row] of c)
                        if (row === target) {
                            c.delete(k);
                            invalidated.add(row);
                        }
        },
    } as unknown as RealmLike;
}
