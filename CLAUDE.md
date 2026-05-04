# ts-sdk Agent Guide

`@arkade-os/sdk` — TypeScript SDK for building Bitcoin wallets on the Arkade
protocol. See [`README.md`](README.md) for the public API and usage; this file
captures the conventions an agent needs to do recurring repo work
(version bumps, changelog entries, PRs).

## Version Bumps

- When asked to bump the version, find the diff since the last version-bump
  commit. Releases land as `chore: release X.Y.Z` commits (see
  `scripts/release.sh` and recent `chore: release 0.4.x` commits) — use
  `git log <last-release-commit>..HEAD` and `git diff <last-release-commit>..HEAD`
  to enumerate user-visible changes.
- Run `pnpm lint` and `pnpm test:unit` before bumping. Only run
  `pnpm test:integration` if the change plausibly touches the e2e path; it
  needs `nigiri` running.
- Use `pnpm release` (or `pnpm release:dry-run` first) to drive the bump —
  don't edit `package.json` `version` by hand. The script handles the bump,
  tag, and branch.
- ALWAYS update `CHANGELOG.md` in the same release commit. Never bump without
  a changelog entry.

## Changelog

- File lives at `CHANGELOG.md` at the repo root. If it doesn't exist yet on
  first bump, create it with a `# Changelog` heading and start the
  `## [X.Y.Z] - YYYY-MM-DD` section.
- Group changes under these headings, in this order, omitting any that are
  empty:
  - `### Breaking Changes` — public API removed or changed in a way that
    requires consumer updates. Include the migration in the entry itself.
  - `### Features` — new public capability.
  - `### Bug Fixes` — defect fixes. This is the most common section.
  - `### Performance` — speed/memory wins with no behavioural change.
  - `### Observability` — log/metric/trace additions with no behavioural
    change.
  - `### Internal` — refactors, build, test infra. Keep terse; consumers
    don't need detail here.
- Entry style: lead with a **bolded one-line headline** that names the
  user-visible symptom or the new capability, then a short paragraph
  explaining the root cause and what specifically changed. Reference
  affected files/classes by name. Linking the PR is fine but not required.
- Write for someone reading the changelog a year from now to understand
  *why* a release exists, not just what files moved. Vague entries
  ("fix bugs", "improve stability") are worse than no entry.

### Example entry shape

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Bug Fixes
- **`ElectrumOnchainProvider.getTxStatus` returned "confirmed" for
  unconfirmed txs when the server's index lagged the mempool.** Fulcrum
  briefly returns `missingheight` from `transaction.get_merkle` for txs
  that are in the mempool but not yet indexed; the provider was treating
  that as an error and falling through to the confirmed branch. Now
  treated as unconfirmed (matching the Esplora provider).

### Performance
- ...
```

## Coding & PR Conventions

- Match the existing style of the file you're editing. Don't reformat
  adjacent code that's unrelated to your change.
- Conventional commit prefixes are used: `feat`, `fix`, `test`, `chore`,
  `docs`, `refactor`, optionally with a scope (`fix(electrum): ...`).
- Tests live under `test/` (unit) and `test/e2e/` (integration). Don't
  skip or filter failing tests to make CI pass — fix the root cause or
  ask. For bugs, the cleanest path is a failing test first.
- Run `pnpm format` and `pnpm lint` before pushing. CI will reject
  formatting drift.
- Keep `README.md` in sync when public API or supported environments
  change.

## Repository Layout

Quick map for orientation; read the files for detail.

- `src/wallet/` — `Wallet`, `ReadonlyWallet`, `OnchainWallet`,
  `ServiceWorkerWallet`, settlement/renewal config.
- `src/identity/` — `MnemonicIdentity`, `SeedIdentity`, `SingleKey`,
  readonly variants, `BatchSignableIdentity`.
- `src/providers/` — `ArkProvider`, `IndexerProvider`,
  `EsploraProvider`, `ElectrumOnchainProvider`, default URLs.
- `src/contracts/` — VTXO contract handlers (Arkade-native, VHTLC, etc.)
  and the `ContractManager` / `ContractWatcher` orchestration. See
  [`CONTRACTS.md`](CONTRACTS.md) for ownership boundaries.
- `src/repositories/` — `WalletRepository`, `ContractRepository`,
  IndexedDB / SQLite / Realm / in-memory implementations, migrations.
- `src/worker/` — service-worker (browser) and Expo background-task
  orchestrators sharing a common message-bus pattern.
- `src/intent/`, `src/musig2/`, `src/tree/`, `src/forfeit.ts` —
  protocol-level pieces (intent registration, MuSig2 signing, tree
  construction, forfeit).
- `src/adapters/` — opt-in environment glue (Expo providers, storage
  adapters for AsyncStorage / IndexedDB / file system / localStorage).
- `examples/` — runnable usage examples; keep these working when
  changing public API.
- `regtest/` — Docker compose stack used by integration tests.

Update this section when the directory layout changes meaningfully.
