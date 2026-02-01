# HD Wallet Interface Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable HD wallet functionality with separate interfaces for single-key and HD wallets, sharing a common base.

**Architecture:** Two wallet interfaces (`ISingleKeyWallet`, `IHDWallet`) extend a base interface (`IBaseWallet`). HD wallets use descriptor-based signing with ContractManager integration. Boarding UTXOs are represented as contracts for a unified balance model.

**Tech Stack:** TypeScript, existing SeedIdentity with DescriptorProvider, ContractManager, ContractHandler

---

## 1. Interface Hierarchy

### 1.1 Base Wallet Interface

```typescript
/**
 * Base wallet interface - shared by both single-key and HD wallets.
 * No identity field here - that's implementation-specific.
 */
interface IBaseWallet {
    // Query operations
    getVtxos(filter?: GetVtxosFilter): Promise<ExtendedVirtualCoin[]>;
    getBoardingUtxos(): Promise<ExtendedCoin[]>;
    getTransactionHistory(): Promise<ArkTransaction[]>;
    getContractManager(): Promise<IContractManager>;

    // Transaction operations (same signature for both wallet types)
    sendBitcoin(params: SendBitcoinParams): Promise<string>;
    settle(params?: SettleParams, eventCallback?: (event: SettlementEvent) => void): Promise<string>;
}
```

### 1.2 Single-Key Wallet Interface

```typescript
/**
 * Single-key wallet interface (current behavior).
 * Uses one fixed keypair for all operations.
 * Maintains backwards compatibility with existing WalletBalance type.
 */
interface ISingleKeyWallet extends IBaseWallet {
    identity: Identity;

    // Single address (implicit index 0)
    getAddress(): Promise<string>;
    getBoardingAddress(): Promise<string>;

    // Original balance format (non-breaking change)
    getBalance(): Promise<WalletBalance>;
}
```

### 1.3 HD Wallet Interface

```typescript
/**
 * HD wallet interface - multiple addresses, descriptor-based signing.
 * Identity must implement DescriptorProvider for HD key derivation.
 */
interface IHDWallet extends IBaseWallet {
    identity: Identity & DescriptorProvider;

    // Multi-address operations
    getAddresses(index: number): Promise<AddressInfo>;

    // New balance format (contract-based, unified model)
    getBalance(): Promise<HDWalletBalance>;
}
```

---

## 2. Address Info Type

```typescript
/**
 * Address information at a specific HD derivation index.
 */
interface AddressInfo {
    /** Ark address for receiving offchain funds */
    ark: string;

    /** Boarding address for onchain-to-offchain transitions */
    boarding: string;

    /** Signing descriptor: tr([fp/86'/coinType'/0']xpub/0/{index}) */
    descriptor: string;

    /** The derivation index */
    index: number;
}
```

---

## 3. HD Balance Model

### 3.1 Contract Balance

```typescript
/**
 * Balance summary for a contract.
 */
interface ContractBalance {
    /** Contract type (e.g., "default", "vhtlc", "boarding") */
    type: string;

    /** Contract script (unique identifier) */
    script: string;

    /** Spendable balance */
    spendable: number;

    /** Unspendable balance (locked, pending timelocks, unconfirmed boarding) */
    unspendable: number;

    /** Recoverable balance (can only be spent by joining a batch) */
    recoverable: number;

    /** Total balance */
    total: number;

    /** Number of coins */
    coinCount: number;
}
```

### 3.2 HD Wallet Balance

```typescript
/**
 * HD Wallet balance structure.
 * Boarding is represented as a contract type for unified concept.
 */
interface HDWalletBalance {
    /** Balance by contract */
    contracts: ContractBalance[];

    /** Aggregate spendable across all contracts */
    spendable: number;

    /** Aggregate unspendable across all contracts */
    unspendable: number;

    /** Aggregate recoverable across all contracts */
    recoverable: number;

    /** Total balance */
    total: number;
}
```

### 3.3 Boarding as Contract

Boarding UTXOs are represented as a contract type `"boarding"` for a unified concept:

| State | Category | Reason |
|-------|----------|--------|
| Unconfirmed | `unspendable` | Cannot be spent until confirmed |
| Confirmed | `recoverable` | Can only be spent by joining a batch |
| After settlement | Moves to `"default"` contract as `spendable` | Now a VTXO |

---

## 4. Contract Handler Descriptor Resolution

### 4.1 Wallet Descriptor Info

```typescript
/**
 * A wallet's descriptor associated with specific spending paths.
 */
interface WalletDescriptorInfo {
    /** The descriptor for signing */
    descriptor: string;

    /** Role in the contract (for multi-party contracts) */
    role?: string;

    /** Which paths this descriptor is used for */
    pathNames: string[];  // e.g., ["claim", "refund"] or ["forfeit", "exit"]
}
```

### 4.2 Extended ContractHandler Interface

```typescript
/**
 * Extended ContractHandler interface with descriptor resolution.
 */
interface ContractHandler<P, S extends VtxoScript> {
    // ... existing methods ...

    /**
     * Get all wallet descriptors from contract params.
     * Returns all descriptors that belong to the wallet, along with
     * which paths they're used for.
     *
     * A contract may have multiple paths with different descriptors
     * (e.g., sender and receiver in a swap where wallet is both).
     *
     * @param contract - The contract
     * @param identity - DescriptorProvider to check ownership
     * @returns Array of wallet's descriptors with path info
     */
    getWalletDescriptors(
        contract: Contract,
        identity: DescriptorProvider
    ): WalletDescriptorInfo[];
}
```

### 4.3 Handler Implementations

**DefaultContractHandler:**

```typescript
getWalletDescriptors(contract: Contract, identity: DescriptorProvider): WalletDescriptorInfo[] {
    const result: WalletDescriptorInfo[] = [];
    const pubKey = contract.params.pubKey;

    if (pubKey && identity.isOurs(pubKey)) {
        result.push({
            descriptor: pubKey,
            pathNames: ["forfeit", "exit"],
        });
    }
    return result;
}
```

**VHTLCContractHandler:**

```typescript
getWalletDescriptors(contract: Contract, identity: DescriptorProvider): WalletDescriptorInfo[] {
    const result: WalletDescriptorInfo[] = [];

    if (contract.params.sender && identity.isOurs(contract.params.sender)) {
        result.push({
            descriptor: contract.params.sender,
            role: "sender",
            pathNames: ["refund", "unilateralRefund"],
        });
    }

    if (contract.params.receiver && identity.isOurs(contract.params.receiver)) {
        result.push({
            descriptor: contract.params.receiver,
            role: "receiver",
            pathNames: ["claim", "unilateralClaim"],
        });
    }

    return result;
}
```

---

## 5. Path Selection with Descriptor

### 5.1 Extended PathSelection

```typescript
interface PathSelection {
    /** The tapleaf script to use for spending */
    leaf: TapLeafScript;

    /** Additional witness elements (e.g., preimage for HTLC) */
    extraWitness?: Bytes[];

    /** Sequence number override (for CSV timelocks) */
    sequence?: number;

    /** Descriptor to use for signing this path */
    descriptor?: string;
}
```

### 5.2 Signing Flow

```typescript
// 1. Get contract and handler
const [contract] = await manager.getContracts({ script: contractScript });
const handler = contractHandlers.get(contract.type);

// 2. Get wallet's descriptors for this contract
const walletDescriptors = handler.getWalletDescriptors(contract, this.identity);

// 3. Get spendable paths (handler populates descriptor field)
const paths = await manager.getSpendablePaths({
    contractScript,
    vtxo,
    walletDescriptors,
});

// 4. Sign using the path's descriptor
for (const path of paths) {
    if (path.descriptor) {
        const [signed] = await this.identity.signWithDescriptor(
            path.descriptor,
            [{ tx, inputIndexes: [inputIndex] }]
        );
    }
}
```

---

## 6. Implementation Tasks

### Task 1: Add Types to wallet/index.ts

**Files:**
- Modify: `src/wallet/index.ts`

Add new types:
- `AddressInfo`
- `ContractBalance`
- `HDWalletBalance`
- `IBaseWallet`
- `IHDWallet`

Keep existing:
- `ISingleKeyWallet` (rename from `IWallet`)
- `WalletBalance` (unchanged for backwards compat)

### Task 2: Add WalletDescriptorInfo to contracts/types.ts

**Files:**
- Modify: `src/contracts/types.ts`

Add:
- `WalletDescriptorInfo` interface
- `descriptor?: string` to `PathSelection`
- `getWalletDescriptors()` to `ContractHandler`

### Task 3: Implement getWalletDescriptors in DefaultContractHandler

**Files:**
- Modify: `src/contracts/handlers/default.ts`
- Test: `test/contracts/handlers.test.ts`

### Task 4: Implement getWalletDescriptors in VHTLCContractHandler

**Files:**
- Modify: `src/contracts/handlers/vhtlc.ts`
- Test: `test/contracts/handlers.test.ts`

### Task 5: Update getSpendablePaths to Include Descriptor

**Files:**
- Modify: `src/contracts/contractManager.ts`
- Modify: `src/contracts/handlers/default.ts`
- Modify: `src/contracts/handlers/vhtlc.ts`

Pass `walletDescriptors` through to handlers, handlers populate `descriptor` on returned paths.

### Task 6: Create HDWallet Class

**Files:**
- Create: `src/wallet/hdWallet.ts`
- Modify: `src/wallet/index.ts` (export)

Implement `IHDWallet`:
- `getAddresses(index)` - derive addresses at index
- `getBalance()` - return `HDWalletBalance` via ContractManager

### Task 7: Add Boarding Contract Handler

**Files:**
- Create: `src/contracts/handlers/boarding.ts`
- Modify: `src/contracts/handlers/index.ts`
- Modify: `src/contracts/handlers/registry.ts`

Represents boarding UTXOs as contracts for unified balance model.

### Task 8: Refactor Wallet to ISingleKeyWallet

**Files:**
- Modify: `src/wallet/wallet.ts`
- Modify: `src/wallet/index.ts`

Ensure existing `Wallet` class implements `ISingleKeyWallet`.
Add type alias: `type IWallet = ISingleKeyWallet` for backwards compat.

---

## 7. Future Considerations (Out of Scope)

- **Gap limit scanning:** `getNextAddresses()` with standard 20-address gap limit
- **Address caching:** Track used indexes in repository
- **Multi-account:** Different account indexes (m/86'/coinType'/**account**'/0/index)
