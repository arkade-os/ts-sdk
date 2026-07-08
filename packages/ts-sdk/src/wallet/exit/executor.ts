import { OnchainProvider } from "../../providers/onchain";
import { ExitPackage, ExitStep, SweepStep } from "./types";

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

type TxStatus = { confirmed: boolean; blockHeight?: number; blockTime?: number };

/**
 * Keyless, stateless executor for a pre-signed exit package.
 *
 * The blockchain is the only state: every action re-checks tx status first,
 * so the executor can be killed and re-run anywhere at any time. It never
 * parses transaction hex — it only relays it.
 */
export class Executor implements AsyncIterable<ExecutorEvent> {
    private readonly pollIntervalMs: number;

    constructor(
        readonly pkg: ExitPackage,
        readonly provider: OnchainProvider,
        opts?: { pollIntervalMs?: number },
    ) {
        this.pollIntervalMs = opts?.pollIntervalMs ?? 5_000;
    }

    private sleep(): Promise<void> {
        return new Promise((r) => setTimeout(r, this.pollIntervalMs));
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
            await this.sleep();
        }
    }

    async *[Symbol.asyncIterator](): AsyncIterator<ExecutorEvent> {
        const dead = new Set<string>(); // outpoints whose branch failed

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

            const forVtxos = step.kind === "package" ? step.forVtxos : undefined;
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

            const anchorTxid = step.kind === "package" ? step.parentTxid : step.txid;
            const existing = await this.status(anchorTxid);
            if (existing?.confirmed) {
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
                    } else {
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

                const swept = await this.status(step.txid);
                if (swept?.confirmed) {
                    done.add(index);
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
}
