import type { PaymentHandle, PaymentStatus, RouteResult } from "./types";

type Update = { status: PaymentStatus; result?: RouteResult; error?: unknown };

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
    // Surface a terminal failure on the observable stream: rails only emit() on
    // success, so without this a subscribe-only consumer never learns a payment
    // failed. The guard leaves an already-settled result intact if the run rejects
    // afterwards. This also handles the unhandled-rejection warning for
    // fire-and-forget callers; awaiters of settled() still receive the original
    // rejection (settled() returns `done`, a separate branch off the same promise).
    done.catch((error) => {
        if (status !== "settled") emit({ status: "failed", error });
    });
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
