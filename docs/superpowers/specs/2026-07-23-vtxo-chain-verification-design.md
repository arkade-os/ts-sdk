# Trustless VTXO Chain Verification Design

**Date:** 2026-07-23

## Goal

Add a client-side `verifyVtxo` capability to `@arkade-os/sdk` that can promote a
settled VTXO to `confirmed` without trusting the Ark operator or an indexer for
the truth of the claim.

The verifier may use an indexer or a local repository to obtain proof material,
but it treats that material as adversarial input. A result is `confirmed` only
when the claimed VTXO is bound through a valid virtual transaction graph to
independently verified Bitcoin commitment transactions.

## Scope

This change covers Tier 1 verification:

- VTXO leaf outpoint, amount, and script binding.
- Virtual transaction graph structure and amount conservation.
- TREE key-path Schnorr signatures (`tapKeySig`).
- ARK/checkpoint tapscript signatures and script constraints.
- Taproot NUMS internal-key constraints where script-path spending is expected.
- Commitment transaction raw bytes, confirmation depth, and outspend state
  obtained from an independent on-chain provider.
- Multi-level TREE graphs and VTXO histories that cross multiple batches.
- Structured results that distinguish cryptographic invalidity from unavailable
  proof material and from a merely preconfirmed VTXO.

The following remain out of scope:

- Tier 2 checkpoint anti-replay policy beyond the protocol checks needed for the
  traversed chain.
- Tier 3 signer-set transparency or operator identity consensus.
- A proof visualizer.
- Changes to wallet balance semantics or automatic rejection/deletion of coins.
- bChannel UI integration; that follows after an upstream SDK release.

## Trust Model

The indexer, Ark operator, and any delegated scanner may collude. They can omit,
reorder, duplicate, or fabricate chain entries and PSBTs. Such behavior must
result in `invalid` or `unavailable`, never `confirmed`.

The caller chooses an independent Bitcoin chain backend. That backend is trusted
for raw transaction bytes, confirmation status, chain tip, and outspend data.
The verifier does not claim protection against a malicious on-chain backend.

The local wallet repository is an availability and privacy optimization, not a
root of trust. Cached PSBTs are verified exactly like indexer-supplied PSBTs.

Possession of a viewing private key and a spending public key proves ownership
of a correctly constructed output, but does not prove that the output exists or
is anchored. MPC is not required for verification because verification uses
public keys and existing signatures only.

## Reference Implementation Constraint

The repository guidance names the ArkLabsHQ NArk/.NET SDK as the architectural
reference. No public NArk repository or accessible sibling checkout was
available while designing this change. The implementation therefore follows the
current TypeScript SDK's released exit resolver, transaction tree, PSBT, and
provider abstractions. This constraint must be called out in the pull request so
maintainers can identify any NArk parity adjustments during review.

## Public API

Expose a standalone function rather than adding a method to `Wallet` in the
first version:

```ts
export async function verifyVtxo(
    vtxo: VirtualCoin,
    proofSource: VtxoProofSource,
    chainSource: VtxoChainSource,
    serverInfo: VtxoVerificationServerInfo,
    options?: VtxoVerificationOptions,
): Promise<VtxoVerificationResult>;
```

`VtxoProofSource` matches the existing exit resolver boundary:

```ts
export interface VtxoProofSource {
    getVtxoChain(vtxo: Outpoint): Promise<ChainTx[]>;
    getVirtualTxs(txids: string[]): Promise<string[]>;
}
```

`ExitChainResolver` structurally satisfies this interface, so callers can use
`createExitChainResolver` and retain local-first retrieval.

The server input contains only the expected historical forfeit key:

```ts
export interface VtxoVerificationServerInfo {
    forfeitPubkey: Uint8Array;
}
```

The verifier decodes each TREE input's `VtxoTreeExpiry` field and accepts it
only when that expiry, the expected forfeit key, and the declared cosigners
reproduce the P2TR prevout key. The expiry is therefore proof material, not a
trusted caller-supplied policy value.

`VtxoChainSource` is deliberately narrower than changing every existing
`OnchainProvider` implementation:

```ts
export interface VtxoChainSource {
    getTxHex(txid: string): Promise<string>;
    getTxStatus(txid: string): Promise<
        | { confirmed: false }
        | { confirmed: true; blockTime: number; blockHeight: number }
    >;
    getTxOutspends(txid: string): Promise<{ spent: boolean; txid?: string }[]>;
    getChainTip(): Promise<{ height: number; time: number; hash: string }>;
}
```

`EsploraProvider` and `ElectrumOnchainProvider` will implement `getTxHex`.
Adding the method to their concrete classes does not expand the required
`OnchainProvider` interface. Custom providers can supply a small adapter.

Results use a discriminated union:

```ts
export type VtxoVerificationResult =
    | VtxoConfirmedResult
    | VtxoPreconfirmedResult
    | VtxoInvalidResult
    | VtxoUnavailableResult;
```

- `confirmed`: every required proof and anchor check passed.
- `preconfirmed`: the coin has no final commitment anchor; partial checks may be
  reported but this status is never truthy confirmation.
- `invalid`: complete-enough evidence demonstrates a cryptographic, structural,
  metadata, or anchor mismatch.
- `unavailable`: proof material or independent chain data could not be obtained
  or was incomplete.

All variants carry the requested outpoint. Diagnostic issues use stable codes
plus human-readable messages so downstream UI does not parse English strings.

`minConfirmationDepth` defaults to `6`. A caller may explicitly set it to `1`
or `0`; depth below the configured minimum cannot produce `confirmed`.

## Verification Pipeline

### 1. Resolve and parse proof material

Fetch the complete ancestry metadata for the requested outpoint. Reject
duplicate txids with conflicting metadata, unknown transaction types, cycles,
missing parents, and PSBT count/order mismatches. Parse PSBTs and recompute every
unsigned transaction id rather than trusting the lookup key.

Partition the ancestry graph into TREE segments rooted at commitment
transactions, with ARK/checkpoint transactions joining segments where a VTXO
crosses batches.

### 2. Bind the claimed VTXO

Locate the exact `txid:vout` in the parsed graph. The output must exist, and its
amount and script must byte-for-byte match the supplied `VirtualCoin`. Missing
metadata is not silently accepted.

### 3. Validate graph and scripts

For each TREE segment, reuse and extend `validateVtxoTxGraph` to validate:

- parent/child outpoint coherence;
- no duplicate spend of a graph output;
- complete amount conservation;
- expected Taproot output scripts;
- cosigner key aggregation;
- the expected server forfeit key and proof-carried sweep expiry;
- multi-level parent/child relationships.

For ARK and checkpoint nodes, validate actual transaction inputs against
declared parents, amounts, scripts, expiry encoding, and expected signer sets.

### 4. Verify signatures

TREE transactions spend parent outputs through Taproot key path. Verify every
`tapKeySig` with BIP-341 sighash construction using all input prevout scripts and
amounts, and the x-only output key extracted from the spent P2TR script.

ARK/checkpoint transactions spend through script path. Derive required signers
from the decoded tapscript, then use `verifyTapscriptSignatures`. Never derive
the required signer set from signatures already present in the PSBT.

Where script-path spending is required, verify that the control block uses the
standard unspendable NUMS internal key.

### 5. Verify each Bitcoin anchor independently

For every commitment transaction reached by the graph:

1. Fetch raw transaction hex from `VtxoChainSource`.
2. Parse it and recompute its txid.
3. Resolve every root TREE prevout directly from the commitment output. If the
   PSBT includes a witness UTXO it must match; if omitted, hydrate it from the
   authenticated raw transaction before graph and signature verification.
4. Fetch confirmation status and the shared chain tip.
5. Require confirmation depth to meet `minConfirmationDepth`.
6. Check the commitment output's outspend. An unspent output is valid. A spent
   output is valid only when the spender is the expected finalized root
   transaction; an unknown or different spender is invalid.

The chain tip is fetched once per `verifyVtxo` call to keep depth calculations
consistent across multiple anchors.

## Failure Classification

Malformed bytes, bad signatures, graph contradictions, metadata mismatches,
wrong anchor outputs, insufficient confirmation depth, and unexpected spends
are `invalid`.

Network errors, timeouts, unsupported provider capability, missing PSBTs, and
indexer withholding are `unavailable` unless the returned evidence itself
proves a contradiction.

A protocol-declared preconfirmed VTXO is `preconfirmed` even if all currently
available off-chain checks pass.

The verifier collects bounded diagnostics rather than throwing for adversarial
proof data. Programmer errors and invalid API arguments may still throw.

## Testing

Unit fixtures cover one-level and multi-level trees, mixed TREE/ARK/checkpoint
histories, multiple commitment anchors, and every result status.

Adversarial tests mutate:

- the VTXO amount, script, outpoint, and output index;
- ancestry metadata and PSBT ordering;
- TREE `tapKeySig`;
- ARK/checkpoint `tapScriptSig`;
- Taproot internal key and cosigner fields;
- commitment raw bytes, output script, amount, confirmation, and outspend;
- one anchor in a multi-anchor chain.

Each adversarial mutation must be observed failing before the corresponding
production implementation is added.

Regtest integration creates a real VTXO, mines the configured number of blocks,
verifies it as `confirmed`, and wraps the indexer to forge proof bytes that must
not verify.

## Downstream Semantics

bChannel will continue to label an operator-indexer sighting as `observed`.
Only `status === "confirmed"` from this verifier promotes it to `confirmed`.
`unavailable` retains the observed state, while `invalid` produces a security
warning. No verification path requires MPC or spending-key participation.
