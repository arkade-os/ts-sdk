import type { ArkProvider, Identity, IndexerProvider, IWallet } from "@arkade-os/sdk";
import type { AsyncStorageTaskQueue } from "@arkade-os/sdk/worker/expo";
import type { BoltzSwapProvider } from "../boltz-swap-provider";
import type { SwapRepository } from "../repositories/swap-repository";
import type { ArkadeSwapsConfig } from "../types";
import type { Network } from "../types";

/**
 * Dependencies injected into every swap processor at runtime.
 *
 * Unlike the wallet's `TaskDependencies`, these are swap-specific:
 * we need the Boltz provider, swap repository, and identity to
 * poll status and attempt claim/refund.
 */
export interface SwapTaskDependencies {
    swapRepository: SwapRepository;
    swapProvider: BoltzSwapProvider;
    arkProvider: ArkProvider;
    indexerProvider: IndexerProvider;
    identity: Identity;
    wallet: IWallet;
}

/**
 * Minimal config persisted to AsyncStorage for background rehydration.
 *
 * The background handler runs in a fresh JS context without access to
 * the foreground's in-memory state, so we persist just enough to
 * reconstruct providers and identity.
 */
export interface PersistedSwapBackgroundConfig {
    boltzApiUrl: string;
    arkServerUrl: string;
    network: Network;
}

/**
 * Background scheduling configuration for {@link ExpoArkadeSwaps}.
 *
 * OS-level task registration is **not** part of this config — call
 * `registerExpoSwapBackgroundTask` from `@arkade-os/boltz-swap/expo/background`
 * explicitly. Splitting that step out keeps `/expo` free of the
 * `expo-task-manager` / `expo-background-task` dependencies.
 */
export interface ExpoSwapBackgroundConfig {
    /** Persistence layer for foreground ↔ background handoff. */
    taskQueue: AsyncStorageTaskQueue;
    /** If set, acknowledges background results at this interval (ms) while the app is in the foreground. */
    foregroundIntervalMs?: number;
}

/**
 * Options for {@link defineExpoSwapBackgroundTask}.
 */
export interface DefineSwapBackgroundTaskOptions {
    /** AsyncStorage-backed queue (must match the one passed to ExpoArkadeSwaps.setup). */
    taskQueue: AsyncStorageTaskQueue;
    /** Swap repository (fresh instance is fine — connects to the same DB). */
    swapRepository: SwapRepository;
    /** Factory to reconstruct Identity from secure storage in the background. */
    identityFactory: () => Promise<Identity>;
}

/**
 * Configuration for {@link ExpoArkadeSwaps.setup}.
 */
export interface ExpoArkadeSwapsConfig extends ArkadeSwapsConfig {
    /**
     * Ark server base URL (e.g. "https://ark.example.com").
     *
     * Recommended for type-safe background rehydration. If omitted,
     * ExpoArkadeSwaps will attempt to derive it from the ArkProvider.
     */
    arkServerUrl?: string;
    background: ExpoSwapBackgroundConfig;
}

/** @deprecated Use ExpoArkadeSwapsConfig instead */
export type ExpoArkadeLightningConfig = ExpoArkadeSwapsConfig;
