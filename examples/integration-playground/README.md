# Arkade integration playground

A single Next.js app that imports every ported Arkade web package. It is private and never
published.

## Why this exists

**The important thing about this example is that it builds.** Bundling all the packages together
exercises their real export maps, ESM/CJS dual-package resolution, and cross-package `.d.ts`
correctness — the failure modes that per-package unit tests cannot reach. CI runs `typecheck` and
`build` on it for exactly that reason.

Next.js is required rather than preferred: `@arkade-os/checkout` exports `POST`/`GET` handlers that
import `next/server`, which cannot run under Vite. Next is the only framework able to host those
alongside the browser-side integrations, so a genuinely unified example forces it.

## What each panel covers

| Panel | Package | Needs |
| --- | --- | --- |
| Wallet providers | `@arkade-os/wallet-providers` | UniSat, OKX, Leather, or Phantom extension |
| Sats Connect | `@arkade-os/sats-connect-react` (+ `@arkade-os/sats-connect`) | Xverse or another Sats Connect wallet |
| Snap | `@arkade-os/snap` | MetaMask Flask |
| Checkout | `@arkade-os/checkout` | `ARKADE_PRIVATE_KEY_HEX` |

The snap panel invokes the snap over RPC through MetaMask and resolves it from npm, so it exercises
the **published** package, not this working tree. That is why `@arkade-os/snap` is not a dependency
here.

### The checkout mount path is fixed, not configurable

Checkout's route handlers **must** be mounted at `/api/arkade`. `Checkout.tsx` and `useCheckout.tsx`
hardcode `/api/arkade/status`, `/api/arkade/claim` and `/api/arkade/create`, and `webhook.ts`
self-calls `/api/arkade/claim`. Mounting anywhere else builds and typechecks cleanly but 404s the
moment you click through — a build-time gate cannot catch a hardcoded fetch path.

### These handlers have no authentication

`create`, `claim` and `webhook` ship with no auth, no rate limiting, and no origin check. `create`
mints Boltz reverse swaps using the server's key, and the checkout id is the Boltz payment hash,
which is not secret. **Mount them behind app-level authentication before exposing them publicly.**
This is inherited from the source repo, not introduced by the port.

## Running it

```bash
pnpm install
pnpm -r build                                  # packages must build first
pnpm -C examples/integration-playground dev
```

Then open http://localhost:3000.

For the checkout panel's server flows:

```bash
export ARKADE_PRIVATE_KEY_HEX=<hex>
```

See `packages/checkout/README.md` and `packages/checkout/VSS_SETUP.md` for the full server setup,
including the optional VSS-backed key source.

## What is not automated

Every wallet flow needs a real browser extension — UniSat, OKX, Leather, Phantom, Xverse, MetaMask
Flask. No headless runner can drive those without a signed extension fixture, so **clicking the
buttons is a manual verification step**. CI only proves the packages compile and bundle together.

The UI is deliberately unstyled. This is a wiring harness, not a design reference.
