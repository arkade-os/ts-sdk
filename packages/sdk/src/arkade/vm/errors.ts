// The btcd ErrorCode names the fork can emit; the executor surfaces only these strings.
export type ArkadeErrorCode =
    | "ErrCheckSigVerify"
    | "ErrCleanStack"
    | "ErrDiscourageUpgradableNOPs"
    | "ErrDiscourageUpgradeablePubKeyType"
    | "ErrEarlyReturn"
    | "ErrElementTooBig"
    | "ErrEmptyStack"
    | "ErrEqualVerify"
    | "ErrEvalFalse"
    | "ErrInvalidIndex"
    | "ErrInvalidProgramCounter"
    | "ErrInvalidSigHashType"
    | "ErrInvalidStackOperation"
    | "ErrInvalidTaprootSigLen"
    | "ErrMalformedPush"
    | "ErrMinimalData"
    | "ErrMinimalIf"
    | "ErrNegativeLockTime"
    | "ErrNotPushOnly"
    | "ErrNullFail"
    | "ErrNumEqualVerify"
    | "ErrNumberTooBig"
    | "ErrReservedOpcode"
    | "ErrScriptTooBig"
    | "ErrScriptUnfinished"
    | "ErrStackOverflow"
    | "ErrTaprootPubkeyIsEmpty"
    | "ErrTapscriptCheckMultisig"
    | "ErrUnbalancedConditional"
    | "ErrUnsatisfiedLockTime"
    | "ErrVerify";

// Stable `kind`s for failures Go reports as plain errors (no ErrorCode).
export const KIND = {
    divisionByZero: "ErrBigNumDivisionByZero",
    moduloByZero: "ErrBigNumModuloByZero",
    modulusNotPositive: "ErrBigNumModulusNotPositive",
    negativeExponent: "ErrBigNumNegativeExponent",
    modexpOperandTooLarge: "ErrBigNumModexpOperandTooLarge",
    fixedBytes: "ErrFixedBytes",
    noPrevout: "ErrNoPrevout",
    extensionParse: "ErrExtensionParse",
    emulatorPacketParse: "ErrEmulatorPacketParse",
    expressionStackDepth: "ErrExpressionStackDepth",
    sigHash: "ErrSigHash",
    pubKeyXTooBig: "ErrPubKeyXTooBig",
    pubKeyNotOnCurve: "ErrPubKeyNotOnCurve",
    // where Go panics instead of returning an error
    panic: "ErrPanic",
    // txscript codes raised outside the VM, carried as TaprootError's `code`
    taprootMerkleProofInvalid: "ErrTaprootMerkleProofInvalid",
    taprootOutputKeyParityMismatch: "ErrTaprootOutputKeyParityMismatch",
} as const;

/** A script failure: `code` is set for txscript.Error, `kind` for Go's code-less errors. */
export class ScriptError extends Error {
    constructor(
        readonly code: ArkadeErrorCode | undefined,
        message: string,
        readonly kind?: string,
    ) {
        super(message);
        this.name = "ScriptError";
    }
}

export const scriptError = (code: ArkadeErrorCode, message: string): ScriptError =>
    new ScriptError(code, message);

export const plainError = (kind: string, message: string): ScriptError =>
    new ScriptError(undefined, message, kind);

/** Behaviour the port refuses rather than guesses; never a ScriptError, so no handler swallows it. */
export class ErrUnsupportedByPort extends Error {
    readonly kind = "ErrUnsupportedByPort";

    constructor(message: string) {
        super(message);
        this.name = "ErrUnsupportedByPort";
    }
}

/** Locates a failed step: mirrors Go's ExecutionError, wrapping only ScriptErrors. */
export class ExecutionError extends Error {
    constructor(
        readonly scriptIndex: number,
        readonly position: number,
        readonly opcode: string,
        override readonly cause: ScriptError,
    ) {
        super(`script=${scriptIndex} opcode=${opcode} position=${position}: ${cause.message}`, {
            cause,
        });
        this.name = "ExecutionError";
    }

    get code(): ArkadeErrorCode | undefined {
        return this.cause.code;
    }

    get kind(): string | undefined {
        return this.cause.kind;
    }
}

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type Rewrap = (message: string, cause: unknown) => Error;

/** Go's fmt.Errorf("prefix: %w"); the port's own refusals pass through unwrapped. */
export const wrap = (
    prefix: string,
    e: unknown,
    as: Rewrap = (message, cause) => new Error(message, { cause }),
): Error => (e instanceof ErrUnsupportedByPort ? e : as(`${prefix}: ${messageOf(e)}`, e));

export function prefixed<T>(prefix: string, fn: () => T, as?: Rewrap): T {
    try {
        return fn();
    } catch (e) {
        throw wrap(prefix, e, as);
    }
}
