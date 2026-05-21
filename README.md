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

### Documentation

```bash
pnpm -C packages/ts-sdk run docs:build   # Build TypeScript API docs
pnpm -C packages/ts-sdk run docs:open    # Open in browser
```

## Releasing

Releases are run from the repository root and publish both packages in lockstep. The release command sets `@arkade-os/sdk` and `@arkade-os/boltz-swap` to one shared version, builds, commits and tags `v<version>`, publishes SDK first, publishes boltz-swap, then pushes the commit and tag.

```bash
pnpm run release                    # Prompt for a bump or literal version
pnpm run release -- <version>       # First lockstep release while versions differ
pnpm run release -- patch           # Normal flow after versions are aligned
pnpm run release:dry-run -- <version>
pnpm run release:cleanup
```

While package versions are not aligned, use a literal target version. Package-local release scripts are disabled.

## License

MIT
