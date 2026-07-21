/**
 * Default indexer pagination size for batched VTXO queries (`getVtxos`).
 *
 * Shared by {@link ContractManager}'s bulk history sync, the discovery
 * handlers' batched `detectUsedScripts` probe, and `wallet/vtxo.ts`'s chunked
 * reader so they can't drift. It lives in its own leaf module (importing
 * nothing) so every layer can use it without a `handlers → contractManager`
 * import cycle — contractManager imports the handler registry, so the handlers
 * must not import back from contractManager.
 *
 * Large enough that a single wallet index's candidate scripts resolve in one
 * page in the common case.
 */
export const DEFAULT_PAGE_SIZE = 500;

/**
 * Maximum scripts per `getVtxos` query string.
 *
 * Scripts cost ~77 bytes each in the URL, so an unbounded wallet-derived list
 * `414`s: a few hundred contracts is ~28 KB. 32 keeps a request at ~2.6 KB —
 * well inside any plausible limit, since `arkd`'s real ceiling is unpublished
 * and 16 is the largest batch observed working in the wild.
 */
export const SCRIPT_QUERY_CHUNK_SIZE = 32;
