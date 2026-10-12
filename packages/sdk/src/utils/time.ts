/** Validate an optional millisecond duration; zero retains its caller-defined meaning. */
export function assertNonNegativeMs(name: string, ms: number | undefined): void {
    if (ms !== undefined && (!Number.isSafeInteger(ms) || ms < 0)) {
        throw new Error(`${name} must be a non-negative safe integer`);
    }
}
