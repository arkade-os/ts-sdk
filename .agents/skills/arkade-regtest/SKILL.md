---
name: arkade-regtest
description: >
  Bring up ArkLabsHQ/arkade-regtest in one shot and run smoke and functional
  tests of an Arkade contract against it. Use for the regtest CLI, faucet,
  notes, asset issuance, the emulator, and e2e tests in packages/ts-sdk.
  Do not use for contract authoring.
---

# Arkade regtest

[arkade-regtest](https://github.com/ArkLabsHQ/arkade-regtest) is the Docker stack: Bitcoin Core, mempool (Esplora under `/api`), arkd, the emulator, and optional solvers. This repo vendors it as the `regtest/` submodule. `git submodule update --init` after clone. Docker with the compose plugin, and Node 18 or newer. No `npm install` inside the regtest repo.

## One-shot stack

From this repo, with ports free:

```bash
pnpm run regtest:up:ts-sdk
pnpm run regtest:setup:ts-sdk
```

`up` is `node regtest/regtest.mjs start --env packages/ts-sdk/.env.regtest`. `setup` waits until arkd and the emulator answer, then runs `ark init` inside the arkd container with password `secret`. From a checkout of arkade-regtest itself, `node regtest.mjs start` is the same bring-up and also seeds the `ark` client with offchain funds.

Stop with `pnpm run regtest:down:ts-sdk` (`stop` keeps volumes). Wipe with `pnpm run regtest:reset:ts-sdk` (`clean` drops containers and volumes). `pnpm run test:integration:ts-sdk` is reset, up, setup, and the e2e suite.

`start` with no profile flag brings up the full stack. A contract test needs `ark` and the emulator:

```bash
node regtest/regtest.mjs start --profile ark --profile emulator
```

Set `AUTOMINE_INTERVAL=0` in the override file for any test that mines. The default auto-miner (one block every 600 seconds) moves block-denominated expiry and sweeps under a running test. Mine with `node regtest/regtest.mjs mine [n]`.

Defaults that matter: arkd `http://localhost:7070` (admin `7071`), Esplora `http://localhost:3000/api`, emulator `http://localhost:7073`, arkd wallet `http://localhost:6060`. The SDK's regtest Esplora default is that `/api` URL. Bitcoin Core RPC is `localhost:18443`, user `admin1`, password `123`.

arkd's default locktimes in this stack are below 512, so they are blocks. Public arkd rejects that. A test of an exit leaf passes the constructor the sequence the target operator expects.

## Fund

Onchain, from the node wallet. Amount is BTC. `--confirm` mines one block; without it the coin sits unconfirmed.

```bash
node regtest/regtest.mjs faucet <address> 0.001 --confirm
```

Offchain, the stack's `ark` client sends sats to an Arkade address. The password in the e2e helpers is `secret`.

```bash
docker exec arkd ark send --to <address> --amount 20000 --password secret
```

The e2e helpers are `faucetOnchain`, `faucetOffchain`, `mineBlocks`, and `beforeEachFaucet` in `packages/ts-sdk/test/e2e/utils.ts`. `beforeEachFaucet` redeems a fresh note because spent rounds leave notes the balance still shows and `ark send` cannot spend:

```bash
docker exec arkd arkd note --amount 200000
docker exec arkd ark redeem-notes -n <note> --password secret
```

`pnpm run regtest:test:ts-sdk` runs the suite. `pnpm run regtest:test:ts-sdk test/e2e/asset.test.ts` runs one file. The full cycle is `pnpm run test:integration:ts-sdk`.

## Issue an asset

Fund an offchain wallet first. Issuance is `wallet.assetManager.issue({ amount })`. The result's `assetId` is genesis txid plus group index; `AssetId.fromString` splits it into the `bytes32` and `int` a beacon or vault constructor wants.

A control asset is an issuance of amount `1n`. A later `issue({ amount, controlAssetId })` mints under that control. Poll `getVtxos()` until the asset amount is present. The indexer trails a settle and a mine; `waitFor` on the vtxo, and read Bitcoin Core's height with `node regtest/regtest.mjs rpc getblockcount` when a locktime must still be immature. Do not treat an Esplora tip as that height.

A beacon reading is that asset amount on the beacon output. Update spends the beacon, pays the same script, and sets the ticker amount to the new price and the clock amount to the new time. Passthrough pays the same script with each amount at least the input amount.

## Smoke, then the contract

Smoke proves the stack and one happy path. Stop if smoke fails; the contract test will not explain a down arkd.

- `curl -sf http://localhost:7070/v1/info` and, when a covenant path is under test, the emulator info URL on port 7073.
- Faucet an onchain address with `--confirm` and see it on Esplora.
- Redeem a note, `ark send` to a wallet address, and see the vtxo in `getVtxos()`.
- Issue an asset and see `assetId` on a vtxo.
- `programFromArtifact`, `register()`, fund `contract.address`, and see `vtxo_received` for that `pkScript`.

Functional tests hit every spend group against this stack, plus the rejects:

- Happy path for each function, with the outputs the covenant requires.
- Finalize before the deadline and cancel after it. The opposite clock fails.
- A second input that carries the same intent script fails a finalize that requires a different funding script.
- An output under 330 sats is folded only where the contract folds it.
- Beacon `update` accepts a higher clock and rejects a lower one. `passthrough` keeps both asset amounts.
- A refused emulator claim: compare `hex.encode(client.emulatorKey)` with the emulator's reported signer before changing the contract.

Virtual txids are not on Esplora. Assert through the indexer and `vtxo_spent`. Mine, then ask Esplora, only for an unrolled exit.
