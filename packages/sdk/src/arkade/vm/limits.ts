import { scriptError } from "./errors";
import { OpcodeByName, opcodeNames } from "./opnames";

// Go identifiers throughout, as plan §2.2 names them.
export const MaxScriptElementSize = 520;
export const MaxScriptSize = 10_000;
export const MaxStackSize = 1000;
/** Arkade's addition: the element cap alone lets a script hold ~520 KB per input. */
export const maxCombinedStackByteSize = 128 * 1024;
export const requestInputBudget = 4;

/** Opcode value → executions allowed; absent opcodes are unlimited. */
export type ComputeLimits = ReadonlyMap<number, number>;

const DEFAULT_LIMITS = {
    OP_CHECKSIG: 50,
    OP_CHECKSIGVERIFY: 50,
    OP_CHECKSIGADD: 50,
    OP_CHECKSIGFROMSTACK: 50,
    OP_ECADD: 1000,
    OP_ECMUL: 50,
    OP_ECMULSCALARVERIFY: 50,
    OP_TWEAKVERIFY: 50,
    OP_ECPAIRING: 2,
    OP_MODEXP: 64,
    OP_INSPECTINTENTMESSAGE: 16,
};

export const DefaultComputeLimits = (): Map<number, number> =>
    new Map(
        Object.entries(DEFAULT_LIMITS).map(([name, limit]) => [
            OpcodeByName.get(name) as number,
            limit,
        ]),
    );

/** Rejects NaN, fractions and infinities, which would silently disable a cap. */
export function cloneComputeLimits(c: ComputeLimits): Map<number, number> {
    for (const [op, limit] of c) {
        if (!Number.isSafeInteger(limit)) throw new RangeError(`compute limit for ${op}: ${limit}`);
    }
    return new Map(c);
}

// ponytail: saturates at MAX_SAFE_INTEGER where Go uses math.MaxInt; no reachable count differs
const SATURATED = Number.MAX_SAFE_INTEGER;

export const AggregateComputeLimits = (c: ComputeLimits): Map<number, number> =>
    new Map(
        [...cloneComputeLimits(c)].map(([op, limit]) => [
            op,
            limit > Math.floor(SATURATED / requestInputBudget)
                ? SATURATED
                : limit * requestInputBudget,
        ]),
    );

export const DefaultAggregateComputeLimits = (): Map<number, number> =>
    AggregateComputeLimits(DefaultComputeLimits());

/** The request-wide brake shared by every input's engine; per-input limits reset per engine. */
export class ComputeBudget {
    private readonly limits: Map<number, number>;
    private readonly counts = new Map<number, number>();

    constructor(limits: ComputeLimits = DefaultAggregateComputeLimits()) {
        this.limits = cloneComputeLimits(limits);
    }

    charge(op: number): void {
        const limit = this.limits.get(op);
        if (limit === undefined) return;
        const count = (this.counts.get(op) ?? 0) + 1;
        this.counts.set(op, count);
        if (count > limit) {
            throw scriptError(
                "ErrScriptTooBig",
                `opcode ${opcodeNames[op]} exceeded request execution limit of ${limit}`,
            );
        }
    }
}
