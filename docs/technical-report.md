# Client-Side VTXO Verification for the Arkade TypeScript SDK

## Technical Report

### 1. Introduction

This report describes the design and implementation of client-side VTXO (Virtual Transaction Output) verification in the Arkade TypeScript SDK. The goal is to enable wallets to independently validate every claim made by the ASP (Ark Service Provider) without trusting it, using only a user-controlled Bitcoin node (via Esplora) and the presigned transaction data.

### 2. Verification Algorithm

The verification pipeline processes a VTXO through five sequential stages:

```
VTXO (leaf) --> Chain Fetch --> DAG Reconstruction --> Structure Validation
                                                          |
                                     Signature Verification <--+
                                                          |
                                     Onchain Anchoring  <--+
                                                          |
                                     Script Satisfaction <--+ (Tier 2)
                                                          |
                                     Result Object      <--+
```

**Stage 1: Chain Reconstruction.** The verifier calls `IndexerProvider.getVtxoChain()` to obtain the chain of transaction IDs from the VTXO leaf back to the commitment transaction. It then fetches the actual PSBT data via `getVirtualTxs()` and the full tree structure via `getVtxoTree()`. The raw data is fed into `TxTree.create()`, which reconstructs the directed acyclic graph (DAG) from flat chunks, identifying the root (the node not referenced as any other node's child) and recursively building the tree.

**Stage 2: DAG Structure Validation.** The existing `validateVtxoTxGraph()` function (reused from the settlement flow) validates:
- Each child transaction's input correctly references its parent transaction's output (matching txid and output index).
- Amount conservation: the sum of all root outputs equals the batch output amount from the commitment transaction.
- At each tree level, `sum(child outputs) == parent output` (no value created or destroyed).
- Cosigner public keys in each child's PSBT fields aggregate (via MuSig2 `aggregateKeys`) to produce the parent output's taproot key, ensuring the n-of-n key path is correctly constructed.

**Stage 3: Signature Verification.** For each transaction in the tree that has `tapScriptSig` entries, the verifier calls `verifyTapscriptSignatures()`. This function:
- Collects prevout scripts and amounts from `witnessUtxo` fields on all inputs.
- Reconstructs the BIP-341 sighash via `preimageWitnessV1()`.
- Verifies each Schnorr signature against the computed sighash and the signer's public key using `schnorr.verify()` from `@noble/curves`.

**Stage 4: Onchain Anchor Verification.** The verifier queries the user's Bitcoin node (Esplora) to confirm:
- The commitment transaction exists and is confirmed (`getTxStatus()`).
- The confirmation depth meets the minimum threshold (default: 6 blocks).
- The raw transaction hex is fetched independently (`getTxHex()`) and parsed to verify that the batch output's amount and script match what the tree root expects.
- The batch output has not been spent by another transaction (`getTxOutspends()`).

**Stage 5: Script Satisfaction (Tier 2).** For each input's tapscript, the verifier decodes the script type and checks:
- **CSV (BIP-68):** The input's `nSequence` encodes a relative timelock at least as large as the script requires, and enough blocks/time have elapsed since the parent transaction's confirmation.
- **CLTV (BIP-65):** The transaction's `nLockTime` meets the absolute threshold, and the current chain tip exceeds the required height or time.
- **Hash preimages (HASH160/SHA256):** For condition scripts (used in vHTLC contracts for Boltz submarine swaps), the witness preimage is hashed and compared against the expected hash in the script.

### 3. Security Properties

**What is verified (trust boundary):**
- The full DAG of presigned virtual transactions from leaf to batch output is structurally sound.
- All Schnorr signatures in the tree are cryptographically valid.
- The commitment transaction is confirmed onchain with the expected output amounts and scripts.
- The commitment output has not been double-spent.
- MuSig2 cosigner key aggregation produces the correct taproot output keys.

**Trust assumptions:**
- The user's Esplora instance is honest. If the user's Bitcoin node is compromised, verification is meaningless. This is identical to the trust assumption in the existing SDK for all onchain queries.
- The indexer returns the complete tree. The SDK cannot prove completeness without SPV headers and Merkle proofs, which are out of scope for this implementation.
- Verification is point-in-time. A block reorganization after `verifyVtxo()` returns could invalidate the result.

**What is NOT verified:**
- Key path (MuSig2 aggregate) spendability. The key path uses an unspendable internal key by design.
- Connector tree beyond structural validation (ASP-internal concern).
- Privacy of verification queries (Esplora calls leak VTXO interest).

### 4. Design Decisions and Trade-offs

**Result object vs. throwing.** The verification functions return a `VtxoVerificationResult` with `errors[]` and `warnings[]` arrays rather than throwing on the first failure. This allows callers to inspect partial results (e.g., "structure valid but only 3 confirmations"). The existing `validateVtxoTxGraph()` throws, which is appropriate for the settlement flow (abort on any failure) but not for user-facing verification where partial information is valuable.

**Required `getTxHex()` on OnchainProvider.** We added `getTxHex(txid)` as a required method on the `OnchainProvider` interface, which is a breaking change for custom implementations. The alternative (optional method with runtime errors) was rejected because verification is security-critical and compile-time enforcement is worth the breaking change. The method fetches `GET /tx/{txid}/hex` from Esplora, which is universally available.

**Separate verification module.** All verification code lives in `src/verification/` with three focused files (onchain anchor, signatures, chain orchestrator) plus a fourth for script verification. This avoids bloating `wallet.ts` (already 2700+ lines) and makes each verifier independently testable with different mock dependencies.

**Full DAG vs. exit-path verification.** The implementation verifies the complete tree, as specified in the assignment. However, for individual VTXO safety, verifying only the path from leaf to root is sufficient and cheaper. This optimization is tracked as a TODO for future discussion.

**Cache + bounded parallelism for `verifyAllVtxos()`.** Multiple VTXOs from the same batch share a commitment transaction. The batch verification method processes VTXOs in groups of 5 with `Promise.all` to avoid rate-limiting on public Esplora instances.

**Reuse of existing code.** The implementation reuses `validateVtxoTxGraph`, `verifyTapscriptSignatures`, `aggregateKeys`, `decodeTapscript`, and `TxTree` extensively. Approximately 70% of the verification logic was already present in the SDK; the new code is primarily orchestration and onchain anchoring.

### 5. Completed Tiers

**Tier 1 (Core VTXO Chain Verification): Complete.**
- DAG reconstruction from indexer data.
- Full structure validation (amounts, parent-child references, cosigner keys).
- Schnorr signature verification across all tree transactions.
- Onchain anchor verification (confirmation, output matching, double-spend detection).
- `Wallet.verifyVtxo()` and `Wallet.verifyAllVtxos()` public API.

**Tier 2 (Script Satisfaction Verification): Complete.**
- CSV (BIP-68) relative timelock verification against nSequence and chain state.
- CLTV (BIP-65) absolute timelock verification against nLockTime and chain tip.
- HASH160 and SHA256 hash preimage verification for condition scripts.
- Applicable to vHTLC contracts used in Boltz submarine swaps (Ark to LN).

**Tier 3 (Sovereign Exit Data Storage): Not implemented.**
- The `ExitDataRepository` interface and unilateral exit function were designed in the PRD but not implemented due to scope constraints. The design calls for a separate repository interface (following the existing `WalletRepository`/`ContractRepository` pattern) with implementations for IndexedDB, SQLite, and in-memory backends.

### 6. Test Coverage

| Module | Tests | Coverage |
|--------|-------|----------|
| `onchainAnchorVerifier.ts` | 10 | Confirmed/unconfirmed, depth warnings, amount/script mismatch, double-spend, error handling |
| `signatureVerifier.ts` | 6 | Valid sigs, missing signers, exclude pubkeys, cosigner key aggregation |
| `vtxoChainVerifier.ts` | 7 | Preconfirmed VTXO, empty chain, indexer errors, missing commitment tx, empty tree |
| `scriptVerifier.ts` | 11 | CSV pass/fail, CLTV pass/fail, HASH160 correct/wrong/missing, edge cases |
| **Total unit tests** | **34** | |
| E2E (regtest arkd) | 3 | Full settle-then-verify flow, verify-all, preconfirmed VTXO |

All unit tests use synthetic data constructed with `@scure/btc-signer` for determinism and speed. Integration tests use a local arkd instance on regtest with real settlement flows.

### 7. Limitations

1. **No SPV verification.** The implementation trusts the user's Esplora instance for confirmation data. Full trust minimization would require fetching block headers and Merkle inclusion proofs, which Esplora does not natively support.

2. **Point-in-time verification.** Results can be invalidated by block reorganizations. There is no continuous monitoring or reorg detection.

3. **Indexer completeness.** The SDK cannot prove the indexer returned the complete tree. An indexer omission attack (returning a partial tree) would not be detected.

4. **No exit data persistence.** Tier 3 (local storage of all data needed for unilateral exit) was not implemented. Without this, the wallet still depends on the ASP's indexer to reconstruct exit data.

5. **Condition witness extraction.** The hash preimage verifier looks for witness data in `finalScriptWitness` or Ark PSBT unknown fields. In practice, condition witnesses may be structured differently depending on the contract handler; the current implementation covers the standard vHTLC pattern.

### 8. Files

**New files (8 source + 4 test):**
- `src/verification/onchainAnchorVerifier.ts`
- `src/verification/signatureVerifier.ts`
- `src/verification/vtxoChainVerifier.ts`
- `src/verification/scriptVerifier.ts`
- `src/verification/index.ts`
- `test/verification/onchainAnchorVerifier.test.ts`
- `test/verification/signatureVerifier.test.ts`
- `test/verification/vtxoChainVerifier.test.ts`
- `test/verification/scriptVerifier.test.ts`
- `test/e2e/verification.test.ts`

**Modified files (3):**
- `src/providers/onchain.ts` (added `getTxHex()`)
- `src/wallet/wallet.ts` (added `verifyVtxo()`, `verifyAllVtxos()`)
- `src/index.ts` (exported verification module)
