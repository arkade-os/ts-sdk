import type { PaymentHandle, PaymentStatus, RouteResult } from "./types";

type Update = { status: PaymentStatus; result?: RouteResult };

/** Build an observable handle. `run` starts immediately and gets an `emit` to
 *  stream progress; its resolved value is the terminal result. */
export function makeHandle(
    id: string,
    run: (emit: (u: Update) => void) => Promise<RouteResult>,
): PaymentHandle {
    let status: PaymentStatus = "pending";
    let last: Update = { status };
    const subs = new Set<(u: Update) => void>();
    // A throwing subscriber must not break the run cycle, other subscribers, or
    // the subscribe() replay below.
    const notify = (f: (u: Update) => void, u: Update) => {
        try {
            f(u);
        } catch {
            // ignore subscriber errors
        }
    };
    const emit = (u: Update) => {
        status = u.status;
        last = u;
        for (const f of subs) notify(f, u);
    };
    const done = run(emit);
    // Swallow the unhandled-rejection warning for fire-and-forget callers that
    // never await settled(); awaiters still receive the original rejection.
    done.catch(() => {});
    return {
        id,
        get status() {
            return status;
        },
        subscribe(fn) {
            notify(fn, last);
            subs.add(fn);
            return () => subs.delete(fn);
        },
        settled(opts) {
            if (!opts?.timeoutMs) return done;
            let timer: ReturnType<typeof setTimeout>;
            return Promise.race([
                done,
                new Promise<RouteResult>((_, rej) => {
                    timer = setTimeout(() => rej(new Error("settle timeout")), opts.timeoutMs);
                }),
            ]).finally(() => clearTimeout(timer));
        },
    };
}
