import { estimate } from "./estimate";
import type { ExitOptions } from "./estimate";
import { Executor } from "./executor";
import { prepare } from "./prepare";

export * from "./types";
export { ExitPathError, resolveUnilateralPath } from "./path";
export type { ResolvedExitPath } from "./path";
export type { ExecutorEvent } from "./executor";
export type { ExitOptions } from "./estimate";

/**
 * Pre-signed unilateral exit.
 *
 * `estimate` quotes the cost (tx count, fees, funding required) without
 * touching funds; `prepare` signs every transaction needed to land the
 * VTXOs onchain and broadcasts the fee-funding splitter; `Executor` drives
 * the resulting package to completion with nothing but an
 * Esplora-compatible endpoint — no keys, no Arkade infrastructure.
 */
export const UnilateralExit = {
    estimate,
    prepare,
    Executor,
} as const;

export type { ExitOptions as UnilateralExitOptions };
