# Client-Side VTXO Verification for the Arkade TypeScript SDK

## 1. Overview

This module implements independent client-side verification of VTXOs received from the Ark Service Provider (ASP). A wallet can verify every claim the ASP makes without trusting it, using only its own Bitcoin node and the presigned transaction data.

Three tiers were implemented:
- **Tier 1 (Required):** Core chain verification (DAG, signatures, onchain anchor)
- **Tier 2 (Stretch):** Script satisfaction (timelocks, hash preimages, Boltz swap)
- **Tier 3 (Advanced):** Sovereign exit data storage and unilateral exit procedure

## 2. Verification Algorithm

### 2.1 Path-Only Verification (Tier 1)

Given a VTXO, the verifier traverses the DAG from the VTXO (root) backward to the onchain commitment transactions (leaves):

```
Your VTXO (root, most recent)
  |
  Virtual tx (ARK or TREE type)
    |
    Virtual tx (intermediate node)
      |
      Batch tree root (TREE type, spends commitment output)
        |
        Commitment Tx (leaf, oldest, on Bitcoin blockchain)
          confirmed >= 6 blocks
          output amount & script verified against raw tx hex
```

The DAG is traversed from the VTXO (root, most recent) backward in time through the virtual mempool to find the batch output commitment transactions (leaves, oldest, anchored onchain). A VTXO can be linked to multiple commitment transactions when its history spans multiple batches.

The algorithm (7-step verification pipeline):

**Step 1. Parse the full DAG** — Get all transactions from VTXO back to commitment tx(s). Prevents ASP from hiding or omitting transactions.

```
vtxoChainVerifier.ts:92
  vtxoChain = await indexer.getVtxoChain(outpoint)

vtxoChainVerifier.ts:152-158
  for each txid → Transaction.fromPSBT(base64.decode(psbt))
```

**Step 2. Verify parent-child references** — Does each tx's input actually point to the previous tx's output? Prevents ASP from inserting fake transactions into the chain.

```
vtxoChainVerifier.ts:179-194
  const parentTxid = hex.encode(input.txid)
  if (!commitmentTxidSet.has(parentTxid) && !pathTxs.has(parentTxid))
    → error: "references unknown parent"
```

**Step 3. Verify amount conservation** — Are outputs <= input at every level? Prevents ASP from printing money (e.g., inflating 10,000 to 100,000 sats). Falls back to deriving input amount from the parent tx output when the PSBT's witnessUtxo is missing.

```
vtxoChainVerifier.ts:197-218
  outputSum > inputAmount → error: "outputs exceed input"
```

**Step 4. Verify cosigner key aggregation (n-of-n MuSig2)** — Does the aggregated key require ALL cosigners to cooperate? Prevents ASP from using a key only it controls to unilaterally spend.

```
signatureVerifier.ts:155-176 (verifyCosignerKeys)
  aggregateKeys(cosignerKeys, true, { taprootTweak: sweepTapTreeRoot })
  compareBytes(finalKey.slice(1), previousScriptKey) === 0
```

**Step 5. Verify unspendable internal key (NUMS point)** — Is the taproot key path truly unspendable? The NUMS point (`50929b74...`) has no known private key, so key-path spending is impossible. This forces all spending through the script path (which has the multisig + timelock conditions). Prevents ASP from hiding a backdoor key that bypasses all script conditions.

```
signatureVerifier.ts:121-148 (verifyInternalKeysUnspendable)
  compareBytes(internalKey, TAPROOT_UNSPENDABLE_KEY) !== 0
    → error: "not the unspendable NUMS point"
```

**Step 6. Verify all Schnorr signatures (BIP-341)** — Is every presigned transaction's signature actually valid? Invalid signatures mean the user CANNOT perform a unilateral exit. For each input with a tapLeafScript, the expected signer pubkeys are extracted from the decoded tapscript, then each signature is verified against the BIP-341 sighash.

```
signatureVerifier.ts:34-100 (verifyTreeSignatures)
  decodeTapscript(rawScript) → get expected signer pubkeys
  verifyTapscriptSignatures(tx, inputIndex, expectedSigners)
    → internally: tx.preimageWitnessV1() + schnorr.verify()
```

**Step 7. Verify onchain anchoring (against the user's own Bitcoin node)** — Is the commitment tx real, confirmed, and matching? Uses the user's Bitcoin node directly, NOT the ASP's indexer. All commitment transactions in the DAG are independently verified.

```
onchainAnchorVerifier.ts:37-136 (verifyOnchainAnchor)
  a. onchain.getTxStatus(commitmentTxid) → confirmed? how many blocks deep?
  b. onchain.getTxHex(commitmentTxid) → parse raw tx independently,
     compare output.amount === expectedAmount
     compareBytes(output.script, expectedScript) === 0
  c. onchain.getTxOutspends(commitmentTxid) → has the batch output been spent?
```

Additional checks performed between Steps 3 and 6:
- **Checkpoint validation**: Checkpoint entries in the chain are checked for valid parent references and unexpired timestamps.
- **VTXO existence**: The VTXO's txid is confirmed to exist in the reconstructed DAG, and its output index is within bounds.

### 2.2 Script Satisfaction (Tier 2)

For each transaction input with a tapscript, the verifier dispatches to the appropriate checker based on decoded script type:

| Script Type | Checks |
|---|---|
| Multisig | Signatures only (covered by Tier 1) |
| CSVMultisig | nSequence vs BIP-68, type consistency, elapsed time since parent |
| CLTVMultisig | nLockTime vs script value, domain (blocks/seconds), chain tip |
| ConditionMultisig | Hash preimage via HASH160 or SHA256 |
| ConditionCSVMultisig | CSV + hash preimage combined |

Hash preimage verification parses the condition script's opcodes via `Script.decode()` to detect the hash algorithm, then computes and compares.

The `parentConfirmation` parameter enables real CSV satisfaction checking: not just "does nSequence encode the right value?" but "have enough blocks/seconds actually elapsed since the parent was confirmed?"

### 2.3 Sovereign Exit (Tier 3)

The `ExitData` interface captures everything needed for unilateral exit:
- Full chain path (leaf to commitment)
- All presigned virtual transaction PSBTs (keyed by txid)
- Tree node structure
- Commitment txid

`sovereignExit()` accepts `ExitDataRepository + OnchainProvider + Identity + AnchorBumper` but NOT `IndexerProvider` or `ArkProvider`. The function signature itself proves sovereignty. It walks the chain root-to-leaf, finalizes PSBTs, and broadcasts to Bitcoin.

## 3. Security Properties

### 3.1 Trust Model

| Component | Trust Level | Why |
|---|---|---|
| Bitcoin node | Trusted | Standard Bitcoin security model |
| ASP server info (pubkey, sweep interval) | Trusted | Fetched from ASP |
| Indexer (tree/chain data) | **Verified** | Root anchored onchain; cosigner keys checked at every level |
| DAG structure | **Verified** | Parent-child txid references, amount conservation |
| Signatures | **Verified** | BIP-341 sighash + schnorr.verify() |
| Cosigner keys | **Verified** | MuSig2 aggregated key == parent output script |
| Internal key path | **Verified** | Must be unspendable NUMS point |
| Commitment tx | **Verified** | Confirmed, output matches, spending reported |

### 3.2 What We Verify That Others May Not

- **NUMS internal key**: Without this check, the ASP could embed a spendable key path, bypassing all script conditions.
- **Checkpoint expiry**: Warns if checkpoint transactions have expired.
- **Leaf existence**: Confirms your specific VTXO actually exists in the path, not just that the tree structure is valid.
- **WitnessUtxo fallback**: When the indexer's PSBTs omit witnessUtxo (which happens in practice), the verifier derives it from the onchain commitment tx.

### 3.3 Threat Mitigation

| Threat | Mitigation |
|---|---|
| ASP fabricates VTXOs | DAG structure + sig verification + onchain anchor |
| ASP tampers amounts/scripts | Amount conservation at every level + output matching |
| ASP uses invalid cosigner keys | MuSig2 aggregation check against parent output |
| ASP embeds spendable key path | NUMS internal key verification |
| Unconfirmed or double-spent commitment tx | Onchain anchor with depth check + outspend monitoring |

## 4. Design Decisions

### 4.1 Path-Only vs Full-Tree Verification

We verify only the leaf-to-root path, not the full batch tree. This matches the spec ("from the VTXO (leaf) back to the batch output (root)") and is more efficient: O(log n) vs O(n) where n is the tree size. The security guarantee is identical for the user's own funds.

### 4.2 Result Object, Not Throw

`verifyVtxo()` returns `{valid, errors[], warnings[], confirmationDepth, chainLength}` instead of throwing. Callers can inspect partial results (e.g., "structure valid but only 3 confirmations").

### 4.3 Separate Module, Not Wallet Method

The core verification logic lives in `src/verification/` as standalone functions. This keeps them independently testable and maintains clear trust boundaries. Thin wrappers on the `Wallet` class (`wallet.verifyVtxo()`, `wallet.verifyAllVtxos()`) wire up the provider dependencies.

### 4.4 Reuse of Existing SDK Infrastructure

| Reused | Purpose |
|---|---|
| `validateVtxoTxGraph()` | DAG structure validation |
| `verifyTapscriptSignatures()` | BIP-341 Schnorr verification |
| `aggregateKeys()` | MuSig2 key aggregation |
| `decodeTapscript()` | 5-type tapscript decoder |
| `sequenceToTimelock()` | BIP-68 sequence decoding (DRY) |
| `TAPROOT_UNSPENDABLE_KEY` | NUMS point constant |
| `compareBytes()` | Byte comparison |

Only one new method was added to the existing SDK: `getTxHex()` on `OnchainProvider`.

### 4.5 Batch Output Spending as Warning, Not Error

In normal Ark operation, the commitment tx batch output IS spent by tree transactions. The double-spend check reports this as a warning, not an error, since we cannot distinguish expected tree spending from adversarial spending at the anchor verification layer.

## 5. Limitations

1. **Indexer PSBTs may omit witnessUtxo**: Handled via fallback to onchain commitment tx, but adds one extra network call.

2. **CSV real satisfaction requires parent confirmation info**: The `parentConfirmation` parameter is optional. Without it, only structural consistency (nSequence matches script) is verified, not actual elapsed time.

3. **Sovereign exit finalization is best-effort**: PSBT finalization depends on the witness structure (key-path vs script-path). Some edge cases in tapscript spending may require additional handling.

4. **No SPV-level indexer omission detection**: If the indexer omits transactions from the chain, the verifier will error ("unknown parent") but cannot independently discover the missing data.

## 6. Test Coverage

| Category | Tests | What's Covered |
|---|---|---|
| Onchain anchor | 14 | Confirmation depth, output matching, double-spend, errors |
| Signatures | 15 | Schnorr sigs, cosigner MuSig2, NUMS key |
| Chain verifier | 16 | Pipeline, chain fetch, path verification, checkpoints, edge cases |
| Script verifier | 24 | CSV, CLTV, HASH160, SHA256, combined, parentConfirmation |
| Exit data store | 13 | Collect, validate, repository CRUD |
| Sovereign exit | 12 | canExit, exit procedure, broadcast errors |
| **Unit subtotal** | **102** | |
| E2E (regtest) | 5 | Full pipeline, anchor, batch verify, exit data |
| **Grand total** | **107** | |

## 7. Tiers Completed

- **Tier 1**: Complete. DAG reconstruction (path-only), all signatures verified, onchain anchoring with confirmation depth, NUMS key verification, checkpoint validation.
- **Tier 2**: Complete. CSV/CLTV timelock verification with real elapsed-time check, HASH160/SHA256 hash preimage verification demonstrated on VHTLC (Boltz submarine swap) scripts.
- **Tier 3**: Complete. ExitData interface and InMemoryExitDataRepository, collectExitData/validateExitData, sovereignExit with broadcast-and-walk, canSovereignExit pre-flight check.
