import { estimate } from "./estimate";
import type { ExitOptions } from "./estimate";
import { execute } from "./execute";
import { Executor } from "./executor";
import { prepare } from "./prepare";

export * from "./types";
export { ExitPathError, resolveUnilateralPath } from "./path";
export type { ResolvedExitPath } from "./path";
export type { ExecutorEvent, ExecutorOptions, ExitFeeWallet } from "./executor";
export type { ExitOptions } from "./estimate";
export type { ExitCaptureMode } from "./capture";
export type { ExitChainResolver, ExitDataSource } from "./resolver";
export { createExitChainResolver } from "./resolver";

/**
 * Pre-signed unilateral exit.
 *
 * `estimate` quotes the cost (tx count, fees, funding required) without
 * touching funds; `prepare` signs every transaction needed to land the
 * VTXOs onchain and broadcasts the fee-funding splitter; `Executor` drives
 * the resulting package to completion with nothing but an
 * Esplora-compatible endpoint — no keys, no Arkade infrastructure.
 *
 * `execute` is the wallet-side shorthand for that last step: the same
 * executor, with the exit observer wired so the wallet's own repository
 * learns the exit as it lands.
 */
export const UnilateralExit = {
    estimate,
    prepare,
    execute,
    Executor,
} as const;

export type { ExitOptions as UnilateralExitOptions };
