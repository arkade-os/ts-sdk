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

- [ ] **B1 — Naming (Q1).** Ratify `give`/`take` and `lapsed` (spec already
  uses them everywhere — changing either is a spec-wide rename) or pick
  alternatives now, before M1 types crystallize. Recommendation: ratify as-is.
- [ ] **B2 — `resolve()` without discovery (Q2).** The spec TODO offers two
  shapes; pick one:
  - *Throw* `DiscoverySnapshotUnavailable` — one result shape, no half-resolved
    route to misuse. Offline apps inject or warm discovery explicitly.
  - *Partial route shape* — corridor-parsed route with market unresolved;
    friendlier to pre-veto UX but adds a third route state to the type system.
  Recommendation: throw. Deliverable: §3.1 TODO replaced by the chosen rule.
- [ ] **B3 — Lifecycle shape + `client.ready` failure semantics (Q3).**
  Two sub-decisions:
  - start/stop exposure: always-present idempotent methods (spec §3 as drawn)
    vs manual-mode-only. Recommendation: always-present.
  - `ready` failure: enumerate the cases — corrupt records, missing corridor
    deps, a first restore pass producing `needs_recovery` — and pick reject vs
    resolve-with-report per case. Recommendation: `ready` never rejects on
    per-swap problems (they surface via `swaps()`/`onUpdate` as
    `needs_recovery`); it rejects only on repository-unreadable and
    construction-level dependency failures.
  Deliverable: §3 TODO replaced by the semantics table.
- [ ] **B4 — CAIP-19 alias registry (Q5).** The concrete mapping rules between
  public ids and today's discovery/RFQ pair strings:
  - The canonical table: one CAIP-19 BTC id ↔ `btc` on each corridor leg;
    `arkade:<genesis>.<idx>` ↔ asset id forms used by `rfqPair`/offer TLV
    (the endianness/identity forms pinned by `test/rfq.test.ts` and
    `test/offer.test.ts` shared vectors must round-trip through it).
  - Where the registry lives: swap package module vs solver-discovery.
    Recommendation: swap package, injected registry data, defaults from
    discovery.
  - Ticker alias rules ("BTC", "USDT"): case, collisions, network scoping.
  - Write the deliberate divergence from NArk's corridor-specific BTC asset
    model into the FAQ TODO (§"What about assets on other networks?").
  Deliverable: mapping spec appendix + §2 Decision/TODO resolved.
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
- [ ] **B6 — BOLT11 decoder (Q8).** Ground truth: core deliberately carries no
  bolt11 dependency (`ts-sdk/src/payment/predicates.ts`); `boltz-swap` uses
  `light-bolt11-decoder`; swap today requires caller-injected `InvoiceFacts`.
  - Decoder: adopt `light-bolt11-decoder` as a swap-package dependency
    (matches boltz-swap, keeps core clean), wrapped behind the corridor's
    overridable `decode` dep from §6.
  - Validation rules to pin: amountless invoices (reject on send routes —
    the invoice is the amount pin), expiry (reject expired; enforce a
    minimum validity headroom consistent with `assertFundable`'s invoice
    gates), payment-hash extraction, network check (hrp prefix vs wallet
    network; regtest/signet handling).
  Deliverable: decoder + validation rules written into §6's TODO.

## C. Accept idempotency rule (spec §3.2)

- [ ] **C1 — Pick the idempotency key.** The spec says "by quote id *or* a
  deterministic accept id"; choose:
  - *Quote id*: simplest; but feed-priced offer quotes have no solver-minted
    id, so the client mints one at quote time — quote id becomes
    client-minted everywhere, carried on `Quote.id`.
  - *Deterministic accept id*: hash of the canonicalized quote content;
    identical terms dedupe across re-quotes, but two legitimately separate
    accepts of identical terms collapse into one record.
  Recommendation: client-minted quote id as the sole key; deterministic
  content-hash dedupe is a policy concern, not identity. Also define
  `AcceptConflict` field-by-field: which persisted fields, differing from the
  incoming quote, constitute "incompatible" vs benign.
  Deliverable: §3.2 amended to one rule + the conflict field list.

## D. Node SQLite defaults (spec §3, Storage)

- [ ] **D1 — Default database path.** Options: platform config dir
  (XDG / `~/Library/Application Support` / `%APPDATA%`), `~/.arkade/`, or
  cwd-relative. Per-network filename, per-registry namespacing already exists
  via the repository prefix. Recommendation: platform config dir under
  `arkade/swaps/`, `swaps-<network>.sqlite`.
- [ ] **D2 — Connection ownership.** Rule: the client closes connections it
  created on `stop()`/dispose; injected repositories are never closed by the
  client. Deliverable: both written into §3, resolving its TODO.

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
