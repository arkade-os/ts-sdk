---
name: arkade-contract
description: >
  Load any arkadec artifact and spend it through @arkade-os/sdk. Use for
  programFromArtifact, Arkade.connect, client.contract, constructor arguments,
  covenant outputs, tapleaf spends, ContractManager, repositories, and
  watching. Extends the escrow skill at ArkLabsHQ/arkade-escrow-covenant
  .cursor/skills/arkade-contract to any contract.
---

# Spend any Arkade contract

This skill is used from a fresh project. The artifact is produced by the `writing-arkade-contracts` skill (`arkadec` from a clone of [arkade-os/compiler](https://github.com/arkade-os/compiler)). This skill spends that committed JSON. The same steps cover any contract. Function names on `contract.functions` are the function names in the `.ark` file.

Pull the SDK. It is not already in this project.

```bash
git clone --depth 1 https://github.com/arkade-os/ts-sdk.git vendor/ts-sdk
pnpm add @arkade-os/sdk
```

Ignore `vendor/`. Read the implementation under `vendor/ts-sdk/packages/ts-sdk/src`. `programFromArtifact` is `src/arkade/artifact.ts` in that package. If the published `@arkade-os/sdk` you installed does not export it, depend on the clone (`pnpm add ./vendor/ts-sdk/packages/ts-sdk`) instead of an older tarball.

## Ownership

- `ContractWatcher` emits `vtxo_received` and `vtxo_spent`. It does not write repositories and it does not read VTXO state from the indexer.
- `ContractManager` is the only writer of contract and VTXO rows. It subscribes to the watcher and fetches fresh VTXOs from the indexer.
- `Wallet` and `ReadonlyWallet` read balance and VTXOs from repositories. Indexer sync goes through the manager.
- Repository interfaces carry `readonly version`. `ContractRepository` is version 2 (`Contract.watch`). A new field bumps that version in the interface and every implementation (`inMemory`, `indexedDB`, `sqlite`, `realm`).
- The wallet owns keys. Ask `wallet.getNextSigningDescriptor()` and `wallet.signerForDescriptor(descriptor)`. Do not call `randomSecretKey()` for a signing key, and do not branch on wallet type.

## Load the artifact

```ts
import { arkade, programFromArtifact } from "@arkade-os/sdk";
import artifact from "./contract.artifact.json" with { type: "json" };

const program = programFromArtifact(artifact);
```

`programFromArtifact` keeps the compiler's opcodes. An artifact `functions` array is not a `Program`; `parseArtifact` rejects it and points here. Ignore `updatedAt` when diffing artifacts.

`checkTime` is `OP_CHECKTIME`. The SDK already supports it.

`older(n)` is a CSV. The compiler pushes `n` without the BIP68 seconds bit. Public arkd rejects a block-type exit leaf, so an offchain exit passes `n` as a BIP68 seconds sequence (the value is a multiple of 512). Regtest arkd treats a value below 512 as blocks. Change that integer in the constructor arguments. Leave every other opcode alone.

## Open a session

Name the operator provider `arkadeOperator`.

```ts
import {
    ContractManager,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestArkProvider,
    RestEmulatorProvider,
    RestIndexerProvider,
    networks,
} from "@arkade-os/sdk";

const arkadeOperator = new RestArkProvider(arkadeUrl);
const indexer = new RestIndexerProvider(arkadeUrl);
const emulator = new RestEmulatorProvider(emulatorUrl);

const manager = await ContractManager.create({
    indexerProvider: indexer,
    contractRepository: new InMemoryContractRepository(),
    walletRepository: new InMemoryWalletRepository(),
});

const client = await arkade.Arkade.connect({
    arkade: arkadeOperator,
    indexer,
    emulator,
    contractManager: manager,
    network: networks.mutinynet,
});
```

Leave `identity` off when this session only watches or spends leaves that do not need a local signer. `ReadonlyWallet` is the wrong stand-in: it requires a pubkey and then watches that pubkey's scripts. Pass `identity` only when a leaf needs this session to sign.

A `Wallet` already owns a manager and both repositories. Use that manager. Do not construct a second one beside the wallet and write the same scripts through both.

`client.serverKey` is the operator key from `getInfo`. It is part of the taproot tree. It is not a key named in the contract. The emulator is required only when a path actually spends a covenant. `client.emulatorKey` comes from the SDK's network pin, not from the emulator's `/v1/info`. Compare the two when a claim is refused.

## Constructor arguments

`client.contract(program, args)` stores these in the taproot tree. Match the Arkade header.

| Arkade type | Pass |
| --- | --- |
| `pubkey` | `await key.xOnlyPublicKey()`, 32 bytes |
| `bytes32` hash | `sha256(preimage)`. The signer signs the preimage |
| `bytes32` compared to `scriptPubKey` | the 32-byte witness program |
| `int` amount | satoshis, as `bigint` |
| `int` time | the clock that function reads |
| asset id | `AssetId` splits into `txid` (`bytes32`) and `groupIndex` (`int`) |

A witness program is `DefaultVtxo.Script({ pubKey, serverPubKey: client.serverKey, csvTimelock }).tweakedPublicKey`. The output script is `pkScript`: `OP_1` in front of those 32 bytes, hex `5120…`. Pay outputs with `pkScript`. The manager subscribes to that script. Use `tweakedPublicKey` only where the contract compares the 32-byte program.

A receive address is `vtxo.address(network.hrp, client.serverKey)`. It is where a spend pays. It does not replace a `pubkey` argument.

If the program declares `server` or `user` and the caller omits them, `contract()` fills the client server key and the identity key. Explicit args win.

## Spend

```ts
const contract = client.contract(program, args);
const coin = (await contract.getUtxos())[0];

await contract.functions
    .spend(/* witnesses, in source order */)
    .from(coin)
    .to(destination.pkScript, coin.value)
    .send();
```

`.from` / `.to` / `.send()` talks to the operator and the emulator and signs with the session identity. Call whichever function the artifact declares, with its inputs in source order. A function with no inputs is called with none. Outputs have to satisfy that function's `tx.outputs[i]` checks: value, script, and any asset amounts.

`.fund(coins)` adds inputs after the contract coin, signed with the client identity. `.withAsset(spec)` moves an asset group. `.change(script)` is required when the spend is not exact.

`.build()` assembles without broadcasting. A leaf that needs several local signatures and no server is not a `.send()`: take the leaf from the compiled program, set the input sequence when the leaf has `older`, sign input 0 with each required key, and broadcast yourself.

## Watch

```ts
const contract = client.contract(program, args);
await contract.register();

const script = hex.encode(contract.pkScript);
const stop = manager.onContractEvent((event) => {
    if (event.type === "connection_reset" || event.contractScript !== script) return;
    // vtxo_received: funded
    // vtxo_spent: a function ran; the spending tapleaf says which
});
```

`register()` stores the program, constructor args, and the server and emulator keys, and adds `pkScript` to the manager's one subscription. Do not also call `indexer.subscribeForScripts`. The same script again is a no-op and does not refetch history. If the first fetch fails, backfill with `manager.refreshVtxos({ scripts: [script], after: 0 })`.

`getUtxos()` reads the repository once the contract is registered. It drops spent and unrolled coins. An empty list does not mean the contract was never funded. The spent coin arrives on `vtxo_spent`. Its `spentBy` is the spending transaction.

`wallet.restore()` will not find this contract. Nothing in a seed derives the script. The repository row is the backup. In-memory repositories are empty after a restart, so `register()` again with the same program, args, and keys. A durable repository reloads the row when `ContractManager.create` runs. Rebuild with `arkade.ArkadeContract.fromContract(client, row)` so a later server key does not point the watcher at a different script.

Leave `metadata.genericallySpendable` unset unless this contract's coins are safe in a generic wallet send. The arkade handler treats anything but explicit `true` as not generically spendable, and `createContract` is first-writer-wins for that script.

Do not poll Esplora for a virtual transaction id. `GET /api/tx/<virtualTxid>` is 404. Ask Mempool only about a transaction that has been unrolled.

`checkTime` reads the emulator clock, in unix seconds. `older(n)` has not started before unroll. Read the operator minimum from `arkadeOperator.getInfo()` (`unilateralExitDelay`).
