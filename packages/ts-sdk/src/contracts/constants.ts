/**
 * Default indexer pagination size for batched VTXO queries (`getVtxos`).
 *
 * Shared by {@link ContractManager}'s bulk history sync and the discovery
 * handlers' batched `detectUsedScripts` probe so the two can't drift. It lives
 * in its own leaf module (importing nothing) so both the manager and the
 * handler layer can use it without a `handlers → contractManager` import cycle —
 * contractManager imports the handler registry, so the handlers must not import
 * back from contractManager.
 *
 * Large enough that a single wallet index's candidate scripts resolve in one
 * page in the common case.
 */
export const DEFAULT_PAGE_SIZE = 500;
