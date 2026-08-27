# Arkade Swap SDK v2: High-Level Roadmap

Status: draft for refinement. Source of truth for *what* we're building:
[`v2-api-spec.md`](./v2-api-spec.md). Direction record: [`v2-rfc-lite.md`](./v2-rfc-lite.md).
RFQ constraints: [`v2-open-rfq-notes.md`](./v2-open-rfq-notes.md).

Each milestone below is deliberately coarse. We refine one milestone into tasks
before starting it; earlier milestones must not be over-specified here.

Ordering rationale: type foundation -> corridors -> quote -> accept/persist ->
drive/watch -> remaining surface -> verbs -> deprecations/docs. Each layer only
depends on layers before it, so the client is demo-able (read-only quote) by M3
and value-moving by M4.

---

## M0 — Direction lock & groundwork

> Refined: [`v2-m0-groundwork.md`](./v2-m0-groundwork.md).

Close the decisions that gate implementation, before writing v2 code.

- Sign-off on P1–P10 (RFC-lite) as the fixed public direction.
- Resolve blocking open questions: Q1 (naming), Q2 (`resolve()` without a
  discovery snapshot: partial route vs `DiscoverySnapshotUnavailable`),
  Q3 (manual lifecycle shape + `client.ready` failure semantics),
  Q5 (CAIP-19 alias/canonicalization rules), Q6 (Arkade Service URL source),
  Q8 (BOLT11 decoder choice + validation rules).
- Record deferral decisions with reserved names: Q4, Q7, Q9.
- Decide the accept-idempotency rule (spec §3.2: quote id *or* deterministic
  accept id — pick one) and the Node SQLite default path/ownership (spec §3).
- Inventory every v1 root export -> its §8 disposition; produce the concrete
  deprecation map that M8 will execute.
- Confirm alignment with PR #793 (facade ownership) and PR #738 (package
  boundary precedent).
- Hygiene fixes, independent of v2: `rate_limited` refusal-set doc drift and
  dev-transport responder authentication (open-RFQ notes §7, "Observed Drift").

**Exit:** decisions recorded (RFC-lite addendum or spec edits); deprecation map
exists; no v2 code yet.

## M1 — Type foundation

Everything imports this; it is pure types plus the amount codec, no behavior.

- `AssetId` (CAIP-19) + registry-backed alias layer mapping public ids to
  discovery/RFQ pair strings (`arkade:BTC->lightning:BTC`) per Q5; ticker
  aliases canonicalize here.
- `CorridorId`, `Endpoint`, `Instrument`, the closed `Route` union
  (`onchain -> arkade` excluded by construction), `Artifact`.
- Amount law: `bigint` in memory, `Amount.parse`/`Amount.format` at UI edges,
  decimal strings at record/wire boundaries.
- RFQ amount adapter: parse canonical decimal strings, accept non-negative
  safe-integer JSON numbers during migration, refuse unsafe narrowing as
  `AmountEncodingUnsupported`.
- `SwapError` taxonomy (spec §7) as typed errors.
- Package layout decision: where the v2 client lives and how `/protocol`
  re-exports will be shaped (execution is M8, layout is decided now).

**Exit:** type-level tests — unsupported routes unrepresentable after
resolution; amount round-trips; alias map covers all four implemented routes.
Depends on: M0.

## M2 — Corridor modules

Internal modularity per spec §6 — *not* the public third-party plugin API (Q7
deferred).

- Corridor module contract: parse claim over destination strings, instrument
  type, deps, settlement watcher, outcome translation hooks.
- `arkade` (wallet + operator stream), `lightning` (built-in BOLT11 decoder per
  Q8, ephemeral self-claim seal default, optional covclaimd deployment key),
  `onchain` (Arkade-provided chain source, esplora override).
- `CorridorOverrides` semantics: replace deps only, never enable routes, never
  select solvers; explicit null override -> `MissingCorridorDep` at quote time.
- Destination parsing boundary: bolt11 / Arkade address / `bc1...` /
  `AmbiguousDestination` — the single place `to` is parsed.

**Exit:** parsing matrix tests; corridor override and missing-dep tests.
Depends on: M1.

## M3 — Quote path

First developer-visible value: `resolve()` and `quote()` work, nothing moves.

- Discovery: network + registry inferred from wallet; injected/cached snapshot
  semantics for offline `resolve()` per Q2.
- Market resolution: `(give.asset, take.asset, corridors)` -> market card ->
  backend (feed-priced vs RFQ); `policy.selectMarket` veto; market provenance
  carried on every `Quote`.
- `quote()`: amount pinning rules (`AmountMismatch` before any round trip),
  addressed RFQ via the card's transport, feed-priced offer terms, quote TTL.
- Quote verification as invariant: pair match, locally derived contract
  address, invoice consistency, refund window sanity -> `QuoteVerificationError`;
  solver decline stays `SwapRefusal`.
- Reserved-but-inert published-RFQ surface: `policy.rfq`, `policy.selectBid`,
  `Quote.auction` typed, never populated.

**Exit:** `quote()` green for all four implemented routes against fixtures +
regtest; verification-failure tests; `onchain -> arkade` returns
`UnsupportedRoute` before disclosure. Depends on: M2.

## M4 — Accept & persistence

Value moves; the crash windows become the test matrix.

- Persist-first invariant: full record + secrets before funding, funding txid
  after.
- Idempotent `accept()` per the M0 rule: duplicate accept returns/resumes the
  existing record; `AcceptConflict` only for incompatible durable evidence.
- Funding packets: offer extension attached on asset-swap routes (v1's
  fund-without-extension mode unrepresentable); lockup funding on corridors.
- Storage defaults: IndexedDB in browser; file-backed SQLite in Node (path and
  connection ownership per M0); in-memory only as explicit ephemeral/test mode.
- Internalized secrets: ephemeral sealing key, preimage persistence,
  `InsufficientFunds` (v1 `validatePlan`) checked before accept.
- Recovery reconcile-from-evidence before any funding retry; `QuoteExpired`
  on late accept, never silent re-quote.

**Exit:** crash-window matrix (before persist / after persist / after funding /
after txid) with reconcile tests; duplicate-accept tests incl. receive-route
artifact stability. Depends on: M3.

## M5 — Drive, watch, outcomes

The client becomes self-driving and speaks one outcome vocabulary.

- Lifecycle: `drive: "auto" | "manual" | "readonly"`, restore-read on
  construction, arm-on-live-work / arm-on-first-accept, idempotent
  `start()`/`stop()`, terminal `[Symbol.asyncDispose]` that preserves durable
  records and registrations; `client.ready` failure semantics per Q3.
- Poll loop as correctness mechanism; contract-event subscription as
  latency-only optimization (safe to drop).
- Automatic claim on funding with expected-amount enforcement (short-funded
  lockups refuse preimage reveal); automatic refund after `refundLocktime`.
- `Outcome` translation (P6): trader-centric enum, receive-leg solver reclaim
  is `lapsed`, raw protocol state on `detail`; replay-on-subscribe, idempotent
  delivery per swap+outcome.
- `needs_recovery` surfaced, never silently retried; `client.recover(swapId)`.

**Exit:** outcome translation tests across both contract kinds and both
directions; lifecycle tests incl. double-arm and concurrent-driver reconcile.
Depends on: M4.

## M6 — Remaining client surface

- `cancel(swapId: AssetSwapId)`: asset swaps only, fill-race reconciled to
  `{ outcome: "filled" }`, corridor ids rejected as `NotCancellable`.
- `swaps(filter?)` full history across both contract kinds; `markets()` escape
  hatch; `onUpdate` final wiring; `ClientDisposed` enforcement.

**Exit:** cancel race tests on regtest; error-coverage pass against spec §7.
Depends on: M5.

## M7 — Swap verbs

Product layer on the same facade (P8); adds no capability, subtracts vocabulary.

- `pay(destination, { amount?, maxFee? })`, `receive(opts)`,
  `exchange(opts)` — each compiles to `QuoteInput` -> `quote` -> fee ceiling
  check -> `accept`.
- `MaxFeeExceeded` rejects before funding with the quote attached for
  re-presentation.
- Decide behavior for `pay` to a plain Arkade address (spec §5: "not this
  SDK's concern" — passthrough to wallet send vs typed rejection).

**Exit:** verb -> QuoteInput compile tests; one end-to-end product-level
integration test per verb on regtest. Depends on: M6.

## M8 — Deprecations, docs, migration

- v1 building blocks re-exported from `/protocol` with `@deprecated` pointers;
  root export slimmed to the v2 surface (layout per M1, window per Q4).
- Integration docs rewritten to the RFC-lite four lines; `MIGRATION.md`
  updated; README and examples aligned.

**Exit:** a consumer migrating from v1 touches only imports + the four-line
integration; no bold warnings remain. Depends on: M7.

---

## Deferred tracks (post-v2, each its own milestone when scheduled)

Parking lot with re-entry criteria, so reserved names don't ossify:

1. **Published RFQ client** — scope is open-RFQ notes §7: publisher/subscriber
   path, `policy.rfq`/`selectBid` activation, bid provenance + persistence,
   timing invariants, flat-fee bid representation, rendezvous relay rules,
   dev-transport attribution. Re-entry: protocol §4.6 server-side in regular
   use + a second corridor solver exists.
2. **`onchain -> arkade` route** — re-entry: the manager owns the trader's L1
   refund path end to end.
3. **EVM corridor (spec §9)** — re-entry: the full corridor plugin contract
   (Q7) exists; until then §9 stays draft-only.
4. **BOLT12 reusable instruments; cooperative corridor cancel** — both are
   protocol extensions, not SDK flags.

## Cross-cutting

- Tests land with each milestone: unit per module, regtest integration per
  CONTRIBUTING.md for quote/accept/cancel/drive paths.
- NArk alignment check per AGENTS.md at each milestone boundary; deliberate
  divergences (e.g., single CAIP-19 BTC id) documented in the spec's TODO list.
- `ts-sdk` core stays independent of the swap package; shared primitives are
  promoted into core, never copied outward.
