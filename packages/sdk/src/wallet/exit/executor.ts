import { OnchainProvider } from "../../providers/onchain";
import { notifyExitObserved, type OnExitObserved } from "../exitObserver";
import { ExitPackage, ExitStep, SweepStep } from "./types";

/**
 * Resolve the value to throw for an aborted signal.
 *
 * `signal.reason` is forwarded verbatim, matching the platform: both
 * `AbortSignal.prototype.throwIfAborted` and `fetch` throw a custom reason
 * as-is — including non-`Error` values — so a consumer that calls
 * `abort(new MyError())` catches `MyError` rather than something wrapping it.
 * With a no-argument `abort()` a spec-compliant engine supplies a
 * `DOMException` named `"AbortError"`.
 *
 * The fallback exists because `throwIfAborted` is not reliably present on
 * Hermes / React Native, and this SDK ships Expo providers; there `reason` may
 * be `undefined`, so an `Error` carrying the same `name` is constructed.
 */
function abortErrorFor(signal: AbortSignal): unknown {
    if (signal.reason !== undefined) return signal.reason;
    const e = new Error("The operation was aborted");
    e.name = "AbortError";
    return e;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortErrorFor(signal);
}

export type ExecutorEvent = {
    stepIndex: number;
    kind: ExitStep["kind"];
    status: "skipped" | "broadcast" | "confirmed" | "waiting_csv" | "failed" | "warning";
    forVtxos?: string[];
    txid?: string;
    reason?: string;
    /** For waiting_csv with a blocks delay: absolute height at maturity. */
    maturesAtHeight?: number;
    /** For waiting_csv with a seconds delay: unix time at maturity. */
    maturesAtTime?: number;
};

/**
 * Fee source for graph-mode `bump` steps. Given a parent tx carrying a P2A
 * anchor, it builds and signs the CPFP fee child from its own funds and
 * returns the 1P1C package hexes (parent unchanged, child signed) — WITHOUT
 * broadcasting; the executor owns broadcast. `OnchainWallet` implements it.
 */
export interface ExitFeeWallet {
    bumpAnchor(parentHex: string, feeRate: number): Promise<[parentHex: string, childHex: string]>;
}

type TxStatus = { confirmed: boolean; blockHeight?: number; blockTime?: number };

export interface ExecutorOptions {
    pollIntervalMs?: number;
    feeWallet?: ExitFeeWallet;
    /** Abort to stop execution.
     *
     * Iteration then rejects with `signal.reason`. Calling `abort()`
     * with no argument yields an error whose `name` is `"AbortError"`;
     * a custom reason is forwarded as-is, matching `fetch` and
     * `AbortSignal.prototype.throwIfAborted`.
     *
     * Already-broadcast transactions are not recalled; the executor is
     * idempotent, so a later run resumes from the chain. */
    signal?: AbortSignal;
    /**
     * Fired per VTXO once every step serving its branch is onchain, and again
     * once its sweep confirms — the two moments an exit becomes observable.
     * Two fires rather than one is what makes an observer reading a lagging
     * indexer recoverable here: by the sweep the exit has been onchain for at
     * least the CSV delay.
     *
     * Best-effort: a rejection never reaches the exit, which is the whole point
     * of a keyless disaster-recovery path. `UnilateralExit.execute` wires it
     * from a wallet; passing it here keeps the bare executor provider-only.
     */
    onExitObserved?: OnExitObserved;
}

/**
 * Keyless, stateless executor for a pre-signed exit package.
 *
 * The blockchain is the only state: every action re-checks tx status first,
 * so the executor can be killed and re-run anywhere at any time. It never
 * parses transaction hex — it only relays it.
 */
export class Executor implements AsyncIterable<ExecutorEvent> {
    private readonly pollIntervalMs: number;

    private readonly feeWallet?: ExitFeeWallet;

    private readonly signal?: AbortSignal;

    private readonly onExitObserved?: OnExitObserved;

    constructor(
        readonly pkg: ExitPackage,
        readonly provider: OnchainProvider,
        opts?: ExecutorOptions,
    ) {
        this.pollIntervalMs = opts?.pollIntervalMs ?? 5_000;
        this.feeWallet = opts?.feeWallet;
        this.signal = opts?.signal;
        this.onExitObserved = opts?.onExitObserved;
    }

    /**
     * Per-VTXO branch progress, which the executor otherwise does not track:
     * `dead` / `done` are per-step, and a VTXO is only onchain once EVERY
     * `package`/`bump` step naming it has confirmed. (`broadcast` — the funding
     * splitter — carries no `forVtxos` and serves no single VTXO.)
     */
    private branchSteps(): Map<string, Set<number>> {
        const byVtxo = new Map<string, Set<number>>();
        this.pkg.steps.forEach((step, i) => {
            if (step.kind !== "package" && step.kind !== "bump") return;
            for (const vtxo of step.forVtxos) {
                let steps = byVtxo.get(vtxo);
                if (!steps) byVtxo.set(vtxo, (steps = new Set()));
                steps.add(i);
            }
        });
        return byVtxo;
    }

    /**
     * Poll delay. Nearly all wall-clock time is spent here, so it must be the
     * thing that reacts to abort — checking only between polls would leave
     * cancellation up to a full interval late and the timer still pending.
     */
    private sleep(): Promise<void> {
        const signal = this.signal;
        if (!signal) return new Promise((r) => setTimeout(r, this.pollIntervalMs));
        return new Promise((resolve, reject) => {
            if (signal.aborted) return reject(abortErrorFor(signal));
            const onAbort = () => {
                clearTimeout(timer);
                reject(abortErrorFor(signal));
            };
            // `{ once: true }` releases the listener on the abort path; the
            // explicit removal covers the timeout path. A long exit sleeps
            // hundreds of times, so an unreleased listener would just trade a
            // polling leak for a listener leak.
            const timer = setTimeout(() => {
                signal.removeEventListener("abort", onAbort);
                resolve();
            }, this.pollIntervalMs);
            signal.addEventListener("abort", onAbort, { once: true });
        });
    }

    private async status(txid: string): Promise<TxStatus | undefined> {
        try {
            return await this.provider.getTxStatus(txid);
        } catch {
            return undefined; // not found => not onchain
        }
    }

    private async waitConfirmed(txid: string): Promise<TxStatus> {
        for (;;) {
            const s = await this.status(txid);
            if (s?.confirmed) return s;
            // Checked here as well as inside sleep() so an abort that lands
            // during the status read doesn't cost one more network poll.
            throwIfAborted(this.signal);
            await this.sleep();
        }
    }

    async *[Symbol.asyncIterator](): AsyncIterator<ExecutorEvent> {
        throwIfAborted(this.signal); // before anything is broadcast
        const dead = new Set<string>(); // outpoints whose branch failed

        const branchSteps = this.branchSteps();
        const onchainSteps = new Set<number>();
        const branchObserved = new Set<string>();
        // Fired BEFORE the matching yield: a consumer that `break`s out of the
        // loop leaves the generator suspended forever, and the repository write
        // must not be the thing that gets stranded.
        const observeBranch = async (stepIndex: number, forVtxos?: string[]) => {
            onchainSteps.add(stepIndex);
            for (const vtxo of forVtxos ?? []) {
                if (branchObserved.has(vtxo)) continue;
                const steps = branchSteps.get(vtxo);
                if (!steps || ![...steps].every((i) => onchainSteps.has(i))) continue;
                branchObserved.add(vtxo);
                await this.observe(vtxo);
            }
        };

        if (this.pkg.validUntil && Date.now() / 1000 > this.pkg.validUntil) {
            yield {
                stepIndex: -1,
                kind: "broadcast",
                status: "warning",
                reason:
                    `package validUntil ${this.pkg.validUntil} has passed; ` +
                    `the operator may have swept — attempting anyway`,
            };
        }

        const sweeps: { index: number; step: SweepStep }[] = [];

        for (let i = 0; i < this.pkg.steps.length; i++) {
            const step = this.pkg.steps[i];
            if (step.kind === "sweep") {
                sweeps.push({ index: i, step });
                continue;
            }

            const forVtxos =
                step.kind === "package" || step.kind === "bump" ? step.forVtxos : undefined;
            if (forVtxos && forVtxos.every((v) => dead.has(v))) {
                yield {
                    stepIndex: i,
                    kind: step.kind,
                    status: "skipped",
                    forVtxos,
                    reason: "branch failed earlier",
                };
                continue;
            }

            const anchorTxid =
                step.kind === "package" || step.kind === "bump" ? step.parentTxid : step.txid;
            const existing = await this.status(anchorTxid);
            if (existing?.confirmed) {
                await observeBranch(i, forVtxos);
                yield {
                    stepIndex: i,
                    kind: step.kind,
                    status: "skipped",
                    txid: anchorTxid,
                    forVtxos,
                };
                continue;
            }
            if (!existing) {
                try {
                    if (step.kind === "package") {
                        await this.provider.broadcastTransaction(step.parentHex, step.childHex);
                    } else if (step.kind === "bump") {
                        // Graph mode: build+sign the CPFP child now from our
                        // own fee wallet, then broadcast the 1P1C package.
                        if (!this.feeWallet) {
                            throw new Error(
                                "graph package requires a fee wallet (opts.feeWallet) to fund CPFP bumps",
                            );
                        }
                        const [parentHex, childHex] = await this.feeWallet.bumpAnchor(
                            step.parentHex,
                            this.pkg.feeRate,
                        );
                        await this.provider.broadcastTransaction(parentHex, childHex);
                    } else {
                        await this.provider.broadcastTransaction(step.hex);
                    }
                    yield {
                        stepIndex: i,
                        kind: step.kind,
                        status: "broadcast",
                        txid: anchorTxid,
                        forVtxos,
                    };
                } catch (e) {
                    const reason = e instanceof Error ? e.message : String(e);
                    if (step.kind === "broadcast") {
                        // splitter failed: every package step depends on it
                        for (const s of this.pkg.steps) {
                            if (s.kind === "package") s.forVtxos.forEach((v) => dead.add(v));
                        }
                    } else if (step.kind === "package" || step.kind === "bump") {
                        step.forVtxos.forEach((v) => dead.add(v));
                    }
                    yield {
                        stepIndex: i,
                        kind: step.kind,
                        status: "failed",
                        txid: anchorTxid,
                        forVtxos,
                        reason,
                    };
                    continue;
                }
            }
            await this.waitConfirmed(anchorTxid);
            await observeBranch(i, forVtxos);
            yield {
                stepIndex: i,
                kind: step.kind,
                status: "confirmed",
                txid: anchorTxid,
                forVtxos,
            };
        }

        // Sweep phase: opportunistic — every remaining sweep is polled in one
        // loop and broadcasts as soon as its own dependency matures.
        for (const { index, step } of sweeps) {
            if (dead.has(step.vtxo)) {
                yield {
                    stepIndex: index,
                    kind: "sweep",
                    status: "failed",
                    txid: step.txid,
                    forVtxos: [step.vtxo],
                    reason: "branch failed earlier",
                };
            }
        }
        const pending = sweeps.filter(({ step }) => !dead.has(step.vtxo));

        const waitingAnnounced = new Set<number>();
        const done = new Set<number>();
        while (done.size < pending.length) {
            for (const { index, step } of pending) {
                if (done.has(index)) continue;
                throwIfAborted(this.signal);

                const swept = await this.status(step.txid);
                if (swept?.confirmed) {
                    done.add(index);
                    // Second observation for this VTXO: its exit output is
                    // spent now, which is a further state change worth
                    // persisting. `refreshOutpoints` is idempotent.
                    await this.observe(step.vtxo);
                    yield {
                        stepIndex: index,
                        kind: "sweep",
                        status: "confirmed",
                        txid: step.txid,
                        forVtxos: [step.vtxo],
                    };
                    continue;
                }
                if (swept) continue; // in mempool — keep polling

                const dep = await this.status(step.dependsOnTxid);
                if (!dep?.confirmed) continue; // leaf not confirmed yet

                const tip = await this.provider.getChainTip();
                const mature =
                    step.delay.type === "blocks"
                        ? tip.height >= (dep.blockHeight ?? 0) + step.delay.value
                        : tip.time >= (dep.blockTime ?? 0) + step.delay.value;

                if (!mature) {
                    if (!waitingAnnounced.has(index)) {
                        waitingAnnounced.add(index);
                        yield {
                            stepIndex: index,
                            kind: "sweep",
                            status: "waiting_csv",
                            txid: step.txid,
                            forVtxos: [step.vtxo],
                            ...(step.delay.type === "blocks"
                                ? { maturesAtHeight: (dep.blockHeight ?? 0) + step.delay.value }
                                : { maturesAtTime: (dep.blockTime ?? 0) + step.delay.value }),
                        };
                    }
                    continue;
                }

                try {
                    await this.provider.broadcastTransaction(step.hex);
                    yield {
                        stepIndex: index,
                        kind: "sweep",
                        status: "broadcast",
                        txid: step.txid,
                        forVtxos: [step.vtxo],
                    };
                } catch (e) {
                    const reason = e instanceof Error ? e.message : String(e);
                    // Maturity is computed from explorer block times, which can
                    // lag consensus (BIP-68 seconds use median-time-past). A
                    // "not final yet" rejection is transient — retry next poll.
                    if (/non-?bip68|non-?final|premature/i.test(reason)) {
                        continue;
                    }
                    done.add(index);
                    yield {
                        stepIndex: index,
                        kind: "sweep",
                        status: "failed",
                        txid: step.txid,
                        forVtxos: [step.vtxo],
                        reason,
                    };
                }
            }
            if (done.size < pending.length) await this.sleep();
        }
    }

    /** `"txid:vout"` -> outpoint, then hand it to the hook. A malformed entry is skipped. */
    private async observe(outpoint: string): Promise<void> {
        if (!this.onExitObserved) return;
        const sep = outpoint.lastIndexOf(":");
        // `Number("")` is 0, so the empty test is what stops `"txid:"` being
        // observed as vout 0 — a different outpoint than the package named.
        const rest = outpoint.slice(sep + 1);
        const vout = Number(rest);
        if (sep <= 0 || rest === "" || !Number.isInteger(vout)) return;
        await notifyExitObserved(this.onExitObserved, { txid: outpoint.slice(0, sep), vout });
    }
}
