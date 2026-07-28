# Contributing

## Integration testing (regtest stack)

Integration tests live in `test/e2e/` within each package and require the Docker regtest stack.

`test:integration` runs each package's full cycle (reset + up + setup + test) via
`scripts/regtest.sh <pkg> cycle`, using `packages/<pkg>/.env.regtest`.

```bash
pnpm run test:integration              # Both packages, end-to-end
pnpm run test:integration:ts-sdk       # ts-sdk only
pnpm run test:integration:boltz-swap   # boltz-swap only
```

### Per-package stack control

Replace `:ts-sdk` with `:boltz-swap` for the other package.

```bash
pnpm run regtest:up:ts-sdk
pnpm run regtest:setup:ts-sdk
pnpm run regtest:test:ts-sdk                          # whole e2e suite
pnpm run regtest:test:ts-sdk test/e2e/asset.test.ts   # or selected files only
pnpm run regtest:down:ts-sdk
pnpm run regtest:reset:ts-sdk
```

CI fans the ts-sdk e2e suite out across parallel groups by passing each group's file list to
`regtest:test` (see the `integration` matrix in `.github/workflows/ci.yml`).

### The stack itself

`regtest/` is a git submodule pointing to
[arkade-regtest](https://github.com/ArkLabsHQ/arkade-regtest). It manages a Docker Compose stack
(Bitcoin Core, Fulcrum, mempool, NBXplorer, arkd, boltz, LND, fulmine, and supporting services)
driven by the in-house Node CLI `regtest.mjs`. Use `node regtest/regtest.mjs start` / `stop` /
`clean`, or the `scripts/regtest.sh` controller.

Run `git submodule update --init` after cloning.

## Releasing

Package-scoped release orchestrator. Target is `sdk`, `boltz-swap`, or `all`.

```bash
pnpm run release -- boltz-swap patch          # Boltz bugfix only
pnpm run release -- sdk patch                 # SDK + dependent boltz-swap patch
pnpm run release -- sdk prepatch --preid beta # Mirrors prerelease into boltz-swap
pnpm run release -- all patch                 # Bump both
pnpm run release:dry-run -- sdk patch         # Preview without changes
pnpm run release:cleanup                      # Auto-detect dirty release artifacts
```

Tags are `@arkade-os/sdk/<version>` and `@arkade-os/boltz-swap/<version>` (no `v<version>`).

Releasing SDK implies a dependent boltz-swap release because boltz-swap depends on SDK via
`workspace:*`; override with `--boltz-bump <bump-or-version>`.

The script runs tests, builds, commits, tags, publishes to npm (requires local npm credentials),
and pushes commit + tags to `origin`.
