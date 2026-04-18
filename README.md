# Arkade Monorepo

TypeScript packages for the Arkade Bitcoin wallet ecosystem — on-chain/off-chain wallets via the Ark protocol and Lightning/chain swaps via Boltz.

## Packages

| Package | Description |
|---------|-------------|
| [`@arkade-os/sdk`](packages/ts-sdk/) | Bitcoin wallet SDK with Taproot and Ark protocol support |
| [`@arkade-os/boltz-swap`](packages/boltz-swap/) | Lightning and chain swaps using Boltz |
| [Regtest stack](regtest/) | Shared regtest environment ([arkade-regtest](https://github.com/ArkLabsHQ/arkade-regtest) submodule) |

## Prerequisites

- Node.js >= 22.12.0 (LTS)
- pnpm >= 10.25.0

```bash
corepack enable
git submodule update --init
pnpm install
```

## Commands

```bash
pnpm run build          # Build all packages (ts-sdk first, then boltz-swap)
pnpm test               # Run all unit and integration tests
pnpm run test:unit      # Run unit tests across packages
pnpm run test:integration # Run integration tests across packages against regtest
pnpm run lint           # Check formatting (prettier)
```

### Running a single test

```bash
# Single file
pnpm -C packages/ts-sdk vitest run test/wallet.test.ts

# Single test by name
pnpm -C packages/ts-sdk vitest run -t "test name pattern"
```

### Integration tests

Integration tests use the shared [arkade-regtest](https://github.com/ArkLabsHQ/arkade-regtest) environment (git submodule):

```bash
pnpm run regtest:up      # Start nigiri + arkd, boltz, LND, fulmine, etc.
pnpm run regtest:setup   # Initialize wallets and shared test fixtures
pnpm run test:integration # Run e2e tests for all packages against regtest
pnpm run regtest:test    # Run setup + e2e tests
pnpm run regtest:down    # Stop the stack
pnpm run regtest:reset   # Stop and remove volumes
```

### Documentation

```bash
pnpm -C packages/ts-sdk run docs:build   # Build TypeScript API docs
pnpm -C packages/ts-sdk run docs:open    # Open in browser
```

## Releasing

Releases are run interactively from a clean working tree. Each package has its own version and npm dist-tag. Tags are namespaced to avoid collisions: `sdk-v*` for the SDK, `boltz-swap-v*` for boltz-swap.

```bash
pnpm run release              # Release all (ts-sdk first, then boltz-swap)
pnpm run release:ts-sdk       # Release SDK only
pnpm run release:boltz-swap   # Release boltz-swap only
```

The script will prompt for the version bump type (patch, minor, major, or pre-release). It then:

1. Bumps the version in `package.json`
2. Commits and creates a git tag (`sdk-v0.3.14` or `boltz-swap-v0.3.1`)
3. Pushes the tag (triggers a GitHub Release for stable versions)
4. Publishes to npm

To preview without making changes:

```bash
pnpm -C packages/ts-sdk run release:dry-run
pnpm -C packages/boltz-swap run release:dry-run
```

## License

MIT
