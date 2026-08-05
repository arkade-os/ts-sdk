# `@arkade-os/swap` examples

Node programs, run with `tsx` from the package root (`packages/swap`):

| Example                          | What it shows                                                           |
| -------------------------------- | ----------------------------------------------------------------------- |
| `node/lightning-send.ts`         | `arkade:BTC -> lightning:BTC` on regtest: RFQ, local derivation, gates. |
| `node/lightning-send-mainnet.ts` | the same swap on a real network: own key, real solver, durable storage. |

Supporting files: `node/demo-solver.ts` (a stand-in solver), `node/bolt11.ts` (invoice decode),
`node/sqlite.ts` (durable storage on `node:sqlite`), `node/regtest.env` (stack overrides).

## Running the Lightning send

```bash
pnpm -C packages/swap run build          # not needed: the example imports src/
npx tsx examples/node/lightning-send.ts  # from packages/swap
```

Environment, all optional:

| Variable         | Default                     | Meaning                                               |
| ---------------- | --------------------------- | ----------------------------------------------------- |
| `ARK_SERVER_URL` | `http://localhost:7070`     | arkd                                                  |
| `ESPLORA_URL`    | `http://localhost:3000/api` | chain backend for the wallet                          |
| `EMULATOR_URL`   | `http://localhost:7073`     | Arkade emulator (the covenant's refund leaf needs it) |
| `SOLVER_URL`     | _unset_                     | a real solver's base URL; unset picks the demo one    |
| `INVOICE`        | _unset_                     | BOLT11 to pay; also accepted as `argv[2]`             |
| `FUND`           | _unset_                     | `1` funds the lockup (real solver only)               |

### The stack

Start the regtest submodule stack (Bitcoin Core, arkd, the emulator, LND) from the repo root:

```bash
node regtest/regtest.mjs start --env packages/swap/examples/node/regtest.env
```

That override file exists for one reason: **the lightning-send covenant needs a
seconds-denominated unilateral exit delay.** Its unilateral-claim leaf is a BIP68
seconds-based CSV, and `unilateralClaimDelay` rejects anything below 512 as "a block count,
not seconds". The `ts-sdk` and `boltz-swap` regtest profiles run arkd with block-denominated
delays (20 and 5), so quoting against a stack started with either of those fails before a
quote is ever requested.

Without an invoice argument the example asks the stack's LND for a 100k-sat one, so the wallet
needs that much: it boards itself from the faucet on first run.

The stack also ships a real solver (`--profile solver`, HTTP on `http://localhost:7091`), but
its bootstrap registers BTC/asset pairs against a mock pricefeed and the container has no
Lightning node wired to it — so it serves the arkade↔arkade corridor, not this one. Point
`SOLVER_URL` at it only if your build of it quotes `arkade:BTC->lightning:BTC`.

### What the two modes do

**Demo solver (default).** There is no reference solver in this repo, so the example ships an
in-process stand-in (`node/demo-solver.ts`) that quotes the way a real solver does — it reads
the payment hash off the invoice, picks a `refund_locktime`, and derives the same covenant.
It cannot pay a Lightning invoice or claim the lockup, so the example **stops before funding**:
funding it would only park the sats until the covenant refund opens. Before that it runs the
guard that makes the whole flow safe, by quoting through a wrapper that swaps in a different
`lockup_address` and showing the resulting `AddressMismatch` — refuse-to-fund, never
"use theirs".

**Real solver.** `SOLVER_URL=... FUND=1` runs it for real: quote over `httpTransport`, verify,
gate, fund, then follow `rfq_id` to a terminal state and check the published preimage against
the invoice's payment hash. Watching is optional — the preimage lands in the solver's claim
witness on chain, and a swap that fails refunds by covenant with no key or state on this side.

## Running against a real network

`node/lightning-send-mainnet.ts` is the same swap without the regtest scaffolding: a persistent
identity, a real solver, durable storage, and no faucet.

```bash
ARK_PRIVATE_KEY=<64 hex> \
ARK_SERVER_URL=... ESPLORA_URL=... EMULATOR_URL=... SOLVER_URL=... \
npx tsx examples/node/lightning-send-mainnet.ts <bolt11 invoice>
```

Nothing defaults here on purpose — a localhost fallback is exactly what funds a mainnet covenant
against a regtest key — so every variable above is required and a missing one names all of them
at once. Two are optional: `DB_PATH` (default `lightning-send.sqlite`) and `FUND=1`. Without
`FUND` the run is a **dry run**: it quotes, derives, verifies and gates without moving a sat.

| Difference from the regtest example  | Why                                                           |
| ------------------------------------ | ------------------------------------------------------------- |
| `SingleKey.fromHex(ARK_PRIVATE_KEY)` | a random per-run key would strand real funds at exit          |
| No faucet                            | an underfunded wallet prints its boarding address and exits 1 |
| SQLite wallet + swap repositories    | records and wallet state survive restarts (`node/sqlite.ts`)  |
| No demo solver                       | `SOLVER_URL` is required: nothing here can quote in its place |

`ARK_SERVER_URL` and `EMULATOR_URL` must be the **same** Ark server and emulator the solver uses.
Both keys go into the covenant, so a different emulator derives a different address and the swap
is refused with `AddressMismatch` — the guard working correctly, though it reads like a solver
bug until you know why.

One thing the record cannot do: resume a watch. `AssetSwap` carries no `rfq_id`, so a swap funded
by an earlier run can only be followed on chain, not back through `transport.status`. That is
survivable by design — the refund is by covenant and the preimage lands in the claim witness —
but it means the status stream is a convenience for the run that opened it, nothing more.
