# v2 Roadmap — M0 Detail: Direction Lock & Groundwork

Refines [`v2-roadmap.md`](./v2-roadmap.md) M0 into actionables. Reply by ID
("B2: prefer throw", "E1: land as-is"). Every decision lands as an edit to the
spec that owns it (RFC-lite, API spec, or this file) — no unrecorded outcomes.

M0 is done when: every Q has a recorded decision, every spec TODO listed here
is resolved in place, PR #803 and #793 are merged or consciously descoped (in
that order — see execution order), and the deprecation map (F1) exists. No v2
code ships in M0 except G2 if chosen.

---

## A. Direction sign-off

- [ ] **A1 — Ratify P1–P10.** Sign-off on RFC-lite proposals as the fixed
  public direction. Deliverable: a "Decisions" section appended to
  `v2-rfc-lite.md` marking each P accepted / amended / rejected.
- [ ] **A2 — Record deferrals with reserved names.**
  - Q4 (migration window): confirm one major version of `/protocol`
    re-exports, or amend §8.
  - Q7 (corridor plugins): confirm internal-only for v2; §6 keeps its
    WARNING/TODO as-is.
  - Q9 (published-RFQ names): confirm the reserved set — `policy.rfq`,
    `policy.selectBid`, `Quote.auction`, bid timing/provenance fields —
    and freeze anything beyond it out of v2 scope.
  Deliverable: deferral table in the RFC-lite Decisions section.

## B. Blocking decisions

Each: write the decision into the spec where its TODO sits today.

- [x] **B1 — Naming (Q1).** RESOLVED: ratified `give`/`take` and `lapsed`
  as-is; recorded in RFC-lite Decisions. (Was: ratify or rename now, before
  M1 types crystallize — the spec already uses both everywhere, so a rename
  would have been spec-wide.)
- [x] **B2 — `resolve()` without discovery (Q2).** RESOLVED: throw
  `DiscoverySnapshotUnavailable`; §3.1 amended. A partial route shape would
  have been a third route state the type system deliberately excludes; offline
  callers inject or warm a snapshot.
- [x] **B3 — Lifecycle shape + `client.ready` failure semantics (Q3).**
  RESOLVED: always-present idempotent `start()`/`stop()` as drawn in §3;
  `ready` failure semantics written into §3 — rejects only on an unreadable
  repository, per-record/per-swap problems surface as outcomes (corrupt
  records filtered per the v1 store's rule; `needs_recovery` via
  `swaps()`/`onUpdate`; missing corridor deps stay quote-time
  `MissingCorridorDep`).
- [x] **B4 — CAIP-19 alias registry (Q5).** RESOLVED: swap-package module,
  discovery-fed with injected overrides; tickers case-insensitive,
  network-scoped, collisions rejected; arkade identity form (the
  endianness-pinned covenant/TLV form from the `test/offer.test.ts` /
  `test/rfq.test.ts` shared vectors) round-trips byte-for-byte; the NArk
  divergence is documented. Rules written into §2 and the FAQ; RFC-lite
  Decisions record it.
- [ ] **B5 — Arkade Service URL source (Q6).** Ground truth has moved: open
  **PR #803** is the "neutral core API" the spec has been waiting for. It adds
  `IReadonlyWallet.getArkadeInfo()` (live info with cached-snapshot fallback)
  and strips `arkServerUrl` from the five covenant-deriving entrypoints
  (`createOffer`, `requestLightning*`, `requestOnchain*`), which now call
  `wallet.getArkadeInfo()`. It deliberately retains `arkServerUrl` only in
  `cancelOffer` and `watchOfferSwaps`, which need broadcast/indexer access
  beyond `getInfo`.
  - If #803 lands, the v2 decision is largely made: server *info* comes from
    the wallet; the residual question is whether the client's arkade corridor
    needs provider capabilities beyond `getArkadeInfo()` (broadcast, indexer
    — the same seam #803 left in `cancelOffer`/`watchOfferSwaps`), or whether
    the client drives those through wallet/provider wiring instead of a raw
    URL.
  - Actions: (1) review/track #803 as an M0 dependency — B5 cannot be
    written into the spec until its fate is known; (2) decide the residual
    broadcast/indexer seam; (3) only then resolve §3's config TODO.
  Recommendation: block B5's spec edit on #803 merging, then source all
  server info from the wallet and keep `arkServerUrl` config only if the
  broadcast/indexer seam still needs it (likely for watcher/refund paths, in
  which case it stays as a corridor dep, not client config).
  Deliverable: §3 config TODO resolved against #803's actual merged shape.
- [x] **B6 — BOLT11 decoder (Q8).** RESOLVED: `light-bolt11-decoder` as a
  swap-package dependency behind the lightning corridor's overridable `decode`
  (core stays bolt11-free; matches `@arkade-os/boltz-swap`); validation rules
  written into §6 — hrp prefix vs wallet network, payment-hash extraction,
  expired/insufficient-headroom rejected, amountless rejected on send routes.

## C. Accept idempotency rule (spec §3.2)

- [x] **C1 — Idempotency key.** RESOLVED: client-minted `Quote.id` is the sole
  key (minted at quote time, which also covers feed-priced offers that have no
  solver-minted id); content-hash dedupe stays a policy concern, not identity.
  `AcceptConflict` compares pair, assets, amounts, instrument, lock hash,
  `refundLocktime`, and solver/registry; a previously-missing funding txid is
  a benign resume, never a conflict. §3.2 amended; old text reviewed first.

## D. Node SQLite defaults (spec §3, Storage)

- [x] **D1 — Default database path.** RESOLVED: platform config dir (XDG /
  `~/Library/Application Support` / `%APPDATA%`) under `arkade/swaps/`,
  `swaps-<network>.sqlite`. §3 amended; TODO resolved.
- [x] **D2 — Connection ownership.** RESOLVED: the client closes connections
  it created on `stop()`/dispose; injected repositories are caller-owned and
  never closed by the client. §3 amended with D1.

## E. PR alignment

- [ ] **E1 — PR #793 (`createSwapClient`, OPEN).** It is the v1-era facade:
  `SwapQuoteInput` kinds + `resolveKind` are exactly the surface §8 deprecates,
  but its 490 lines wire `RfqSwapManager` + `watchOfferSwaps` into one client
  — the orchestration substrate M5's drive layer needs. Decide:
  - *Land as the v1 facade* (re-exported from `/protocol` later), v2 client
    built fresh on its wiring; or
  - *Re-scope the PR* to land only the orchestration wiring under an internal
    name, skipping the v1 public facade entirely.
  Recommendation: re-scope — shipping a public v1 facade that §8 immediately
  deprecates creates a migration we don't need. Deliverable: PR updated or
  superseded, and merged.
- [ ] **E2 — PR #738 (MERGED).** Record as the package-boundary precedent in
  the RFC-lite Decisions section. No work.

## F. Deprecation map

- [ ] **F1 — Export inventory.** Walk the current root `src/index.ts`
  (242 lines) and produce the table M8 executes mechanically: every export →
  v2 disposition (`/protocol` re-export | internalized into the client |
  deleted) → replacement if any. §8 gives the disposition for the documented
  surface; this catches everything else (`spendUpdate`, `classifySpend`,
  profile parts, `arkadeRefunder`, lockup-contract helpers, activity
  resolvers, ...). Deliverable: appendix table, either here or in §8.

## G. Hygiene fixes (independent of v2; can ship immediately)

- [ ] **G1 — `rate_limited` doc drift.** The code's closed refusal set
  includes it (`src/rfq.ts` `RfqRefusalReason`); the docs' closed set
  (`intents/reference/rfq.mdx`) doesn't. Action: PR to `arkade-os/docs`
  adding `rate_limited`; code is authoritative.
- [ ] **G2 — Dev-transport responder authentication.** `relayTransport`/
  `httpTransport` resolve the first frame with a matching `rfq_id`, no author
  check (`rfq.ts` reply path); production Nostr authenticates via author
  filter + conversation key + event signature. Open-RFQ notes §4.2 flag this
  as inherited-by-construction risk for any open mode. Action: give
  `expectQuote` an optional expected-`solver_pubkey` check and wire it into
  the dev transports; document that production addressing, not this check,
  authenticates Nostr replies. Small, testable, unblocks nothing but removes
  a known trap before M3 builds on these transports.

---

## Suggested execution order

A1 → (B1, B4, B6 in parallel — they gate M1/M2) → (B2, B3, C1, D1, D2 — gate
M3–M5) → F1 → G1/G2 anytime. A2 ratifies last, once the B decisions show what
actually got reserved.

B5 and E1 are PR-tracked, not spec-editable yet: both wait on open PRs that
touch the same swap entrypoints (`offer.ts`, `rfq.ts`). Sequence them: land
**#803 first** (it removes `arkServerUrl` from the covenant-deriving
entrypoints and gives the wallet `getArkadeInfo()`), then re-scope/land
**#793** on top of it — #793's `createSwapClient` wiring currently constructs
`RestArkProvider` from `arkServerUrl` and would conflict. Then write B5's spec
edit and finish E1.
