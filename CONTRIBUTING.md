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

Package-scoped release orchestrator. Target is any package key, or `all`:

`sdk` · `boltz-swap` · `wallet-providers` · `sats-connect` · `sats-connect-react` · `checkout` ·
`snap` · `all`

```bash
pnpm run release -- boltz-swap patch          # Boltz bugfix only
pnpm run release -- sdk patch                 # SDK + dependent boltz-swap patch
pnpm run release -- sdk prepatch --preid beta # Mirrors prerelease into boltz-swap
pnpm run release -- wallet-providers patch    # Web package on its own cadence
pnpm run release -- all patch                 # Bump every package
pnpm run release:dry-run -- sdk patch         # Preview without changes
pnpm run release:cleanup                      # Auto-detect dirty release artifacts
```

Tags are `@arkade-os/<package>/<version>` (no `v<version>`).

### Only boltz-swap fans out from the SDK

Releasing SDK implies a dependent boltz-swap release because boltz-swap depends on SDK via
`workspace:*`, which pnpm rewrites to an *exact* version on publish; override with
`--boltz-bump <bump-or-version>`.

The five web packages are deliberately **not** fan-out dependents. They depend on the SDK through
peer ranges or `workspace:^`, both of which publish as caret ranges and stay satisfied across an SDK
patch or minor. An SDK release does not bump them — release them individually as needed.

### Releasing the snap

`@arkade-os/snap` is not an ordinary npm package. `snap.manifest.json` carries its own `version`,
which MetaMask requires to match the published package version, and a `source.shasum` that MetaMask
validates at install time. A mismatch in either breaks installation for every existing user.

The release script handles this automatically: it mirrors the version into the manifest, lets
`mm-snap build` regenerate the shasum, then verifies the result and **aborts before any commit, tag
or publish** if the built bundle and manifest disagree. The shasum is a composite hash over all snap
source files — never recompute it by hand; always let `mm-snap` do it.

Snap releases must always move forward. The version published as `@arkade-os/snap@0.1.2` predates
this monorepo and no longer matches this source tree, so it can never be republished.

The script runs tests, builds, commits, tags, publishes to npm (requires local npm credentials),
and pushes commit + tags to `origin`.
