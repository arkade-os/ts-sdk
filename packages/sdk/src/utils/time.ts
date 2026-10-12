/** Validate an optional millisecond duration; zero retains its caller-defined meaning. */
export function assertNonNegativeMs(name: string, ms: number | undefined): void {
    if (ms !== undefined && (!Number.isSafeInteger(ms) || ms < 0)) {
        throw new Error(`${name} must be a non-negative safe integer`);
    }
}

/** Largest delay portable across browser and Node timers (signed 32-bit milliseconds). */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** Validate a timer delay without changing whether zero disables or immediately fires it. */
export function assertTimerMs(name: string, ms: number | undefined): void {
    assertNonNegativeMs(name, ms);
    if (ms !== undefined && ms > MAX_TIMER_MS) {
        throw new Error(`${name} must not exceed ${MAX_TIMER_MS} milliseconds`);
    }
}
