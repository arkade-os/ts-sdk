# Contributing

## Integration testing (regtest stack)

Integration tests live in `test/e2e/` within each package and require the Docker regtest stack.

`test:integration` runs each package's full cycle (reset + up + setup + test) via
`scripts/regtest.sh <pkg> cycle`, using `packages/<pkg>/.env.regtest`.

```bash
pnpm run test:integration              # Every package, end-to-end
pnpm run test:integration:sdk          # sdk only
pnpm run test:integration:boltz-swap   # boltz-swap only
pnpm run test:integration:swap         # swap only
pnpm run test:integration:swap-rfq     # swap's RFQ corridor only
```

Each package's stack is configured by its own env file — `packages/<pkg>/.env.regtest` — except
`swap-rfq`, which is a second profile of the `swap` package configured by
`packages/swap/.env.regtest.rfq`. The two swap corridors need opposite arkd timelock *types* —
block-typed for offers, seconds-typed for RFQ — and one arkd cannot serve both, so each profile gets
its own stack. They share ports, so only one can be up at a time locally; CI runs them as separate
matrix jobs.

### Per-package stack control

Replace `:sdk` with `:boltz-swap`, `:swap`, or `:swap-rfq` for the other packages.

```bash
pnpm run regtest:up:sdk
pnpm run regtest:setup:sdk
pnpm run regtest:test:sdk                          # whole e2e suite
pnpm run regtest:test:sdk test/e2e/asset.test.ts   # or selected files only
pnpm run regtest:down:sdk
pnpm run regtest:reset:sdk
```

CI fans the sdk e2e suite out across parallel groups by passing each group's file list to
`regtest:test` (see the `integration` matrix in `.github/workflows/ci.yml`).

### The stack itself

`regtest/` is a git submodule pointing to
[arkade-regtest](https://github.com/ArkLabsHQ/arkade-regtest). It manages a Docker Compose stack
(Bitcoin Core, Fulcrum, mempool, NBXplorer, arkd, boltz, LND, fulmine, and supporting services)
driven by the in-house Node CLI `regtest.mjs`. Use `node regtest/regtest.mjs start` / `stop` /
`clean`, or the `scripts/regtest.sh` controller.

Run `git submodule update --init` after cloning.

## Releasing

Package-scoped release orchestrator. Target is `sdk`, `boltz-swap`, `swap`, or `all`.

```bash
pnpm run release -- boltz-swap patch          # Boltz bugfix only
pnpm run release -- swap patch                # Swap bugfix only
pnpm run release -- sdk patch                 # SDK + dependent boltz-swap/swap patch
pnpm run release -- sdk prepatch --preid beta # Mirrors prerelease into the dependents
pnpm run release -- all patch                 # Bump every package
pnpm run release:dry-run -- sdk patch         # Preview without changes
pnpm run release:cleanup                      # Auto-detect dirty release artifacts
```

Tags are `<package-name>/<version>` — e.g. `@arkade-os/sdk/0.4.57` (no `v<version>`).

Bumps accept `patch | minor | major | prepatch | preminor | premajor | prerelease` or a literal
semver such as `0.5.0-beta.0`. Prerelease bumps require `--preid alpha|beta|rc|next`, and publish
under a matching npm dist-tag — never `latest`.

Releasing SDK implies a dependent release of every package that depends on it via `workspace:*`
(`boltz-swap` and `swap`), because pnpm rewrites `workspace:*` to an exact version on publish, so a
dependent left unreleased stays pinned to the previous SDK. Override an individual dependent's bump
with `--boltz-bump` / `--swap-bump <bump-or-version>`.

The script runs tests, builds, commits, tags, publishes to npm (requires local npm credentials),
and pushes commit + tags to `origin`.

`release:cleanup` restores the selected package manifests and deletes the matching **local** tags —
nothing else. It never deletes remote tags and never resets commits, so if the release commit was
already created, inspect `git log` and undo it yourself (e.g. `git reset --hard HEAD~1`) before
retrying. With no target it auto-detects from release state or dirty manifests; pass one to narrow
it (`pnpm run release:cleanup -- sdk`).

Stable versions must be released from `master`; prereleases may come from any branch.
`--allow-any-branch` is the escape hatch for a stable release off a feature branch — the release
commit and tag land on that branch, so reach for it only when the branch really is the intended
source of the release.
