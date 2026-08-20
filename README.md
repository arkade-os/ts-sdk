# Arkade Monorepo

TypeScript packages for the Arkade Bitcoin wallet ecosystem — on-chain/off-chain wallets via the Ark protocol and Lightning/chain swaps via Boltz.

## Packages

| Package | Description |
|---------|-------------|
| [`@arkade-os/sdk`](packages/ts-sdk/) | Bitcoin wallet SDK with Taproot and Ark protocol support |
| [`@arkade-os/boltz-swap`](packages/boltz-swap/) | Lightning and chain swaps using Boltz |
| [`@arkade-os/swap`](packages/swap/) | Client-side Arkade Intents asset swaps: market discovery, offers, RFQ, restore |

The [`regtest/`](regtest/) directory is a shared regtest environment, vendored as the
[arkade-regtest](https://github.com/ArkLabsHQ/arkade-regtest) git submodule.

## Prerequisites

- Node.js >= 24.15.0 < 27 (LTS; see `.nvmrc`)
- pnpm >= 10.25.0 < 11

```bash
corepack enable
git submodule update --init
pnpm install
```

## Commands

```bash
pnpm run build            # Build all packages (ts-sdk first, then the plugins)
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

Integration tests run against the shared regtest stack; `pnpm run test:integration` cycles every
package's suite (ts-sdk, boltz-swap, swap, and the swap RFQ profile) end-to-end. See
[CONTRIBUTING.md](CONTRIBUTING.md) for per-package stack control, running selected test files, and
how CI fans the ts-sdk e2e suite out across parallel groups.

### Documentation

TypeDoc-generated API docs for `@arkade-os/sdk` are written to the repo-root `docs/` directory (the source for [arkade-os.github.io/ts-sdk](https://arkade-os.github.io/ts-sdk/)).

```bash
pnpm -C packages/ts-sdk run docs:build   # Build into ./docs at the repo root
pnpm -C packages/ts-sdk run docs:open    # Open ./docs/index.html (macOS `open`)
```

After regenerating, sanity-check that source links in the generated HTML point to monorepo-style paths (e.g. `packages/ts-sdk/src/...`) before publishing.

## Releasing

Releases run from the repository root and are package-scoped (`sdk`, `boltz-swap`, `swap`, or `all`),
each with its own version and tag. Releasing `sdk` also bumps the dependents (`boltz-swap`, `swap`),
so they never stay pinned to a stale SDK:

```bash
pnpm run release -- sdk patch           # SDK + dependent boltz-swap/swap patch
pnpm run release:dry-run -- sdk patch   # Preview the plan without changing files
pnpm run release:cleanup                # Restore manifests, delete local tags
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for all targets, bump types, prerelease flags, and cleanup
behavior.

## More

- [CHANGELOG.md](CHANGELOG.md) — release history
- [CONTRIBUTING.md](CONTRIBUTING.md) — integration testing and releasing in detail
- [SECURITY.md](SECURITY.md) — security policy

## License

MIT
