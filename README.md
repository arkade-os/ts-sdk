# Arkade SDK: Client-Side VTXO & Sovereign Exit Verification

## Overview
The **Arkade SDK Verification Pipeline** is a zero-trust implementation designed to guarantee financial self-sovereignty for Ark users. It allows individual wallets to independently validate the claims of an Ark Service Provider (ASP) without needing to trust it. 

Every VTXO (Virtual UTXO) received is rigorously audited through a multi-layered cryptographic pipeline, ensuring that the user always has the necessary data and legal signatures to perform a **Sovereign Unilateral Exit** if the ASP becomes malicious or goes offline.

---

## 🛠 Features & Completed Tiers

### [Tier 1] Core VTXO Chain Verification
- **DAG Reconstruction**: Programmatic reconstruction of the virtual transaction DAG from the leaf back to the root (Commitment).
- **Schnorr & MuSig2 Validation**: High-integrity signature verification (BIP 340) against tweaked Taproot public keys (BIP 341).
- **On-chain Anchoring**: Verification of commitment transaction status (depth and height) directly against a Bitcoin node (Regtest/Signet/Mainnet).

### [Tier 2] Full Script Satisfaction Verification
- **Taproot Tree Audit**: Validation of Merkle proofs for script leaves inside Taproot outputs.
- **Ark Exit Policies**: Enforcement of `CHECKSEQUENCEVERIFY` (CSV) delays to protect against premature ASP sweeps.
- **Atomic Swap HTLCs**: Specialized support for **Boltz Submarine Swaps**, ensuring hash preimages (SHA256/HASH160) are mandatory for claim leaves.

### [Tier 3] Sovereign Unilateral Exit
- **Autonomous Storage**: Local persistence of the topological broadcast sequence using the `StorageAdapter`.
- **ASP-Independent Exit**: Ability to orchestrate and transmit the full withdrawal sequence directly to the Bitcoin network without contacting the ASP/Indexer.

---

## 🚀 Getting Started

### Installation
```bash
npm install
```

### Running Tests
The suite includes unit, integration, and security audit tests.
```bash
# Run all core and security tests
npm test

# Run the Audit Black-Box (ASP-Malicious Mirage/Poisoning/Mirage)
npx vitest run src/__tests__/blackboxSec.test.ts

# Run the Scaling/Stress/DoS Audit (1,000 Node DAGs & Merkle Bombs)
npx vitest run src/__tests__/stress_dos.test.ts

# Run the Integration E2E Mock Node (Arkd + Bitcoin Core)
node --experimental-strip-types src/scripts/mockNodes.ts &
npx vitest run src/__tests__/arkd_integration.test.ts
```

### Configuration: Storage Adapter
To enable Tier 3 Sovereign Exits, provide an implementation of the `StorageProvider` interface (e.g., `localStorage` in browsers or a file-persistent store in Node.js):

```typescript
const myStorage: StorageProvider = {
  getItem: async (key) => ... ,
  setItem: async (key, val) => ...
};

// Hook it into the receive flow to enable autonomous data-at-rest encryption
await onReceiveVtxo(outpoint, indexer, onchain, myStorage);
```

---

## 🛡 Security Properties (Hardened)
- **Zero-Trust**: No data from the ASP is trusted until verified.
- **Privacy-Preserving**: Client fetches entire batches from the Indexer, hiding specific VTXO ownership from the ASP.
- **Forensic Security (Encryption)**: Exit data is stored using AES-256-GCM. No private withdrawal metadata is at rest in plain text.
- **Ouroboros Protection (Cycle)**: Iterative cycle detection prevents infinite loop ASP attacks (`CYCLE_DETECTED`).
- **Iterative Robustness**: All traversals are iterative, preventing `Stack Overflow` attacks on extremely deep transaction chains (1,000+ nodes).
- **Atomic Consistency**: Checks relative maturity (CSV) against actual block heights to ensure satisfiability.
- **Economic Inflation Prevention**: Automatically rejects nodes where output amounts exceed parent funding (`AMOUNT_MISMATCH`).
- **Orphan Payload Mitigation**: Aggressively rejects corrupted sub-graphs disconnected from the commitment anchor to prevent compute exhaustion (`INPUT_CHAIN_BREAK`).
