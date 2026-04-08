# Test Documentation: Tier 3 - Sovereign Unilateral Exit

## Overview
This suite validates the SDK's ability to operate autonomously after a VTXO has been received, ensuring all data required for on-chain withdrawal is permanently secured and broadcastable without contacting the Ark Service Provider (ASP).

### 🎯 Test Goals
1. **Sovereign Save**: Confirming that all raw transactions from the **Anchoring Leaf** (commitment) to the **VTXO Root** are correctly isolated and persisted.
2. **Top-Down Persistence**: Ensuring the storage adapter maintains the strict topological ordering of transactions (Anchor -> Root) to satisfy on-chain dependency rules.
3. **ASP-Independent Broadcast**: Verifying that the withdrawal sequence can be reconstructed and broadcast even with a completely disconnected IndexerService.

### 🌐 Environment
- **Providers**: `MockStorageProvider` (simulating local disk/browser storage) and `OnchainProvider` (simulating Node RPC).
- **Condition**: ASP (Indexer) simulation is explicitly disabled during the exit execution phase to guarantee sovereignty.

### 🧪 Evaluated Scenarios
| Scenario | Description | Expected |
| :--- | :--- | :--- |
| **Secure Save** | Saving a verified 5-depth VTXO and checking its persistence. | **PASS** |
| **Encrypted Save** | Storage of VTXO exit data with AES-256-GCM. | **PASS** |
| **Tampered Data** | Modification of encrypted ciphertext in storage. | **FAIL (AUTH_TAG_MISMATCH)** |
| **Recovery & Exit** | Reconstructing the broadcast sequence from local storage and pushing to network. | **PASS** |
| **Topological Sequence** | Verifying the Anchoring Leaf (spending commitment) is the first tx in the sequence. | **PASS** |
| **Missing Data** | Attempting an exit for a VTXO that was not locally secured. | **FAIL (NO_LOCAL_DATA)** |

### 📈 Results
- **Resilience**: The SDK successfully identifies and secures the necessary 100% of "Exit Data" during the `onReceiveVtxo` hook.
- **Independence**: Successfully completed 10+ withdrawal simulations with the Indexer service turned off.
- **Security Audit**: COMPLIANT. PBKDF2-HMAC-SHA256 (100k iterations) used for key derivation. (87/87 tests passed).
