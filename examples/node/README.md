### Ark SDK NodeJS Persistence Example

This example demonstrates how to use the Ark SDK in a NodeJS environment by injecting a native persistence layer.

The SDK is designed to be platform-agnostic for its storage requirements. 
In NodeJS, it can be used with the provided `FileSystemStorageAdapter` or with a custom implementation.

#### Running the example

You need to have the SDK built and dependencies installed.

```bash
# From the project root
pnpm install
pnpm run build

# Run the example
npx examples/node/example.ts
```

#### Using IndexedDB in Node

If you prefer to use the `IndexedDB` implementation provided by the SDK in a NodeJS environment, you can inject a shim like `fake-indexeddb` into the global scope:

```typescript
import "fake-indexeddb/auto";
import { IndexedDBWalletRepository, IndexedDBContractRepository } from "@ark-network/ark-sdk";

const wallet = await Wallet.create({
  // ...
  storage: {
    walletRepository: await IndexedDBWalletRepository.create("my-wallet-db"),
    contractRepository: await IndexedDBContractRepository.create("my-contract-db"),
  }
});
```
