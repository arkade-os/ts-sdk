---
name: arkade-regtest
description: >
  Bring up ArkLabsHQ/arkade-regtest in one shot and prove any Arkade contract
  with one functional end-to-end test against that stack. Use for the regtest
  CLI, faucet, notes, asset issuance, and the emulator. Do not write unit
  tests. Do not use for contract authoring.
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

Fund an offchain wallet first, then `wallet.assetManager.issue({ amount })`. Skip this when the contract under test locks only sats. The result's `assetId` is genesis txid plus group index; `AssetId.fromString` splits it into the `bytes32` and `int` a constructor stores.

A control asset is an issuance of amount `1n`. A later `issue({ amount, controlAssetId })` mints under that control. Poll `getVtxos()` until the amount is present. The indexer trails a settle and a mine; `waitFor` on the vtxo. When a locktime must still be immature, read Bitcoin Core with `node regtest/regtest.mjs rpc getblockcount`. An Esplora tip lags that height.

## One functional test

Do not write unit tests. Do not add a file that compiles the artifact and counts opcodes, and do not add a test per `require`. Write one end-to-end test against this running stack, and make that one complete.

The test is the contract's real life, in order: the stack answers, coins arrive from the faucet, assets are issued only when the contract locks them, the artifact is registered and funded, each spend function a party can run is run, and the indexer shows the coin leaving on `vtxo_spent`. A continuation pays the next script that function names. A coin whose reading moves is asserted by the amount on the continuing output. A path that must fail is one step in that same test, with the output or the clock the contract rejects.

Virtual txids are not on Esplora. Assert through the indexer. Mine, then ask Esplora, only for an unrolled exit.

A refused emulator signature is a key mismatch until `hex.encode(client.emulatorKey)` differs from the pubkey the emulator serves. Compare those before changing the contract.

If the stack is down, stop. A failing spend will not explain a down arkd. `curl -sf http://localhost:7070/v1/info` and, when the contract has a covenant, the emulator on port 7073.

## Shape of the file

The test is the body of the file. Helpers go at the end. Funding, waiting on the indexer, building constructor args, and decoding an asset id are functions below the test, not a prelude and not a second module of unit tests.
