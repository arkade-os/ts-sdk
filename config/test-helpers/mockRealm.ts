import type { RealmLike } from "@arkade-os/sdk/repositories/realm";

// In-memory RealmLike for tests. Stores shallow copies as row objects and
// returns those same references from objects()/filtered(), so delete() can
// match by identity. Supports `col == $n` and `col == null` predicates joined
// by AND / OR.

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

function compareValues(left: unknown, right: unknown): number {
    if (typeof left === "number" && typeof right === "number") return left - right;
    const a = Array.from(String(left), (char) => char.codePointAt(0)!);
    const b = Array.from(String(right), (char) => char.codePointAt(0)!);
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
}

function splitAtTopLevel(expression: string, operator: "AND" | "OR"): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < expression.length; i++) {
        if (expression[i] === "(") depth++;
        else if (expression[i] === ")") depth--;
        else if (depth === 0 && expression.slice(i).toUpperCase().startsWith(` ${operator} `)) {
            parts.push(expression.slice(start, i).trim());
            i += operator.length + 1;
            start = i + 1;
        }
    }
    parts.push(expression.slice(start).trim());
    return parts;
}

function matches(row: Row, expression: string, args: unknown[]): boolean {
    let clause = expression.trim();
    while (clause.startsWith("(") && clause.endsWith(")")) {
        let depth = 0;
        let wrapped = true;
        for (let i = 0; i < clause.length - 1; i++) {
            if (clause[i] === "(") depth++;
            else if (clause[i] === ")") depth--;
            if (depth === 0) {
                wrapped = false;
                break;
            }
        }
        if (!wrapped) break;
        clause = clause.slice(1, -1).trim();
    }
    const ors = splitAtTopLevel(clause, "OR");
    if (ors.length > 1) return ors.some((part) => matches(row, part, args));
    const ands = splitAtTopLevel(clause, "AND");
    if (ands.length > 1) return ands.every((part) => matches(row, part, args));
    const m = clause.match(/^(\w+)\s*(==|>=|>)\s*(?:\$(\d+)|(null))$/);
    if (!m) throw new Error(`mockRealm: unsupported filtered() clause: "${clause}"`);
    if (m[4]) return row[m[1]] === null || row[m[1]] === undefined;
    const value = args[Number(m[3])];
    if (m[2] === "==") return row[m[1]] === value;
    const order = compareValues(row[m[1]], value);
    return m[2] === ">" ? order > 0 : order >= 0;
}

function withFiltered(rows: Row[]): Row[] {
    const arr = rows as Row[] & {
        filtered: (q: string, ...a: unknown[]) => Row[];
        sorted: (key: string | readonly (readonly [string, boolean])[], reverse?: boolean) => Row[];
    };
    arr.sorted = (key, reverse = false) =>
        withFiltered(
            [...arr].sort((a, b) => {
                const fields = typeof key === "string" ? [[key, reverse] as const] : key;
                for (const [field, descending] of fields) {
                    const left = a[field];
                    const right = b[field];
                    const order = compareValues(left, right);
                    if (order !== 0) return descending ? -order : order;
                }
                return 0;
            }),
        );
    arr.filtered = (q: string, ...a: unknown[]) =>
        withFiltered(arr.filter((row) => matches(row, q, a)));
    return arr;
}

/**
 * @param primaryKeys schema name → primary-key property. Required and
 * exhaustive: an unlisted schema throws rather than keying every row on
 * `undefined`, which would collapse a whole collection onto one row.
 */
export function createMockRealm(primaryKeys: Record<string, string>): RealmLike {
    const pkOf = (name: string, o: Row): string => {
        const field = primaryKeys[name];
        if (!field) throw new Error(`mockRealm: no primary key configured for schema "${name}"`);
        return String(o[field]);
    };

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
