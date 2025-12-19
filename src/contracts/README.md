# Contract System

The contract system manages VTXOs across different contract types (default wallet, VHTLC swaps, etc.), providing automatic watching, sweeping, and event handling.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      ContractManager                            │
│  - Orchestrates all contract operations                         │
│  - Manages contract lifecycle (create, activate, deactivate)    │
│  - Coordinates watching and sweeping                            │
│  - Auto-initializes watching on startup                         │
└────────────────────┬───────────────────┬───────────────────────┘
                     │                   │
        ┌────────────▼────────┐ ┌───────▼────────────┐
        │  ContractWatcher    │ │  ContractSweeper   │
        │  - Real-time VTXO   │ │  - Auto-sweep      │
        │    subscription     │ │    spendable VTXOs │
        │  - Watches active   │ │  - Handler-defined │
        │    contracts +      │ │    destinations    │
        │    contracts with   │ │  - Batched sweeps  │
        │    VTXOs            │ │                    │
        └─────────────────────┘ └────────────────────┘
                     │
        ┌────────────▼────────────────────────────────┐
        │           ContractHandler Registry          │
        │  - "default": DefaultContractHandler        │
        │  - "vhtlc": VHTLCContractHandler            │
        │  - Custom handlers can be registered        │
        └─────────────────────────────────────────────┘
```

## Core Concepts

### Contract

A `Contract` represents a receiving address with associated spending logic:

```typescript
interface Contract {
  id: string;                    // Unique identifier (defaults to script)
  type: string;                  // Handler type ("default", "vhtlc", etc.)
  params: Record<string, string>; // Type-specific parameters
  script: string;                // pkScript hex for VTXO matching
  address: string;               // Human-readable address
  state: ContractState;          // "active" | "inactive" | "expired"
  // ... optional fields
}
```

### ContractHandler

Handlers know how to:
1. Create VtxoScripts from parameters
2. Serialize/deserialize parameters for storage
3. Select appropriate spending paths based on context
4. Define sweep destinations

```typescript
interface ContractHandler<P, S extends VtxoScript> {
  type: string;
  createScript(params: Record<string, string>): S;
  serializeParams(params: P): Record<string, string>;
  deserializeParams(params: Record<string, string>): P;
  selectPath(script: S, contract: Contract, context: PathContext): PathSelection | null;
  getSpendablePaths(script: S, contract: Contract, context: PathContext): PathSelection[];
  getSweepDestination?(contract: Contract, context: PathContext, defaultDestination: string): string;
  supportsDelegation?(): boolean;
}
```

### ArkContract String

Contracts can be shared as URI-style strings:

```
arkcontract:type=vhtlc&sender=ab12...&receiver=cd34...&hash=1234...
```

Use `encodeArkContract()` and `decodeArkContract()` for conversion.

## Usage

### Basic Setup

```typescript
import { Wallet } from "@arkade-os/sdk";

// Contract manager is auto-initialized when wallet connects
const wallet = await Wallet.create({
  identity: myIdentity,
  arkServerUrl: "https://ark.example.com",
});

// Access contract manager
const manager = wallet.contractManager;

// Register for events
manager.onContractEvent((event) => {
  console.log("Contract event:", event.type, event.contractId);
});
```

### Creating Contracts

```typescript
// Create a VHTLC contract for a swap
const contract = await manager.createContract({
  type: "vhtlc",
  params: {
    sender: senderPubKey,
    receiver: receiverPubKey,
    server: serverPubKey,
    hash: preimageHash,
    // ... other params
  },
  script: derivedScript,
  address: derivedAddress,
  autoSweep: true,
});
```

### Querying Contracts

```typescript
// Get all contracts
const all = manager.getAllContracts();

// Get active contracts
const active = manager.getActiveContracts();

// Get specific contract
const contract = await manager.getContract(contractId);

// Get contracts with VTXOs
const vtxos = await manager.getContractVtxos({ activeOnly: true });
```

### Contract Lifecycle

```typescript
// Deactivate (stop watching for new VTXOs, but continue if has VTXOs)
await manager.deactivateContract(contractId);

// Reactivate
await manager.activateContract(contractId);

// Update runtime data (e.g., when preimage is revealed)
await manager.updateContractData(contractId, { preimage: "abc123" });
```

## Event Types

| Event | Description |
|-------|-------------|
| `vtxo_received` | New VTXO received in a contract |
| `vtxo_spent` | VTXO was spent |
| `vtxo_swept` | VTXO was auto-swept |
| `vtxo_spendable` | VTXO became spendable (timelock expired, etc.) |
| `contract_expired` | Contract reached expiration |

## Watching Behavior

The watcher subscribes to indexer events for:
- All **active** contracts
- All contracts with **existing VTXOs** (regardless of state)

This ensures funds are never "lost" even after a contract is deactivated.

## Sweeping

When `autoSweep: true`, the sweeper automatically moves spendable VTXOs:
1. Checks for spendable paths via handler's `selectPath()`
2. Determines destination via handler's `getSweepDestination()` (or default wallet address)
3. Executes the sweep transaction

Configuration:
```typescript
const sweeperConfig: SweeperConfig = {
  enabled: true,
  pollIntervalMs: 60000,      // Check every minute
  minSweepValue: 1000,        // Minimum sats to trigger sweep
  maxVtxosPerSweep: 10,       // Max VTXOs per transaction
  batchSweeps: true,          // Batch from multiple contracts
};
```

## Delegation (Future)

The architecture supports future delegation for server-side VTXO refresh:

```typescript
interface Contract {
  // ...
  delegation?: DelegationConfig;
}

interface DelegationConfig {
  enabled: boolean;
  delegatePubKey?: string;      // Server's pubkey for delegation
  maxDelegatedRounds?: number;  // Limit server refreshes
}
```

Handlers indicate delegation support via `supportsDelegation()`. Default contracts support delegation; complex multi-party contracts may not.

## Registering Custom Handlers

```typescript
import { contractHandlers } from "@arkade-os/sdk/contracts";

const myHandler: ContractHandler<MyParams, MyScript> = {
  type: "my-contract",
  createScript(params) { /* ... */ },
  serializeParams(params) { /* ... */ },
  deserializeParams(params) { /* ... */ },
  selectPath(script, contract, context) { /* ... */ },
  getSpendablePaths(script, contract, context) { /* ... */ },
};

contractHandlers.set("my-contract", myHandler);
```

## Files

| File | Purpose |
|------|---------|
| `types.ts` | Core interfaces and types |
| `contractManager.ts` | Main orchestrator |
| `contractWatcher.ts` | Real-time VTXO subscription |
| `contractSweeper.ts` | Auto-sweep logic |
| `arkcontract.ts` | URI string encoding/decoding |
| `handlers/registry.ts` | Handler registration |
| `handlers/default.ts` | Default wallet contract handler |
| `handlers/vhtlc.ts` | VHTLC swap contract handler |
