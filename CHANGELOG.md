# Changelog

All notable changes to `@arkade-os/sdk` are documented here. Format
conventions and section ordering are defined in [`CLAUDE.md`](CLAUDE.md).

This file covers the **0.4.x** line. Pre-0.4 release history (0.3.x and
earlier) lives in `git log` — those entries were not written in this
style and have not been backfilled.

## [Unreleased]

### Bug Fixes

- **Settlement forfeits a VTXO past expiry that the operator has not
  swept.** The forfeit-skip decision read `canRecoverOnchain`, which is
  true for any VTXO past its wall-clock expiry, so renewing one whose
  batch output the operator never swept sent no forfeit and arkd failed
  the batch with `missing forfeit transactions`. Settlement, delegation
  and Arkade batches now decide with `requiresForfeit`, mirroring arkd's
  `Vtxo.RequiresForfeit()`: only swept or unrolled VTXOs skip the
  forfeit, whatever their expiry. Because the delta sync never revisits
  a coin swept after its cursor, `settle` now refreshes the swept state
  of expired inputs before deciding, so an already-swept VTXO is not
  given a forfeit the operator allocated no connector for.

- **`programFromArtifact` reads time-based CSV literals.** A literal
  relative timelock in an `arkadec` artifact is the encoded BIP68
  sequence, but the reader tagged every literal as a block count, so a
  512-second literal such as `4194314` (bit 22 set) failed to build with
  `Expected Number blocks <= 65535`. Literals are now decoded: `4194314`
  reads as 5,120 seconds and builds the artifact's own script bytes. A
  literal that does not round-trip through BIP68, such as `70000`, is
  refused when the artifact is read. `$param` operands are still bound
  as block counts. (#1012)

### Performance

- **`getVtxos` and `getBalance` no longer read spent history.** Both
  loaded every stored VTXO row, spent ones included, and dropped the
  spent ones in memory. They now ask the repository for unspent rows
  only, the read `getSpendableVtxos` already uses, which IndexedDB
  serves from the `scriptUnspent` index. Results are unchanged:
  `getVtxos` still reads spent rows when `withUnrolled` is set, because
  an unrolled coin is returned even when spent, and the balance buckets
  already skip every spent coin.

## [0.4.77] - 2026-09-30

### Breaking Changes

- **The IndexedDB wallet database moves to schema v4.** `DB_VERSION`
  goes from 3 to 4 to add a `scriptUnspent` index on the VTXO store;
  existing rows are backfilled in one paged pass on upgrade, so no
  manual migration is needed. An older SDK cannot reopen a v4
  database, so a downgrade after upgrading fails to open storage.
  `IndexedDBStorageAdapter` no longer defaults its `version` to the
  wallet schema version and opens at the database's current version
  when none is passed. (#991)

### Features

- **`programFromArtifact` reads `arkadec` compiler artifacts into a
  `Program`.** The new reader (with `isContractArtifact` and the
  `ContractArtifact` type, exported from the arkade entry) converts
  the JSON the compiler writes, including constructor pubkeys tweaked
  by a covenant (the new `TweakedSigner` signer form). `parseArtifact`
  now refuses an `arkadec` artifact by name instead of turning its
  spend-group array into functions named `"0"`, `"1"`, ...; byte
  `0xdc` is named `OP_CHECKTIME`. (#958)
- **Scoped and bounded funding reads for `getSpendableVtxos`.** The
  filter is now `GetSpendableVtxosFilter`, which adds opt-in
  `watchedOnly`, `genericallySpendableOnly`, `maxSyncAgeMs` and
  `requireSynced`. Wallet repositories gain an optional
  `getVtxosForScripts` bulk read, implemented by the in-memory,
  IndexedDB, SQLite and Realm backends, and the built-in coin
  selectors are scoped to eligible contracts. `hasTerminalSpend` is
  renamed `isVtxoSpent`; the old name stays as a deprecated alias.
  (#991)

### Bug Fixes

- **`send` no longer creates change below the operator's VTXO
  minimum.** Coin selection now keeps adding coins until a positive
  change output meets `vtxoMinAmount` (and dust when it carries asset
  change), and falls back to an exact BTC-only subset with no change
  when the balance cannot produce valid change. With an explicit
  `selectedVtxos`, change below the minimum is refused with an error
  naming both amounts. (#987)

### Performance

- **Contract VTXOs are grouped in one pass.** `ContractManager` builds
  the per-contract VTXO grouping in a single sweep instead of
  filtering once per contract. (#990)

## [0.4.76] - 2026-09-25

### Features

- **`available` balance reserves one dust carrier while assets are
  held.** An Arkade asset rides on a dust-sized carrier output whose
  sats move only with the asset, so when any available VTXO carries
  assets, `getBalance().available` is reduced by one dust amount on
  both the main-thread and service-worker paths. `getDustAmount` now
  accepts an `IReadonlyWallet` or `undefined` and falls back to the
  default threshold. (#975)

### Bug Fixes

- **`BIP21.create` writes the amount as a plain decimal.** It formatted
  the BTC amount with `String()`, which switches to exponent notation
  below `1e-6`, so any amount under 100 sats came out as `amount=1e-7` —
  outside BIP21's `*digit [ "." *digit ]` grammar, and rejected by the
  SDK's own `BIP21.parse`. Amounts are now written with at most 8
  decimals and no trailing zeros, which also drops float noise
  (`0.30000000000000004` → `0.3`) and rounds sub-satoshi precision to the
  satoshi.

### Performance

- **Contract tapscripts are memoized across syncs.** `ContractManager`
  keeps derived tapscripts for its lifetime, keyed on type, script and
  params and bounded to 1024 entries, instead of re-deriving every
  contract on each bulk sync. A hit is only reused while the handler
  that derived it is still registered. `TapscriptDeriving`
  implementations must now be pure in type and params. (#984)

## [0.4.75] - 2026-09-23

### Features

- **Arkade opcode table gains `PUSHEXPIRY`, `CHECKTIME`, `TUNNEL` and
  the intent opcodes.** The table now covers `0xc3`-`0xf8`, matching
  what the emulator and compiler artifacts already use. (#967)

### Bug Fixes

- **Collaborative exits pay the destination exactly.** New
  `Ramps.offboardExact` prices the output fee on the destination
  amount and sources it on top, replacing `onchainRail`'s fixpoint
  gross-up, which could short-pay the recipient on a non-converging
  fee schedule and charged the fee on the wrong output. Both exits now
  refuse change above `vtxoMaxAmount` with the new
  `OversizedChangeError` before submitting, and the `onchain` quote
  includes the change output's own fee. (#956)
- **HD unilateral-exit sweeps are signed with the right key.** Sweeps
  now route through the wallet's descriptor-aware signer router
  instead of always signing with the identity key, so a VTXO on a
  rotated HD descriptor can be swept. (#959)
- **`Arkade.connect` takes the address network from the server.** A
  contract created without an explicit `network` against a signet,
  regtest or mutinynet server previously got a mainnet (`ark1...`)
  address; it now uses `getInfo().network`. An explicit `network`
  still wins. (#962)
- **A look-ahead failure at startup no longer aborts wallet
  construction.** A transient provider error while probing the HD
  look-ahead band is recorded as an owed refill, retried on the next
  contract event, and reported as a degraded sync instead of throwing.
  (#965)
- **A just-recorded spend survives a stale indexer response.** A
  `send` that left change could have its inputs restored to unspent by
  an indexer sync that had not caught up yet, re-offered to coin
  selection and rejected by the operator. Spends this process recorded
  are now held in memory for 60 seconds against such a sync. (#966)

### Performance

- **Boarding addresses are fetched concurrently.** Boarding UTXO lookup
  on wallet initialization queries all boarding addresses in parallel
  instead of one at a time, and saves UTXOs only once every fetch has
  succeeded. (#964)

## [0.4.74] - 2026-09-19

### Features

- **A payment request can name the VTXOs it spends.**
  `PaymentRequest.selectedVtxos` carries the caller's selection with
  `SendParams.selectedVtxos` semantics (taken whole, a shortfall is an
  error). The `ark` and `onchain` rails honour it; the swap rails drop
  themselves rather than ignore it. `Ramps.offboard` gains a trailing
  `vtxos` parameter for a partial exit, and an explicitly named input
  whose fee exceeds its value is refused. `NormalizedExtendedVirtualCoin`
  is now exported. (#948)
- **`watchScript` and `unwatchScript` accept a set.** Both now take
  `string | string[]`; a set is registered or dropped in one
  subscription update with one batched indexer read. Single-script
  calls are unchanged. (#955)

### Bug Fixes

- **A partial offboard now pays for its change output.**
  `Ramps.offboard` priced its inputs and exit output but not the
  offchain change output, so any partial offboard under a nonzero
  `offchainOutput` fee was rejected by the server. The change fee is
  now solved to a fixpoint, a schedule where it never settles is
  refused, and a fee that outruns the change emits no change output.
  (#950)
- **Expo no longer sends Arkade headers to the indexer origin.**
  `getExpoFetch` added `X-Build-Version` / `X-SDK-VERSION` to every
  request, which fails CORS preflight on an indexer deployed on its
  own origin. Only `ExpoArkProvider` sends them now. (#927)

## [0.4.73] - 2026-09-15

### Bug Fixes

- **Wallet submits verify the operator's cosignature.**
  `submitOffchainTx` had a server-signature check that the wallet
  never enabled, so a txid-matching PSBT the server never signed was
  finalized. The wallet now enables it, checking each signature
  against the key the spent leaf names (the active signer or a
  deprecated one). (#923)
- **Settlements are validated against the intent proof when no
  recipients are passed.** `createArkadeBatchHandler` skipped both
  validation gates without an explicit `recipients` list; it now
  falls back to the outputs signed in the intent proof. Asset
  assignments still need the explicit list. (#922)
- **`settle` fails when the commitment tx omits a boarding input.**
  It previously continued silently and signed the VTXO forfeits,
  leaving the boarding input behind. Arknotes are exempt. (#921)
- **Delegation is scheduled at least one operator session before
  expiry.** The default `delegateAt` is now the later of 10% of
  remaining lifetime and `sessionDuration` before the earliest expiry,
  so a short-lived VTXO is no longer scheduled too late to renew.
  (#912)

### Internal

- **Regtest stacks run on arkd v0.9.16.** (#908)

## [0.4.72] - 2026-09-10

### Features

- **Wallet restore hooks.** `registerWalletRestoreHook(wallet, hook)`
  registers a plugin callback that runs after `restore()` completes,
  on both the main-thread and service-worker wallets; it returns an
  unregister function, and hook failures are collected into an
  `AggregateError`. (#901)
- **`RouteQuote.validUntil`.** A quote can now state how long it is
  good for as a typed optional field instead of only in `meta`;
  absence means the rail has nothing to state, not that the quote
  never expires. (#874)
- **`createContracts` registers a set of contracts in one indexer
  round trip.** Optional on `IContractManager`, so custom
  implementations keep compiling; a part-way failure does not leave
  persisted rows unwatched. (#897)

### Bug Fixes

- **Provider reads have a 30-second deadline.** `baseFetch` now bounds
  GET and HEAD requests with `READ_TIMEOUT_MS`, so a silently dropped
  connection surfaces as a retryable `ProviderUnavailableError`
  instead of hanging the retry ladder and the wallet's spend lock.
  Writes stay unbounded, and a caller-supplied signal always wins.
  The emulator's info read now goes through the same boundary. (#884,
  #887)
- **Transaction history is gated like balance.** Coins at gated
  contracts (such as a swap offer covenant) were counted as the
  wallet's own change, which cancelled out funding, fill and cancel
  rows. History now treats them as an external counterparty and tags
  those rows `"gated"`. (#859)
- **A `vtxo_spent` from the failsafe poll now carries the row that records
  the spend.** `ContractWatcher.pollContracts` reported the difference
  using its *cached* rows, and those were unspent when cached — so a
  poll-derived `vtxo_spent` stated `isSpent: false`, `spentBy: ""` and no
  `arkTxId` on an event whose whole meaning is that the output was spent.
  Anything reading a spend txid off these events saw nothing to bind the
  spend to, including `Wallet`'s own subscription, which forwards them as
  `spentVtxos`. The poll now takes spent rows from the repository query it
  was already making — no extra read — and emits the stored row, falling
  back to the cached one when storage has nothing fresher. **Grep your
  `vtxo_spent` handlers for `spentBy`, `arkTxId` and `isSpent`**: fields
  that were always empty on the poll path are now populated, and a handler
  branching on `!vtxo.isSpent` inside a spend handler now takes the other
  branch. (#864)

### Performance

- **Identical in-flight VTXO reads share one request.**
  `RestIndexerProvider` serves concurrent identical
  `/v1/indexer/vtxos` reads from a single wire request, while each
  caller still gets its own converted coins. (#876)
- **Opt-in staleness budget for the pre-send sync.**
  `ContractManagerConfig.vtxoSyncMaxAgeMs` lets an embedder serve
  `getContractsWithVtxos` from the repository when a full sync ran
  within the budget. The default `0` keeps the old always-sync
  behaviour, and a connection reset clears recorded freshness. (#882)

## [0.4.71] - 2026-09-08

### Breaking Changes

- **`ContractEvent` gains contract-less `vtxo_received` /
  `vtxo_spent` variants.** Code that narrows on `type` and then reads
  `event.contract` no longer compiles; narrow with the new
  `isContractVtxoEvent` first. (#857)

### Features

- **Watch-only scripts on `ContractWatcher`.** `watchScript`,
  `unwatchScript` and `getWatchedScripts` (optional on
  `IContractManager`, implemented by both shipped managers and the
  service-worker wallet) report VTXO activity at a script the wallet
  does not own, without persisting it or counting it in balance,
  recovery or history. Delivery is at-least-once and re-announces on
  restart. `WatchedScript` and `ContractVtxoEvent` are exported. (#857)

## [0.4.70] - 2026-09-08

### Breaking Changes

- **`onchainRail` requires a fee source, and `RouterContext.wallet` is
  `IWallet`.** `onchainRail()` is now `onchainRail({ feeInfo })` and
  throws at construction without one; use the new
  `walletFeeSource(wallet)`. `RouterContext.wallet` is typed `IWallet`
  instead of the concrete `Wallet`, so a custom rail reading
  `Wallet`-only members must take them as constructor dependencies.
  `createDefaultPaymentRouter` callers are unaffected. (#851)

### Features

- **`PaymentRouter` gets an asset dimension.** `PaymentRequest` gains
  optional `assets` and `RouteQuote` an optional `assets`
  (`{ delivered, spent }`) view; the existing sats fields keep their
  meaning. A new `ark-asset` rail (`arkAssetRail`, `ASSET_CARRIER_SATS`)
  pays an Arkade address in an asset and is in the default router, and
  every BTC-only rail now refuses a request carrying an asset instead
  of paying only its carrier sats. (#838)

### Bug Fixes

- **`EsploraProvider.getChainTip` falls back to `/v1/blocks`.**
  Mempool-backend-only explorers return 404 on `/blocks`; the provider
  now retries `/v1/blocks` on a 404 and fails immediately on other
  errors. (#637)

## [0.4.69] - 2026-09-04

### Features

- **`waitForIncomingFunds` is cancellable.** It accepts
  `{ signal, timeoutMs }` (`WaitForIncomingFundsOptions`) and rejects
  with the new `AbortError` on cancellation, tearing down its watchers.
  It also rejects when the underlying subscription fails instead of
  hanging. (#830)

### Bug Fixes

- **Esplora address watchers no longer leak HTTP pollers.** A watcher
  stopped during its async setup kept a 15-second full-history poll
  running forever. Teardown is now tracked across awaits, watchers of
  the same address set share one refcounted transport, polling uses
  capped exponential backoff, and the WebSocket-to-HTTP fallback logs
  a warning. (#830)
- **A late address-watch baseline is anchored on chain height.** When
  the initial history fetch fails, the chain height at watch start is
  recorded so transactions confirmed above it (and unconfirmed ones)
  are still reported as new when the baseline is later adopted.
  `ExplorerTransaction.status` declares the optional `block_height`.
  (#833, #840)
- **Electrum `getChainTip().time` is median-time-past.**
  `ElectrumOnchainProvider` returned the tip header's own `nTime`,
  which can mature a seconds-based timelock early; it now computes the
  11-block MTP, cached per tip hash, matching `EsploraProvider`. (#837)

### Performance

- **The HTTP watcher fallback probes address stats before refetching
  history.** Each poll cycle first reads `/address/{addr}` activity
  counts and fetches full history only when they changed or something
  is pending in the mempool; a backend without the endpoint falls
  through to history. (#834)

## [0.4.68] - 2026-09-03

### Breaking Changes

- **VHTLC covenant leaves are enabled by one `nonInteractiveParameters`
  option.** `VHTLC.Options.nonInteractiveClaim` and
  `nonInteractiveRefund` (including `withoutReceiver` and the `strict`
  claim bound) are removed; `nonInteractiveParameters: {
  emulatorPubkey, receiverPkScript, senderPkScript }` builds all three
  covenant leaves, byte-identical to before. The pre-timelocked-refund
  shape stays expressible via `legacy: "preTimelockedRefund"`.
  `VHTLCV2ContractParams` changes the same way; stored rows read back
  unchanged, but rows written with only one leaf, two different
  emulator keys, or `strict` keys are refused at deserialize. (#818)

### Bug Fixes

- **PSBT signing and tree validation are hardened.** `SingleKey` and
  `SeedIdentity` now refuse to sign an input declaring
  `SIGHASH_NONE` or `SIGHASH_SINGLE` variants (allowed: `DEFAULT`,
  `ALL`, `ALL|ANYONECANPAY`), returned checkpoints are checked the same
  way before signing, and `TxTree` rejects a node with a nonzero
  locktime or non-final sequence. `assertAllowedSighashTypes` is
  exported. (#819)
- **Exited VTXOs are kept out of renewal, recovery and cash-claim
  paths.** `isVtxoExpiringSoon` and `getExpiringAndRecoverableVtxos`
  no longer return unrolled coins, `getSpendableVtxos` logs the exited
  coins it drops, and `ArkadeContract.getUtxos` no longer trusts
  server-side `spendableOnly` on its no-manager path. (#817)

## [0.4.67] - 2026-08-31

### Breaking Changes

- **`OnchainProvider` gains a required `getRawTransaction`.** Both
  shipped providers implement it (Esplora reads `/tx/{txid}/hex`); a
  custom `OnchainProvider` must add it. (#809)
- **Unrolled VTXOs are no longer Arkade-spendable.** A VTXO with
  `isUnrolled: true` was counted in `available` and selectable for
  send, renewal and recovery, all of which fail at the server. It now
  moves to a new `unrolled` bucket on `WalletBalance` /
  `OffchainBalance` (inside `total`), `canSpendOffchain` and
  `canRecoverOnchain` refuse it, the new `canSweepOnchain` claims it,
  and `classifyCashVtxos` reports a new `exited` reason. (#816)

### Features

- **`getNewAddresses` mints fresh receive and boarding addresses.**
  `getNewAddresses({ types, forceNew })` allocates `default` and/or
  `boarding` addresses from a single new HD index, registers them as
  watched contracts without changing the advertised `getAddress()`,
  and returns `{ address, contract, signingDescriptor }` entries.
  `forceNew` throws `WalletCannotAllocateAddressError` on a wallet that
  cannot allocate; an empty `types` list is rejected. Available on
  `ExpoWallet` and `ServiceWorkerWallet`, with
  `isAddressAllocationCapable` for feature detection.
  `getNewBoardingAddress` is deprecated. (#810)
- **`CachingArkProvider` caches `getInfo` with a TTL.** A decorator
  over any `ArkProvider` (default 60s TTL) that is refreshed by
  server-info change events. `RestArkProvider` now also emits
  `onServerInfoChanged` when a routine `getInfo` refresh returns a
  changed digest, not only after `DIGEST_MISMATCH`. (#676)
- **Exit-observed hook.** `OnExitObserved`, `exitObserverFor` and
  `notifyExitObserved` let `Unroll.sessionFor` and
  `UnilateralExit.execute` mark a VTXO unrolled locally when this
  wallet performs the exit. (#816)
- **VHTLC non-interactive refund-without-receiver leaf.** An opt-in
  ninth leaf lets a sender who goes offline be refunded to a
  pre-committed destination after `refundLocktime` with only the
  server and emulator co-signer; the vhtlc-v2 contract handler
  round-trips the flag. Off by default because it changes the
  address. (#812)
- **Prevout transaction resolution for emulator v0.0.7.**
  `resolvePrevTxs`, `attachPrevArkTxs`, `attachPrevoutTxs`,
  `withPrevTxs` and `PrevTxUnavailableError` attach the prevout
  transactions the emulator now requires; covenant spends and intent
  proofs carry them, and arkd-direct paths are unchanged. (#809)

### Bug Fixes

- **A rejected 1P1C package no longer reports success.**
  `/txs/package` answers HTTP 200 even when Bitcoin Core rejects every
  transaction; the provider now inspects `package_msg` and throws with
  the per-transaction errors, so the exit executor stops waiting on a
  refused broadcast. (#807)
- **Graph-mode exits quote enough funding.** `fundingRequiredSats`
  omitted the final change output's dust floor, so depositing exactly
  the quoted amount stranded the last CPFP bump. Estimate and prepare
  now add one dust floor. (#806, #808)
- **Signer-rotation migration reads a settled signer.** The migration
  pass now drains an in-flight `onServerInfoChanged` rotation before
  reading signer-derived state, and `report.rotated` reflects a
  rotation applied by its own refresh. (#804)
- **Service-worker events are pushed immediately.** Contract, VTXO,
  UTXO and settle/renew/recover/migrate progress events no longer wait
  for the next tick (up to `tickIntervalMs`); the bus has a push
  channel, and discarded batches are logged at debug. (#813)

### Internal

- **Formatting moved from Prettier to Biome**, and `noImplicitReturns`
  is enabled. (#786, #814)

## [0.4.66] - 2026-08-24

### Features

- **`toXOnly` key normalizer.** Exported helper that converts a 33-byte
  compressed or 32-byte x-only key to x-only and throws on anything
  else. Every internal site that stripped a prefix inline now uses it,
  so a malformed server, delegate or cosigner key fails loudly instead
  of being truncated into a wrong key. (#780)
- **`sweep_tx` transaction notifications.** `getTransactionsStream`
  now yields a `sweepTx` arm (`SweepTxNotification`, with
  `sweptVtxos` outpoints) instead of dropping the event; frames are
  typed as `TxNotificationEvent`. (#781)
- **`ArkInfo.maxTxWeight` and `maxOpReturnOutputs`.** Both server
  limits are surfaced from `GetInfo` and round-trip through the cached
  info snapshot. A missing or zero value reads as `undefined`
  (unadvertised). (#782)
- **Unpaged `getVtxos` returns every VTXO.** A query with no
  `pageIndex`/`pageSize` is now paged to exhaustion internally (500
  per page, following the server cursor) and returned without a
  `page`, instead of a silent server-chosen prefix. Explicitly paged
  queries are unchanged; `DEFAULT_VTXO_PAGE_SIZE` is exported. (#783)
## [0.4.65] - 2026-08-20

### Features

- **`VHTLC.ScriptV2` can be denominated in an Arkade asset, with an
  opt-in strict claim.** A new optional `asset: { txid, groupIndex }`
  makes the two non-interactive covenant leaves also require the
  output to hold at least the input's amount of that asset (the sat
  covenant is kept alongside it). `nonInteractiveClaim.strict` adds
  quoted-amount bounds on the claim leaf only. An `asset` with neither
  covenant leaf is refused; omitting both options leaves every script
  byte unchanged. The `vhtlc-v2` handler round-trips both fields. (#763)
- **Asset-ID encoding vectors ship as a package export.**
  `asset.ASSET_ID_VECTORS` pins the identity, covenant-push, offer-TLV
  and RFQ pair-leg encodings so other implementations can test against
  the same bytes. (#767)
- **Shared IndexedDB connection helpers are exported.**
  `createManagedConnection` (with `ManagedConnection` and
  `ConnectionDisposedError`) plus `promisifyRequest`,
  `awaitTransaction`, `deleteByIndex` and `getAllByIndexValues`, so
  plugin repositories reuse the SDK's reopen and commit handling. (#765)

### Bug Fixes

- **IndexedDB repositories recover from a closed connection.** Every
  repository cached its `IDBDatabase`, so a `versionchange` or abnormal
  close bricked the store until reload. Wallet, contract, intent and
  virtual-tx repositories now reopen on the next call. (#765)
- **IndexedDB writes report success only once committed.** Most
  `readwrite` transactions in the wallet and contract repositories
  resolved on request success, so a quota or eviction abort could roll
  back a write the caller was told had landed. (#765)
- **A blocked IndexedDB upgrade fails instead of hanging.** An open
  blocked by another connection now rejects with
  `DatabaseUpgradeBlockedError` after `BLOCKED_UPGRADE_TIMEOUT_MS`
  (10s) and can be retried, rather than stalling the first repository
  call indefinitely. (#759)

## [0.4.64] - 2026-08-18

No SDK changes; released alongside `@arkade-os/swap`.

## [0.4.63] - 2026-08-17

### Features

- **Activity resolvers can declare an outcome.** `GroupMembership` and
  `ActivityIntent` gain an optional `outcome` string, an opaque machine
  token (e.g. `"failed"`, `"refunded"`) merged first-writer-wins across
  resolvers sharing a `groupId`, like `label` and `kind`. (#753)
- **`runInTransaction` and `sanitizeTablePrefix` are exported from the
  SQLite subpath.** Lets repositories outside the SDK share the one
  write chain per executor instead of opening a second over the same
  connection. (#758)

### Bug Fixes

- **The spending-gate log names a missing handler.** A VTXO excluded
  because its contract type has no registered handler in this build was
  logged with the same "not generically spendable" text as an ordinary
  refusal; it now gets its own message. Which VTXOs are excluded is
  unchanged. (#754)

## [0.4.62] - 2026-08-13

### Breaking Changes

- **`contractPreimage` takes an options object.** The third parameter
  changed from `stored?: Uint8Array` to
  `{ stored?: Uint8Array; salt?: Uint8Array }`. (#744)

### Features

- **Static wallets derive swap preimages from a public per-swap salt.**
  `provisionClaimSecret` now derives the preimage for single-key wallets
  from a 32-byte salt kept in the clear on the record
  (`ProvisionedClaimSecret.salt`), so only signers that cannot sign
  deterministically still store one. Adds `signSchnorrDeterministic` on
  `SingleKey` and `SeedIdentity`, `ARKADE_SALTED_PREIMAGE_TAG` and
  `buildSaltedPreimageMessage`. (#744)
- **`send` accepts the caller's inputs and a recipient taptree.**
  `IWallet.send` also takes a `SendParams` object whose `selectedVtxos`
  are spent exactly as given (a shortfall is an error, not a top-up),
  with asset packets built correctly. `Recipient.tapTree` publishes
  `PSBT_OUT_TAP_TREE` on that output and is refused unless it derives
  the recipient address. Custom `IWallet` implementations must accept
  the new argument form. (#730)
- **Balance splits the unavailable remainder into `gated` and
  `intentLocked`.** `WalletBalance` reports the two causes as disjoint
  buckets so `settled + preconfirmed === available + gated +
  intentLocked`; no existing field changes value. (#751)

### Bug Fixes

- **Contract preimage edge cases.** `contractPreimage` length-checks a
  stored preimage, including an empty one; the salted arm no longer
  swallows foreign-key and cannot-sign errors into a stored-preimage
  fallback; and the payment-hash guard compares hex case-insensitively.
  (#744)

## [0.4.61] - 2026-08-13

### Breaking Changes

- **`signerForDescriptor` refuses descriptors the wallet cannot sign
  for.** It previously returned the baseline identity for an unknown
  descriptor; it now throws `ForeignDescriptorError`. On static and
  `auto` wallets `getNextSigningDescriptor()` now returns the identity
  key as `tr(pubkey)` instead of `undefined`. Both `Wallet` and
  `ServiceWorkerWallet` go through the shared
  `resolveDescriptorSigner`. (#738)

### Features

- **Contract key provisioning lives in the SDK.**
  `provisionRefundKey`, `provisionClaimSecret`, `contractSigner`,
  `contractPreimage` and `adoptContractDescriptor` give a contract leg
  its key or claim secret without the caller probing wallet shape.
  Provisioning refuses a wallet that cannot actually sign
  (`WalletCannotSignError`) before anything is funded. Also exports
  `identityDescriptor`, `isSigningIdentity` and descriptor parsing
  helpers. (#738)
- **`unspendableNowReasons` on the contract manager.** A predicate form
  of `assertSpendableNow` returning refusals keyed by outpoint, so a
  caller can drop a refused input instead of failing the batch;
  `outpointReasons` feeds per-input reasons to `logExcludedVtxos`.
  (#731)

### Bug Fixes

- **Recovery drops refused inputs instead of failing the batch.**
  `recoverVtxos` and `getRecoverableBalance` read the ungated VTXO
  list, so an immature VHTLC lockup joined the recovery batch and
  failed it, including unrelated funds. Both now exclude refused inputs
  and report every refusal when nothing is left to settle. (#731)
- **`ExpoWallet` forwards the HD descriptor surface.** It forwarded
  none of it, so an Expo wallet in `hd` mode bound every artifact to
  its baseline key. (#738)
- **Arkade scripts encode minimal pushes for single-byte data.** A
  one-byte push of 1..16 or `0x81` is now written as `OP_1`..`OP_16` /
  `OP_1NEGATE`, as the Arkade VM's MINIMALDATA rule requires. Scripts
  containing such pushes encode to different bytes. (#742)

## [0.4.60] - 2026-08-12

### Breaking Changes

- **Registered contracts are no longer generically spendable by
  default.** `ContractHandler.isGenericallySpendable` gates send,
  settle, renewal, asset operations, offboard and the `available`
  balance; a handler without it is closed. `arkade` rows opt in via
  `metadata.genericallySpendable === true`; `vhtlc` and `vhtlc-v2` are
  closed. Explicit-input calls (`settle({ inputs })`,
  `selectedVtxos`) stay open. (#681, #702)
- **`IReadonlyWallet.getSpendableVtxos` and
  `WalletBalance.availableAssets` are required.** The new read applies
  the gate, pending recovery and intent locks from one snapshot;
  `getVtxos` stays the raw read. Custom wallet implementations must add
  both. (#681)
- **`ContractRepository.version` is 2.** Implementations must persist
  the new `Contract.watch` field and treat a missing one as
  `"watched"`. The IndexedDB, in-memory, SQLite and Realm backends are
  updated. (#694)

### Features

- **Retained-but-unwatched contract state.** `Contract.watch`
  (`"watched" | "awaiting-funds" | "retained"`) is separate from
  `state`: `retained` drops the subscription but keeps the row for
  history and restore, and `awaiting-funds` self-demotes once funded.
  `getContracts` accepts a `watch` filter. (#694)
- **`VHTLC.ScriptV2` and non-interactive VHTLC leaves.** `VHTLC.Script`
  gains optional `nonInteractiveClaim` and `nonInteractiveRefund`
  covenant leaves paying a pre-committed P2TR destination (validated by
  content). `ScriptV2` shares the leaf ladder but requires an exact
  32-byte preimage. A new `vhtlc-v2` contract handler
  (`VHTLCV2ContractHandler`) lets such lockups be registered. (#683,
  #690)
- **Consumers can supply the EventSource.** Set it per provider
  (`eventSource` option) or via `configureEventSource()`. With none
  available, streams throw `EventSourceUnavailableError` and the
  watcher stops retrying instead of looping every 5s. (#699)
- **HD allocation surface.** `HDAllocationCapable`
  (`getNextSigningDescriptor`, `advanceSigningDescriptorWatermark`) is
  implemented by `Wallet` and proxied through `ServiceWorkerWallet`;
  `getUsedSigningDescriptors({ lookAhead })` probes past the watermark
  (capped at `MAX_USED_SIGNING_DESCRIPTORS_LOOK_AHEAD`). The watermark
  is bounded at 2^31. (#695, #705)
- **Offchain-tx primitives exported.** `signAndSubmitOffchainTx` and
  `claimWithPreimageIdentity`; `submitOffchainTx` gains opt-in
  `verifyServerSignatures`, off by default. (#719)
- **Explicit VHTLC settle is refused before its refund opens.** The
  optional `assertSpendableNow` hook lets the VHTLC handlers reject
  `settle({ inputs })` naming a lockup before `refundLocktime` with a
  clear error, rather than a server rejection. (#704)
- **The service-worker bus takes an `intentRepository`.** Without it,
  worker mode persisted no intents and counted intent-locked VTXOs as
  available. (#681)

### Bug Fixes

- **`renewVtxos` and `recoverVtxos` pay the intent fee.** Both built
  their output as the gross input sum, so any operator with a non-zero
  intent fee rejected them (`INTENT_INSUFFICIENT_FEE`). Inputs are now
  priced like `settle()`, and `getRecoverableBalance` reports the same
  net figures. Fixes #696. (#701)
- **One broken contract no longer fails every read.** A row whose
  handler is missing, or whose params its handler rejects, failed
  `getVtxos`, `getBalance`, history and `initialize`. Its VTXOs are now
  skipped and reported through `getSyncState`. (#681)
- **VHTLC rows registered through `ContractManager` are visible.**
  Annotation threw `forfeit is not a function`, so VTXOs were never
  synced and sync stayed `degraded`. (#702)
- **Height-typed CLTV paths are reachable.** `PathContext.blockHeight`
  was never populated; `ContractManager` now fills it from a bounded,
  cached `chainTip` that `Wallet` supplies. Seconds-typed timelocks use
  the chain tip's time (`chainTime`) instead of the host clock. (#703,
  #704)
- **The service-worker `getVtxos` honors `withUnrolled`.** Unrolled
  coins were always dropped, so `prepareUnrollTransaction` found
  nothing behind the worker. (#681)

### Internal

- **`typescript` and `tsup` declared as devDependencies** so the
  package builds standalone (e.g. a git subdirectory install). (#683)
## [0.4.59] - 2026-08-12

### Breaking Changes

- **`Arkade.connect` takes the emulator co-signer key from the network,
  not from the emulator.** It no longer calls the emulator's `getInfo`;
  the key comes from a per-network pin (bitcoin, mutinynet, regtest). On
  testnet, signet, or a hand-built `Network` with no `name`, connecting
  with an emulator now throws unless you pass the new
  `emulatorPubkey` option (33-byte compressed hex). (#729)

### Features

- **Per-network emulator co-signer constants.** New exports
  `BITCOIN_EMULATOR_PUBKEY`, `MUTINYNET_EMULATOR_PUBKEY`,
  `REGTEST_EMULATOR_PUBKEY`, `defaultEmulatorPubkey(network)` and
  `resolveEmulatorPubkey(network, override?)`, which rejects a malformed
  override instead of passing it through. `Network` gains an optional
  `name`, set on every entry of the `networks` table. (#729)
- **Checkpoint exit-delay floor defaults to what signet and mutinynet
  advertise.** `Wallet.create` rejected the hosted signet (86016s) and
  mutinynet (4096s) servers under the 86400s default floor. Those two
  networks now default to their advertised values
  (`SIGNET_MIN_CHECKPOINT_EXIT_DELAY_SECONDS`,
  `MUTINYNET_MIN_CHECKPOINT_EXIT_DELAY_SECONDS`); bitcoin and testnet
  keep 86400s. (#721)

### Bug Fixes

- **Timelock-floor rejections name the override that lowers them.** The
  batch-expiry and checkpoint exit-delay errors now name
  `minBatchExpirySeconds` / `minCheckpointExitDelaySeconds` and give the
  value that would accept the server's timelock. (#721)

### Internal

- **`repository` field added to the published `package.json`.** (#707)

## [0.4.58] - 2026-08-10

### Features

- **Service-worker wallets accept the timelock-floor overrides.**
  `ServiceWorkerWalletOptions` now forwards `minBatchExpirySeconds` and
  `minCheckpointExitDelaySeconds` to the worker's wallet. Before this,
  page-side consumers could not set them at all, which blocked mutinynet,
  whose server advertises a checkpoint delay below the default floor.
  (#706)
- **Node 26 allowed.** `engines.node` widened from `>=22.12.0 <25` to
  `>=22.12.0 <27`. (#685)

### Bug Fixes

- **`renewVtxos` and `recoverVtxos` now pay the intent fee.** Both built
  their settlement output as the gross sum of their inputs, so the
  intent paid zero fee and any operator with a non-zero intent fee
  rejected it (`INTENT_INSUFFICIENT_FEE`). This includes the automatic
  renewal the SDK runs on `vtxo_received`. Inputs and outputs are now
  priced through the fee estimator. Inputs whose fee is at least their
  value are dropped before batch capping, and the dust check applies to
  the net output. `getRecoverableBalance` uses the same pricing, so its
  `recoverable`, `subdust` and `vtxoCount` now match what
  `recoverVtxos` would settle. Closes #696. (#698)

## [0.4.57] - 2026-08-07

### Breaking Changes

- **Server-supplied batch expiry and checkpoint exit delay are now
  checked against a floor.** A round's `batchExpiry` and the checkpoint
  script's exit delay were used without any check. Off regtest both must
  now be seconds-typed and at least 24h by default. The checkpoint script's
  pubkey must also be the operator's forfeit key, and `batchExpiry` must
  equal `vtxoTreeExpiry` when the server advertises it. A failing round
  is rejected with `ServerResponseMismatchError` before registration is
  confirmed. A bad checkpoint script fails `Wallet.create` and
  `rotateServerSigner`. Lower the floors with the new
  `WalletConfig.minBatchExpirySeconds` /
  `minCheckpointExitDelaySeconds` (they cannot be disabled). The policy
  helpers (`assertValidBatchExpiry`, `assertValidServerUnrollScript`,
  `default*Policy`, `resolve*Policy` and the floor constants) are
  exported, and `ArkInfo` gains an optional `vtxoTreeExpiry`. (#686,
  #687)

## [0.4.56] - 2026-08-05

### Breaking Changes

- **Recipient Arkade addresses must match the wallet's network and
  operator.** `send`, `sendBitcoin` and `settle` now reject an address
  whose prefix differs from the wallet's, or whose server key is neither
  the current signer nor a deprecated signer still before its rotation
  cutoff. Before, such an address was accepted. (#675)
- **`SignerSet.deprecated` is typed `ReadonlyMap`.** The wallet hands
  out its live deprecated-signer map, which drives coin selection and
  the pending-recovery balance. Code that wrote through it no longer
  compiles. (#675)

### Features

- **`validateBatchRecipients` and `assertFinalCommitmentMatchesValidated`
  exported.** Exported so external batch handlers (the boltz-swap VHTLC
  handler) can run the same recipient check and commitment pinning as
  the wallet. (#674)

## [0.4.55] - 2026-08-04

### Features

- **Server responses are checked against locally derived data before
  co-signing.** `submitTx` responses must return the `arkTxid` (and
  `finalArkTx`, when present) that was submitted, and checkpoints that
  match the ones submitted, by txid. Pending-tx finalization rebuilds
  each checkpoint from its own VTXO. Batch finalization compares the
  commitment tx with the one validated during tree signing. A mismatch
  throws the new `ServerResponseMismatchError` (`retryable = false`); in
  pending-tx finalization the tx is skipped and stays pending.
  `assertSubmittedArkTxid` and `matchServerCheckpoints` are exported.
  (#669)
- **Settlements without offchain outputs now validate their
  recipients.** Such a settle skips tree signing, so the commitment tx
  was never checked against the requested recipients. It is now checked
  at batch finalization, before any input is signed. Missing-output
  errors from batch validation are now `ServerResponseMismatchError`.
  (#670)
- **Descriptor-scoped identity and HD wallet capability.** New
  `DescriptorIdentity` (an `Identity` pinned to one HD descriptor) and
  the `HDWalletCapable` interface with its `isHDWalletCapable` guard.
  `Wallet` implements it with `getCurrentSigningDescriptor`,
  `getUsedSigningDescriptors` and `signerForDescriptor`. Also exports
  `isHDDeterministicSignCapable` and
  `deriveDescriptorLeafCompressedPubKey`. (#662)
- **Collaborative-exit and asset-mint activity resolvers.**
  `createDefaultActivityRegistry()` now registers `collabExitResolver`
  ("Collaborative exit") and `assetMintResolver` ("Asset mint" for the
  issuer, "Asset receive" for a recipient of the genesis tx), so default
  activity groupings can include these new kinds. `ArkTransaction` now
  exposes the history builder's `tag`, typed as the open union `TxTag`.
  (#584)

## [0.4.54] - 2026-07-31

### Features

- **Payment router.** New `PaymentRouter` with pluggable rails, ranked
  by a `priority` preference, plus `options()` / `route()` and
  `AmbiguousRouteError` for `tieBreak: "require-choice"`.
  `createDefaultPaymentRouter(wallet)` registers the `ark` rail
  (`Wallet.send`) and the `onchain` rail (collaborative exit via
  `Ramps.offboard`). Quotes are receiver-exact: `amount` is delivered
  and `fee` is added on top, so the onchain rail grosses up its amount.
  Also exports `PaymentRequest`, the target predicates, and
  `resolveSendAmount` / `tryResolveSendAmount`. `BIP21` is now exported
  from the root and gains `BIP21.amountSats`. (#586)
- **Cancel a running exit `Executor` with an `AbortSignal`.** Pass
  `signal` in the executor options. Iteration then rejects with an
  error whose `name` is `"AbortError"`, including mid-poll.
  Already-broadcast transactions are not recalled. (#663)
- **`verifyTapscriptSignatures` can pin the signed leaf.** A new
  optional `expectedLeafHash` argument rejects signatures over any
  other leaf the input carries. `scriptFromTapLeafScript` is now
  exported. (#653)

### Performance

- **Transaction history fetches tx timestamps in batches.** History
  looked up each spent output's `createdAt` with one indexer call per
  ark txid. These are now batched outpoint queries, 64 outpoints per
  request. A retryable failure falls back to the previous estimate for
  that chunk. (#661)

### Internal

- **MuSig2 helpers no longer sort the caller's key array in place.**
  `aggregateKeys` and session creation sort a copy. An internal
  `partialSigVerify` was added. (#653)
- **Lint guard scripts work with Windows path separators.**

## [0.4.53] - 2026-07-28

### Features

- **Message-bus error classifiers exported.**
  `isMessageBusInitializingError` and `isMessageBusNotInitializedError`
  are exported, so callers can tell a bus that is still initializing
  from one that is not initialized. Test the initializing check first:
  its message also matches the other. (#648)

### Bug Fixes

- **Expo background task ran every ~15 hours instead of every 15
  minutes.** `registerExpoBackgroundTask` multiplied `minimumInterval`
  by 60, but `expo-background-task` already takes minutes. (#647)

## [0.4.52] - 2026-07-27

### Bug Fixes

- **The HD look-ahead window watches every receive variant.** The
  window derived only the wallet's own receive script at each index.
  A delegate wallet therefore missed funds sent to the default-variant
  address issued at that index, which only `restore()` would find.
  Handlers can now implement `Discoverable.candidatesAt`, used by both
  the window and the restore scan. `hasCandidates` and `CandidateDeps`
  are exported. (#645)

## [0.4.51] - 2026-07-24

### Breaking Changes

- **`IContractManager` gains a required `refillLookAhead()` method.**
  Custom implementations of the interface must add it (a no-op is fine
  without a look-ahead config). (#643)

### Features

- **HD look-ahead watch window.** HD wallets now watch unfunded
  offchain receive scripts within `N` indices on either side of the
  last-used index. Funds sent to an address that another party issued
  from the same seed now arrive without a `restore()`. Watched scripts
  are not stored until funded, so they do not show up in balances,
  address lists or history. Set the width with
  `WalletConfig.lookAheadWindow` (default 20, positive integer), also
  forwarded by `ServiceWorkerWalletOptions`. Refilling the window after
  a rotation is best-effort: a refill failure does not fail the rotation.
  (#643)
## [0.4.50] - 2026-07-23

### Bug Fixes

- **Retired contracts stay in background coverage.** An Ark receive
  address can be paid again after the wallet rotates past it, but
  `ContractWatcher.getWatchedContracts()` dropped inactive contracts
  once their VTXOs were spent, removing them from both the
  subscription and the sync scope. The watched set is now every
  registered contract; retirement only affects cadence and address
  selection, and `deleteContract` is what stops watching. (#636)

## [0.4.49] - 2026-07-23

### Features

- **Batched HD restore discovery.** `Discoverable` gains an optional
  `discoverRange(entries, deps)` that answers a whole scan window in
  one call; the scanner prefers it and falls back to per-index
  `discoverAt`. The `default` and `delegate` handlers implement it.
  A batched failure makes the whole range indeterminate, and an
  incomplete result map is treated as a failure. `HandlerError` gains
  an optional `toIndex`. (#635)

### Bug Fixes

- **`getVtxos` queries no longer exceed URL limits.** Scripts ride in
  the query string, so a wallet with a few hundred contracts built a
  ~28 KB URL and got a terminal 414: zero balance, and a failed
  construct on the next boot. Script lists are now chunked at 32 and
  each chunk is paged to exhaustion (`getAllNormalizedVtxos`). (#635)
- **Restore fetches full history for newly discovered contracts.** The
  post-scan `refreshVtxos` inherited the global delta cursor, already
  advanced by the boot-time reconcile, so contracts found by the scan
  were only queried for the last 24h. (#635)
- **Delegate contract params decode through the shared helpers.**
  `DelegateContractHandler.deserializeParams` now applies the same
  descriptor and missing-`csvTimelock` guards as the default handler.
  (#635)

### Performance

- **One subscription update per restore scan.** `addContract`
  re-subscribed eagerly with the whole accumulated script list, so a
  restore discovering N contracts sent N growing POSTs.
  `scanContracts` now defers watcher updates and flushes a single
  subscribe on exit, on both success and error paths. (#635)

## [0.4.48] - 2026-07-21

### Breaking Changes

- **Implementer-facing type changes for custom wallets and contract
  managers.** `IReadonlyWallet.getVtxos` now returns
  `NormalizedExtendedVirtualCoin[]` (#619), and `ScanResult` gains a
  required `highestConfirmedUsedIndex` plus optional `truncatedAt`,
  with `lastIndexUsed` kept as a deprecated alias (#630). Callers are
  unaffected; third-party `IReadonlyWallet` / `IContractManager`
  implementations must return the new shapes.

### Features

- **ArkadeCash bearer instruments.** `wallet.createCash(amount)` sends
  funds to a fresh key and returns an `arkadecash1...` (or
  `tarkadecash1...`) bech32m string; `wallet.claimCash(str)` sweeps
  every spendable VTXO at that key into the wallet, one offchain tx
  each, and reports the rest (swept, subdust, already-spent,
  has-assets, sweep-failed) with per-VTXO reasons. Nothing is
  persisted; re-running a claim drains an interrupted one. Amounts
  must be whole sats at or above dust. If funding fails after submit,
  `ArkadeCashCreateError` carries the token so funds stay
  recoverable. Exports `ArkadeCash`, `ArkadeCashCreateError` and the
  claim-result types. (#621, #633)
- **Canonical VTXO facts on `VirtualCoin`.** New optional fields
  `isSwept`, `isPreconfirmed`, `commitmentTxIds`, `expiresAt` (Date)
  and `expiresAtHeight` replace the lossy `virtualStatus`, which is
  now deprecated but still emitted. Coins returned by the SDK are
  normalized, including those from custom `IndexerProvider` and
  `WalletRepository` backends. New predicates `canSpendOffchain`,
  `canRecoverOnchain`, `hasTerminalSpend`, `isPastExpiry` and
  `isVirtualCoin` plus the `TimeHeight` type are exported;
  `isSpendable`, `isRecoverable` and `isExpired` are deprecated.
  `isSpendable` now also treats a VTXO with `spentBy` or `settledBy`
  as spent. (#619)
- **Origin-scoped rate gate with `Retry-After` backoff.** Indexer,
  `getInfo` and delegate-info GETs share a per-origin cooldown and a
  concurrency cap of 6, wait behind a 429's `Retry-After` (capped at
  60s, jittered), and GET/HEAD indexer requests retry availability
  failures a bounded number of times. Intent and settlement POSTs only
  report 429s and are never delayed or retried. (#630)

### Bug Fixes

- **Expired-but-unswept VTXOs no longer count as `available`.** Balance
  counted them as available while `send` refused them; balance and
  coin selection now read the same predicate, so they move to
  `recoverable`. Renewal and recovery fetch the chain tip once per
  pass, so height-encoded expiry is evaluated instead of ignored.
  Forfeits skip expired inputs, matching arkd. A `batchExpiry` of 0
  no longer reads as height 0. (#619)
- **Restore no longer under-reports balances under rate limiting.** A
  failed `discoverAt` probe counted toward the gap limit, so a
  rate-limited scan closed its window on failed requests. The scan now
  stops at the first indeterminate index, still persists confirmed
  hits above it, and `restore` throws an `AggregateError` naming the
  truncation index; retry is safe. (#630)
- **Deprecated-signer migration skips inputs the send path would
  reject.** One ineligible VTXO aborted the whole migration leg. Such
  inputs are now partitioned out and reported as
  `notSpendableOffchain`, with a new `"not-spendable-only"` skip
  reason when nothing is eligible. (#619)
- **Arkade batch handler distinguishes VTXOs from boarding inputs.**
  `createArkadeBatchHandler` takes `ArkadeBatchInput` (the union of
  `ArkadeExtendedCoin` and the new `ArkadeExtendedVirtualCoin`); an
  unmatched boarding input now throws with its outpoint instead of
  being skipped into an empty forfeit set. (#619)

## [0.4.47] - 2026-07-17

### Features

- **Arkade Script support.** New `arkade` namespace export with Arkade
  opcodes, `ArkadeScript` encoding and ASM conversion, script-key
  tweaks, and a high-level `Arkade` / `ArkadeContract` program API
  that compiles artifacts into contracts. Program contracts plug into
  the contract pipeline via the new `ArkadeContractHandler`
  (`ArkadeContractParams`). Adds `RestEmulatorProvider` and the
  `EmulatorPacket` extension packet for covenant paths, and exports
  the extension module (`Extension.getEmulatorPacket`,
  `getPacketByType`, `getPackets`). (#319)
- **Custom extension packets on sends.** `Recipient.extensions`
  accepts `{ type, payload }` packets that are embedded in the
  transaction's extension output alongside any asset packet. Also
  exports `createAssetPacket`, `selectCoinsWithAsset`,
  `selectVirtualCoins`, `PrevArkTxField` and `PrevoutTxField`. (#319)
- **`TapscriptDeriving` handler capability.** Contract handlers whose
  scripts have no `forfeit()` leaf can implement `deriveTapscripts` to
  supply the forfeit/intent tapscripts used for VTXO annotation.
  (#319)

### Bug Fixes

- **`Extension.create` rejects packet types outside 0-255.** The type
  tag serializes as one byte, so larger values were silently
  truncated on the wire. (#319)
- **Offchain sends validate checkpoint counts against the built set.**
  Both the signer's and the server's checkpoint arrays are now checked
  against the checkpoints actually submitted; previously two equally
  truncated arrays agreed with each other, and one path had no guard,
  so a short server response could finalize silently. A miscounting
  signer now fails before `submitTx`. (#620)

### Internal

- **Offchain submit/finalize core extracted** into `submitOffchainTx`
  with an injected signer; wallet behaviour is unchanged. (#620)

## [0.4.46] - 2026-07-16

### Features

- **arkd 0.9.14 indexer alignment.** `GetVtxosOptions` gains
  `renewableOnly`. `pendingOnly` and `renewableOnly` now join the
  client-side mutual-exclusivity check, so combining any two state
  filters throws. New `ArkErrorName` constants (`DIGEST_MISMATCH`,
  `VTXO_ALREADY_SPENT`, `INVALID_TX_FILTER`,
  `TX_FILTERS_LIMIT_EXCEEDED`, `FORFEIT_CLOSURE_LOCKED`) and an
  `isArkError(err, name?)` guard are exported. (#616, #618)

### Bug Fixes

- **Outputs exactly at the dust limit are accepted.** `sendBitcoin`
  and delegation rejected amounts `<= dust`; they now share
  `isSubdust` and reject only amounts below dust. `isSubdust` also
  accepts a bigint amount. (#614)

## [0.4.45] - 2026-07-11

### Breaking Changes

- **`IContractManager` gains a required `getSyncState()`.** Returns a
  `ContractSyncState` (`online` or `degraded` with a reason). Custom
  `IContractManager` implementations must add it. (#609)

### Features

- **Offline-first wallet boot.** Live server info is snapshotted to
  wallet state; if the operator is unreachable at `create()`, the
  wallet is built from the cached snapshot instead of throwing.
  Indexer and Ark transport failures and bodyless 429/5xx responses
  are typed as `ProviderUnavailableError`, and `ContractManager`
  initialize, reads and hydration fall back to repository data on
  those errors. A 5xx carrying a structured arkd error stays a
  terminal `ArkError`. Exports `isRetryableProviderError`. (#609)
- **Connection-state diagnostics.** `wallet.getProviderConnectionState()`
  reports `online` or `degraded` (source, provider, reason) and
  `getContractSyncState()` reports sync health. Both work across the
  service-worker boundary (new `GET_CONTRACT_SYNC_STATE`, and
  `GET_STATUS` carries the connection state); the Expo foreground
  wallet exposes `getProviderConnectionState()`. (#609)
- **Exit data captured locally for offline unilateral exit.** With a
  `virtualTxRepository` configured, the wallet captures each received
  VTXO's exit branch and prunes it on spend (ref-counted), and
  `UnilateralExit.estimate`/`prepare` read it local-first before the
  indexer. New `StorageConfig.exitDataCapture`: `mode` `"lite"`
  (default, structure only) or `"full"` (also PSBTs, so exits need no
  indexer), `minExitWorthSats` (default 1000), and extra `sources`.
  Exports `createExitChainResolver`, `ExitDataSource`,
  `ExitChainResolver` and `ExitCaptureMode`. (#608)

## [0.4.44] - 2026-07-11

### Features

- **Pre-signed unilateral exit packages.** New `UnilateralExit`
  namespace: `estimate` quotes tx count and funding without touching
  funds, `prepare` pre-signs every unroll tx plus a CSV sweep per VTXO
  to `sweepAddress` and broadcasts a fee-funding splitter, and
  `Executor` drives the package with only an Esplora endpoint, no
  keys. `mode: "graph"` defers fee funding to an executor-side
  `ExitFeeWallet`. Packages are versioned JSON
  (`serializeExitPackage` / `deserializeExitPackage`). Exit paths are
  resolved through contract handlers, so e.g. VHTLC VTXOs are
  supported; asset-bearing VTXOs are not. (#606)
- **`OnchainWallet.bumpAnchor`.** Builds and signs a CPFP child for a
  P2A parent from confirmed coins without broadcasting. `bumpP2A` now
  shares its core, sizes the fee for the actual number of inputs, and
  throws instead of creating a sub-dust change output. (#606)
- **`completeUnroll` resolves the exit path through contract
  handlers.** VTXOs with a contract row use their handler's
  unilateral paths; others fall back to the tap-tree exit paths. The
  shortest-delay path is chosen and must already be mature. (#606)

## [0.4.43] - 2026-07-08

### Features

- **Intent and virtual-tx repositories.** New `IntentRepository` and
  `VirtualTxRepository` interfaces with InMemory, IndexedDB, SQLite
  and Realm backends (SQLite/Realm via their subpaths). Passing
  `storage.intentRepository` makes `settle()` persist intent state,
  reconciles stale intents against the indexer on sync, and subtracts
  intent-locked VTXOs from `getBalance().available` only. Both are
  opt-in; the IndexedDB and Realm schemas stay at v3/v2 and the new
  stores live behind experimental schema versions, so upgrading
  migrates nothing. `virtualTxRepository` is an experimental cache
  `Unroll.Session.create` can read from. Exports `ChainedTxType`.
  (#494)
- **Deprecated-signer migration refreshes the wallet's signer cache.**
  `VtxoManager.migrateDeprecatedSignerVtxos` now calls
  `wallet.refreshDeprecatedSigners` with fresh server info first, so a
  later `settle()` excludes expired deprecated-signer inputs even in
  custom renewal loops. (#603)

### Bug Fixes

- **Typed `FetchError` for transport failures.** `fetch` / `baseFetch`
  rejections (DNS, connection refused, TLS, CORS) are rethrown as an
  exported `FetchError` carrying `url`, `method` and the original
  error as `cause`. Both now also accept a `URL` input. (#601)
- **MetaMask Snap (SES) compatibility.** `@marcbachmann/cel-js` is
  bumped from 7.3.1 to 8.0.0, whose interpreter no longer contains a
  bare `eval(` token that SES rejects. (#602)
- **`settle()` never cancels a committed batch.** If a local step
  fails after `Batch.join` returns, the server intent is no longer
  deleted; the error is still thrown. A synchronous throw from
  `eventCallback` no longer disrupts the settlement stream. (#494)
- **SQLite writes are serialized per shared connection.**
  Repositories sharing one `SQLExecutor` no longer nest
  `BEGIN IMMEDIATE` ("cannot start a transaction within a
  transaction"), and the `vtxos` table migration runs entirely in one
  transaction. (#494)
## [0.4.42] - 2026-07-06

### Bug Fixes

- **`ContractWatcher` recognises arkd's new stale-subscription error.**
  arkd changed its wording from `subscription <uuid> not found` to
  `subscription not found: <uuid>`, so the watcher never cleared a stale
  subscription id and looped on reconnect. The match now accepts both
  phrasings, clears the stale id, and creates a fresh subscription.
  (#600)

## [0.4.41] - 2026-07-01

### Breaking Changes

- **`IReadonlyWallet` gained required members: `clear()`, `activity` and
  `getActivityHistory()`.** All SDK wallets implement them; custom
  implementations of `IReadonlyWallet` / `IWallet` (shims, mocks) must add
  them to keep compiling. `ServiceWorkerReadonlyWallet.clear()` changed
  meaning: it used to delete only the current address's VTXOs on the page
  side and now has the worker wipe the whole wallet and contract
  repositories. (#579, #582)

### Features

- **Activity history: `wallet.getActivityHistory()` and
  `ActivityRegistry`.** Groups the wallet's transaction history into
  logical `Activity` rows with a signed net amount (positive received,
  negative sent; same-key change rows excluded). Apps register an
  `ActivityResolver` via `wallet.activity.use(...)` to tag their own
  transactions; a built-in `boarding` resolver is pre-registered on every
  wallet, and a transaction may belong to several groups. A resolver whose
  `prepare()` throws is isolated rather than failing the whole call.
  Exports `ActivityRegistry`, `boardingResolver`,
  `createDefaultActivityRegistry` and the `Activity`, `ActivityIntent`,
  `GroupMembership`, `ActivityResolver` types. (#582)
- **`wallet.clear()` resets all locally stored wallet data.** `Wallet`
  disposes itself and then clears both the wallet and contract
  repositories. `ExpoWallet.clear()` stops the foreground poll, waits for
  an in-flight poll to finish, wipes, and removes queued contract-poll
  tasks. IndexedDB connections now close on `versionchange`, so a database
  deletion is no longer blocked by the SDK's cached connection. (#579)

### Bug Fixes

- **Settling an unsignable boarding input fails fast with a diagnostic.**
  A boarding UTXO whose script the signer router could not resolve was
  silently left unsigned and only rejected later by arkd as "not a wallet
  script". Settlement now throws before submission, naming the outpoint,
  the unresolved address and the boarding addresses the wallet does
  recognise. It does not make such an input signable. (#567)
- **Wallet creation no longer fails when the delegate service is
  unreachable.** If `getDelegateInfo()` on the configured delegate or
  delegator provider rejects, the wallet now falls back to the plain
  default script instead of throwing from `create()`. (#594)

## [0.4.40] - 2026-06-29

### Breaking Changes

- **`Estimator.eval()` is renamed to `Estimator.evaluate()`.** MetaMask
  Snaps run bundles through SES, whose direct-eval detector rejects any
  bare `eval(` token, so the SDK could not be used inside a snap. The
  per-input helpers (`evalOffchainInput`, `evalOnchainInput`,
  `evalOffchainOutput`, `evalOnchainOutput`) keep their names. (#581)
- **`OnchainProvider.getTxOutspends()` now returns `txid?: string`.**
  Some Esplora deployments (e.g. mempool.arkade.sh) omit the spender
  txid from `/outspends`; the type now says so. Callers reading `.txid`
  must handle `undefined`. `ExplorerTransaction` also gains an optional
  `vin` array. (#587)

### Features

- **Intent proofs set BIP-322's `PSBT_GLOBAL_GENERIC_SIGNED_MESSAGE`
  (0x09).** The intent message is now written into the PSBT's global 0x09
  field, so a co-signer can recompute the `to_spend` commitment from PSBT
  data and tell an ownership proof from a fund-moving spend. (#578)

### Bug Fixes

- **Boarding sweeps no longer show up as phantom receives in transaction
  history.** When `/outspends` omitted the spender txid, `getBoardingTxs()`
  could not match the sweep's commitment, so the swept VTXO was listed on
  top of the boarding deposits and the history double-counted the
  onboarded amount. The commitment txid is now recovered from the
  boarding address's own transactions via their `vin`. (#587)
- **Service-worker init can no longer bind the message bus to a stale
  identity.** `INITIALIZE_MESSAGE_BUS` requests are serialized, wallet
  messages are rejected while an init is pending (new
  `MessageBusInitializingError` / `MESSAGE_BUS_INITIALIZING`, a subclass
  of the not-initialized error), and handlers are not ticked during
  re-init. `ServiceWorkerWallet.create()` / `reinitialize()` check the
  worker reports the expected pubkey before returning. Also, Electrum
  `getTxStatus` now matches not-in-block / missingheight errors whose
  spaces were stripped by the transport. (#571)

## [0.4.39] - 2026-06-19

No SDK changes; released alongside `@arkade-os/boltz-swap`.

## [0.4.38] - 2026-06-19

No SDK changes; released alongside `@arkade-os/boltz-swap`.

## [0.4.37] - 2026-06-18

### Features

- **`buildVersion` and `sdkVersion` are exported.** The values the SDK
  sends to arkd as `X-Build-Version` and `X-SDK-VERSION` are now part of
  the public API. (#569)

### Bug Fixes

- **`MissingSigningDescriptorError` names more causes.** The message now
  also points out that the contract may belong to a different identity
  (e.g. reused storage), and suggests deleting the contract. (#572)

## [0.4.36] - 2026-06-16

No SDK changes; released alongside `@arkade-os/boltz-swap`.

## [0.4.35] - 2026-06-15

### Breaking Changes

- **`WalletBalance` has a new required `pendingRecovery` field.** Funds
  under a deprecated server signer whose cutoff has passed cannot be
  co-signed until the server sweeps them, so they are now excluded from
  `available`, `settled` and `preconfirmed` and from send coin selection,
  but still counted in `total`. Code that builds `WalletBalance` objects
  or sums its fields must account for it. (#554)

### Features

- **Support for arkd signer rotation.** Wallets register and watch
  baseline and boarding contracts under deprecated signers as well as the
  current one. VTXOs under a deprecated signer are migrated to the active
  signer before their cutoff via a new `SettlementConfig`
  `deprecatedSignerMigration` poll pass (on by default) or explicitly via
  `VtxoManager.migrateDeprecatedSignerVtxos()`; `getDeprecatedSignerStatus()`
  reports per-signer state, and migration does not pay intent fees.
  Post-cutoff funds are recovered under the active signer once swept.
  New exports include `classifyContractSigner`,
  `classifyAgainstSignerSet`, `signerSetFromInfo`,
  `isCooperativelyMigratable`, `toXOnlySignerHex`, `BoardingUtxoGroup`
  and the migration report types. (#554)
- **Mid-session signer-change detection via `X-Digest`.**
  `RestArkProvider` sends the cached server-info digest on arkd requests.
  On a `DIGEST_MISMATCH` it refreshes `getInfo()`, notifies
  `onServerInfoChanged` listeners (the wallet uses this to rotate signer)
  and throws the new exported `DigestMismatchError`, so the caller must
  rebuild and retry. `maybeArkError` now also parses errors that carry the
  name only in the top-level message. (#554)
- **arkd requests carry `X-Build-Version` and `X-SDK-VERSION` headers.**
  Ark-server requests (including Expo's streaming fetch) send arkd's
  compatibility version and `ts-sdk/<version>`. Esplora, indexer and
  delegate requests stay header-free so their CORS preflight still
  passes. (#557, #568, #554)

### Bug Fixes

- **Settlement batches respect the server's `vtxoMaxAmount`.** Renewal,
  recovery, periodic and manual settle now also stop adding inputs once
  the output would exceed the server's per-output ceiling, skipping
  oversized inputs so smaller ones still fit; the rest settles next
  cycle. `settle()` also reads the receive address once, so a concurrent
  receive-address rotation can no longer cause a spurious "no output
  matches" error. (#553)
- **`ContractWatcher` recovers faster after a server disruption.**
  Default reconnect backoff is capped at 5s (was 30s) and the failsafe
  poll runs every 20s (was 60s). (#564)
- **Signer-rotation self-transfers no longer appear as zero-amount sends.**
  Transaction history skips a sent entry with zero net amount and no
  assets; zero-amount asset sends (issue/reissue/burn) are kept. (#566)
- **Electrum `getTxStatus` handles `RPCError`-wrapped index-lag errors.**
  Not-in-block / missingheight errors are now matched in the error's
  `.str` field too, so they return `{ confirmed: false }` instead of
  throwing. (#562)

### Internal

- **typedoc bumped and `minimatch` overridden** to fix a Node.js 24 ESM
  crash in the docs build. (#552)

## [0.4.34] - 2026-06-09

### Breaking Changes

- **The regtest default Esplora URL is now `http://localhost:3000/api`**
  (was `http://localhost:3000`), matching the arkade-regtest stack's
  mempool endpoint. Regtest setups on the old nigiri layout must pass
  their Esplora URL explicitly. (#538)

### Features

- **HD boarding-address rotation.** HD wallets now rotate the boarding
  address after a settle spends a boarding UTXO, and expose
  `getNewBoardingAddress()` and `getBoardingAddresses()`. Boarding UTXOs,
  history, sweeps and `notifyIncomingFunds` cover every boarding address,
  current and rotated, and the watcher re-subscribes when the address
  rotates. Rotated boarding inputs are signed with their per-index key,
  and `restore()` finds used boarding indices on-chain. Static wallets
  keep a single boarding address. (#542)
- **`restore()` scans deprecated server signers.** L2 discovery probes
  the server's deprecated signers as well as the current one, from a
  fresh `getInfo()` snapshot, so VTXOs created before a signer rotation
  are restored with the right key. (#545)

### Bug Fixes

- **Taproot script trees now match arkd for every leaf count.**
  `VtxoScript` builds its tree with btcd's algorithm instead of scure's
  Huffman builder, which agreed with arkd only for power-of-two leaf
  counts. For other counts the output key differed and arkd rejected
  spends with `INVALID_PSBT_INPUT`. The builder is exported as
  `assembleBtcdTaprootTree`. (#547)
- **Settlement batches are capped at 50 VTXOs.** Large wallets could
  build intents arkd rejects as `TX_TOO_LARGE`. Renewal and periodic
  settle now take the soonest-expiring VTXOs first, recovery and manual
  settle the highest-value ones; the rest settles next cycle. Recovery
  throws a separate error when the capped batch is below dust. (#549)
- **BIP21 amount validation tightened.** `BIP21.parse` accepts only the
  BIP21 amount grammar (allowing `.5` and `5.`), and both `create` and
  `parse` reject amounts beyond the safe-integer range. (#548)
- **`EsploraProvider` works against mempool-backed Esplora.**
  `getChainTip()` uses the standard `/blocks` route instead of
  `/blocks/tip`, which mempool answers with an empty array. `getFeeRate()`
  returns `undefined` on a 404 so callers fall back to the minimum fee
  rate; other failures still throw. (#538)

### Performance

- **Faster `restore()` scans.** HD indices are probed in batches capped
  by the remaining gap window, handlers run in parallel per index, and
  default/delegate candidates are checked in one indexer query. The
  discovered set is the same as a serial scan. (#545)

### Internal

- **Regtest moved off nigiri** to arkade-regtest's Node CLI stack, with
  arkd v0.9.6. (#538, #544)
## [0.4.33] - 2026-06-04

### Breaking Changes

- **`csvTimelock` is now required on `DefaultVtxo.Options` (and so on
  `DelegateVtxo.Options`).** `DefaultVtxo.Script` and
  `DelegateVtxo.Script` no longer fall back to
  `DefaultVtxo.Script.DEFAULT_TIMELOCK` when the exit timelock is
  omitted, and the wallet reads `offchainTapscript.options.csvTimelock`
  without a fallback. Code constructing these scripts directly must pass
  a `RelativeTimelock`. `DefaultContractHandler.deserializeParams` keeps
  the `DEFAULT_TIMELOCK` fallback for persisted params that carry no
  `csvTimelock`. (#518, #540)

### Features

- **New `boarding` contract type.** `BoardingContractHandler` and
  `BoardingContractParams` are exported and registered in
  `contractHandlers`. The wallet derives its on-chain boarding address
  from this handler and, on contract-manager init, persists an active
  `boarding` contract so the boarding script is watched. When the
  boarding and default scripts coincide, the row is kept as a single
  `default` contract instead of throwing. Code that enumerates contracts
  will now see rows of type `boarding`. (#533)
- **Contract handler authoring helpers exported.** `isCsvSpendable` and
  `isCltvSatisfied` are now part of the root export, so custom
  `ContractHandler`s can implement `selectPath` / `getSpendablePaths`
  without reimplementing BIP-68 / BIP-65 maturity checks. (#541)

### Bug Fixes

- **`BatchSignableIdentity` one-popup signing restored.** The move to
  per-input routing via `InputSignerRouter` (0.4.27) meant the send and
  pending-tx recovery paths signed the ark tx and each checkpoint
  separately, so `signMultiple` was never reached. When the identity is
  batch-signable and every input resolves to the baseline key, the
  wallet again calls `signMultiple` once for the ark tx plus all
  checkpoints; HD-rotated or mixed sends keep the sequential path.
  `combineTapscriptSigs` now throws an input-indexed error on an
  input-count mismatch or a missing `tapScriptSig` on either side,
  instead of appending `undefined` to the witness. (#535)
- **`waitForIncomingFunds` no longer resolves on outgoing activity.**
  `notifyIncomingFunds` also fires for spends (a `vtxo` event with empty
  `newVtxos`, a `utxo` event with empty `coins`), so the helper could
  resolve with an empty result on the spent half of a self-send. It now
  skips fund-less notifications and keeps waiting. (#536)
- **`RestIndexerProvider` reports spent VTXOs as `"spent"`.**
  `virtualStatus.state` never took the value `"spent"`, so spent VTXOs
  were reported as `"settled"` (or `"preconfirmed"` / `"swept"`). The
  spent check now comes first. (#540)

## [0.4.32] - 2026-05-29

### Bug Fixes

- **Swept boarding deposits no longer appear twice in transaction
  history.** A leaf VTXO whose `settledBy` points at an ignored boarding
  commitment was still emitted as a separate batch receive. Such VTXOs
  are now suppressed, and boarding `ArkTransaction` entries carry
  `key.commitmentTxid` (previously always `""`). (#530)
- **Boarding refills no longer produce duplicate receive entries.**
  `buildTransactionHistory` now matches each settled boarding receive
  against at most one batch-received VTXO (by commitment txid, or by
  amount and timestamp) and drops the duplicate batch entry. (#531)

## [0.4.31] - 2026-05-28

### Performance

- **`annotateVtxos` builds each contract's taproot tree once per batch.**
  `createScript()` was called for every VTXO, which dominated
  `getVtxos()` / `getBalance()` latency on long spent/swept histories.
  Tapscripts are now cached per contract for the duration of an
  annotation batch and cloned into each VTXO, so callers mutating one
  VTXO's tap leaves cannot affect another. (#529)

## [0.4.30] - 2026-05-27

### Features

- **Per-call threshold on `renewVtxos`.** `IVtxoManager.renewVtxos`
  accepts an optional second argument `RenewVtxosOptions` with
  `thresholdSeconds`, overriding `SettlementConfig.vtxoThreshold` for
  that call only. Forwarded through the service-worker bus. A
  non-finite or non-positive value throws `TypeError` before any state
  changes. `RenewVtxosOptions` is exported. (#512)

### Bug Fixes

- **`RealmLike.create` accepts a boolean `mode`.** The parameter was
  typed `string` only, rejecting Realm's boolean update flag; it is now
  `boolean | string`. (#527)

## [0.4.29] - 2026-05-26

### Breaking Changes

- **"Delegator" renamed to "delegate" across the API.** New names:
  `DelegateProvider`, `RestDelegateProvider`, `IDelegateManager`,
  `DelegateManagerImpl`, `DelegateNotConfiguredError`, the
  `delegateProvider` wallet config field and `getDelegateManager()`.
  The old `Delegator*` exports, the `delegatorProvider` config field and
  `getDelegatorManager()` remain as deprecated aliases. Not aliased: the
  public `Wallet.delegatorProvider` property is now `delegateProvider`,
  and `IWallet` implementers must add `getDelegateManager()`.
  `DelegateInfo` gains `delegateAddress`; `delegatorAddress` is now an
  optional deprecated alias, and `RestDelegateProvider.getDelegateInfo()`
  accepts either field and always returns a string `delegateAddress`.
  (#519, #520)

### Features

- **`ServiceWorkerWallet.restore()`.** Mirrors `Wallet.restore()` by
  running the gap scan inside the worker on the long-running message
  path, so the bus timeout does not race the scan. An `AggregateError`
  from the worker is rebuilt on the page with its `.errors` intact.
  Read-only worker wallets reject the call. (#501)
- **Mainnet defaults for providers and scripts.** `RestArkProvider`,
  `RestIndexerProvider`, `ExpoArkProvider` and `ExpoIndexerProvider`
  default to `https://arkade.computer`, `EsploraProvider` to the
  bitcoin mainnet Esplora URL, and `VtxoScript.address()` /
  `onchainAddress()` to the bitcoin network. URL string fields in wallet
  config (`arkServerUrl`, `indexerUrl`, `esploraUrl`, and `delegatorUrl`
  on service-worker options) are marked `@deprecated` in favour of
  provider instances; runtime behaviour is unchanged. (#511, #516)
- **`AssetManager` exported.** `AssetManager`, `ReadonlyAssetManager`,
  `IAssetManager` and `IReadonlyAssetManager` are now part of the root
  export. (#517)

### Bug Fixes

- **Partial offboard rejects sub-dust change locally.** A collaborative
  exit that would leave a change VTXO below the wallet's dust amount was
  sent to arkd and failed with a raw server error. `Ramps` now throws an
  exported `DustChangeError` (carrying `change` and `dustAmount`) so the
  caller can offer to exit the full balance instead. (#513)

## [0.4.28] - 2026-05-22

### Breaking Changes

- **Expo background-task helpers moved to
  `@arkade-os/sdk/wallet/expo/background`.** `defineExpoBackgroundTask`,
  `registerExpoBackgroundTask`, `unregisterExpoBackgroundTask` and their
  option types are no longer exported from `@arkade-os/sdk/wallet/expo`.
  The lazy `require()` there was invisible to Metro, so the Expo task
  packages never entered the bundle. `ExpoWallet.setup()` no longer
  registers the OS task and `dispose()` no longer unregisters it:
  `background.taskName` and `background.minimumBackgroundInterval` are
  removed (ignored with a console warning if still passed). Call
  `registerExpoBackgroundTask` / `unregisterExpoBackgroundTask` from the
  new subpath yourself. (#487)
- **Build output layout changed (tsup).** The package now ships a single
  `dist/` tree (`dist/index.js`, `dist/index.cjs`, per-entry `.d.ts` and
  `.d.cts`) instead of `dist/esm`, `dist/cjs` and `dist/types`. Imports
  through the documented `exports` subpaths are unaffected; deep imports
  into `dist/esm/...` or `dist/cjs/...` no longer resolve. (#496)

### Features

- **Explicit wallet restore with gap-limit discovery.**
  `Wallet.restore({ gapLimit? })` (default 20) recovers contracts and
  balance on a fresh repository: HD wallets scan indices until
  `gapLimit` consecutive unused ones, static wallets restore the single
  default key. Concurrent calls share one run, `dispose()` waits for an
  in-flight restore, and per-handler discovery failures are surfaced as
  an `AggregateError` after found funds are recovered. Backed by the new
  `IContractManager.scanContracts` (capped at index 10,000) and an
  optional `Discoverable.discoverAt` capability, implemented by the
  default and delegate handlers. `HDDescriptorProvider` gains
  `materializeDescriptorAt` and `advanceLastIndexUsed`. Exported types:
  `Discoverable`, `DiscoveryDeps`, `DiscoveredContract`,
  `isDiscoverable`, `ScanResult`, `ScanContractsOptions`,
  `HandlerError`. (#492)
- **`getRandomId` exported** from the package root, and `RealmResults`
  now declares `sorted()` and `length`. (#427)

### Bug Fixes

- **Deterministic active receive address after HD rotation.** When two
  wallet-receive contracts share a `createdAt`, the boot lookup now
  prefers the higher HD index from `metadata.signingDescriptor` instead
  of an arbitrary order. (#492)

### Internal

- **Moved to a pnpm monorepo** under `packages/ts-sdk`, built with
  tsup. `engines.node` widened from `>=22.12.0 <23` to
  `>=22.12.0 <25`. (#427, #495, #496)

## [0.4.27] - 2026-05-18

### Features

- **Opt-in HD receive-address rotation via `walletMode`.** New
  `WalletConfig.walletMode`: `'auto'` (default, currently identical to
  `'static'`), `'static'`, `'hd'` (throws at `Wallet.create` if the
  identity is not HD-capable), or a `DescriptorProvider` instance.
  In HD mode each `vtxo_received` on the current receive contract
  allocates the next index, registers a new default/delegate contract
  tagged `metadata.source = 'wallet-receive'`, and marks the previous
  one inactive (still watched while it holds VTXOs). Signing is routed
  per input to the identity or the matching descriptor, so rotated VTXOs
  can be spent. Service workers accept the string modes
  (`ServiceWorkerWalletMode`). New exports: `WalletMode`,
  `ServiceWorkerWalletMode`, `isHDCapableIdentity`,
  `MissingSigningDescriptorError`,
  `DescriptorSigningProviderMissingError`. (#489)
- **`refreshVtxos({ includeInactive: true })`.** Syncs every contract in
  the repository, not just the watcher's active set, to audit for funds
  sent to stale rotated addresses. Does not advance the sync cursor;
  ignored when `scripts` is set. (#489)
- **`ExtendedContractVtxo` type exported** for VTXOs that have been
  annotated with their contract's tapscripts. (#464)
- **Identity descriptor methods deprecated.** `isOurs`,
  `signWithDescriptor` and `signMessageWithDescriptor` on
  `SeedIdentity` and the `HDCapableIdentity` interface are marked
  `@deprecated` in favour of the same methods on a `DescriptorProvider`
  (`HDDescriptorProvider` or `StaticDescriptorProvider`). (#489)

### Bug Fixes

- **Custom `arkProvider` no longer pairs with the public default
  indexer.** When `indexerProvider` and `indexerUrl` are both omitted,
  the indexer URL is now taken from the injected `arkProvider`'s
  `serverUrl`; `Wallet.create` throws if a custom provider exposes no
  `serverUrl`. (#464)
- **`Unroll.completeUnroll` no longer throws on fractional fee rates.**
  `BigInt(feeRate)` threw `RangeError` when the onchain provider
  returned a non-integer sat/vB; the rate is now rounded up first.
  (#489)

## [0.4.26] - 2026-05-08

### Bug Fixes

- **Published `.d.ts` files use ESM-compatible relative imports.**
  Declaration files were emitted with extensionless relative specifiers,
  which TypeScript consumers on `moduleResolution: "node16"` /
  `"nodenext"` could not resolve. The build now adds `.js` extensions to
  relative imports in `dist/types` as well as `dist/esm`, including
  `import()` type references. (#485)

### Internal

- **TypeDoc comments clarified** on `VirtualCoin` fields (`isSpent`,
  `settledBy`, `spentBy`, `arkTxId`) and default constants switched to
  `as const`. (#484)

## [0.4.25] - 2026-05-07

### Features

- **Script-scoped `WalletRepository` methods.** Optional
  `getVtxosForScript`, `saveVtxosForScript` (keyed by the new
  `VtxoRepositoryKey`) and `deleteVtxosForScript` are implemented by the
  bundled IndexedDB, in-memory, SQLite and Realm backends. Contract-scoped
  reads and writes use them when present; custom repositories without
  them fall back to address-based storage filtered and validated by
  script. (#482)
- **`IContractManager.refreshOutpoints(outpoints)`.** Re-fetches the
  given outpoints from the indexer and upserts them under their owning
  contract, without moving the sync cursor. Also available through the
  service worker. Custom `IContractManager` implementations must add it.
  (#477)

### Bug Fixes

- **`VTXO_ALREADY_SPENT` recovery targets the rejected outpoint.** The
  previous recovery was a cursor-bounded `refreshVtxos()`, which can
  never see an old VTXO that was spent recently, so auto-renewal retried
  the same stale VTXO every poll interval. When the server error carries
  `metadata.vtxo_outpoint`, the wallet now refreshes that outpoint
  directly; it still falls back to `refreshVtxos()` otherwise. (#477)
- **Settle inputs are re-checked against the indexer before submit.**
  `VtxoManager` refreshes the candidate outpoints before both renewal and
  periodic settle and drops any now reported spent, avoiding a rejected
  intent round-trip. A failed pre-check falls back to the original
  candidates. (#478)

## [0.4.24] - 2026-05-06

### Features

- **Unroll steps expose the package to broadcast.** `Unroll.UnrollStep`
  now carries `pkg: [parent, child]`; the P2A fee bump runs when the step
  is produced rather than inside `do()`. The tapscript decoder namespaces
  gain `isScriptValid(script): true | Error` for validating a leaf without
  catching exceptions. (#479)

### Bug Fixes

- **VTXOs are gated by owning script on every contract-scoped read and
  write.** Legacy address buckets could hold rows for a different script,
  which leaked into contract VTXO lists, won `txid:vout` dedup, and could
  seed the watcher baseline so it emitted a phantom `vtxo_spent`. Rows
  are now filtered by script; background sync skips mismatches with a
  warning. After a send or settle, spent inputs are persisted under
  their own contract's address, and a failure to persist now rejects the
  `send` / `settle` call instead of being logged and swallowed. An
  undecodable wallet address in cached reads now throws instead of
  returning a zero balance. (#481)
- **`refreshVtxos()` with no options syncs incrementally again.** It
  passed an empty `window` object, which bypassed the cursor-derived
  window, so every call re-downloaded the full VTXO history and never
  advanced the cursor. (#476)
- **`Unroll.completeUnroll` builds the output for the wallet's
  network.** The output address was decoded as mainnet, so regtest and
  testnet addresses failed with `Unknown letter`. (#479)

### Internal

- **BIP-68 helpers centralised** in `src/utils/timelock.ts`;
  `timelockToSequence` / `sequenceToTimelock` keep the same root exports.
  (#412)

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
