/** The API entry point an error surfaced through, not where it originated. */
export type Stage =
    | "decode"
    | "compile"
    | "bind"
    | "build"
    | "instantiate"
    | "derive"
    | "spend"
    | "match";

/** Sentinel categories an error chain can carry; several may be present at once. */
export type Kind =
    | "unsupported_version"
    | "invalid_artifact"
    | "invalid_template"
    | "invalid_variables"
    | "unsupported"
    | "unaffordable"
    | "ineligible"
    | "no_match"
    | "unsupported_artifact_version";

export type Code = Exclude<Kind, "unsupported_artifact_version"> | "internal";

// Fixed order, not the deepest cause: a chain wrapping both unaffordable and ineligible reports
// unaffordable. unsupported_artifact_version is absent on purpose and falls through to internal.
const PRECEDENCE: readonly Exclude<Code, "internal">[] = [
    "unsupported_version",
    "invalid_artifact",
    "invalid_template",
    "invalid_variables",
    "unsupported",
    "unaffordable",
    "ineligible",
    "no_match",
];

export class Failure extends Error {
    constructor(
        readonly kinds: readonly Kind[],
        message: string,
        /** JSON Pointer of the innermost field a decoder could name. */
        public path?: string,
    ) {
        super(message);
    }
}

/** A failure of `kind`; with `cause`, the cause's kinds and path stay reachable (Go's `%w: %w`). */
export function fail(kind: Kind, message: string, cause?: unknown): Failure {
    if (!(cause instanceof Failure)) return new Failure([kind], message);
    return new Failure([kind, ...cause.kinds], `${message}: ${cause.message}`, cause.path);
}

export function isKind(err: unknown, kind: Kind): boolean {
    return err instanceof Failure && err.kinds.includes(kind);
}

export class TemplateError extends Error {
    constructor(
        readonly stage: Stage,
        readonly code: Code,
        readonly path: string,
        cause: unknown,
    ) {
        super(`${stage}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
}

export function wrap(stage: Stage, err: unknown): TemplateError {
    if (err instanceof TemplateError) return wrap(stage, err.cause);
    const code = PRECEDENCE.find((c) => isKind(err, c)) ?? "internal";
    return new TemplateError(stage, code, err instanceof Failure ? (err.path ?? "") : "", err);
}
