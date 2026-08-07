# Trustless VTXO Chain Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public `verifyVtxo` API that confirms a VTXO only after independently validating its virtual transaction history, signatures, leaf metadata, and Bitcoin anchors.

**Architecture:** A standalone verification module consumes the existing local-first `ExitChainResolver` shape and a narrow independent chain-source interface. Focused parsers build verified graph segments, signature helpers validate TREE key-path and ARK/checkpoint script-path signatures, and an anchor helper binds each claimed commitment to raw Bitcoin data. The orchestrator returns a discriminated result union so unavailable data can never be mistaken for invalid evidence or confirmation.

**Tech Stack:** TypeScript 5.9, Vitest 3, `@scure/btc-signer` 2, `@noble/curves` Schnorr, pnpm 10.25.

> **Implementation note:** Live arkd PSBTs omit TREE `witnessUtxo`. The final
> implementation reconstructs root prevouts from raw Bitcoin commitments and
> child prevouts from parent virtual transactions. It also derives the sweep
> expiry from `VtxoTreeExpiry`, so `VtxoVerificationServerInfo` carries only
> `forfeitPubkey`; the proof-carried expiry must reproduce the anchored output.

## Global Constraints

- Base all work on `upstream/master` version `0.4.49` or newer.
- Use Node `>=24.15.0 <25` and pnpm `>=10.25.0 <11`.
- Keep `OnchainProvider` source-compatible for custom implementations.
- Default `minConfirmationDepth` is `6`.
- Only a `confirmed` result represents trustless receipt confirmation.
- Treat indexer, operator, delegated scanner, and cached PSBT bytes as adversarial input.
- Do not include Tier 2, Tier 3, a proof visualizer, bChannel UI changes, or wallet coin deletion.
- Note in the pull request that the NArk reference checkout was unavailable.

---

## File Structure

- `packages/ts-sdk/src/verification/types.ts`: public source, option, issue, and result types.
- `packages/ts-sdk/src/verification/proof.ts`: adversarial chain metadata and PSBT parsing into graph segments.
- `packages/ts-sdk/src/verification/signatures.ts`: TREE key-path, script-path, NUMS, and signer-set checks.
- `packages/ts-sdk/src/verification/anchor.ts`: raw Bitcoin commitment, depth, output, and outspend validation.
- `packages/ts-sdk/src/verification/verifyVtxo.ts`: phase orchestration and result classification.
- `packages/ts-sdk/src/verification/index.ts`: verification module exports.
- `packages/ts-sdk/src/providers/onchain.ts`: concrete Esplora raw-transaction retrieval.
- `packages/ts-sdk/src/providers/electrum.ts`: concrete Electrum raw-transaction retrieval.
- `packages/ts-sdk/src/index.ts`: public package exports.
- `packages/ts-sdk/test/verification/*.test.ts`: focused unit and adversarial tests.
- `packages/ts-sdk/test/e2e/verification.test.ts`: live regtest confirmation and forged-proof rejection.

### Task 1: Independent raw-transaction sources

**Files:**
- Modify: `packages/ts-sdk/src/providers/onchain.ts`
- Modify: `packages/ts-sdk/src/providers/electrum.ts`
- Create: `packages/ts-sdk/test/verification/chainSources.test.ts`

**Interfaces:**
- Consumes: existing `baseFetch`, `ElectrumWS.request`, and `GetTransactionMethod`.
- Produces: public concrete methods `EsploraProvider.getTxHex(txid)` and `ElectrumOnchainProvider.getTxHex(txid)`.

- [ ] **Step 1: Write failing Esplora and Electrum tests**

Create tests that stub the existing transport seams and assert trimmed raw hex:

```ts
it("fetches and trims Esplora raw transaction hex", async () => {
    fetchMock.mockResolvedValue(new Response("02000000\\n", { status: 200 }));
    const provider = new EsploraProvider("https://chain.example/api");
    await expect(provider.getTxHex("11".repeat(32))).resolves.toBe("02000000");
});

it("fetches Electrum raw transaction hex without verbose mode", async () => {
    electrum.request.mockResolvedValue("02000000");
    const provider = new ElectrumOnchainProvider(electrum, networks.regtest);
    await expect(provider.getTxHex("22".repeat(32))).resolves.toBe("02000000");
    expect(electrum.request).toHaveBeenCalledWith(
        "blockchain.transaction.get",
        "22".repeat(32),
        false,
    );
});
```

- [ ] **Step 2: Run the source tests and verify RED**

Run:

```bash
pnpm -C packages/ts-sdk vitest run test/verification/chainSources.test.ts
```

Expected: FAIL because both concrete providers lack `getTxHex`.

- [ ] **Step 3: Implement the two concrete methods**

Add to `EsploraProvider`:

```ts
async getTxHex(txid: string): Promise<string> {
    const response = await baseFetch(`${this.baseUrl}/tx/${txid}/hex`);
    const body = await response.text();
    if (!response.ok) {
        throw new Error(`Failed to get transaction hex: ${body}`);
    }
    return body.trim();
}
```

Add to `ElectrumOnchainProvider` using its existing request wrapper:

```ts
async getTxHex(txid: string): Promise<string> {
    return this.ws.request<string>(GetTransactionMethod, txid, false);
}
```

Do not change the public `OnchainProvider` interface.

- [ ] **Step 4: Verify GREEN and run provider regression tests**

Run:

```bash
pnpm -C packages/ts-sdk vitest run test/verification/chainSources.test.ts
pnpm -C packages/ts-sdk vitest run test/esplora.test.ts test/electrum.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ts-sdk/src/providers/onchain.ts \
  packages/ts-sdk/src/providers/electrum.ts \
  packages/ts-sdk/test/verification/chainSources.test.ts
git commit -m "feat(verification): expose raw transaction sources"
```

### Task 2: Public verification contract and proof parsing

**Files:**
- Create: `packages/ts-sdk/src/verification/types.ts`
- Create: `packages/ts-sdk/src/verification/proof.ts`
- Create: `packages/ts-sdk/src/verification/index.ts`
- Create: `packages/ts-sdk/test/verification/proof.test.ts`

**Interfaces:**
- Consumes: `Outpoint`, `VirtualCoin`, `ChainTx`, `Transaction`, `TxTree`, `RelativeTimelock`.
- Produces: `VtxoProofSource`, `VtxoChainSource`, `VtxoVerificationOptions`, `VtxoVerificationIssue`, `VtxoVerificationResult`, `ParsedVtxoProof`, and `parseVtxoProof`.

- [ ] **Step 1: Write failing parser tests**

Cover a valid one-level TREE proof and individual rejection cases for:

```ts
it.each([
    ["duplicate metadata", duplicateChain],
    ["missing PSBT", missingPsbt],
    ["PSBT txid mismatch", wrongTxidPsbt],
    ["cycle", cyclicChain],
    ["unknown parent", orphanChain],
])("rejects %s", async (_name, fixture) => {
    await expect(parseVtxoProof(outpoint, fixture.source)).rejects.toMatchObject({
        code: expect.stringMatching(/^proof_/),
    });
});
```

Also assert that `createExitChainResolver(...)` is assignable to
`VtxoProofSource` without an adapter.

- [ ] **Step 2: Run parser tests and verify RED**

Run:

```bash
pnpm -C packages/ts-sdk vitest run test/verification/proof.test.ts
```

Expected: FAIL because the verification module does not exist.

- [ ] **Step 3: Define the public discriminated result types**

Implement these stable status shapes:

```ts
export type VtxoVerificationStatus =
    | "confirmed"
    | "preconfirmed"
    | "invalid"
    | "unavailable";

export type VtxoVerificationIssue = {
    code: string;
    message: string;
    txid?: string;
    inputIndex?: number;
    outputIndex?: number;
};

type BaseResult = {
    outpoint: Outpoint;
    commitmentTxids: string[];
    chainLength: number;
    issues: VtxoVerificationIssue[];
};

export type VtxoVerificationResult =
    | (BaseResult & {
          status: "confirmed";
          confirmationDepth: number;
      })
    | (BaseResult & {
          status: "preconfirmed";
          partialChecks: Partial<Record<VtxoVerificationCheck, boolean>>;
      })
    | (BaseResult & { status: "invalid" })
    | (BaseResult & { status: "unavailable" });
```

Define `VtxoProofSource` with the same two methods as `ExitChainResolver`, and
define `VtxoChainSource` with `getTxHex`, `getTxStatus`, `getTxOutspends`, and
`getChainTip`.

- [ ] **Step 4: Implement strict proof parsing**

`parseVtxoProof` must:

1. fetch ancestry once;
2. identify commitment and virtual entries;
3. fetch virtual PSBTs in declared order;
4. parse every PSBT and compare `Transaction.id` to the declared txid;
5. derive actual parents from inputs and compare them with `ChainTx.spends`;
6. detect duplicate/conflicting entries, cycles, and disconnected nodes;
7. build TREE segments with `TxTree.create`;
8. return parsed transactions, segments, and commitment ids without asserting
   cryptographic validity.

Use a typed internal error:

```ts
export class VtxoProofError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly kind: "invalid" | "unavailable",
    ) {
        super(message);
    }
}
```

Transport failure and absent bytes use `kind: "unavailable"`; contradictory
bytes or metadata use `kind: "invalid"`.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
pnpm -C packages/ts-sdk vitest run test/verification/proof.test.ts
```

Expected: all parser tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ts-sdk/src/verification packages/ts-sdk/test/verification/proof.test.ts
git commit -m "feat(verification): parse adversarial VTXO proofs"
```

### Task 3: Claimed leaf and graph validation

**Files:**
- Create: `packages/ts-sdk/src/verification/graph.ts`
- Modify: `packages/ts-sdk/src/verification/types.ts`
- Create: `packages/ts-sdk/test/verification/graph.test.ts`

**Interfaces:**
- Consumes: `ParsedVtxoProof`, `VirtualCoin`, `validateVtxoTxGraph`, `TxTree`.
- Produces: `verifyClaimedLeaf(vtxo, proof)` and `verifyGraphSegments(proof, serverInfo)`.

- [ ] **Step 1: Write failing leaf-binding tests**

For a valid parsed fixture, independently mutate the claim:

```ts
expect(verifyClaimedLeaf(validCoin, proof)).toEqual([]);
expect(verifyClaimedLeaf({ ...validCoin, value: validCoin.value + 1 }, proof)[0].code)
    .toBe("leaf_amount_mismatch");
expect(verifyClaimedLeaf({ ...validCoin, script: forgedScript }, proof)[0].code)
    .toBe("leaf_script_mismatch");
expect(verifyClaimedLeaf({ ...validCoin, vout: 99 }, proof)[0].code)
    .toBe("leaf_output_missing");
expect(verifyClaimedLeaf({ ...validCoin, txid: unknownTxid }, proof)[0].code)
    .toBe("leaf_tx_missing");
```

- [ ] **Step 2: Write failing graph tests**

Cover one-level and three-level trees, then mutate a child parent outpoint,
duplicate-spend one parent output, inflate a child output, remove cosigner
metadata, and replace the configured sweep leaf.

- [ ] **Step 3: Run graph tests and verify RED**

Run:

```bash
pnpm -C packages/ts-sdk vitest run test/verification/graph.test.ts
```

Expected: FAIL because graph verification functions are missing.

- [ ] **Step 4: Implement exact leaf binding**

Look up the transaction by recomputed id and require:

```ts
claimed.txid === tx.id;
claimed.vout < tx.outputsLength;
BigInt(claimed.value) === output.amount;
claimed.script !== undefined;
hex.encode(output.script) === claimed.script.toLowerCase();
```

Return stable issues for each mismatch; do not accept a missing claimed script.

- [ ] **Step 5: Implement per-segment graph validation**

Derive the sweep Taproot root from:

```ts
const sweepScript = CSVMultisigTapscript.encode({
    timelock: serverInfo.sweepInterval,
    pubkeys: [serverInfo.pubkey],
}).script;
const sweepTapTreeRoot = tapLeafHash(sweepScript);
```

For each commitment-rooted TREE segment, invoke `validateVtxoTxGraph` with the
parsed commitment transaction representation, then add explicit duplicate-spend
and actual-parent checks across segment boundaries. Convert thrown validation
errors into stable `graph_*` issues.

- [ ] **Step 6: Verify GREEN and existing tree regressions**

Run:

```bash
pnpm -C packages/ts-sdk vitest run test/verification/graph.test.ts
pnpm -C packages/ts-sdk vitest run test/arkade-batch.test.ts test/exit-path.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/ts-sdk/src/verification/graph.ts \
  packages/ts-sdk/src/verification/types.ts \
  packages/ts-sdk/test/verification/graph.test.ts
git commit -m "feat(verification): bind VTXO leaves to transaction graphs"
```

### Task 4: Cryptographic signature verification

**Files:**
- Create: `packages/ts-sdk/src/verification/signatures.ts`
- Create: `packages/ts-sdk/test/verification/signatures.test.ts`

**Interfaces:**
- Consumes: parsed `Transaction`s, `verifyTapscriptSignatures`, `decodeTapscript`, `schnorr.verify`.
- Produces: `verifyProofSignatures(proof): VtxoVerificationIssue[]`.

- [ ] **Step 1: Write a failing valid TREE key-path test**

Build a P2TR prevout with a known private key, compute the BIP-341 message using
`Transaction.preimageWitnessV1`, store a real 64-byte Schnorr signature in
`tapKeySig`, and expect no issues.

- [ ] **Step 2: Write the forged TREE signature regression**

Flip one byte of the valid `tapKeySig`:

```ts
const forged = Uint8Array.from(validSignature);
forged[0] ^= 0xff;
tree.updateInput(0, { tapKeySig: forged });
expect(verifyProofSignatures(proof)).toContainEqual(
    expect.objectContaining({ code: "signature_invalid_tap_key" }),
);
```

Also cover missing signature, non-P2TR witness UTXO, 65-byte allowed sighash,
and a rejected unsupported sighash.

- [ ] **Step 3: Write failing script-path and NUMS tests**

Use a real tapscript fixture and assert:

- required signers are decoded from the script;
- a self-consistent signature from an unlisted key is rejected;
- missing required signatures are rejected;
- a non-NUMS internal key is rejected.

- [ ] **Step 4: Run signature tests and verify RED**

Run:

```bash
pnpm -C packages/ts-sdk vitest run test/verification/signatures.test.ts
```

Expected: FAIL because `verifyProofSignatures` does not exist.

- [ ] **Step 5: Implement TREE `tapKeySig` verification**

For every TREE input:

1. require `witnessUtxo`, `tapKeySig`, and a 34-byte `OP_1 PUSH32` script;
2. collect every input's prevout script and amount;
3. split a 64-byte default signature or 65-byte signature+sighash;
4. allow only `SigHash.DEFAULT`;
5. compute:

```ts
const message = tx.preimageWitnessV1(
    inputIndex,
    prevoutScripts,
    sighashType,
    prevoutAmounts,
);
const outputKey = input.witnessUtxo.script.slice(2);
const valid = schnorr.verify(signature, message, outputKey);
```

Emit `signature_invalid_tap_key` if verification returns false.

- [ ] **Step 6: Implement script-path and NUMS verification**

Decode each relevant tap leaf, extract its required pubkeys, invoke
`verifyTapscriptSignatures`, and compare its control-block internal key with
`TAPROOT_UNSPENDABLE_KEY`. Never infer required signers from `tapScriptSig`.

- [ ] **Step 7: Verify GREEN and existing signing regressions**

Run:

```bash
pnpm -C packages/ts-sdk vitest run test/verification/signatures.test.ts
pnpm -C packages/ts-sdk vitest run test/verifySignatures.test.ts test/musig2.test.ts
```

Expected: all selected tests PASS, including the forged `tapKeySig` rejection.

- [ ] **Step 8: Commit**

```bash
git add packages/ts-sdk/src/verification/signatures.ts \
  packages/ts-sdk/test/verification/signatures.test.ts
git commit -m "feat(verification): verify VTXO graph signatures"
```

### Task 5: Independent Bitcoin anchor verification

**Files:**
- Create: `packages/ts-sdk/src/verification/anchor.ts`
- Create: `packages/ts-sdk/test/verification/anchor.test.ts`

**Interfaces:**
- Consumes: `VtxoChainSource`, root TREE input witness UTXO, expected root txid.
- Produces: `verifyCommitmentAnchors(proof, chainSource, minDepth)`.

- [ ] **Step 1: Write failing happy-path anchor test**

Provide raw commitment bytes whose recomputed txid, output amount, and output
script match the TREE root input. Return confirmed status, a chain tip six
blocks later, and an unspent output. Expect depth `6` and no issues.

- [ ] **Step 2: Write failing adversarial anchor cases**

Independently test:

```ts
it.each([
    "anchor_txid_mismatch",
    "anchor_output_missing",
    "anchor_amount_mismatch",
    "anchor_script_mismatch",
    "anchor_unconfirmed",
    "anchor_depth_insufficient",
    "anchor_unexpected_spend",
])("reports %s", async (expectedCode) => {
    const result = await verifyCommitmentAnchors(mutatedProof(expectedCode), chain, 6);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: expectedCode }));
});
```

For expected unroll, return the finalized root transaction id as spender and
assert acceptance. For `spent: true` without a spender txid, require an
`anchor_spender_unknown` invalid issue.

- [ ] **Step 3: Write unavailable-source tests**

Make each chain-source method reject in turn and assert a typed
`VtxoVerificationUnavailableError` rather than a cryptographic issue.

- [ ] **Step 4: Run anchor tests and verify RED**

Run:

```bash
pnpm -C packages/ts-sdk vitest run test/verification/anchor.test.ts
```

Expected: FAIL because the anchor verifier is missing.

- [ ] **Step 5: Implement raw transaction and output binding**

Parse with:

```ts
const commitment = Transaction.fromRaw(hex.decode(rawHex), {
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
});
```

Compare `commitment.id` to the requested id and the exact output against the
TREE root input `witnessUtxo`.

- [ ] **Step 6: Implement shared-tip depth and outspend checks**

Fetch `getChainTip()` once. For each anchor compute:

```ts
const depth = tip.height - status.blockHeight + 1;
```

The minimum depth across all anchors becomes the confirmed result depth. An
anchor is valid when unspent, or when its spender equals the finalized expected
root txid.

- [ ] **Step 7: Verify GREEN**

Run:

```bash
pnpm -C packages/ts-sdk vitest run test/verification/anchor.test.ts
```

Expected: all anchor tests PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/ts-sdk/src/verification/anchor.ts \
  packages/ts-sdk/test/verification/anchor.test.ts
git commit -m "feat(verification): bind VTXO graphs to Bitcoin anchors"
```

### Task 6: `verifyVtxo` orchestration and status classification

**Files:**
- Create: `packages/ts-sdk/src/verification/verifyVtxo.ts`
- Modify: `packages/ts-sdk/src/verification/index.ts`
- Create: `packages/ts-sdk/test/verification/verifyVtxo.test.ts`

**Interfaces:**
- Consumes: parser, graph, signature, and anchor functions from Tasks 2–5.
- Produces: public `verifyVtxo(...) => Promise<VtxoVerificationResult>`.

- [ ] **Step 1: Write the four failing status tests**

Assert:

```ts
expect((await verifyVtxo(settledCoin, proof, chain, server)).status).toBe("confirmed");
expect((await verifyVtxo(preconfirmedCoin, proof, chain, server)).status)
    .toBe("preconfirmed");
expect((await verifyVtxo(forgedCoin, proof, chain, server)).status).toBe("invalid");
expect((await verifyVtxo(settledCoin, withholdingProof, chain, server)).status)
    .toBe("unavailable");
```

Assert that the default minimum depth is six and an explicit
`{ minConfirmationDepth: 1 }` changes the threshold.

- [ ] **Step 2: Write multi-level and multi-anchor orchestration tests**

Use a three-level TREE and a later ARK transaction joining inputs from two
batches. Require both commitment ids in the result and use the smaller anchor
depth. Mutating either anchor or any intermediate signature must make the whole
result `invalid`.

- [ ] **Step 3: Run orchestration tests and verify RED**

Run:

```bash
pnpm -C packages/ts-sdk vitest run test/verification/verifyVtxo.test.ts
```

Expected: FAIL because `verifyVtxo` is missing.

- [ ] **Step 4: Implement phase ordering and bounded diagnostics**

Implement phases in this order:

```ts
parse -> preconfirmed classification -> leaf -> graph -> signatures -> anchors
```

Map typed unavailable errors to `status: "unavailable"` and evidence
contradictions to `status: "invalid"`. Cap issues at 100 and add one
`issues_truncated` diagnostic when the cap is reached.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
pnpm -C packages/ts-sdk vitest run test/verification/verifyVtxo.test.ts
pnpm -C packages/ts-sdk vitest run test/verification
```

Expected: all verification tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ts-sdk/src/verification/verifyVtxo.ts \
  packages/ts-sdk/src/verification/index.ts \
  packages/ts-sdk/test/verification/verifyVtxo.test.ts
git commit -m "feat(verification): add trustless verifyVtxo API"
```

### Task 7: Public exports, documentation, and package checks

**Files:**
- Modify: `packages/ts-sdk/src/index.ts`
- Modify: `packages/ts-sdk/README.md`
- Create: `packages/ts-sdk/test/verification/publicApi.test.ts`

**Interfaces:**
- Consumes: verification module exports.
- Produces: package-root imports for `verifyVtxo` and all public verification types.

- [ ] **Step 1: Write a failing public API test**

Import from `../src` and assert:

```ts
expect(typeof verifyVtxo).toBe("function");
const source: VtxoProofSource = createExitChainResolver({ indexer });
expect(source).toBeDefined();
```

- [ ] **Step 2: Run the public API test and verify RED**

Run:

```bash
pnpm -C packages/ts-sdk vitest run test/verification/publicApi.test.ts
```

Expected: FAIL because package-root exports are absent.

- [ ] **Step 3: Export the API and add usage documentation**

Export `verifyVtxo`, result/source/options types, and stable issue types from
`src/index.ts`. Add a README example:

```ts
const proofSource = createExitChainResolver({
    indexer: wallet.indexerProvider,
    repository: wallet.virtualTxRepository,
});

const result = await verifyVtxo(vtxo, proofSource, chainSource, serverInfo);
if (result.status === "confirmed") {
    console.log(`confirmed at depth ${result.confirmationDepth}`);
}
```

Explain that proof retrieval is untrusted, the independent chain source is the
trust boundary, and `preconfirmed` is not confirmation.

- [ ] **Step 4: Run API, type, build, and lint checks**

Run:

```bash
pnpm -C packages/ts-sdk vitest run test/verification/publicApi.test.ts
pnpm -C packages/ts-sdk typecheck
pnpm -C packages/ts-sdk build
pnpm -C packages/ts-sdk lint
```

Expected: all commands exit `0`.

- [ ] **Step 5: Commit**

```bash
git add packages/ts-sdk/src/index.ts packages/ts-sdk/README.md \
  packages/ts-sdk/test/verification/publicApi.test.ts
git commit -m "docs(verification): export and document verifyVtxo"
```

### Task 8: Regtest adversarial integration and final verification

**Files:**
- Create: `packages/ts-sdk/test/e2e/verification.test.ts`
- Modify: `.github/workflows/ci.yml` only if the existing e2e glob/matrix does not include the new file.

**Interfaces:**
- Consumes: public package API and the existing regtest wallet helpers.
- Produces: end-to-end proof that real settled VTXOs confirm and forged indexer bytes do not.

- [ ] **Step 1: Write the real settled-VTXO integration test**

Create a wallet and VTXO using existing e2e helpers, mine enough blocks, resolve
the branch with the wallet repository plus real indexer, and assert:

```ts
expect(result.status).toBe("confirmed");
if (result.status === "confirmed") {
    expect(result.confirmationDepth).toBeGreaterThanOrEqual(1);
}
```

Use `{ minConfirmationDepth: 1 }` to keep the test cycle short.

- [ ] **Step 2: Run the integration test and verify its first failure**

Run:

```bash
pnpm run regtest:up:ts-sdk
pnpm run regtest:setup:ts-sdk
pnpm run regtest:test:ts-sdk test/e2e/verification.test.ts
```

Expected on first run: the new fixture exposes any wire-format mismatch between
unit fixtures and real arkd/indexer data. Record and fix only the production or
fixture mismatch demonstrated by the failure.

- [ ] **Step 3: Add forged-indexer integration cases**

Wrap `getVirtualTxs` to flip one byte in the first TREE `tapKeySig`, then assert
`status === "invalid"` and issue code `signature_invalid_tap_key`. Add a second
case that changes the claimed VTXO amount and expects
`leaf_amount_mismatch`.

- [ ] **Step 4: Run focused integration and unit suites**

Run:

```bash
pnpm run regtest:test:ts-sdk test/e2e/verification.test.ts
pnpm -C packages/ts-sdk test:unit
```

Expected: all tests PASS.

- [ ] **Step 5: Run repository-wide verification**

Run:

```bash
pnpm run build
pnpm run lint
pnpm run test:unit
```

Expected: all commands exit `0` with no new warnings.

- [ ] **Step 6: Commit**

```bash
git add packages/ts-sdk/test/e2e/verification.test.ts .github/workflows/ci.yml
git commit -m "test(verification): reject forged VTXO proofs on regtest"
```

### Task 9: Prepare the upstream pull request

**Files:**
- Modify: `docs/superpowers/specs/2026-07-23-vtxo-chain-verification-design.md` only if implementation-review findings require factual corrections.
- Modify: `docs/superpowers/plans/2026-07-23-vtxo-chain-verification.md` to mark every completed checkbox.

**Interfaces:**
- Consumes: verified branch history and test outputs.
- Produces: pushed fork branch and an upstream PR targeting `arkade-os/ts-sdk:master`.

- [ ] **Step 1: Review the final diff and commit topology**

Run:

```bash
git status --short
git log --oneline upstream/master..HEAD
git diff --check upstream/master...HEAD
git diff --stat upstream/master...HEAD
```

Expected: clean status, focused commits, no whitespace errors.

- [ ] **Step 2: Re-run the mandatory verification set**

Run:

```bash
pnpm -C packages/ts-sdk test:unit
pnpm -C packages/ts-sdk typecheck
pnpm run build
pnpm run lint
```

Expected: every command exits `0`.

- [ ] **Step 3: Push the branch**

```bash
git push -u origin feat/vtxo-verification-v2
```

Expected: the fork branch is created or updated successfully.

- [ ] **Step 4: Open the upstream PR**

Use `gh pr create --repo arkade-os/ts-sdk --base master --head cheng-chun-yuan:feat/vtxo-verification-v2`.
The body must state:

- the exact trust boundary;
- the four result statuses;
- the `tapKeySig` regression fixed relative to the old PR;
- multi-level and multi-anchor coverage;
- unit, build, lint, and regtest commands run;
- NArk was unavailable for parity review;
- Tier 2, Tier 3, visualizer, and bChannel UI are excluded.

- [ ] **Step 5: Record the PR URL**

Add the confirmed URL to the session handoff and do not claim upstream
acceptance until maintainers merge it.
