# Changelog

All notable changes to `@arkade-os/sdk` are documented here. Format
conventions and section ordering are defined in [`CLAUDE.md`](CLAUDE.md).

This file covers the **0.4.x** line. Pre-0.4 release history (0.3.x and
earlier) lives in `git log` — those entries were not written in this
style and have not been backfilled.

## [Unreleased]

### Bug Fixes

- **`BatchSignableIdentity.signMultiple` was unreachable from
  `Wallet.buildAndSubmitOffchainTx` after the `InputSignerRouter`
  refactor.** The N+1 → 1 popup optimization introduced in #395 was
  silently lost when per-input routing moved into
  `src/wallet/inputSignerRouter.ts`: the send path called
  `_signerRouter.sign` once per PSBT, never folding work across the
  arkTx + N checkpoints. Restored by adding an `InputSignerRouter.classify`
  primitive (single source of truth for routing) with a `canBatch`
  predicate, and re-introducing the batch path in
  `Wallet.buildAndSubmitOffchainTx` and the pending-tx recovery loop.
  The batch path activates when the identity implements `signMultiple`
  *and* every signable input across the bundle resolves to the baseline
  key — i.e. no HD-rotated or other descriptor-bound contracts in scope.
  HD/mixed sends keep using the existing sequential signing path
  unchanged. Static single-key browser wallets (Xverse / UniSat / OKX
  style identities) go back to one confirmation popup per send.

## [0.4.23] - 2026-05-04

### Breaking Changes

- **`Asset.amount` and `AssetDetails.supply` are now `bigint` (was
  `number`).** Number-typed asset amounts overflowed silently above
  2^53; switching the type ensures protocol-level money handling
  cannot lose precision. Cascade through providers, transaction-history
  aggregation, `wallet.getBalance`, `wallet.send` change-output
  accounting, the delegator, validation, and asset coin selection.
  `IssuanceParams.amount` / `ReissuanceParams.amount` /
  `BurnParams.amount` are also `bigint` now. Persistence layer
  serializes amounts as strings — `deserializeAsset` accepts legacy
  on-disk numbers, new strings, and runtime bigints, so no data
  migration is required. Callers doing arithmetic on
  `asset.amount` / `assetDetails.supply` get a clear TS error and
  must work in bigint or call `Number(...)` explicitly. (#472)

### Features

- **`HDDescriptorProvider` for HD receive-address rotation.** New
  wallet-layer `DescriptorProvider` backed by `SeedIdentity` that
  owns a single global derivation index and rotates the active
  receive descriptor on demand. State persists under
  `walletRepository.settings.hd` so no schema migration is required.
  The provider is now a pure rotating allocator —
  `getNextSigningDescriptor()` is the only entry point; the read-side
  "current descriptor" surface lives in the contract repository
  instead. Mirrors the dotnet SDK's `IArkadeAddressProvider` shape.
  (#440)
- **HD wallet primitives on `SeedIdentity` / `MnemonicIdentity`.**
  Identities now expose the wildcard descriptor template directly
  via the public `descriptor` field, with `isOurs` matching across
  HD indices and a `signWithDescriptor` API that derives the right
  child key per request. The descriptors-scure library now drives
  template materialization (`expand({ index })`), `isRanged`
  classification, and `canonicalExpression` — replacing hand-rolled
  regex substitution and tolerating checksum-suffixed templates.
  Constructors take `(seed, opts)` directly and validate inputs as
  wildcard templates. `ReadonlyDescriptorIdentity` is HD-aware too,
  so watch-only HD wallets can rotate receive addresses without
  seed access. Secret-bearing state (seed / mnemonic / passphrase)
  is held in module-private `WeakMap`s rather than public fields,
  removing the JS-level enumeration path that TypeScript visibility
  doesn't actually close. (#439)
- **Default to bitcoin mainnet + `https://arkade.computer`.** New
  `getArkadeServerUrl(network)` helper plus mainnet defaults reduce
  the configuration users have to type for production wallets. (#460)
- **`export anchor helpers`.** `TxWeightEstimator`, the `VSize` type,
  and the `timelockToSequence` / `sequenceToTimelock` BIP-68
  conversions are now part of the public API for consumers that
  need to estimate fees or work with relative timelocks. (#468)

### Bug Fixes

- **Electrum: `transaction.get_merkle` `missingheight` was treated as
  a hard error during electrs index lag.** electrs can briefly return
  `missingheight` from `get_merkle` for txs that are confirmed
  enough to appear in `listunspent` but not yet fully indexed. The
  provider now treats this the same as the matching wording on
  `block.header` lookups — confirmation status flips to `false` until
  the next poll, mirroring the old verbose-tx path's
  `blocktime || time || 0` fallback. Genuine errors still propagate.

### Internal

- **arkade-regtest image bumped** for refreshed regtest fixtures.
  (#465)

## [0.4.22] - 2026-04-29

### Bug Fixes

- **`ContractWatcher` `vtxo_received` events stopped delivering all
  required fields.** `ContractVtxo` was missing the inheritance from
  `VirtualCoin`, so consumers downcasting to that shape silently lost
  data. The fix re-establishes the type relation, scopes auto-delegate
  to delegate-typed contracts only (and moves the filter into the
  delegator manager where it belongs), and adds a debug log on the
  watcher path so future drift is observable. (#462)
- **Expo SDK 55 unified versions rejected by peer ranges.** SDK 55
  ships `expo-sqlite` / `expo-background-task` / `expo-task-manager`
  on the unified 55.0.x line. Widened the peer ranges to accept both
  the legacy lines and the new unified majors so installs don't
  emit peer warnings. (#463)

## [0.4.21] - 2026-04-28

### Bug Fixes

- **Two indexer SSE subscriptions opened per wallet — one from
  `notifyIncomingFunds`, one from `ContractManager` — for the same
  scripts.** `notifyIncomingFunds` now piggybacks on the
  `ContractManager` event bus instead of opening its own subscription.
  Adds a cold-start kick in `tryUpdateSubscription` so the listener
  opens promptly when the first contract is added after a zero-script
  `startWatching`. Closes #454. (#457)
- **Server-vs-client `unilateralExitDelay` divergence broke contract
  registration after the mainnet pin.** Wallet now reconciles a
  hardcoded exit delay against the value advertised by `arkd.getInfo`
  and registers contracts under both so existing addresses keep
  resolving while new addresses use the configured value. (#456)
- **`getWalletScripts` / `getScriptMap` silently fell back to the
  default script on fresh wallets.** Both accessors guarded contract-
  manager init via internal flags and on a fresh wallet that hadn't
  yet completed bootstrap they returned only the current default
  script — hiding historical default and delegate VTXOs from
  subscriptions and pending-tx flows. Drop the guards and always go
  through `getContractManager`; let init errors bubble. (#459)
- **SSE iterator could leak the underlying connection on abort.**
  Hardened iterator cleanup so `return()` and the abort signal both
  release the connection, including the path where the caller never
  iterates (see #433). (#453)

## [0.4.20] - 2026-04-27

### Features

- **Mnemonic and seed identities supported in the service-worker
  wallet.** `ServiceWorkerWallet.create()` no longer requires a
  single-private-key identity. Adds a tagged
  `SerializedIdentity` envelope spanning all SDK identity classes
  (single-key, readonly-single-key, seed, mnemonic,
  readonly-descriptor) and routes it through `INITIALIZE_MESSAGE_BUS`.
  Readonly wallets always downgrade signing identities at the
  serialization boundary so signing material cannot cross into the
  worker for read-only flows. The legacy `{ privateKey }` /
  `{ publicKey }` wire shape is still accepted by new workers (with
  a one-time deprecation warning) so an older page build can still
  initialize a newer worker during a rolling upgrade; the reverse
  direction is deliberately not supported. SDK-created service-worker
  wallets denormalize their init config so a lost cache (e.g. a
  service-worker restart) self-heals via a rebuilt envelope rather
  than failing with "missing configuration". The mnemonic / seed
  envelopes carry master-seed material — documented as a deliberate
  trade-off for class-preserving round-trip; threat-model section
  added to `src/worker/browser/README.md`. (#447)
- **Production-ready `ElectrumOnchainProvider`.** WebSocket-based
  onchain provider implementing the same `OnchainProvider` interface
  as `EsploraProvider`. Uses scripthash subscriptions instead of
  polling, derives output amounts from raw tx bytes (exact bigints,
  never `Math.round(value * 1e8)`), caches the chain tip via a single
  headers subscription, batches initial `watchAddresses` setup via
  `Promise.all`, and lifts `getTxOutspends` from
  O(outputs × history × fetch) to O(4 round trips). Atomic 1P1C
  package broadcast (TRUC / BIP 431) via Fulcrum's
  `blockchain.transaction.broadcast_package` — there is no fallback
  to sequential broadcast: when the server doesn't implement it, the
  caller gets a clear error rather than a silent failure at the
  parent step. Compatible with both Fulcrum and electrs for the core
  methods (`scripthash.{listunspent, get_history, subscribe}`,
  `transaction.{get, get_merkle, broadcast}`,
  `block.header`, `headers.subscribe`, `estimatefee`, `relayfee`);
  `broadcast_package` is Fulcrum-only. (#450)
- **Output descriptors as first-class contract params.** Contract
  handlers now accept descriptor strings (`tr(...)`) for
  `pubKey` / `serverPubKey` instead of `Uint8Array`. Adds a
  `DescriptorProvider` interface, a `StaticDescriptorProvider`
  wrapper for legacy `Identity` instances, and per-`SigningRequest`
  descriptors so a single `signWithDescriptor()` call can sign
  multiple inputs at different derivation indices. Pubkey
  comparisons in role resolution are now case-insensitive. (#411)

### Bug Fixes

- **Service-worker `MessageBus` could leave a caller's message id
  silently unanswered.** Six paths could drop responses, hanging the
  client until its own timeout fired: unknown handler tag, handler
  returning `null`/`undefined`, handler completing past the per-
  message timeout, dropped reply due to detached source, and so on.
  Every message now produces exactly one final response — explicit
  ack, error, late-delivery (within a 5-minute grace window), or
  abandoned-after-grace. Adds `messageTimeoutOverrides` so callers
  can set per-message-type / per-handler-tag timeouts (e.g. SETTLE
  needs more than GET_VTXOS), uses `Object.prototype.hasOwnProperty`
  for the override-map lookup so a message named like a prototype
  method doesn't resolve to a non-numeric value, and labels timeout
  errors with the message type so surfaced errors name the operation
  the client actually triggered. (#451)
- **Streaming SETTLE / RECOVER_VTXOS / RENEW_VTXOS hit the
  service-worker timeout during quiet protocol gaps.** Settlement
  surrenders control to the Ark server and peers, so multi-second
  silent intervals are normal and were tripping the page-side 50s
  inactivity timer plus the worker-side 30s wrapper. Both sides now
  exempt those three message types; SW death is still detected
  out-of-band via `PING` / `MESSAGE_BUS_NOT_INITIALIZED` on short
  concurrent requests. (#446)
- **`VtxoManager` crashed handling fees on edge inputs.** Fee
  calculations and types in the manager are now consistent with the
  rest of the wallet path. (#449)

### Performance

- **SSE reconnect spam on transient drops.** `getEventStream`
  reconnect attempts now reject quietly so the wallet's own retry
  logic isn't drowning the console with errors that the SDK
  recovers from on its own. (#452)

### Internal

- **`MessageBus` enforces one-response-per-message at the
  transport boundary.** Adds a bus-owned `Set` of late-delivery
  watchers with per-record `settled` flags so duplicate or
  post-stop deliveries are dropped at the source. Routes the four
  pre-handler response sites (PING ack, INIT ack, not-initialized
  error, invalid-envelope error) through the same `deliverResponse`
  helper so a null `event.source` is logged in debug rather than
  dropped silently. (#451)

## [0.4.19] - 2026-04-23

### Bug Fixes

- **`BatchStarted` race could miss the event without leaking the
  subscription.** Reordered subscription setup so the
  event handler is attached before the first event can fire, and
  ensured the subscription is cleaned up on every error path.
  Closes #443. (#445)
- **`getVtxos` returned VTXOs that were already committed to an
  in-flight `settle()` or `send()`.** Three classes of coin-selection
  race were possible: a concurrent UI call to `getVtxos()`
  reselecting inputs already on their way out; `VtxoManager`
  auto-renewal firing on a `vtxo_received` event during a manual
  `settle()`; and a second auto-renewal slipping past
  `renewalInProgress` and picking the same VTXOs the first one
  already submitted. Outpoints committed to an active spend are now
  tracked in an in-memory `Set<string>` and filtered from
  `getVtxos()`. The set is populated before `safeRegisterIntent` /
  `buildAndSubmitOffchainTx` (no visibility gap), cleared in `finally`
  before the abort signal fires (preserves the SSE cleanup path from
  #433), and is in-memory only — a crash self-heals on the next boot.
  Wired into `_settleImpl`, `_sendImpl`, and `sendBitcoin`'s
  `selectedVtxos` branch. (#444)
- **Stale VTXO cache could survive across `VTXO_ALREADY_SPENT`
  errors.** The server returns `VTXO_ALREADY_SPENT` when the local
  cache is out of date relative to the server. Both the event-driven
  renewal path and the poll-driven `runPeriodicSettle` now trigger a
  full `contractManager.refreshVtxos()` (throttled at 30s) and skip
  the cycle without bumping the consecutive-failure counter, so the
  next cycle retries immediately once the refreshed data lands.
  Combined with the SSE leak fix below, this closes the remaining
  client-side contributors to the 2026-04-18 retry-storm incident.
  (#437)
- **`runPeriodicSettle` and `_settleImpl` tried to settle unconfirmed
  boarding UTXOs.** Ark rejects those with `INVALID_PSBT_INPUT` and
  in the periodic-poll path each rejection bumped the
  exponential-backoff counter — delaying legitimate settle attempts
  and flooding logs until the funding tx confirmed (~10 min). Both
  paths now filter on `utxo.status.confirmed` pre-flight; since the
  failure never happens, the backoff counter is no longer affected.
  Fixes #438. (#442)
- **`RestArkProvider.getEventStream` leaked SSE connections.** The
  provider opened the `EventSource` eagerly outside the async
  generator body. If the caller (e.g. `_settleImpl`) threw after
  creating the stream but before the first iteration — notably when
  `safeRegisterIntent` rejected — the generator body never ran, the
  abort handler was never attached, and the trailing
  `abortController.abort()` became a no-op. Observable as a
  persistent 16-18 SSE listener floor on arkd across quiet hours.
  Move the `EventSource` allocation inside the generator body,
  override `return()` so closing the generator always releases the
  connection, and call `stream.return()` in `_settleImpl`'s
  `finally` to force cleanup even when iteration never started.
  (#433)

## [0.4.18] - 2026-04-22

### Bug Fixes

- **Multi-contract wallets silently corrupted VTXO spending
  metadata.** Every callsite that converted a bare `VirtualCoin`
  into an `ExtendedVirtualCoin` via `extendVirtualCoin(this, vtxo)`
  used the wallet's *default* `offchainTapscript`, regardless of
  which contract actually locked the VTXO. For wallets with only a
  default contract that worked; for wallets with additional contracts
  (delegate, vHTLC, swaps) every non-default VTXO was written back to
  the repository with the default contract's forfeit/intent
  tapscripts. With the indexer now emitting `vtxo.script` and the
  repositories persisting it, VTXOs are attributed to their owning
  contract via a mandatory `extendVirtualCoinForContract` lookup;
  the default-tapscript fallback is gone, and `extendVirtualCoin`
  was deleted entirely so no future code path can re-introduce the
  bug. Service-worker clients now route annotation through
  `ContractManager.annotateVtxos` over RPC instead of a duplicated
  client-side implementation that swallowed errors and re-stamped
  the default tapscript. Single-default wallets observe no
  behaviour change. (#431)
- **`VirtualCoin.script` is now required (was `string | undefined`).**
  Tightens the type so every callsite can trust the field. All three
  storage backends (SQLite, Realm, IndexedDB) gain a migration that
  derives the script from the VTXO's Ark address for legacy rows via
  a shared `scriptFromArkAddress` helper. SQLite uses a transactional
  table rebuild (`BEGIN IMMEDIATE` … `COMMIT`) so a crash mid-rebuild
  rolls back to the original `vtxos` table untouched — eliminating
  a data-loss window where `DROP TABLE` had committed but
  `RENAME tmp → vtxos` hadn't. Realm bumps `ArkVtxo` to schema v2
  and exposes a `runArkRealmMigrations` helper that consumers compose
  into their own `onMigration` callback. IndexedDB bumps to DB v3
  with cursor-based backfill plus a read-time backfill safety net.
  Realm's row-level backfill gate keys on per-row presence rather
  than `oldRealm.schemaVersion < 2` so consumers at higher schema
  versions still get the backfill. (#431)
- **Persistent VTXO cache could rewind under concurrent syncs.**
  `advanceSyncCursor` is now monotonic via `Math.max`, so out-of-order
  commits can't slip the global cursor backwards and force the next
  delta window to re-fetch everything between the two commit points.
  Subset polls intentionally don't advance the cursor so they can't
  hide data other contracts still need to pick up. (#431)
- **Boarding-settle retry treadmill across tabs (2026-04-18
  incident).** Three changes together: (a) boarding-settle cooldown
  in `VtxoManager` arms after every attempt — success or failure —
  with an exponentially-scaled cap of 5 min, so a persistently
  failing input doesn't produce identical RegisterIntent + DeleteIntent
  pairs every 60s poll; (b) `safeRegisterIntent`'s "duplicated input"
  retry proof is now signed over the caller's inputs (boarding UTXOs
  included), not `getVtxos()`, so the stuck intent is actually cleared;
  (c) the poll body is wrapped in `navigator.locks` with
  `ifAvailable: true` so only one same-origin context (tab / SW)
  registers intents per interval (no-op in Node / RN). (#431)
- **`SQLite` and `Realm` repositories silently dropped `vtxo.script`.**
  The IndexedDB and in-memory repositories round-tripped the field;
  SQLite had no column and Realm had no schema property. The two
  explicit-mapping repositories now persist `script` (SQLite via an
  idempotent `ALTER TABLE` plus secondary index, Realm via an
  optional indexed property) so script-based attribution survives
  reload. The "duplicate column" error SQLite raises on re-add is
  caught and ignored. (#431)
- **VTXO renewal cooldown wasn't armed on failed renewals.** Moving
  `lastRenewalTimestamp = Date.now()` into the `finally` block
  guarantees the 30s cooldown applies even when `settle()` throws.
  Without this, a failed renewal left the timestamp unchanged and the
  next `vtxo_received` event re-entered the renewal immediately on
  every subsequent VTXO until one succeeded or the error recurred in
  a tight loop. (#431)
- **`deleteIntent` failures were silently swallowed.** Replaces the
  `.catch(() => {})` in the settle error path with logging plus the
  failing input IDs so a lingering intent — which would surface later
  as an opaque "duplicated input" — can be traced to the settle
  attempt that failed. (#431)
- **Periodic settle ignored expiring VTXOs.** The poll loop only
  settled fresh boarding UTXOs; VTXO renewal fired only off the
  `vtxo_received` event. Wallets with VTXOs drifting toward expiry
  but no recent activity had no periodic renewal path. Renamed the
  loop to `runPeriodicSettle` and now bundles near-expiry VTXOs
  alongside unsettled boarding UTXOs into a single intent, with
  unified cooldown state across both paths. When the event-driven
  renewal is mid-flight, VTXOs are omitted from the poll-path
  intent to avoid double-spending. (#431)
- **Subscription baseline drift after restart.**
  `ContractWatcher.addContract` now pre-populates `lastKnownVtxos`
  from the wallet repository before the first poll runs. Without
  this, every persisted VTXO appeared "new" on the first poll after
  (re)start, triggering redundant per-VTXO delta syncs and firing
  spurious `vtxo_received` events to consumers. On `connection_reset`
  the manager refetches and reconciles the pending frontier for every
  watched contract — active OR holding cached VTXOs — not just active
  ones, so an inactive contract whose state flipped during an outage
  isn't left with stale data. (#431)
- **Expo background poll silently drifted to "always spendable".**
  The Expo contract-poll task fetched with `spendableOnly: true` and
  called `walletRepository.saveVtxos`, which is an upsert with no
  batch delete. A VTXO that became spent between polls was never
  re-observed and stayed marked as spendable in the repository
  forever — producing silently wrong balances the longer an installed
  wallet ran. Now fetches the full set so the upsert overwrites stale
  records with their latest state, matching `ContractManager.syncContracts`.
  (#431)

### Performance

- **`getContractsByScript` no longer loads every contract on every
  call.** Helper now takes an `Iterable<string>` and forwards it to
  the repository's existing script filter. A shared
  `collectVtxoScripts` helper dedupes scripts across
  `newVtxos` / `spentVtxos` / inputs at each callsite. Wallets with
  many historical contracts no longer pay the full fetch on every
  subscription update, every `updateDbAfterOffchainTx`, and every
  `updateDbAfterSettle`. (#431)
- **Default sync scoped to the watched set.** `syncContracts({})`
  used to fall through to `contractRepository.getContracts()` —
  every contract ever persisted, including dormant ones holding no
  cached VTXOs. Switched to `ContractWatcher.getWatchedContracts()`
  so full-scope syncs match what the subscription actually watches
  (active OR `lastKnownVtxos` non-empty). (#431)

### Observability

- **`getContractsByScript` warns on default-tapscript fallback.** A
  bare `catch { return new Map() }` swallowed errors (init failure,
  repository errors) and silently rerouted every VTXO through the
  default-tapscript fallback — exactly the regression this PR was
  preventing. Errors are logged at warn so the degradation is
  visible in production logs. (#431)
- **Subscription drops aggregated at debug level.** When the
  subscription covers multiple scripts and an incoming VTXO carries
  no `script` field or resolves to a script we're not watching, it's
  silently skipped so we don't fan it out into every contract's
  `lastKnownVtxos`. The failsafe poll backfills these, but the drop
  was previously invisible. Emits an aggregate debug log per batch.
  (#431)

### Internal

- **Removed the contract-level expiry concept.** Contract-level
  `expiresAt` and `contract_expired` events layered an expiration
  idea on top of VTXO-level `batchExpiry` that never had a clear
  purpose. Stripped from types, handlers, watcher, manager, poll
  processor, repos, docs, and examples. The underlying SQLite
  `expires_at` and Realm `expiresAt` columns are left in place to
  avoid a schema migration; we simply stop reading/writing them.
  (#431)

## [0.4.17] - 2026-04-21

### Bug Fixes

- **Default address for swept VTXOs.** Wallet now retrieves VTXOs
  via the contract manager (rather than reaching past it), includes
  spent VTXOs in `getContractsWithVtxos()` so swept VTXOs surface,
  and treats every contract as a bootstrap candidate when forced —
  so swept VTXOs landing on the wallet's default address are routed
  correctly. Resets cursors on init and deduplicates indexer calls
  along the way. (#432)
- **`getDefaultAddress` removed.** Callers should resolve addresses
  through the contract manager instead of treating "default" as a
  separate concept. (#421)

### Internal

- **e2e settlement test tolerates `VtxoManager` renew race.** The
  default-on settlement config means `VtxoManager` may dispatch a
  background renewal mid-test; assertions now tolerate the extra
  movement. (#434)
- **Regtest image bumped.** (#429)

## [0.4.16] - 2026-04-17

### Bug Fixes

- **Mainnet unilateral exit delay pinned to `605184` seconds.** Ark
  servers are about to lower the advertised unilateral exit delay
  from ~7 days to ~1 day. Existing mainnet wallets derive addresses
  using the old value; following the server would produce different
  scripts and break address continuity. Hardcoded `605184` on
  mainnet, kept the server value on other networks, and explicit
  `config.exitTimelock` still overrides the mainnet pin. (#426)

### Internal

- **e2e coverage for cross-server-config contract registration.**
  Reload a delegator wallet with a different `unilateralExitDelay`
  and assert both old and new default + delegate contracts coexist,
  the new address matches the new delegate, and VTXOs on both
  addresses stay visible. (#425)

## [0.4.15] - 2026-04-13

### Bug Fixes

- **Proof tx `lockTime` confused BIP-68 relative timelocks with
  BIP-65 absolute nLockTime.** `craftToSignTx` was taking the max of
  per-input `nSequence` values and assigning it to `tx.lockTime`,
  conflating the two encodings. A VTXO with a 605184s CSV timelock
  produced `lockTime = 4195486` on the signed proof. Now matches
  BIP-322 by hardcoding `lockTime = 0`; per-input `nSequence` still
  carries the CSV value on the PSBT input. The proof tx is
  unbroadcastable (its `toSpend` references a zero-hash outpoint per
  BIP-322) and serves only as a sighash commitment, so `nLockTime`
  and `nSequence` have no consensus meaning here — they just need to
  agree between signer and verifier. (#423)
- **Unroll `completeUnroll` derived `nSequence` from the wrong
  source.** The `nSequence` on the completion tx must come from the
  CSV timelock encoded on the VTXO, not from the prior tx's sequence
  field. Now uses the shared `timelockToSequence` helper. (#405)
- **Stale VTXOs not reconciled during delta sync.** The
  `pendingOnly` reconciliation could mark valid preconfirmed VTXOs
  as spent in two scenarios: (a) mixed bootstrap/delta sync where
  the cache scan checked all VTXOs but the indexer fetch only
  covered delta scripts; (b) a paginated `pendingOnly` response
  where a truncated first page made every VTXO outside that page
  look absent. Replaces the multi-step pending/spendable cascade
  with a single full re-fetch over delta scripts and reconciles all
  states (not just preconfirmed). Cursors advance after
  reconciliation rather than before. (#413)
- **VHTLC handler block-height CLTV check.** Block-height locktimes
  (< 500_000_000) on the VHTLC `claimDelay` / `refundDelay` /
  `refundNoReceiverDelay` fields are now correctly compared against
  block heights rather than unix timestamps. (#408)
- **Auto-renewal `VTXO_ALREADY_SPENT` no longer logs as an error.**
  The server returns this when a user-initiated transaction spends
  a VTXO before auto-renewal picks it up. It's harmless — renewal
  retries on the next cycle — and was falling through to
  `console.error`. (#394)

### Features

- **`BatchSignableIdentity` for one-shot batch PSBT signing.** Adds
  a sub-interface that browser wallet providers can implement to
  sign all checkpoint + main tx PSBTs in a single wallet popup
  instead of N+1 individual confirmations. When the identity
  supports `signMultiple`, `buildAndSubmitOffchainTx` pre-signs
  everything upfront and merges the stashed user signatures onto the
  server-signed checkpoints after `submitTx` returns. Identities
  without batch support fall back to the existing sequential signing
  path unchanged. Transactions are cloned before being passed to
  `signMultiple()` to prevent provider mutation; the contract is
  documented as "exactly one result per request, in the same order".
  (#395)
- **Identity creation `opts` is optional.** Default network is
  mainnet (matching the wallet default in #355) so identities can be
  constructed without arguments for the common case. (#393)
- **Number-typed CLTV values are accepted.** `parseCltv` now also
  parses `number` block heights / unix timestamps in addition to
  bigint, simplifying integration with code that hasn't migrated to
  bigint yet. (#404)

### Internal

- **`arkade-regtest` submodule replaces bespoke docker-compose
  stack.** `regtest/server.Dockerfile` and `regtest/wallet.Dockerfile`
  are gone; the shared `arkade-regtest` submodule is the single
  source of truth, pinned to `arkd` v0.9.0 via `.env.regtest`. The
  CI nigiri Action and docker build steps go away with it. (#386)
- **Strict server health check in e2e setup.** Test setup now waits
  for arkd to be ready and skips wallet recreation when an existing
  wallet is detected, reducing flakiness. (#397)

## [0.4.14] - 2026-03-31

### Features

- **Configurable per-message timeouts in the service-worker
  bus.** Page-side callers can now set per-message-type or
  per-handler-tag timeouts via `messageTimeoutOverrides` to
  accommodate operations whose duration legitimately varies (e.g.
  SETTLE vs GET_VTXOS). Sensible defaults applied when no override
  is given. (#371)

### Internal

- **Bumped `@bitcoinerlab/descriptors-scure` to 3.1.7.** (#392)

## [0.4.13] - 2026-03-27

### Internal

- **Replaced `@kukks/bitcoin-descriptors` with
  `@bitcoinerlab/descriptors-scure`.** Ongoing migration to the
  scure-stack descriptor library; aligns noble-curve versions with
  the new dep so a single curve implementation ships in builds.
  (#385)

## [0.4.12] - 2026-03-26

### Bug Fixes

- **Duplicate VTXO bootstrap on first wallet load.** Two related
  causes: (a) `getVtxos()` and `getTransactionHistory()` triggered
  `syncVtxos()` independently when called concurrently during init,
  duplicating the paginated VTXO fetch — on a wallet with ~3500
  VTXOs that doubled ~1.9 MB of network traffic. Added an inflight
  promise guard so concurrent callers share the same in-flight
  sync. (b) `createContract()` fetched all VTXOs for a new contract
  but did not advance the sync cursor, so when the watcher's
  `addContract()` then emitted a `vtxo_received` event,
  `handleContractEvent()` called `deltaSyncContracts()` which found
  no cursor and re-bootstrapped the same script. The cursor now
  advances after the initial fetch so the event-driven delta sync
  sees it and skips the redundant bootstrap. (#387)

## [0.4.11] - 2026-03-26

### Features

- **Persistent transaction history with per-script delta sync.**
  Introduces `WalletState.settings.vtxoSyncCursors` — per-script
  high-water marks — so subsequent VTXO fetches pull only the
  changes since the last sync rather than the full history. Uses a
  bounded sync window with safety lag and overlap margins for
  correctness. `getVtxos()` reads cursors and fetches deltas;
  `getTransactionHistory()` is now cache-first via a shared
  `syncVtxos()` method, eliminating the redundant second indexer
  fetch. After delta sync on init, all pending (not-yet-finalized)
  VTXOs are re-fetched via `pendingOnly` to catch state changes
  outside the delta window. `clearSyncCursors()` is exposed on the
  wallet for debugging and recovery; `ContractManager.refreshVtxos()`
  clears all cursors before doing a full fetch. (#381)

### Performance

- **VTXO indexer page size raised from 200 to 500.** Reduces the
  number of paginated indexer calls for wallets with >1k VTXOs (e.g.
  16 calls → ~6 on a 5000-VTXO wallet). (#379)
- **Multiple wallet network requests deduplicated.** Avoid duplicate
  subscriptions on wallet reload, parallelize `getPendingTxs` batch
  fetches, throttle paged calls by 500ms, fetch `getInfo` and
  `getDelegateInfo` once before parallel delegation, deduplicate
  outspend lookups in `getBoardingTxs`, pre-collect and batch
  uncached txids into a single `getVtxos({ outpoints: [all] })`
  call, only check pending transactions on start, fetch boarding
  UTXOs once and pass them to both `settleBoardingUtxos()` and
  `sweepExpiredBoardingUtxos()`, and chunk the batched outpoints
  lookup. Cumulatively a sizeable reduction in startup network
  pressure. (#379)

### Bug Fixes

- **`dispose()` returned before `pollDone` resolved.** A wallet
  disposal that fired during an in-flight poll could leave the poll
  task running. `dispose()` now awaits `pollDone` and clears the
  disposal timeout when the poll finishes first. (#370)

### Internal

- **Bumped `@kukks/bitcoin-descriptors` to 3.2.3.** Fixes Vite
  browser builds broken by Node-only `createRequire` in 3.2.2: the
  3.2.3 release replaces it with dynamic `import()` for
  browser-compatible lazy loading of the optional miniscript
  dependency. (#383)
- **Bumped `@kukks/bitcoin-descriptors` to 3.2.2.** Makes
  `@bitcoinerlab/miniscript` an optional peer dependency. ts-sdk
  doesn't use miniscript descriptors, so this reduces install
  footprint with no code change required. (#373)

## [0.4.10] - 2026-03-19

### Bug Fixes

- **Service-worker reinit failed after reload.** A reinit-after-
  reload bug on the service-worker wallet path meant the wallet
  could not be re-attached cleanly. Constants now used for error
  descriptions; tests cover the reinit flow end-to-end. (#368)
- **`arkTransaction` rejected the second OP_RETURN output.** Limit
  raised to two OP_RETURN outputs (the protocol's actual upper
  bound), matching server expectations. (#366)
- **Exported `MESSAGE_BUS_NOT_INITIALIZED` error.** Consumers
  catching this state had no exported constant to compare against;
  now exported from the worker barrel. (#369)

## [0.4.9] - 2026-03-18

### Performance

- **Indexer round-trips during wallet bootstrap reduced from ~21 to
  2 (one per contract).** `ContractManager.initialize()` and
  `createContract()` now fetch the full VTXO history (including
  spent/swept) rather than just spendable ones, populating the
  repository so downstream reads (balance, transaction history,
  spendable VTXOs) hit the cache instead of the indexer. The
  service-worker `onWalletInitialized` is restructured so contract
  manager init runs first; subsequent reads (`getVtxosFromRepo()`,
  `buildTransactionHistoryFromCache()`) consume the populated cache.
  GET_VTXOS / GET_BALANCE / GET_TRANSACTION_HISTORY all route through
  repository reads now. `connection_reset` uses `includeSpent: true`
  so the repo keeps full VTXO history after reconnect; `RELOAD_WALLET`
  forces a fresh indexer fetch via `ContractManager.refreshVtxos()`
  instead of being a silent no-op. (#360)
- **N indexer calls collapsed into one when fetching VTXOs for
  multiple contracts.** `ContractManager.fetchContractVtxosBulk()`
  now issues a single batched `getVtxos` call with all contract
  scripts instead of N parallel calls. `VirtualCoin` carries an
  optional `script` field populated by `convertVtxo()` in both
  `RestIndexerProvider` and `ExpoIndexerProvider`, so callers can
  route each returned VTXO back to its contract without a separate
  lookup. Closes #362. (#364)

### Bug Fixes

- **VTXO renewal feedback loop hammered the indexer.** When VTXOs
  are renewed via `settle()`, the server emits new VTXOs that
  trigger `vtxo_received` events. Without guards, this immediately
  triggered another `renewVtxos()` call — an infinite
  settle→receive→settle loop. Two defenses: a re-entrancy guard
  skips `vtxo_received` while a renewal is in flight; a 30s cooldown
  window suppresses `vtxo_received` events shortly after a
  successful renewal, since those VTXOs are our own settlement
  output. The poller's `disposed` flag also blocks new timeouts after
  `dispose()` is called, and `settleBoardingUtxos()` now rethrows
  errors instead of silently returning, so the poll loop's `hadError`
  tracking actually drives backoff. (#358)
- **Infinite reconnect loop when arkd's subscription expired after
  inactivity.** Retry logic now only fires when the subscription
  isn't found; other errors don't trigger the reconnect storm. (#363)
- **Service-worker creation arguments lost across reload.**
  Preserves the original creation arguments so service-worker
  wallets can self-rebuild without "missing configuration". (#365)

## [0.4.8] - 2026-03-17

### Features

- **`settlementConfig` is enabled by default with boarding UTXO
  sweep on.** Replaces `RenewalConfig` with `SettlementConfig`;
  unifies threshold units to seconds; adds `boardingUtxoSweep` so
  expired boarding UTXOs are auto-swept back to a fresh boarding
  address via the unilateral exit path before being re-onboarded.
  Multiple expired UTXOs batch into a single tx with a dust guard.
  Block-based timelocks supported via `chainTipHeight`.
  `RenewalConfig` and `thresholdMs` remain backwards-compatible.
  Wallets created without `settlementConfig` now opt in to settlement
  with default behaviour (3-day VTXO renewal threshold, sweep
  enabled, 60s poll interval); explicit opt-out via
  `settlementConfig: false`. `VtxoManager` is exposed on
  `ServiceWorkerWallet` so SW callers can `getVtxoManager()` /
  `renewVtxos` / `recoverVtxos` / `getRecoverableBalance` /
  `getExpiringVtxos` directly. (#344, #352)
- **Network mismatch guard between identity and Ark server.**
  `isMainnet` defaults to `true` (production-first), and
  `Wallet.create` plus `ReadonlyWallet`'s constructor throw if a
  seed-based identity's network doesn't match the Ark server (e.g. a
  mainnet identity connected to a testnet server). Closes #347.
  (#355)
- **Compilation target moved to ES2022.** Lets us use modern syntax
  (`Array#at`, top-level `await`, nullish coalescing assignment) in
  the source. Existing consumers on Node 22+ / modern browsers are
  unaffected. (#354)

### Bug Fixes

- **Boarding UTXO poller caused rate limiting.** Three changes to
  reduce API pressure: (a) `setInterval` replaced with `setTimeout`
  chaining so a slow poll can't stack up behind the fixed timer; (b)
  exponential backoff on consecutive failures (base interval doubles
  per failure, capped at 5 min, resets on success); (c) eliminate
  duplicate `getBoardingUtxos()` call in `settleBoardingUtxos()` by
  filtering the already-fetched list in-place instead of calling
  `getExpiredBoardingUtxos()` (which re-fetched). (#353)
- **Concurrent operations registering VTXOs with the Ark server.**
  Operations that register VTXOs (settle, send, recover, renew) are
  now serialized so two flows can't both try to spend the same
  inputs and cause server-side rejection storms. (#357)

### Performance

- **Read-only request deduplication and SW health check.** The
  message bus dedups read-only requests, performs a healthcheck
  before sending, and uses robust `Error` types for serialization
  consistency between worker and page. (#356)

## [0.4.7] - 2026-03-16

### Internal

- **Quieted VTXO renewal log noise on no-op cycles.** Don't log
  errors when there's nothing to renew or when the only renewable
  VTXOs are below dust. (#350)

## [0.4.6] - 2026-03-13

(No user-visible changes — release commit only.)

## [0.4.5] - 2026-03-13

(No user-visible changes — release commit only.)

## [0.4.4] - 2026-03-12

### Bug Fixes

- **Asset packet referenced the wrong output index in `settle()`.**
  Used a "first offchain output" heuristic to decide which output
  receives the asset packet. When the settlement had outputs in a
  different order than expected (e.g. an onchain recipient before
  the wallet's own offchain output), the asset packet referenced
  the wrong index and arkd reported `asset output not found in
  asset group <id> at index 0`. Now matches by destination script
  via the same `findDestinationOutputIndex` helper introduced for
  the delegator path in #345. (#348)

### Internal

- **Force-built regtest from arkd 0.9.0** to align integration tests
  with the upcoming server release. (#349)

## [0.4.3] - 2026-03-11

### Bug Fixes

- **Asset packet attached to the wrong output in delegate intents.**
  Asset packet is now attached to the wallet's own destination
  output (matched by script) rather than the last output in the
  list. Adds `findDestinationOutputIndex` as an exported helper plus
  unit tests covering matches at various positions, no match, empty
  outputs, undefined scripts, and duplicate scripts. (#345)

## [0.4.2] - 2026-03-11

### Bug Fixes

- **Service-worker event listeners were never removed.** Each
  `.bind()` call created a new function reference, so the
  `removeEventListener` call inside `stop()` couldn't find the
  registered handler and the listener leaked. Now uses
  `event.waitUntil` to signal the browser that async work is in
  flight, and stores the bound reference for clean removal on stop.
  (#341)

## [0.4.1] - 2026-03-11

### Features

- **Asset packet on delegate intents.** Asset packets are appended
  to delegate intents so delegators can renew asset-bearing VTXOs.
  (#343)
- **`createTaskDependencies` factory for custom schedulers.** New
  factory in `worker/expo` builds the `TaskDependencies` object
  needed by `contractPollProcessor`, extracting the
  `extendVtxo` construction logic that was previously inlined in
  `defineExpoBackgroundTask`. Consumers running custom task
  schedulers (e.g. bare React Native with
  `react-native-background-fetch`) can now use the task processors
  without depending on Expo. Also exports `extendVirtualCoin`,
  `extendVtxoFromContract`, and `extendCoin`. (#336)

## [0.4.0] - 2026-03-06

Baseline of the `0.4.x` line. Released from the `0.4.0-next` branch
(see the `v0.4.0-next.0` … `v0.4.0-next.8` pre-release tags in `git
tag` for the staged work that landed in this version).

Pre-0.4 release history (0.3.x and earlier) is in `git log`.
