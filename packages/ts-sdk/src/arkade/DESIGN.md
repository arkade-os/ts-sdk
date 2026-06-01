# ArkadeContract — Design

Status: **design / planning** (no implementation yet). This document is the agreed
target for the high-level contract API that sits on top of the Arkade primitives
(`ArkadeVtxoScript`, the script tweak, `EmulatorPacket`, `ConditionWitness`,
`buildOffchainTx`). It supersedes the exploratory `contract.ts` checkpoint.

## 1. Goals

1. **It should feel like *just Arkade*.** A developer defining a covenant, deriving
   its address and spending it should write idiomatic TypeScript — no manual key
   tweaking, no hand-encoded witness bytes, no PSBT/base64 juggling, and no
   awareness that a co-signing service exists.
2. **CashScript / viem / ethers ergonomics.** A contract is a set of named
   **functions** (its spending paths). Spending reads as
   `contract.functions.<name>(...args).to(...).send()`. The contract can look
   itself up on-chain (`address`, `getUtxos()`, `getBalance()`).
3. **Future-proof to the compiler.** `arkade-os/compiler` will emit a JSON
   artifact (contractName / constructorInputs / functions[].asm / …). The
   hand-written program object here is a strict subset of that artifact, so when
   the compiler ships the same `ArkadeContract` consumes its JSON with no API
   churn.
4. **Raw opcodes, not typed builders.** Paths are expressed as raw Arkade/Bitcoin
   opcode arrays (`ArkadeScript.encode([...])`-style), not via
   `ConditionMultisigTapscript`/`enforcePayTo`. Those helpers are fine but don't
   scale to arbitrary contracts.

## 2. Architecture background (why there are two script segments)

Every spending path splits across **two execution contexts**:

| Segment | Where it executes | What enforces it |
| --- | --- | --- |
| `tapscript` | Bitcoin consensus (the taproot leaf) | the chain — real Schnorr signatures, `CLTV`/`CSV`, hashlocks |
| `arkadeScript` | the Arkade VM, inside the emulator/TEE | the emulator only co-signs when the script passes |

Why the split is mandatory, not stylistic:

- **Arkade opcodes are not enforceable by Bitcoin consensus.** Bytes `0xc4–0xf3`
  (the `INSPECT*` family, 64-bit math, EC/asset ops) fall in BIP-342's
  `OP_SUCCESSx` range (`0xbb–0xfe`); `0xb3` is the repurposed `OP_NOP4`. On
  Bitcoin L1 those are no-ops that *make the script succeed* — so they can
  enforce nothing on-chain. They only mean something inside the Arkade VM.
- Therefore the `arkadeScript` **never lands in a taproot leaf**. It is carried in
  the **OP_RETURN Emulator Packet** and executed by the emulator, which
  interprets Arkade Script (its `CHECKSIG`/`SIGHASH` use a non-BIP342 sighash).
- The binding between the two is a **key tweak**: the co-signer key committed in
  the `tapscript` leaf is `coSigner + H("ArkScriptHash", arkadeScript)·G`. The
  emulator holds that key and **only produces its signature when it has executed
  the `arkadeScript` and it passed.** So:

  > a valid signature on the tweaked key *is* the proof the Arkade Script passed.

  Consensus only has to verify a signature (which it can), and gets the covenant
  for free without ever running an Arkade opcode.

### Security stance (locked)

- **The CHECKSIGs of real participants stay on the Bitcoin stack.** At minimum the
  user's signature is consensus-enforced, so a compromised TEE still cannot spend
  without the user's real Bitcoin signature. Standard opcodes (hashlocks,
  timelocks) may also live in `tapscript` when on-chain enforcement is wanted.
- **Every contract has a pure-`tapscript` unilateral exit** so funds are always
  recoverable without the emulator. In VTXOs this is a **relative timelock
  (`CSV`)**, derived from the server's `unilateralExitDelay` — *not* an absolute
  `CLTV`. (App-level deadlines like an HTLC refund are a different, cooperative
  thing and may use `CLTV`.)

## 3. The `Arkade` client

Providers/identity/network are declared **once** as a client, not threaded into
every contract. The client resolves and caches the network constants (server
x-only key, checkpoint closure, emulator key) so `contract()` is synchronous.

```ts
// (1) explicit
const arkade = await Arkade.connect({
    arkade:   new RestArkProvider(ARK_URL),       // the Ark/Arkade server
    emulator: new RestEmulatorProvider(EMU_URL),  // the introspector / co-signing service
    indexer:  new RestIndexerProvider(ARK_URL),
    identity,                                      // signer (optional → watch-only)
    network:  networks.regtest,
});

// (2) from an existing Wallet — reuses indexerProvider, network, arkServerPublicKey, identity
const arkade = await Arkade.fromWallet(wallet, { emulator });   // emulator is the only extra
```

- `Wallet` already carries `identity`, `network`, `indexerProvider`,
  `onchainProvider`, `arkServerPublicKey`. The **only** thing it lacks is the
  emulator, so `fromWallet` takes just `{ emulator }`. (Follow-up option: teach
  `Wallet.create` an optional `emulatorProvider`, alongside `delegateProvider`,
  so later `Arkade.fromWallet(wallet)` needs nothing — out of scope for the first
  cut.)
- `identity` is the **signer**: when a path's `tapscript.signers` includes the
  user, the builder signs with `arkade.identity` automatically (CashScript's
  `SignatureTemplate`, but the client already holds the key).
- Resolved once and cached: `serverKey` (x-only), `checkpoint` closure, `emulatorKey`.

```ts
// contracts are cheap & synchronous off the client:
const htlc = arkade.contract(program, { receiver, amount: 10_000n, hash });
```

## 4. The `Program` model

A program is a set of named **functions**. Each function is split into the two
segments from §2, plus its named call inputs (the ABI).

```ts
const htlc: arkade.Program = {
    params: { receiver: "bytes", amount: "int", hash: "bytes" },  // baked at instantiation

    functions: {
        claim: {
            inputs: { preimage: "bytes" },                        // the function's call args

            // Bitcoin Script — enforced on-chain. `signers` → checksigs; the
            // tweaked co-signer key is appended by the SDK automatically.
            tapscript: {
                signers: ["server"],
                asm: ["HASH160", "$hash", "EQUALVERIFY"],          // optional extra standard opcodes
                witness: ["preimage"],                             // consumed from the taproot witness
            },

            // Arkade Script — emulated, bound via the tweaked signature.
            arkadeScript: {
                asm: [
                    "DUP", "INSPECTOUTPUTSCRIPTPUBKEY", 1, "EQUALVERIFY",
                    "$receiver", "EQUALVERIFY",
                    "INSPECTOUTPUTVALUE", "$amount", "EQUAL",
                ],
                witness: [0],                                      // consumed from the packet entry
            },
        },

        // Unilateral exit: pure tapscript, relative timelock, no arkadeScript.
        exit: {
            tapscript: { signers: ["user"], csv: "unilateralExitDelay" },
        },
    },
};
```

### Placeholders & values

- `$name` → a `params` value, supplied as constructor args to `arkade.contract(program, args)`.
- `signers: ["server" | "user" | <pubkey>]` → resolved keys. `"server"` =
  `arkade.serverKey`; `"user"` = `arkade.identity` public key; or a literal
  pubkey. The SDK appends the **tweaked co-signer** to the leaf's key set.
- `csv: "unilateralExitDelay"` (or a literal) → relative timelock for exit leaves,
  defaulted from `arkade.getInfo()`.
- A segment with no `arkadeScript` is a pure-tapscript path (exits, plain
  multisig). A segment with `signers`-only and no `asm` is just the checksig(s).

### Witness routing (this is the "what does each part consume" answer)

Routing is **declared, not extracted** — the two segments run in different VMs on
different stacks, so there is no robust automatic cut of one interleaved script.
Instead each segment names what it consumes:

- **`tapscript.signers`** → each entry consumes exactly one signature, produced by
  the matching `Identity`/resolved key. The developer never hand-rolls a sig.
- **`tapscript.witness`** → named inputs / literals consumed from the **taproot
  script-path witness** (e.g. `"preimage"` for a hashlock). Set via the
  `ConditionWitness` PSBT field on the ark tx + checkpoints.
- **`arkadeScript.witness`** → named inputs / literals consumed from the
  **Emulator Packet** entry (e.g. `0` = output index). Numbers are minimally
  script-num encoded, so `0` is literally `0`, not the `[0x01,0x00]` wire form.

`inputs` are typed, so `contract.functions.claim` is inferred as
`(preimage: Uint8Array) => builder` and each segment references inputs by name.

### Validation

- `tapscript.asm` must contain **only standard Bitcoin opcodes** (reject Arkade
  extension opcodes — they'd be `OP_SUCCESS` on-chain).
- `arkadeScript.asm` is where the Arkade opcodes live.
- Every contract must expose at least one pure-`tapscript` exit path.

## 5. Fluent spend API

```ts
contract.address;                 // funding address
await contract.getUtxos();        // spendable VTXOs (indexer)
await contract.getBalance();      // bigint

const { txid } = await contract.functions
    .claim(preimage)              // named path + typed unlock args
    .from(coin?)                  // optional; defaults to auto-select from getUtxos()
    .to(script, amount)           // repeatable; or .to([{script, amount}, ...])
    .send();                      // build + submit to emulator → finalized tx

// .build() returns the unsigned { arkTx, checkpoints } without broadcasting.
```

Under the hood `send()`:
1. resolves the leaf for the chosen path (tweaked co-signer key already in the tree),
2. `buildOffchainTx([coin], outputs, checkpoint)`,
3. sets `ConditionWitness` (tapscript witness) on the ark tx + checkpoints,
4. attaches the `EmulatorPacket` (arkadeScript + its witness),
5. signs any user `signers` with `arkade.identity`,
6. submits to the emulator, returns `{ txid, signedArkTx, signedCheckpointTxs }`.

## 6. Mapping to existing primitives

| Design concept | Existing primitive |
| --- | --- |
| taproot tree + tweaked co-signer | `ArkadeVtxoScript` (+ `computeArkadeScriptPublicKey`) |
| leaf lookup for a path | `ArkadeVtxoScript.leafScript(index)` (added) |
| tapscript witness (preimage…) | `ConditionWitness` + `setArkPsbtField` |
| arkadeScript + its witness | `EmulatorPacket` in an `Extension` OP_RETURN |
| build ark tx + checkpoints | `buildOffchainTx`, checkpoint from `arkade.getInfo()` |
| submit / co-sign | `EmulatorProvider.submitTx` |
| address / pkScript | `VtxoScript.address` / `.pkScript` |

## 7. Compiler forward-compatibility

The compiler artifact is a superset: `contractName`, `constructorInputs`
(↔ `params`), `functions[]` with `functionInputs` (↔ `inputs`), `serverVariant`
(cooperative vs exit), and `asm`. The compiler emits **one** `asm` per function
with `<sig>`/CHECKSIG + `INSPECT` placeholders; the SDK routes by opcode class
(standard → `tapscript`, Arkade → `arkadeScript`) or honours an explicit boundary
the compiler marks. Either way `ArkadeContract` consumes *segments* internally, so
`new ArkadeContract(artifactJson, args, { client })` works later with no surface
change — the hand-written `Program` is just the artifact minus
`source`/`compiler`/`require` metadata.

## 8. Decisions locked

- **Client fields:** `arkade`, `emulator`, `indexer`, `identity`, `network`.
- **Segment names:** `tapscript` (on-chain) and `arkadeScript` (emulated). Never "covenant".
- **Cooperative leaf:** participant `signers` **+** tweaked co-signer (option b).
- **`tapscript` form:** general `{ signers, asm?, witness? }` (hashlocks/timelocks
  can be on-chain), `signers`-only is the common shorthand.
- **Exit:** relative `CSV`, pure tapscript, mandatory.
- **Emulator location:** on the `Arkade` client now; optional `Wallet.create`
  integration is a follow-up.
- **Witness model:** declared per segment with named inputs (no auto-extraction).

## 9. Phased implementation plan

1. **Types + resolver** — `Program`, `params`/`$placeholder` resolution, `signers`
   resolution, witness encoding, opcode-class validation. Build the taproot tree
   via `ArkadeVtxoScript`; resolve server/emulator keys + checkpoint from the
   client.
2. **`Arkade` client** — `connect()` and `fromWallet()`; cache network constants;
   `contract(program, args)`.
3. **Contract + builder** — `functions.<name>(...)`, `.from/.to/.send/.build`,
   `address`/`getUtxos`/`getBalance`, automatic user signing via `identity`.
4. **Tests** — rewrite `arkade-htlc.test.ts` on the new API; offline unit tests
   for placeholder resolution, witness routing/encoding, address parity, exit
   leaf, validation errors.
5. **Artifact adapter (stub)** — accept the compiler JSON behind the same
   constructor, marked experimental.

## 10. Target e2e (HTLC) for reference

```ts
const htlc = arkade.contract(htlcProgram, { receiver, amount: CONTRACT_AMOUNT, hash: HTLC_PREIMAGE_HASH });

faucetOffchain(htlc.address, Number(CONTRACT_AMOUNT));
await waitFor(async () => (await htlc.getUtxos()).length > 0);

// happy path
const { txid } = await htlc.functions.claim(HTLC_PREIMAGE).to(receiver, CONTRACT_AMOUNT).send();
expect(txid).toBeTruthy();

// negative paths still throw (emulator rejects wrong script/amount)
await expect(htlc.functions.claim(HTLC_PREIMAGE).to(OP_RETURN, CONTRACT_AMOUNT).send()).rejects.toThrow();
```
