import type { OnchainProvider } from "../../providers/onchain";
import { exitObserverFor } from "../exitObserver";
import type { Wallet } from "../wallet";
import { Executor, type ExecutorOptions } from "./executor";
import type { ExitPackage } from "./types";

/**
 * An {@link Executor} with the wallet's exit observer already wired, so the repository re-reads
 * each outpoint as its branch confirms and again as its sweep does, moving the value into the
 * `unrolled` balance bucket without waiting for a delta sync — which could not see the change
 * anyway, filtering as it does on creation time. What the re-read learns depends on the indexer
 * having caught up; see `exitObserverFor`.
 *
 * The bare `Executor` stays keyless and provider-only; this is the wallet-side convenience that
 * makes the default path correct, because an opt-in parameter only reaches callers who know to pass
 * it. An explicit `opts.onExitObserved` still wins.
 */
export async function execute(
    wallet: Wallet,
    pkg: ExitPackage,
    opts?: ExecutorOptions & { provider?: OnchainProvider },
): Promise<Executor> {
    const manager = await wallet.getContractManager();
    return new Executor(pkg, opts?.provider ?? wallet.onchainProvider, {
        ...opts,
        onExitObserved: opts?.onExitObserved ?? exitObserverFor(manager),
    });
}
