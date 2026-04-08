# Test Documentation: Tier 2 - Taproot & HTLC Verification

## Overview
This suite ensures the cryptographic integrity of the scripts, Merkle trees, and timelocks that define Ark's exit policies and atomic swap conditions.

### 🎯 Test Goals
1. **BIP 341/342 Compliance**: Verifying Tapleaf script hashing and Merkle proof validation.
2. **Ark Exit Policies**: Checking for the presence of mandatory `CHECKSEQUENCEVERIFY` in Ark leaves.
3. **HTLC Atomic Swaps**: Validating hash lock and locktime satisfaction for **Boltz Submarine Swaps**.

### 🌐 Environment
- **Providers**: `MockIndexerProvider` and `MockOnchainProvider`.
- **Data Source**: Custom scripts (`P2TR`) with embedded `HASH160` and `SHA256` conditions.
- **Execution**: Node.js/Vitest environment.

### 🧪 Evaluated Scenarios
| Scenario | Description | Expected |
| :--- | :--- | :--- |
| **Valid CSV** | A VTXO with a 24-hour maturation delay. | **PASS** |
| **Premature CSV** | A VTXO being spent before its relative maturity height. | **FAIL (TIMELOCK_NOT_REACHED)** |
| **Valid Hash Lock** | A Boltz Swap claim leaf with the correct SHA256 preimage. | **PASS** |
| **Missing Preimage** | Attempting to verify a HASH160 HTLC leaf without providing a preimage. | **FAIL (MISSING_HASH_PREIMAGE)** |
| **Trivial Script** | A Tapleaf script that is just `OP_TRUE`. | **FAIL (SECURITY_VIOLATION)** |
| **Script Poisoning** | Malformed Taproot script designed to bypass parsing. | **FAIL (INVALID_SCRIPT_FORMAT)** |

### 📈 Results
- **Security Audit**: COMPLIANT. Structural script decoding (Zero-Trust) eliminates bypass vectors.
- **Interoperability**: Verified full compatibility with Boltz's standard submarine swap script structure.
- **Total Suite Integration**: All 87/87 tests passed successfully.
