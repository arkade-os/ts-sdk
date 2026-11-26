import { BigNum } from "./bignum";
import {
    ErrUnsupportedByPort,
    ExecutionError,
    KIND,
    plainError,
    ScriptError,
    scriptError,
} from "./errors";
import type { ArkPrevOutFetcher } from "./fetcher";
import {
    type ComputeBudget,
    type ComputeLimits,
    DefaultComputeLimits,
    maxCombinedStackByteSize,
    MaxScriptElementSize,
    MaxScriptSize,
    MaxStackSize,
} from "./limits";
import { checkMinimalDataPush } from "./minimalpush";
import { type Opcode, opcodeArray } from "./opcodes";
import { OpCondTrue, Stack } from "./stack";
import { isExtensionScript, isPushOnlyScript, ScriptTokenizer } from "./tokenizer";
import { serializeSizeStripped, type TxSigHashes, tapLeafHash, txid, type VmTx } from "./tx";
import type { AssetPacketLike, EmulatorPacketLike, ExtensionCodec } from "./types";

export const blankCodeSepValue = 0xffffffff;

export interface TapLeaf {
    readonly leafVersion: number;
    readonly script: Uint8Array;
}

/** Go's taprootExecutionCtx minus the annex, which non-test Go code never sets (spend_type is 2). */
export interface TaprootExecutionCtx {
    codeSepPos: number;
    readonly tapLeaf: TapLeaf;
    readonly tapLeafHash: Uint8Array;
    readonly opCounts: Map<number, number>;
}

export const newTaprootExecutionCtx = (tapLeaf: TapLeaf): TaprootExecutionCtx => ({
    codeSepPos: blankCodeSepValue,
    tapLeaf,
    tapLeafHash: tapLeafHash(tapLeaf.leafVersion, tapLeaf.script),
    opCounts: new Map(),
});

export interface EngineOptions {
    /** The scriptPubKey slot: the arkade script. */
    readonly script: Uint8Array;
    readonly tx: VmTx;
    readonly inputIndex: number;
    readonly inputAmount: bigint;
    readonly fetcher: ArkPrevOutFetcher;
    /** txscript.TxSigHashes; Go passes nil in expression mode. */
    readonly sigHashes?: TxSigHashes;
    /** Unix seconds for OP_CHECKTIME. Go reads time.Now() once in NewEngine and has no setter. */
    readonly now?: bigint;
    // the rest mirror WithExpiry, WithIntentMessage, SetAssetPacket and SetEmulatorPacket
    readonly expiry?: bigint;
    readonly intentMessage?: string;
    readonly assetPacket?: AssetPacketLike;
    readonly emulatorPacket?: EmulatorPacketLike;
    readonly codec?: ExtensionCodec;
}

// Go's answers for a tx that carries no extension output.
const NO_EXTENSION: ExtensionCodec = {
    readExtension: () => null,
    findEmulatorPacket: () => null,
    maskExtensionOutput: () => null,
};

const isConditional = (v: number): boolean => v === 0x63 || v === 0x64 || v === 0x67 || v === 0x68;

const stackBytes = (s: Stack): number => s.stk.reduce((n, item) => n + item.length, 0);

/** NewEngine plus the engine. Fields are public because the ops/*.ts handlers drive them. */
export class Engine {
    readonly tx: VmTx;
    readonly txIdx: number;
    readonly inputAmount: bigint;
    readonly prevOutFetcher: ArkPrevOutFetcher;
    readonly sigHashes: TxSigHashes | undefined;
    readonly scripts: readonly Uint8Array[];
    readonly dstack = new Stack();
    readonly astack = new Stack();
    condStack: number[] = [];
    scriptIdx = 0;
    tokenizer: ScriptTokenizer;
    currentTime: BigNum;
    expiry: bigint | undefined;
    intentMessage: Uint8Array | undefined;
    assetPacket: AssetPacketLike | undefined;
    emulatorPacket: EmulatorPacketLike | undefined;
    codec: ExtensionCodec | undefined;
    // metering and OP_CHECKSIG & co. are both gated on this being set
    taprootCtx: TaprootExecutionCtx | undefined;
    limits: ComputeLimits = DefaultComputeLimits();
    budget: ComputeBudget | undefined;
    private txHash: Uint8Array | undefined;
    private txSize: number | undefined;

    constructor(opts: EngineOptions) {
        const { tx, inputIndex } = opts;
        if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= tx.inputs.length) {
            throw scriptError(
                "ErrInvalidIndex",
                `transaction input index ${inputIndex} is negative or >= ${tx.inputs.length}`,
            );
        }
        const scriptSig = tx.inputs[inputIndex].scriptSig;
        if (scriptSig.length === 0 && opts.script.length === 0) {
            throw scriptError("ErrEvalFalse", "false stack entry at end of script execution");
        }
        this.currentTime = BigNum.fromInt64(opts.now ?? BigInt(Math.floor(Date.now() / 1000)));
        if (!isPushOnlyScript(scriptSig)) {
            throw scriptError("ErrNotPushOnly", "signature script is not push only");
        }
        this.scripts = [scriptSig, opts.script];
        for (const script of this.scripts) {
            if (script.length > MaxScriptSize) {
                throw scriptError(
                    "ErrScriptTooBig",
                    `script size ${script.length} is larger than max allowed size ${MaxScriptSize}`,
                );
            }
            const t = new ScriptTokenizer(script);
            while (t.next());
            if (t.err) throw t.err;
        }
        if (scriptSig.length === 0) this.scriptIdx = 1;
        this.dstack.verifyMinimalData = true;
        this.astack.verifyMinimalData = true;
        this.tokenizer = new ScriptTokenizer(this.scripts[this.scriptIdx]);
        this.tx = tx.version < 0 ? { ...tx, version: tx.version >>> 0 } : tx;
        this.txIdx = inputIndex;
        this.inputAmount = opts.inputAmount;
        this.prevOutFetcher = opts.fetcher;
        this.sigHashes = opts.sigHashes;
        if (opts.expiry !== undefined) this.expiry = int64("expiry", opts.expiry);
        if (opts.intentMessage !== undefined) {
            this.intentMessage = new TextEncoder().encode(opts.intentMessage);
        }
        this.assetPacket = opts.assetPacket;
        this.emulatorPacket = opts.emulatorPacket;
        this.codec = opts.codec;
    }

    isBranchExecuting(): boolean {
        return (
            this.condStack.length === 0 || this.condStack[this.condStack.length - 1] === OpCondTrue
        );
    }

    /** Each gate yields a different code, so the order is engine.go:294-326 exactly. */
    executeOpcode(op: Opcode, data: Uint8Array): void {
        // OP_VERIF / OP_VERNOTIF fail even in a dead branch
        if (op.value === 0x65 || op.value === 0x66) {
            throw scriptError("ErrReservedOpcode", `attempt to execute reserved opcode ${op.name}`);
        }
        // the element cap also runs in a dead branch
        if (data.length > MaxScriptElementSize) {
            throw scriptError(
                "ErrElementTooBig",
                `element size ${data.length} exceeds max allowed size ${MaxScriptElementSize}`,
            );
        }
        const executing = this.isBranchExecuting();
        if (!executing && !isConditional(op.value)) return;
        if (this.dstack.verifyMinimalData && executing && op.value <= 0x4e) {
            checkMinimalDataPush(op, data);
        }
        this.chargeOpcode(op.value);
        op.handler(op, data, this);
    }

    chargeOpcode(op: number): void {
        const ctx = this.taprootCtx;
        if (!ctx) return;
        const limit = this.limits.get(op);
        if (limit !== undefined) {
            const count = (ctx.opCounts.get(op) ?? 0) + 1;
            ctx.opCounts.set(op, count);
            if (count > limit) {
                throw scriptError(
                    "ErrScriptTooBig",
                    `opcode ${opcodeArray[op].name} exceeded execution limit of ${limit}`,
                );
            }
        }
        this.budget?.charge(op);
    }

    checkErrorCondition(finalScript: boolean): void {
        if (this.scriptIdx < this.scripts.length) {
            throw scriptError("ErrScriptUnfinished", "error check when script unfinished");
        }
        const depth = this.dstack.depth();
        if (finalScript && depth !== 1) {
            throw scriptError(
                "ErrCleanStack",
                `stack must contain exactly one item (contains ${depth})`,
            );
        }
        if (depth < 1) throw scriptError("ErrEmptyStack", "stack empty at end of script execution");
        if (!this.dstack.popBool()) {
            throw scriptError("ErrEvalFalse", "false stack entry at end of script execution");
        }
    }

    /** Returns true once the last opcode of the last script has executed. */
    step(): boolean {
        if (this.scriptIdx >= this.scripts.length) {
            throw scriptError(
                "ErrInvalidProgramCounter",
                `script index ${this.scriptIdx} beyond total scripts ${this.scripts.length}`,
            );
        }
        if (!this.tokenizer.next()) {
            throw (
                this.tokenizer.err ??
                scriptError(
                    "ErrInvalidProgramCounter",
                    `attempt to step beyond script index ${this.scriptIdx}`,
                )
            );
        }
        this.executeOpcode(this.tokenizer.op as Opcode, this.tokenizer.data);

        // both limits count the data and alt stacks together, and only after the step
        const combined = this.dstack.depth() + this.astack.depth();
        if (combined > MaxStackSize) {
            throw scriptError(
                "ErrStackOverflow",
                `combined stack size ${combined} > max allowed ${MaxStackSize}`,
            );
        }
        const bytes = stackBytes(this.dstack) + stackBytes(this.astack);
        if (bytes > maxCombinedStackByteSize) {
            throw scriptError(
                "ErrStackOverflow",
                `combined stack size ${bytes} bytes > max allowed ${maxCombinedStackByteSize} bytes`,
            );
        }

        if (!this.tokenizer.done()) return false;
        if (this.condStack.length !== 0) {
            throw scriptError(
                "ErrUnbalancedConditional",
                "end of script reached in conditional execution",
            );
        }
        this.astack.stk = [];
        this.scriptIdx++;
        if (this.scriptIdx < this.scripts.length && this.scripts[this.scriptIdx].length === 0) {
            this.scriptIdx++;
        }
        if (this.scriptIdx >= this.scripts.length) return true;
        this.tokenizer = new ScriptTokenizer(this.scripts[this.scriptIdx]);
        return false;
    }

    /** Runs to completion, then enforces the clean stack and a truthy final element. */
    execute(): void {
        let lastScriptIdx = -1;
        let lastOffset = -1;
        for (let done = false; !done; ) {
            const scriptIdx = this.scriptIdx;
            const offset = this.tokenizer.byteIndex();
            try {
                done = this.step();
            } catch (err) {
                throw this.locateError(scriptIdx, offset, err);
            }
            lastScriptIdx = scriptIdx;
            lastOffset = offset;
        }
        try {
            this.checkErrorCondition(true);
        } catch (err) {
            const final =
                err instanceof ScriptError
                    ? new ScriptError(
                          err.code,
                          `final script validation failed: ${err.message}`,
                          err.kind,
                      )
                    : err;
            throw this.locateError(lastScriptIdx, lastOffset, final);
        }
    }

    private locateError(scriptIdx: number, offset: number, err: unknown): unknown {
        const script = this.scripts[scriptIdx];
        if (!(err instanceof ScriptError) || !script || offset < 0 || offset >= script.length) {
            return err;
        }
        return new ExecutionError(scriptIdx, offset, opcodeArray[script[offset]].name, err);
    }

    getStack(): Uint8Array[] {
        return this.dstack.stk.map((item) => Uint8Array.from(item));
    }

    /** No element-size check, as in Go: witness items over 520 bytes enter the stack. */
    setStack(data: readonly Uint8Array[]): void {
        this.dstack.stk = data.map((item) => Uint8Array.from(item));
    }

    getAltStack(): Uint8Array[] {
        return this.astack.stk.map((item) => Uint8Array.from(item));
    }

    setAltStack(data: readonly Uint8Array[]): void {
        this.astack.stk = data.map((item) => Uint8Array.from(item));
    }

    txID(): Uint8Array {
        this.txHash ??= txid(this.tx);
        return this.txHash.slice();
    }

    // cached like txID(): OP_TXWEIGHT is unmetered and the tx is the requester's
    strippedSize(): number {
        this.txSize ??= serializeSizeStripped(this.tx);
        return this.txSize;
    }

    codecFor(tx: VmTx): ExtensionCodec {
        return codecFor(this.codec, tx);
    }
}

/** Without a codec only a tx carrying no extension output can be read; others are refused. */
export function codecFor(codec: ExtensionCodec | undefined, tx: VmTx): ExtensionCodec {
    if (codec) return codec;
    if (!tx.outputs.some((o) => isExtensionScript(o.script))) return NO_EXTENSION;
    throw new ErrUnsupportedByPort("reading an extension output needs an ExtensionCodec");
}

export const newEngine = (opts: EngineOptions): Engine => new Engine(opts);

export function int64(name: string, v: bigint): bigint {
    if (BigInt.asIntN(64, v) !== v) throw new RangeError(`${name} is not an int64: ${v}`);
    return v;
}

/** draft.go sets only the expiry, and only for a source whose expiry is non-zero. */
export type ExpressionOptions = Pick<
    EngineOptions,
    "script" | "tx" | "inputIndex" | "inputAmount" | "fetcher" | "now" | "expiry" | "codec"
>;

/**
 * Expression mode (executor draft.go:61-102): no taproot context, so no metering, no clean-stack
 * and no truthiness check. Returns the single element the script leaves.
 */
export function evalExpression(opts: ExpressionOptions): Uint8Array {
    const { script, tx, inputIndex, inputAmount, fetcher, now, expiry, codec } = opts;
    const vm = new Engine({ script, tx, inputIndex, inputAmount, fetcher, now, expiry, codec });
    for (let done = false; !done; ) done = vm.step();
    const stack = vm.getStack();
    if (stack.length !== 1) {
        throw plainError(
            KIND.expressionStackDepth,
            `expression: stack holds ${stack.length} elements`,
        );
    }
    return stack[0];
}
