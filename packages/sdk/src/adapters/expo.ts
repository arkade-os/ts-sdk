// Expo adapter for React Native/Expo environments
export { ExpoArkadeProvider } from "../providers/expoArkade";
export { ExpoIndexerProvider } from "../providers/expoIndexer";
export type { ArkadeProvider } from "../providers/arkade";
export type { IndexerProvider } from "../providers/indexer";

import type { ArkadeProvider } from "../providers/arkade";
import { ExpoArkadeProvider } from "../providers/expoArkade";

/** @deprecated Use {@link ExpoArkadeProvider}. */
export const ExpoArkProvider = ExpoArkadeProvider;
/** @deprecated Use {@link ExpoArkadeProvider}. */
export type ExpoArkProvider = ExpoArkadeProvider;
/** @deprecated Use {@link ArkadeProvider}. */
export type ArkProvider = ArkadeProvider;
