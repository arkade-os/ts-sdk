# Arkade Monorepo

TypeScript packages for the Arkade Bitcoin wallet ecosystem — on-chain/off-chain wallets via the Ark protocol and Lightning/chain swaps via Boltz.

## Packages

| Package | Description |
|---------|-------------|
| [`@arkade-os/sdk`](packages/ts-sdk/) | Bitcoin wallet SDK with Taproot and Ark protocol support |
| [`@arkade-os/boltz-swap`](packages/boltz-swap/) | Lightning and chain swaps using Boltz |
| [Regtest stack](regtest/) | Shared regtest environment ([arkade-regtest](https://github.com/ArkLabsHQ/arkade-regtest) submodule) |

## Prerequisites

- Node.js >= 24.15.0 (LTS — see `.nvmrc`)
- pnpm >= 10.25.0

```bash
corepack enable
git submodule update --init
pnpm install
```

## Commands

```bash
pnpm run build            # Build all packages (ts-sdk first, then boltz-swap)
pnpm test                 # Run all unit and integration tests
pnpm run test:unit        # Run unit tests across packages
pnpm run test:integration # Run integration tests across packages against regtest
pnpm run lint             # Check formatting (prettier)
```

### Running a single test

```bash
# Single file
pnpm -C packages/ts-sdk vitest run test/wallet.test.ts

# Single test by name
pnpm -C packages/ts-sdk vitest run -t "test name pattern"
```

### Integration tests

Integration tests use the shared [arkade-regtest](https://github.com/ArkLabsHQ/arkade-regtest) environment (git submodule). Each package runs against its own regtest stack via a per-package override file:

- `packages/ts-sdk/.env.regtest`
- `packages/boltz-swap/.env.regtest`

#### All packages

```bash
pnpm run test:integration   # Runs test:integration:ts-sdk, then test:integration:boltz-swap
```

Each script invokes `scripts/regtest.sh <pkg> cycle`, where `cycle` means `reset + up + setup + test` against that package's stack.

#### Single package

Per-package commands let you control the stack directly. Replace `:ts-sdk` with `:boltz-swap` for the other package.

```bash
pnpm run regtest:up:ts-sdk      # Start the package's regtest stack
pnpm run regtest:setup:ts-sdk   # Initialize wallets and fixtures
pnpm run regtest:test:ts-sdk    # Run the package's e2e suite (assumes stack is up)
pnpm run regtest:down:ts-sdk    # Stop the stack (preserves data)
pnpm run regtest:reset:ts-sdk   # Remove containers and volumes
```

`regtest:test` accepts optional test-file paths to run just a subset against the running stack:

```bash
pnpm run regtest:test:ts-sdk test/e2e/asset.test.ts test/e2e/arkadeCash.test.ts
```

CI uses this to fan the ts-sdk e2e suite out across parallel groups (see the `integration` matrix in `.github/workflows/ci.yml`); the same file lists reproduce a single group locally.

### Documentation

TypeDoc-generated API docs for `@arkade-os/sdk` are written to the repo-root `docs/` directory (the source for [arkade-os.github.io/ts-sdk](https://arkade-os.github.io/ts-sdk/)).

```bash
pnpm -C packages/ts-sdk run docs:build   # Build into ./docs at the repo root
pnpm -C packages/ts-sdk run docs:open    # Open ./docs/index.html in the browser
```

After regenerating, sanity-check that source links in the generated HTML point to monorepo-style paths (e.g. `packages/ts-sdk/src/...`) before publishing.

## Releasing

Releases run from the repository root and are package-scoped. Each package is released independently with its own version and its own `<package-name>/<version>` tag (e.g. `@arkade-os/sdk/0.4.28`). Releasing `@arkade-os/sdk` also releases `@arkade-os/boltz-swap` by default because boltz-swap depends on SDK via `workspace:*`, which pnpm rewrites to an exact version at publish time.

```bash
pnpm run release -- boltz-swap patch          # Boltz bugfix only
pnpm run release -- sdk patch                 # SDK + dependent boltz-swap patch
pnpm run release -- sdk minor --boltz-bump patch
pnpm run release -- all patch                 # Bump both
pnpm run release -- sdk prepatch --preid beta # Mirrors prerelease into boltz-swap

pnpm run release:dry-run -- sdk patch
pnpm run release:cleanup                      # Auto-detect dirty artifacts
pnpm run release:cleanup -- sdk               # Clean only sdk artifacts
```

Targets are `sdk`, `boltz-swap`, or `all`. Bumps accept `patch | minor | major | prepatch | preminor | premajor | prerelease` or a literal semver. Prerelease bumps require `--preid alpha|beta|rc|next`.

When SDK is released, the dependent boltz-swap bump defaults to `patch`; prerelease SDK bumps mirror the prerelease shape and `--preid` into boltz-swap unless overridden with `--boltz-bump`. Before publishing boltz-swap, the release script packs it to a temp dir and verifies that the packed manifest pins the intended `@arkade-os/sdk` version.

The release script runs unit tests, builds all packages, creates a release commit, tags it, publishes to npm (requires local npm credentials), then pushes the commit and tags to `origin`.

Cleanup restores selected package manifests and removes selected local `<package>/<version>` tags. It never deletes remote tags and never resets commits; if a release commit was already created, run `git reset --hard HEAD~1` manually after inspecting `git log`. Package-local release scripts are disabled.

## License

MIT
