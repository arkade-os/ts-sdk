# Introspector v0.0.1 — TS SDK Update + Test Ports

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update the ts-sdk to work with the released `introspector v0.0.1` (vs `v0.0.1-rc.2`) and port the `htlc_test.go` and `delegate_test.go` non-interactive covenant tests to TypeScript e2e.

**Architecture:** v0.0.1 adds the `SubmitOnchainTx` RPC, two new opcodes (`OP_INSPECTPACKET`, `OP_INSPECTINPUTPACKET`), an `INTROSPECTOR_ARKD_URL` env var (so the introspector can finalize VTXOs by talking to arkd directly), two new PSBT fields (`prevarktx` for intent proofs, `prevouttx` for plain Bitcoin txs) used by `OP_INSPECTINPUTSCRIPTPUBKEY`, a unified arbitrary-precision `BigNum` numeric type on the VM stack (sign-magnitude little-endian, up to 520 bytes), and fixes the seckey-negation behavior so any introspector secret key now works. We extend the existing `RestIntrospectorProvider`, `ARKADE_OP` table, `ArkPsbtFieldCoder` machinery, and `ArkadeScript` script encoder to accept `bigint` literals; expose a public `arkade.BigNum` API for users who want to encode/decode numbers outside the script encoder; then port three e2e tests verifying non-interactive HTLC, delegate-refresh, and onchain-spend flows. The delegate test uses a custom `Batch.Handler` (not `createArkadeBatchHandler`) because the user identity is not in the forfeit closure.

**Note on auto-finalization (former Task 3, removed):** an earlier draft auto-detected via `finalScriptWitness` whether the introspector had already submitted+finalized via arkd, and skipped re-submission. Per user direction, callers must instead know from their multisig topology whether the introspector was the last non-arkd signer — the SDK does not infer it. Tests using `submitTx` always proceed with `arkProvider.submitTx`/`finalizeTx` afterwards.

**Tech Stack:** TypeScript, vitest, `@scure/btc-signer`, `@scure/base`, Docker Compose, GitHub Actions, the existing `arkade-regtest` git submodule.

---

## File Structure

**Modified:**
- `docker-compose.introspector.yml` — bump image to `v0.0.1`, add `INTROSPECTOR_ARKD_URL`.
- `src/providers/introspector.ts` — add `submitOnchainTx` method to `IntrospectorProvider` and `RestIntrospectorProvider`.
- `src/arkade/opcodes.ts` — add `INSPECTPACKET = 0xf4` and `INSPECTINPUTPACKET = 0xf5` to `ARKADE_OP`.
- `src/utils/unknownFields.ts` — add `PrevArkTx` and `PrevoutTx` enum values and the matching coders.
- `src/index.ts` — export `PrevArkTxField` and `PrevoutTxField`.
- `test/e2e/utils.ts` — add e2e helpers shared by the ported tests.

**Created:**
- `test/e2e/arkade-htlc.test.ts` — port of `htlc_test.go` (claim + refund subtests).
- `test/e2e/arkade-delegate.test.ts` — port of `delegate_test.go` (non-interactive batch refresh).
- `test/e2e/arkade-onchain.test.ts` — port of `onchain_test.go` (SubmitOnchainTx, all subtests).
- `test/arkade-opcodes.test.ts` — unit test for the two new opcode constants.
- `test/prev-ark-tx-field.test.ts` — unit test for `PrevArkTxField` and `PrevoutTxField`.

**Why split the e2e tests by file:** the existing `test/e2e/arkade.test.ts` is already 500+ lines and mixes "covenant"-style tests with the full settlement flow. Each ported test has its own arkade script, helpers, and orchestration, so keeping them in separate files matches their per-file scope in the Go repo.

---

## Task 1: Bump introspector image and wire `INTROSPECTOR_ARKD_URL`

**Files:**
- Modify: `docker-compose.introspector.yml`

- [ ] **Step 1: Update the image tag and env vars**

Replace the contents of `docker-compose.introspector.yml` with:

```yaml
# Introspector service — runs on the nigiri network created by arkade-regtest.
# Start after `./regtest/start-env.sh`:
#
#   docker compose -f docker-compose.introspector.yml up -d
#
name: nigiri
services:
    introspector:
        image: ghcr.io/arklabshq/introspector:v0.0.1
        container_name: introspector
        ports:
            - "7073:7073"
        environment:
            - INTROSPECTOR_NO_TLS=true
            - INTROSPECTOR_SECRET_KEY=b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c4
            - INTROSPECTOR_PORT=7073
            - INTROSPECTOR_LOG_LEVEL=5
            - INTROSPECTOR_ARKD_URL=arkd:7070
        volumes:
            - type: tmpfs
              target: /app/data
        restart: unless-stopped

networks:
    default:
        name: nigiri
        external: true
```

`INTROSPECTOR_ARKD_URL=arkd:7070` is required in v0.0.1: when the introspector is the last non-arkd signer of a finalization, it now forwards the result to arkd itself. The container name `arkd` matches the override compose started by `arkade-regtest` (`regtest/docker/docker-compose.arkd-override.yml:20`).

The secret key intentionally stays the same `…c4` even-Y key — v0.0.1 fixes the odd-Y negate path, but the existing key already works and avoids re-wiring fixtures.

- [ ] **Step 2: Restart the local container and confirm the new version**

```bash
docker compose -f docker-compose.introspector.yml down
docker compose -f docker-compose.introspector.yml up -d
curl -sf http://localhost:7073/v1/info | jq .
```

Expected: a JSON response whose `version` starts with `v0.0.1` and a 33-byte hex `signerPubkey`.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.introspector.yml
git commit -m "chore: bump introspector to v0.0.1 and wire ARKD_URL"
```

---

## Task 2: Add `submitOnchainTx` to `IntrospectorProvider`

**Files:**
- Modify: `src/providers/introspector.ts`
- Test: `test/providers/introspector.test.ts` (create new)

- [ ] **Step 1: Write the failing unit test**

Create `test/providers/introspector.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RestIntrospectorProvider } from "../../src/providers/introspector";

describe("RestIntrospectorProvider.submitOnchainTx", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("POSTs the tx to /v1/onchain-tx and returns the signed tx", async () => {
        const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(
                new Response(JSON.stringify({ signedTx: "SIGNED_B64" }), {
                    status: 200,
                })
            );

        const provider = new RestIntrospectorProvider("http://introspector");
        const result = await provider.submitOnchainTx("RAW_B64");

        expect(result).toEqual({ signedTx: "SIGNED_B64" });
        expect(fetchMock).toHaveBeenCalledWith(
            "http://introspector/v1/onchain-tx",
            expect.objectContaining({
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tx: "RAW_B64" }),
            })
        );
    });

    it("throws when the response lacks signedTx", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(JSON.stringify({}), { status: 200 })
        );

        const provider = new RestIntrospectorProvider("http://introspector");
        await expect(provider.submitOnchainTx("RAW_B64")).rejects.toThrow(
            /missing signedTx/
        );
    });

    it("throws on non-2xx", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response("boom", { status: 500 })
        );

        const provider = new RestIntrospectorProvider("http://introspector");
        await expect(provider.submitOnchainTx("RAW_B64")).rejects.toThrow(
            /Failed to submit onchain tx to introspector: boom/
        );
    });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `pnpm vitest run test/providers/introspector.test.ts`
Expected: FAIL — `provider.submitOnchainTx is not a function`.

- [ ] **Step 3: Add the interface method and implementation**

Edit `src/providers/introspector.ts`. Inside `interface IntrospectorProvider` (right after `submitFinalization(...)`), add:

```typescript
    submitOnchainTx(tx: string): Promise<{ signedTx: string }>;
```

Then inside `class RestIntrospectorProvider`, add this method after `submitFinalization`:

```typescript
    async submitOnchainTx(tx: string): Promise<{ signedTx: string }> {
        const url = `${this.serverUrl}/v1/onchain-tx`;
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tx }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(
                `Failed to submit onchain tx to introspector: ${errorText}`
            );
        }

        const data = await response.json();
        if (typeof data.signedTx !== "string" || !data.signedTx) {
            throw new Error(
                "Invalid introspector submitOnchainTx response: missing signedTx"
            );
        }
        return { signedTx: data.signedTx };
    }
```

- [ ] **Step 4: Run the test again, expect pass**

Run: `pnpm vitest run test/providers/introspector.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/providers/introspector.ts test/providers/introspector.test.ts
git commit -m "feat(introspector): add submitOnchainTx REST endpoint"
```

---

## Task 3: ~~Detect introspector auto-finalization in `submitTx`~~ — **REMOVED**

> **Removed by user direction.** Per user feedback, the SDK should NOT auto-detect whether the introspector finalized the tx via arkd. Callers know from their multisig topology whether they are the last non-arkd signer; if they are, they must skip the post-`submitTx` `arkProvider.submitTx`/`finalizeTx` calls themselves. No interface or behavior change in `RestIntrospectorProvider.submitTx`.
>
> The body below is preserved for historical context only — **do not implement**.

In v0.0.1 the introspector may now finalize the Ark tx itself when it is the last non-`arkd` signer for all owned inputs (`introspector` PR #61). When that happens, `signed_ark_tx` comes back **fully finalized** and `arkd` has already received and finalized the tx. Callers must not call `arkProvider.submitTx`/`finalizeTx` again — that produces "duplicate submission" errors.

The provider becomes responsible for telling the caller which mode the response is in. We add a `finalized: boolean` field to the `submitTx` return shape; callers branch on it.

**Files:**
- Modify: `src/providers/introspector.ts`
- Test: `test/providers/introspector.test.ts` (extend the existing file from Task 2)

- [ ] **Step 1: Write the failing tests**

Append to `test/providers/introspector.test.ts`:

```typescript
import { base64 } from "@scure/base";
import { Transaction, p2pkh } from "@scure/btc-signer";

function unsignedPsbtB64(): string {
    const tx = new Transaction({ allowUnknownInputs: true });
    tx.addInput({
        txid: new Uint8Array(32),
        index: 0,
    });
    tx.addOutput({ script: new Uint8Array([0x6a]), amount: 0n });
    return base64.encode(tx.toPSBT());
}

function finalizedPsbtB64(): string {
    // Build a 1-in/1-out tx with finalScriptWitness already populated.
    const tx = new Transaction({ allowUnknownInputs: true });
    tx.addInput({
        txid: new Uint8Array(32),
        index: 0,
        finalScriptWitness: [new Uint8Array([0x01])],
    });
    tx.addOutput({ script: new Uint8Array([0x6a]), amount: 0n });
    return base64.encode(tx.toPSBT());
}

describe("RestIntrospectorProvider.submitTx finalization detection", () => {
    beforeEach(() => vi.restoreAllMocks());

    it("returns finalized=false when no input is finalized", async () => {
        const partial = unsignedPsbtB64();
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(
                JSON.stringify({
                    signedArkTx: partial,
                    signedCheckpointTxs: [partial],
                }),
                { status: 200 }
            )
        );
        const provider = new RestIntrospectorProvider("http://introspector");
        const r = await provider.submitTx("ARK_B64", ["CP_B64"]);
        expect(r.finalized).toBe(false);
    });

    it("returns finalized=true when every input has finalScriptWitness", async () => {
        const final = finalizedPsbtB64();
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(
                JSON.stringify({
                    signedArkTx: final,
                    signedCheckpointTxs: [final],
                }),
                { status: 200 }
            )
        );
        const provider = new RestIntrospectorProvider("http://introspector");
        const r = await provider.submitTx("ARK_B64", ["CP_B64"]);
        expect(r.finalized).toBe(true);
    });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `pnpm vitest run test/providers/introspector.test.ts -t "finalization detection"`
Expected: FAIL — `r.finalized` is `undefined`.

- [ ] **Step 3: Implement detection**

In `src/providers/introspector.ts`:

1. Add at the top of the file (after the existing imports):

```typescript
import { base64 } from "@scure/base";
import { Transaction } from "../utils/transaction";

/**
 * Returns true iff every input of the PSBT has been finalized (has either
 * finalScriptSig or finalScriptWitness set). Used to detect when the
 * introspector self-finalized via arkd in v0.0.1+.
 */
function isFullyFinalized(b64: string): boolean {
    let tx: Transaction;
    try {
        tx = Transaction.fromPSBT(base64.decode(b64));
    } catch {
        return false;
    }
    if (tx.inputsLength === 0) return false;
    for (let i = 0; i < tx.inputsLength; i++) {
        const inp = tx.getInput(i);
        const hasWitness =
            Array.isArray(inp?.finalScriptWitness) &&
            inp!.finalScriptWitness.length > 0;
        const hasSig =
            inp?.finalScriptSig instanceof Uint8Array &&
            inp.finalScriptSig.length > 0;
        if (!hasWitness && !hasSig) return false;
    }
    return true;
}
```

2. Update the `IntrospectorProvider` interface (the return type of `submitTx`):

```typescript
    submitTx(
        arkTx: string,
        checkpointTxs: string[]
    ): Promise<{
        signedArkTx: string;
        signedCheckpointTxs: string[];
        finalized: boolean;
    }>;
```

3. Update the `submitTx` implementation in `RestIntrospectorProvider`. Find the `return { signedArkTx: ..., signedCheckpointTxs: ... };` block at the end of `submitTx` and replace with:

```typescript
        return {
            signedArkTx: data.signedArkTx,
            signedCheckpointTxs: data.signedCheckpointTxs,
            finalized: isFullyFinalized(data.signedArkTx),
        };
```

- [ ] **Step 4: Run the tests, expect pass**

Run: `pnpm vitest run test/providers/introspector.test.ts`
Expected: PASS (5 tests — 3 from Task 2 + 2 new).

- [ ] **Step 5: Update existing arkade.test.ts call sites**

The existing `test/e2e/arkade.test.ts` has three callers (`grep -n "introspector.submitTx" test/e2e/arkade.test.ts`):

For each, replace the existing pattern:

```typescript
const introResult = await introspector.submitTx(...);
const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
    introResult.signedArkTx,
    introResult.signedCheckpointTxs
);
const finalCheckpoints = await mergeAndSignCheckpoints(...);
await arkProvider.finalizeTx(arkTxid, finalCheckpoints);
```

with:

```typescript
const introResult = await introspector.submitTx(...);
if (!introResult.finalized) {
    const { arkTxid, signedCheckpointTxs } =
        await arkProvider.submitTx(
            introResult.signedArkTx,
            introResult.signedCheckpointTxs
        );
    const finalCheckpoints = await mergeAndSignCheckpoints(
        signedCheckpointTxs,
        introResult.signedCheckpointTxs,
        bob // or whatever signer is used in this test
    );
    await arkProvider.finalizeTx(arkTxid, finalCheckpoints);
}
```

- [ ] **Step 6: Run the existing arkade e2e against the local stack**

Pre-req: introspector v0.0.1 + arkd is running (from Task 1).

```bash
ARK_ENV=docker pnpm vitest run test/e2e/arkade.test.ts
```

Expected: PASS, with the (now-skipped) post-submit logic only running for partial responses if any.

- [ ] **Step 7: Commit**

```bash
git add src/providers/introspector.ts test/providers/introspector.test.ts test/e2e/arkade.test.ts
git commit -m "feat(introspector): detect auto-finalization in submitTx response"
```

---

## Task 4: Add `OP_INSPECTPACKET` and `OP_INSPECTINPUTPACKET`

**Files:**
- Modify: `src/arkade/opcodes.ts`
- Test: `test/arkade-opcodes.test.ts` (create new)

- [ ] **Step 1: Write the failing test**

Create `test/arkade-opcodes.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
    ARKADE_OP,
    OPCODE_NAMES,
    OPCODE_VALUES,
    getOpcodeName,
    getOpcodeValue,
} from "../src/arkade/opcodes";

describe("ARKADE_OP — v0.0.1 packet introspection", () => {
    it("defines INSPECTPACKET = 0xf4", () => {
        expect(ARKADE_OP.INSPECTPACKET).toBe(0xf4);
    });

    it("defines INSPECTINPUTPACKET = 0xf5", () => {
        expect(ARKADE_OP.INSPECTINPUTPACKET).toBe(0xf5);
    });

    it("registers both opcodes in name and value maps", () => {
        expect(OPCODE_NAMES[0xf4]).toBe("OP_INSPECTPACKET");
        expect(OPCODE_NAMES[0xf5]).toBe("OP_INSPECTINPUTPACKET");
        expect(OPCODE_VALUES["OP_INSPECTPACKET"]).toBe(0xf4);
        expect(OPCODE_VALUES["INSPECTPACKET"]).toBe(0xf4);
        expect(OPCODE_VALUES["OP_INSPECTINPUTPACKET"]).toBe(0xf5);
        expect(getOpcodeName(0xf4)).toBe("OP_INSPECTPACKET");
        expect(getOpcodeValue("OP_INSPECTINPUTPACKET")).toBe(0xf5);
    });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `pnpm vitest run test/arkade-opcodes.test.ts`
Expected: FAIL — `expected undefined to be 244`.

- [ ] **Step 3: Add the opcodes**

In `src/arkade/opcodes.ts`, replace the `// Transaction ID (0xf3)` block:

```typescript
    // Transaction ID (0xf3)
    TXID: 0xf3,
} as const;
```

with:

```typescript
    // Transaction ID (0xf3)
    TXID: 0xf3,

    // Packet Introspection (0xf4-0xf5) — added in introspector v0.0.1
    INSPECTPACKET: 0xf4,
    INSPECTINPUTPACKET: 0xf5,
} as const;
```

The `OPCODE_NAMES`/`OPCODE_VALUES` derived maps update automatically — they iterate over `ARKADE_OP`.

- [ ] **Step 4: Run the test, expect pass**

Run: `pnpm vitest run test/arkade-opcodes.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/arkade/opcodes.ts test/arkade-opcodes.test.ts
git commit -m "feat(arkade): add OP_INSPECTPACKET and OP_INSPECTINPUTPACKET opcodes"
```

---

## Task 5: Add `PrevArkTxField` and `PrevoutTxField` PSBT coders

The Go side defines two parallel coders:

```
key  = [0xde] || "prevarktx"          # prev Ark tx (used on intent proofs)
key  = [0xde] || "prevouttx"          # prev plain Bitcoin tx (used on onchain spends)
value = serialized wire.MsgTx (raw bitcoin tx, NOT a PSBT)
```

Both take a `Uint8Array` of raw tx bytes — callers obtain it from `Transaction.toBytes()` of the funding tx (or any source that yields the raw tx).

**Files:**
- Modify: `src/utils/unknownFields.ts`
- Modify: `src/index.ts`
- Test: `test/prev-ark-tx-field.test.ts` (create new)

- [ ] **Step 1: Write the failing test**

Create `test/prev-ark-tx-field.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import {
    PrevArkTxField,
    setArkPsbtField,
    getArkPsbtFields,
    ArkPsbtFieldKeyType,
} from "../src/utils/unknownFields";

function emptyTx(): Transaction {
    const tx = new Transaction({ allowUnknownInputs: true });
    tx.addInput({
        txid: hex.decode(
            "0000000000000000000000000000000000000000000000000000000000000001"
        ),
        index: 0,
    });
    tx.addOutputAddress(
        "bcrt1pqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqs0xnk7l",
        100n,
        { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef }
    );
    return tx;
}

describe("PrevArkTxField", () => {
    it("encodes with the canonical [0xde]+'prevarktx' key", () => {
        const raw = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
        const encoded = PrevArkTxField.encode(raw);
        expect(encoded[0].type).toBe(ArkPsbtFieldKeyType);
        expect(new TextDecoder().decode(encoded[0].key)).toBe("prevarktx");
        expect(encoded[1]).toEqual(raw);
    });

    it("round-trips through setArkPsbtField/getArkPsbtFields", () => {
        const tx = emptyTx();
        const raw = new Uint8Array([0xaa, 0xbb, 0xcc]);
        setArkPsbtField(tx, 0, PrevArkTxField, raw);
        const got = getArkPsbtFields(tx, 0, PrevArkTxField);
        expect(got).toHaveLength(1);
        expect(got[0]).toEqual(raw);
    });

    it("decodes to null for a different key", () => {
        const decoded = PrevArkTxField.decode([
            { type: ArkPsbtFieldKeyType, key: new TextEncoder().encode("taptree") },
            new Uint8Array([1, 2, 3]),
        ]);
        expect(decoded).toBeNull();
    });

    it("decodes to null for a non-arkade key type", () => {
        const decoded = PrevArkTxField.decode([
            { type: 0, key: new TextEncoder().encode("prevarktx") },
            new Uint8Array([1, 2, 3]),
        ]);
        expect(decoded).toBeNull();
    });
});

describe("PrevoutTxField", () => {
    it("uses the canonical [0xde]+'prevouttx' key and round-trips", () => {
        const tx = emptyTx();
        const raw = new Uint8Array([0x11, 0x22, 0x33]);
        const encoded = PrevoutTxField.encode(raw);
        expect(encoded[0].type).toBe(ArkPsbtFieldKeyType);
        expect(new TextDecoder().decode(encoded[0].key)).toBe("prevouttx");

        setArkPsbtField(tx, 0, PrevoutTxField, raw);
        const got = getArkPsbtFields(tx, 0, PrevoutTxField);
        expect(got).toEqual([raw]);
    });

    it("does not collide with PrevArkTxField on the same input", () => {
        const tx = emptyTx();
        const a = new Uint8Array([0xaa]);
        const b = new Uint8Array([0xbb]);
        setArkPsbtField(tx, 0, PrevArkTxField, a);
        setArkPsbtField(tx, 0, PrevoutTxField, b);
        expect(getArkPsbtFields(tx, 0, PrevArkTxField)).toEqual([a]);
        expect(getArkPsbtFields(tx, 0, PrevoutTxField)).toEqual([b]);
    });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `pnpm vitest run test/prev-ark-tx-field.test.ts`
Expected: FAIL — `PrevArkTxField is not exported`.

- [ ] **Step 3: Add the enum values and coders**

In `src/utils/unknownFields.ts`, extend the `ArkPsbtFieldKey` enum:

```typescript
export enum ArkPsbtFieldKey {
    VtxoTaprootTree = "taptree",
    VtxoTreeExpiry = "expiry",
    Cosigner = "cosigner",
    ConditionWitness = "condition",
    PrevArkTx = "prevarktx",
    PrevoutTx = "prevouttx",
}
```

Add both coders right after `ConditionWitness` (and before `CosignerPublicKey`):

```typescript
/**
 * PrevArkTxField carries the serialized raw bitcoin tx of the previous Ark tx
 * spent by an input. Used by OP_INSPECTINPUTSCRIPTPUBKEY on intent proofs and
 * other contexts where the prevout pkScript must be looked up off-chain.
 *
 * Key: [0xde] || "prevarktx". Value: serialized wire.MsgTx (NOT a PSBT).
 */
export const PrevArkTxField: ArkPsbtFieldCoder<Uint8Array> = {
    key: ArkPsbtFieldKey.PrevArkTx,
    encode: (value) => [
        {
            type: ArkPsbtFieldKeyType,
            key: encodedPsbtFieldKey[ArkPsbtFieldKey.PrevArkTx],
        },
        value,
    ],
    decode: (value) =>
        nullIfCatch(() => {
            if (!checkKeyMatch(value[0], ArkPsbtFieldKey.PrevArkTx))
                return null;
            return value[1];
        }),
};

/**
 * PrevoutTxField carries the serialized raw bitcoin tx that produced the
 * previous output spent by an input. Used by OP_INSPECTINPUTSCRIPTPUBKEY in
 * the SubmitOnchainTx flow, where there is no Ark tx but a plain Bitcoin
 * funding tx whose pkScript must be resolvable.
 *
 * Key: [0xde] || "prevouttx". Value: serialized wire.MsgTx (NOT a PSBT).
 */
export const PrevoutTxField: ArkPsbtFieldCoder<Uint8Array> = {
    key: ArkPsbtFieldKey.PrevoutTx,
    encode: (value) => [
        {
            type: ArkPsbtFieldKeyType,
            key: encodedPsbtFieldKey[ArkPsbtFieldKey.PrevoutTx],
        },
        value,
    ],
    decode: (value) =>
        nullIfCatch(() => {
            if (!checkKeyMatch(value[0], ArkPsbtFieldKey.PrevoutTx))
                return null;
            return value[1];
        }),
};
```

- [ ] **Step 4: Re-export from `src/index.ts`**

Locate the existing `setArkPsbtField` / `ArkPsbtFieldCoder` block (around line 165). Add `PrevArkTxField` and `PrevoutTxField` to the import-and-re-export from `./utils/unknownFields`. Open `src/index.ts` and locate the import block:

```typescript
import {
    ArkPsbtFieldCoder,
    ArkPsbtFieldKey,
    ArkPsbtFieldKeyType,
    setArkPsbtField,
    getArkPsbtFields,
    VtxoTaprootTree,
    VtxoTreeExpiry,
    ConditionWitness,
    CosignerPublicKey,
} from "./utils/unknownFields";
```

(The exact lines may differ; if so, use `grep -n "from \"./utils/unknownFields\"" src/index.ts` to locate.) Add `PrevArkTxField` and `PrevoutTxField` to that import list and to the corresponding `export {` block in the same file (search for `export {` blocks containing `setArkPsbtField`).

- [ ] **Step 5: Run the test, expect pass**

Run: `pnpm vitest run test/prev-ark-tx-field.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/utils/unknownFields.ts src/index.ts test/prev-ark-tx-field.test.ts
git commit -m "feat(psbt): add PrevArkTxField and PrevoutTxField coders"
```

---

## Task 6: Add `arkade.BigNum` and accept `bigint` literals in `ArkadeScript.encode`

In v0.0.1 the arkade VM has a unified arbitrary-precision numeric type (`BigNum`). Wire format is the standard Bitcoin sign-magnitude little-endian encoding (last byte's high bit is the sign), but the size is bounded by `MaxScriptElementSize = 520 bytes` instead of 4. `@scure/btc-signer` already implements this format via `ScriptNum(bytesLimit, forceMinimal)`; we just expose it cleanly and let users push `bigint` literals into scripts.

Public API surface (lives at `arkade.BigNum`):

```typescript
namespace BigNum {
    function encode(value: bigint): Uint8Array;        // minimal sign-magnitude LE, max 520 bytes
    function decode(value: Uint8Array): bigint;        // strict minimal validation
    function encodeFixed(value: bigint, size: number): Uint8Array; // padded to `size` bytes
}
```

We also extend the script encoder so users can write inline `bigint` literals — no manual `encode` call needed for the common case:

```typescript
arkade.ArkadeScript.encode([
    "INSPECTOUTPUTVALUE",
    100_000_000_000n,   // <-- bigint, encoded as BigNum
    "EQUAL",
])
```

**Files:**
- Create: `src/arkade/bignum.ts`
- Modify: `src/arkade/script.ts` (extend `ArkadeScriptOP` to include `bigint`, encode via `BigNum.encode`)
- Modify: `src/arkade/index.ts` (export `BigNum`)
- Test: `test/arkade-bignum.test.ts` (create new)

- [ ] **Step 1: Write the failing test**

Create `test/arkade-bignum.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { arkade } from "../src";
const { BigNum, ArkadeScript } = arkade;

describe("BigNum", () => {
    it("encodes 0 as empty bytes", () => {
        expect(BigNum.encode(0n)).toEqual(new Uint8Array());
    });

    it("encodes small positive ints minimally", () => {
        expect(hex.encode(BigNum.encode(1n))).toBe("01");
        expect(hex.encode(BigNum.encode(127n))).toBe("7f");
        // 128 needs a sign-extension byte because high bit is 1.
        expect(hex.encode(BigNum.encode(128n))).toBe("8000");
        expect(hex.encode(BigNum.encode(255n))).toBe("ff00");
        expect(hex.encode(BigNum.encode(256n))).toBe("0001");
    });

    it("encodes small negatives via sign bit", () => {
        expect(hex.encode(BigNum.encode(-1n))).toBe("81");
        expect(hex.encode(BigNum.encode(-127n))).toBe("ff");
        expect(hex.encode(BigNum.encode(-128n))).toBe("8080");
    });

    it("encodes values beyond int64", () => {
        const big = (1n << 200n) + 1n;
        const enc = BigNum.encode(big);
        expect(BigNum.decode(enc)).toBe(big);
    });

    it("rejects non-minimal encoding on decode", () => {
        // Trailing zero magnitude byte is non-minimal.
        expect(() => BigNum.decode(hex.decode("0100"))).toThrow();
        // Negative zero (sign bit set, magnitude zero) is non-minimal.
        expect(() => BigNum.decode(hex.decode("80"))).toThrow();
    });

    it("rejects encodings longer than 520 bytes", () => {
        const tooBig = 1n << 4200n; // ~525 bytes
        expect(() => BigNum.encode(tooBig)).toThrow(/520|too big|exceed/i);
    });

    it("encodeFixed pads with zero magnitude bytes between value and sign", () => {
        // 1 in 4 bytes => 0x01 0x00 0x00 0x00
        expect(hex.encode(BigNum.encodeFixed(1n, 4))).toBe("01000000");
        // -1 in 4 bytes => 0x01 0x00 0x00 0x80 (sign bit on the MSB)
        expect(hex.encode(BigNum.encodeFixed(-1n, 4))).toBe("01000080");
        // 0 in 4 bytes => 0x00 0x00 0x00 0x00
        expect(hex.encode(BigNum.encodeFixed(0n, 4))).toBe("00000000");
    });

    it("encodeFixed fails when value doesn't fit", () => {
        // 1024 needs at least 2 magnitude bytes; size=1 should fail.
        expect(() => BigNum.encodeFixed(1024n, 1)).toThrow();
    });
});

describe("ArkadeScript with bigint literals", () => {
    it("encodes a script that uses a large bigint operand", () => {
        const value = 100_000_000_000n;
        const script = ArkadeScript.encode([
            "INSPECTOUTPUTVALUE",
            value,
            "EQUAL",
        ]);
        // First byte is the opcode for INSPECTOUTPUTVALUE = 0xcf.
        expect(script[0]).toBe(0xcf);
        // Round-trip — but ArkadeScript.decode currently produces Uint8Array
        // for big number pushes; verify the bytes match BigNum.encode(value).
        const expected = BigNum.encode(value);
        const pushLen = script[1];
        expect(pushLen).toBe(expected.length);
        expect(script.slice(2, 2 + pushLen)).toEqual(expected);
    });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `pnpm vitest run test/arkade-bignum.test.ts`
Expected: FAIL — `BigNum` is not exported.

- [ ] **Step 3: Implement `BigNum`**

Create `src/arkade/bignum.ts`:

```typescript
/**
 * BigNum — arbitrary-precision sign-magnitude little-endian encoding used by
 * the arkade VM in introspector v0.0.1. Up to 520 bytes (= MaxScriptElementSize).
 *
 * Wire format:
 *   - empty bytes   = 0
 *   - last byte's high bit (0x80) is the sign (set = negative)
 *   - remaining bits are magnitude, little-endian
 *   - minimal: no trailing zero magnitude byte; `[0x80]` (negative zero) is rejected
 *
 * Wraps `@scure/btc-signer`'s `ScriptNum` with a 520-byte cap. Use the
 * standalone API when you need to round-trip values outside of script encoding;
 * inside `ArkadeScript.encode([...])`, plain `bigint` literals work directly.
 */

import { ScriptNum } from "@scure/btc-signer";

/** Maximum number of bytes for a BigNum (= MaxScriptElementSize). */
export const BIGNUM_MAX_BYTES = 520;

const codec = ScriptNum(BIGNUM_MAX_BYTES, /* forceMinimal */ true);

/**
 * Encode `value` as a minimal sign-magnitude little-endian byte string.
 * Throws if the encoding would exceed 520 bytes.
 */
export function encode(value: bigint): Uint8Array {
    return codec.encode(value);
}

/**
 * Decode a minimal sign-magnitude little-endian byte string into a bigint.
 * Throws on non-minimal encodings or values longer than 520 bytes.
 */
export function decode(value: Uint8Array): bigint {
    return codec.decode(value);
}

/**
 * Encode `value` to exactly `size` bytes by padding with zero magnitude bytes
 * between the value and the sign bit. Throws if the value doesn't fit.
 *
 * Useful when matching arkade VM outputs that push values as fixed-size byte
 * strings (e.g. some asset opcodes that push 8-byte LE values).
 */
export function encodeFixed(value: bigint, size: number): Uint8Array {
    if (size < 0) throw new Error(`negative fixed size ${size}`);
    if (size === 0) {
        if (value !== 0n) throw new Error(`value ${value} does not fit in 0 bytes`);
        return new Uint8Array(0);
    }
    const minimal = encode(value);
    if (minimal.length === 0) {
        return new Uint8Array(size);
    }
    if (minimal.length > size) {
        throw new Error(
            `value needs ${minimal.length} bytes, size=${size}`
        );
    }
    const out = new Uint8Array(size);
    const sign = minimal[minimal.length - 1] & 0x80;
    // Copy magnitude with sign bit stripped from MSB.
    out.set(minimal);
    out[minimal.length - 1] &= 0x7f;
    // Trim if magnitude MSB was just the sign bit alone (i.e. value was the
    // sign-extension byte) — same edge case as Go FixedBytes.
    if (out[minimal.length - 1] === 0 && minimal.length > 1) {
        // Already zero, that's the trim-trailing-zero case; nothing to do.
    }
    // Apply sign on the LAST byte of the output buffer, not of `minimal`.
    out[size - 1] |= sign;
    return out;
}
```

- [ ] **Step 4: Wire `BigNum` namespace + accept `bigint` in `ArkadeScript`**

In `src/arkade/script.ts`, change the type:

```typescript
export type ArkadeScriptOP = keyof typeof ARKADE_OPS | Uint8Array | number | bigint;
```

In the `encodeStream` body, replace the `if (typeof o === "number") o = ScriptNum().encode(BigInt(o));` line and the surrounding logic with:

```typescript
            if (typeof o === "number" || typeof o === "bigint") {
                const big = typeof o === "number" ? BigInt(o) : o;
                // Use BigNum (520-byte cap) so users can push values beyond
                // the legacy 4-byte scriptNum range.
                o = BigNum.encode(big);
            }
```

Add to the imports at the top of `script.ts`:

```typescript
import * as BigNum from "./bignum";
```

In `src/arkade/index.ts`, add to the exports:

```typescript
export * as BigNum from "./bignum";
```

(Adjust the `ArkadeScriptOP` re-export if needed — it's already exported via `export type ArkadeScriptOP` from `./script`.)

- [ ] **Step 5: Run the test, expect pass**

Run: `pnpm vitest run test/arkade-bignum.test.ts`
Expected: PASS (10 tests).

If `ScriptNum(520, true).encode` throws on values > 4 bytes (some `@scure` versions enforce a stricter range), fall back to a hand-rolled encoder that mirrors the Go `encodeBig`/`encodeInt64` functions in `introspector/pkg/arkade/bignum.go:370-417`. Verify with: `node -e "import('@scure/btc-signer').then(({ScriptNum}) => console.log(ScriptNum(520, true).encode(1n << 200n)))"`. If it errors, replace `codec.encode` with a manual implementation in `src/arkade/bignum.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/arkade/bignum.ts src/arkade/script.ts src/arkade/index.ts test/arkade-bignum.test.ts
git commit -m "feat(arkade): add BigNum encoder and accept bigint in ArkadeScript"
```

---

## Task 7: Build shared e2e helpers (`addIntrospectorPacket`, `enforcePayTo`, `enforceSelfSend`, `randomP2TR`, `findOutputIndex`)

The Go test utilities live in `introspector/test/utils_test.go`. We port the helpers used by both ported tests into `test/e2e/utils.ts`.

`makeIntrospectorExtensionOutput` (already in `test/e2e/arkade.test.ts`) only builds a fresh extension output. Both ports need to **mutate a built tx** — inserting an extension OP_RETURN before any anchor and merging into an existing extension if present (matches the Go `addIntrospectorPacket`). They also need an `enforcePayTo` arkade-script builder (HTLC) and an `enforceSelfSend` arkade-script builder (delegate).

**Files:**
- Modify: `test/e2e/utils.ts`

- [ ] **Step 1: Add helpers**

Append to `test/e2e/utils.ts`:

```typescript
import { hex } from "@scure/base";
import { OP, Script, p2tr } from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1";
import {
    arkade,
    Extension,
    IntrospectorPacket,
    networks,
    Transaction,
} from "../../src";
import type { ExtensionPacket } from "../../src/extension";
import { ANCHOR_PKSCRIPT } from "../../src/utils/anchor";

/**
 * P2A anchor pkScript — duplicated here because the Transaction utility doesn't
 * re-export it under a stable path. Keep this in sync with `src/utils/anchor.ts`.
 */
const P2A_PKSCRIPT = ANCHOR_PKSCRIPT;

/**
 * Returns a freshly-generated taproot pkScript (pay-to-key, no script-path).
 * Used as a "throwaway recipient" where the destination identity is irrelevant.
 */
export function randomP2TR(): Uint8Array {
    const sk = schnorr.utils.randomPrivateKey();
    const xonly = schnorr.getPublicKey(sk);
    const payment = p2tr(xonly, undefined, networks.regtest);
    return payment.script;
}

/**
 * Builds an arkade script that enforces:
 *   output[witness[0]].scriptPubKey == taproot(witness_program)  AND
 *   output[witness[0]].value == amount
 *
 * Witness stack (provided at spend time): [output_index].
 * Mirrors the Go `enforcePayTo` helper.
 */
export function enforcePayTo(pkScript: Uint8Array, amount: bigint): Uint8Array {
    if (pkScript[0] !== 0x51 || pkScript[1] !== 0x20) {
        throw new Error("enforcePayTo: expected a v1 P2TR pkScript");
    }
    const witnessProgram = pkScript.slice(2);
    return arkade.ArkadeScript.encode([
        "DUP",
        "INSPECTOUTPUTSCRIPTPUBKEY",
        1,
        "EQUALVERIFY",
        witnessProgram,
        "EQUALVERIFY",
        "INSPECTOUTPUTVALUE",
        amount,
        "EQUAL",
    ]);
}

/**
 * Builds an arkade script that enforces:
 *   tx.version == 2  (intent-proof gate, blocks off-chain Ark txs at v=3)
 *   output[0].scriptPubKey == input[self].scriptPubKey
 *   output[0].value        == input[self].value
 *
 * Witness stack: empty. Mirrors the Go `enforceSelfSend` helper.
 */
export function enforceSelfSend(): Uint8Array {
    return arkade.ArkadeScript.encode([
        "INSPECTVERSION",
        new Uint8Array([0x02, 0x00, 0x00, 0x00]),
        "EQUALVERIFY",
        // output[0].scriptPubKey
        0,
        "INSPECTOUTPUTSCRIPTPUBKEY",
        1,
        "EQUALVERIFY",
        "PUSHCURRENTINPUTINDEX",
        "INSPECTINPUTSCRIPTPUBKEY",
        1,
        "EQUALVERIFY",
        "EQUALVERIFY",
        // output[0].value
        0,
        "INSPECTOUTPUTVALUE",
        "PUSHCURRENTINPUTINDEX",
        "INSPECTINPUTVALUE",
        "EQUAL",
    ]);
}

/**
 * Inserts (or merges into existing) an Extension OP_RETURN containing an
 * IntrospectorPacket built from `entries`, modifying `tx` in place.
 *
 * Behavior matches the Go `addIntrospectorPacket`:
 * - If an extension OP_RETURN already exists, the introspector packet is appended.
 * - Otherwise, a new extension is inserted before the P2A anchor (if any),
 *   else appended at the end.
 */
export function addIntrospectorPacket(
    tx: Transaction,
    entries: { vin: number; script: Uint8Array; witness?: Uint8Array }[]
): void {
    const packet = IntrospectorPacket.create(
        entries.map((e) => ({
            vin: e.vin,
            script: e.script,
            witness: e.witness ?? new Uint8Array(0),
        }))
    );

    // Try to merge into an existing extension output.
    for (let i = 0; i < tx.outputsLength; i++) {
        const out = tx.getOutput(i);
        if (!out?.script) continue;
        if (!Extension.isExtension(out.script)) continue;
        const existing = Extension.fromBytes(out.script);
        const merged = Extension.create([
            ...(existing as any).packets,
            packet,
        ]);
        tx.updateOutput(i, { script: merged.serialize(), amount: 0n });
        return;
    }

    // No existing extension — insert a new one.
    const ext = Extension.create([packet as ExtensionPacket]);
    const newOut = ext.txOut();

    // If the last output is the P2A anchor, swap it: [..., anchor] → [..., ext, anchor].
    const lastIdx = tx.outputsLength - 1;
    const lastOut = tx.getOutput(lastIdx);
    if (
        lastOut?.script &&
        lastOut.script.length === P2A_PKSCRIPT.length &&
        lastOut.script.every((b, j) => b === P2A_PKSCRIPT[j])
    ) {
        // @scure Transaction has no `insertOutput`. Rebuild the last two outputs:
        // overwrite slot lastIdx with the extension and append the anchor.
        tx.updateOutput(lastIdx, {
            script: newOut.script,
            amount: newOut.amount,
        });
        tx.addOutput({ script: lastOut.script, amount: lastOut.amount ?? 0n });
        return;
    }

    tx.addOutput({ script: newOut.script, amount: newOut.amount });
}

/**
 * Returns the index of the first output whose script matches `pkScript`.
 * Throws if none is found.
 */
export function findOutputIndex(
    tx: Transaction,
    pkScript: Uint8Array
): number {
    for (let i = 0; i < tx.outputsLength; i++) {
        const out = tx.getOutput(i);
        if (!out?.script) continue;
        if (
            out.script.length === pkScript.length &&
            out.script.every((b, j) => b === pkScript[j])
        ) {
            return i;
        }
    }
    throw new Error("findOutputIndex: no matching output");
}
```

The cast to `(existing as any).packets` is a deliberate test-only escape hatch — `Extension.packets` is private. If this becomes problematic, expose a public accessor in a follow-up.

If `src/utils/anchor.ts` does not exist or doesn't export `ANCHOR_PKSCRIPT`, replace the import with the inlined constant:

```typescript
const ANCHOR_PKSCRIPT = new Uint8Array([
    0x51, 0x02, 0x4e, 0x73,
]);
```

Verify the actual constant in the SDK first with: `grep -rn "ANCHOR_PKSCRIPT\|P2A" src/ | head -5`. Use the exact bytes from the SDK.

- [ ] **Step 2: Type-check**

Run: `pnpm tsc -p tsconfig.json --noEmit`
Expected: clean. If there are errors about `ArkadeScript.encode` accepting a `bigint`, fall back to constructing the amount as a Bitcoin script number push (look at `src/arkade/script.ts` for the supported `ScriptElement` types and adapt).

- [ ] **Step 3: Commit**

```bash
git add test/e2e/utils.ts
git commit -m "test(e2e): add introspector covenant helpers"
```

---

## Task 8: Port `TestCovenantHTLC` (claim path)

Mirrors `htlc_test.go:94-199`. The VTXO has one closure: `ConditionMultisigClosure` with PubKeys `[server, introspector_tweaked]` and Condition `OP_HASH160 <preimageHash> OP_EQUAL`. Spending requires:
1. Server signature on the forfeit (multisig) tapscript leaf
2. Introspector signature on the forfeit (after arkade script `enforcePayTo(receiver, amount)` passes)
3. The condition witness `[preimage]` set on the PSBT input

**Files:**
- Create: `test/e2e/arkade-htlc.test.ts`

- [ ] **Step 1: Scaffold the test file**

Create `test/e2e/arkade-htlc.test.ts`:

```typescript
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { base64, hex } from "@scure/base";
import {
    arkade,
    ArkAddress,
    buildOffchainTx,
    ConditionMultisigTapscript,
    CSVMultisigTapscript,
    Extension,
    IntrospectorPacket,
    MultisigTapscript,
    networks,
    OP,
    RestArkProvider,
    RestIndexerProvider,
    RestIntrospectorProvider,
    Script,
    setArkPsbtField,
    ConditionWitness,
} from "../../src";
import {
    addIntrospectorPacket,
    beforeEachFaucet,
    createTestArkWallet,
    enforcePayTo,
    faucetOffchain,
    randomP2TR,
} from "./utils";

const INTROSPECTOR_URL = "http://localhost:7073";
const ARK_SERVER_URL = "http://localhost:7070";

const HTLC_PREIMAGE = new Uint8Array(32).fill(0x42);
// HASH160 of HTLC_PREIMAGE — pre-computed to match Go test's htlcPreimageHash.
const HTLC_PREIMAGE_HASH = hex.decode(
    "8739f40ec4dbf569dcb38134c6e7310908566981"
);
const CONTRACT_AMOUNT = 10_000n;
const REFUND_LOCKTIME = 500_000_000;

describe("arkade HTLC (covenant)", () => {
    const introspector = new RestIntrospectorProvider(INTROSPECTOR_URL);
    const arkProvider = new RestArkProvider(ARK_SERVER_URL);
    const indexerProvider = new RestIndexerProvider(ARK_SERVER_URL);

    let serverXOnlyPubkey: Uint8Array;
    let introspectorPubkey: Uint8Array;
    let checkpointUnrollClosure: CSVMultisigTapscript.Type;

    beforeAll(async () => {
        const arkInfo = await arkProvider.getInfo();
        serverXOnlyPubkey = hex.decode(arkInfo.signerPubkey).slice(1);
        checkpointUnrollClosure = CSVMultisigTapscript.decode(
            hex.decode(arkInfo.checkpointTapscript)
        );

        const introInfo = await introspector.getInfo();
        introspectorPubkey = hex.decode(introInfo.signerPubkey);
    });

    beforeEach(beforeEachFaucet, 20000);

    /** wait until at least one VTXO appears at the given pkScript */
    async function waitForVtxo(pkScript: Uint8Array, timeoutMs = 15000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const resp = await indexerProvider.getVtxos({
                scripts: [hex.encode(pkScript)],
                spendableOnly: true,
            });
            if (resp.vtxos.length > 0) return resp.vtxos;
            await new Promise((r) => setTimeout(r, 1000));
        }
        throw new Error("waitForVtxo: timeout");
    }
});
```

- [ ] **Step 2: Add the claim test**

Inside the `describe` block, append:

```typescript
    it("claim: introspector signs only when preimage + arkade script pass", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();

        const receiverPkScript = randomP2TR();
        const arkadeScript = enforcePayTo(receiverPkScript, CONTRACT_AMOUNT);

        const preimageCondition = Script.encode([
            "HASH160",
            HTLC_PREIMAGE_HASH,
            "EQUAL",
        ]);

        const vtxoScript = new arkade.ArkadeVtxoScript([
            {
                arkadeScript,
                introspectors: [introspectorPubkey],
                tapscript: ConditionMultisigTapscript.encode({
                    conditionScript: preimageCondition,
                    pubkeys: [serverXOnlyPubkey],
                }),
            },
        ]);

        const contractAddress = vtxoScript
            .address(networks.regtest.hrp, serverXOnlyPubkey)
            .encode();

        // Fund the contract.
        faucetOffchain(contractAddress, Number(CONTRACT_AMOUNT));
        const [vtxo] = await waitForVtxo(vtxoScript.pkScript);

        // Find the multisig (with arkade-tweaked introspector) leaf.
        const arkadeLeaf = ConditionMultisigTapscript.encode({
            conditionScript: preimageCondition,
            pubkeys: [
                serverXOnlyPubkey,
                arkade.computeArkadeScriptPublicKey(
                    introspectorPubkey,
                    arkadeScript
                ),
            ],
        });
        const tapLeafScript = vtxoScript.findLeaf(hex.encode(arkadeLeaf.script));
        const tapTree = vtxoScript.encode();

        const buildClaim = (outputs: { script: Uint8Array; amount: bigint }[]) => {
            const { arkTx, checkpoints } = buildOffchainTx(
                [{ ...vtxo, tapLeafScript, tapTree }],
                outputs,
                checkpointUnrollClosure
            );
            // Condition witness: [preimage] on ark tx input 0 + on checkpoint input 0.
            setArkPsbtField(arkTx, 0, ConditionWitness, [HTLC_PREIMAGE]);
            for (const cp of checkpoints) {
                setArkPsbtField(cp, 0, ConditionWitness, [HTLC_PREIMAGE]);
            }
            // Output index witness — entry vin=0, witness=[<output_index=0>] = [empty].
            addIntrospectorPacket(arkTx, [
                { vin: 0, script: arkadeScript, witness: new Uint8Array(0) },
            ]);
            return { arkTx, checkpoints };
        };

        const submitAndExpectFailure = async (
            outputs: { script: Uint8Array; amount: bigint }[]
        ) => {
            const { arkTx, checkpoints } = buildClaim(outputs);
            await expect(
                introspector.submitTx(
                    base64.encode(arkTx.toPSBT()),
                    checkpoints.map((c) => base64.encode(c.toPSBT()))
                )
            ).rejects.toThrow(/failed to process transaction/);
        };

        // Invalid: wrong destination at output 0.
        await submitAndExpectFailure([
            { script: new Uint8Array([0x6a]), amount: CONTRACT_AMOUNT }, // OP_RETURN
        ]);
        // Invalid: wrong amount.
        await submitAndExpectFailure([
            { script: receiverPkScript, amount: CONTRACT_AMOUNT - 1n },
            { script: randomP2TR(), amount: 1n },
        ]);

        // Valid: right output and amount.
        const { arkTx: validTx, checkpoints: validCps } = buildClaim([
            { script: receiverPkScript, amount: CONTRACT_AMOUNT },
        ]);
        const introResult = await introspector.submitTx(
            base64.encode(validTx.toPSBT()),
            validCps.map((c) => base64.encode(c.toPSBT()))
        );

        // Forward to arkd; this is a notification flow so we just expect no error.
        const { arkTxid } = await arkProvider.submitTx(
            introResult.signedArkTx,
            introResult.signedCheckpointTxs
        );
        expect(arkTxid).toBeTruthy();
    });
```

- [ ] **Step 3: Run only the new test, expect pass**

```bash
ARK_ENV=docker pnpm vitest run test/e2e/arkade-htlc.test.ts -t "claim"
```

Expected: PASS. If the introspector returns a non-`failed to process transaction` error string for the negative cases, relax the regex to `/process|reject/i` based on the actual server response.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/arkade-htlc.test.ts
git commit -m "test(e2e): port TestCovenantHTLC claim path"
```

---

## Task 9: Port `TestCovenantHTLC` (refund path)

Mirrors `htlc_test.go:201-289`. Same VTXO shape but with `CLTVMultisigClosure { PubKeys: [server, introspector_tweaked], Locktime: 500_000_000 }`. No condition witness, no checkpoint contention; the arkade script enforces "send refund to sender".

**Files:**
- Modify: `test/e2e/arkade-htlc.test.ts`

- [ ] **Step 1: Append the refund test**

Inside the same `describe` block, after the claim test:

```typescript
    it("refund: introspector signs only when CLTV satisfied + arkade script passes", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();

        const senderPkScript = randomP2TR();
        const arkadeScript = enforcePayTo(senderPkScript, CONTRACT_AMOUNT);

        const vtxoScript = new arkade.ArkadeVtxoScript([
            {
                arkadeScript,
                introspectors: [introspectorPubkey],
                tapscript: CLTVMultisigTapscript.encode({
                    absoluteTimelock: BigInt(REFUND_LOCKTIME),
                    pubkeys: [serverXOnlyPubkey],
                }),
            },
        ]);
        const contractAddress = vtxoScript
            .address(networks.regtest.hrp, serverXOnlyPubkey)
            .encode();

        faucetOffchain(contractAddress, Number(CONTRACT_AMOUNT));
        const [vtxo] = await waitForVtxo(vtxoScript.pkScript);

        const arkadeLeaf = CLTVMultisigTapscript.encode({
            absoluteTimelock: BigInt(REFUND_LOCKTIME),
            pubkeys: [
                serverXOnlyPubkey,
                arkade.computeArkadeScriptPublicKey(
                    introspectorPubkey,
                    arkadeScript
                ),
            ],
        });
        const tapLeafScript = vtxoScript.findLeaf(hex.encode(arkadeLeaf.script));
        const tapTree = vtxoScript.encode();

        const build = (outputs: { script: Uint8Array; amount: bigint }[]) => {
            const { arkTx, checkpoints } = buildOffchainTx(
                [{ ...vtxo, tapLeafScript, tapTree }],
                outputs,
                checkpointUnrollClosure
            );
            addIntrospectorPacket(arkTx, [
                { vin: 0, script: arkadeScript, witness: new Uint8Array(0) },
            ]);
            return { arkTx, checkpoints };
        };

        const submitAndExpectFailure = async (
            outputs: { script: Uint8Array; amount: bigint }[]
        ) => {
            const { arkTx, checkpoints } = build(outputs);
            await expect(
                introspector.submitTx(
                    base64.encode(arkTx.toPSBT()),
                    checkpoints.map((c) => base64.encode(c.toPSBT()))
                )
            ).rejects.toThrow(/failed to process transaction/);
        };

        await submitAndExpectFailure([
            { script: new Uint8Array([0x6a]), amount: CONTRACT_AMOUNT },
        ]);
        await submitAndExpectFailure([
            { script: senderPkScript, amount: CONTRACT_AMOUNT - 1n },
            { script: randomP2TR(), amount: 1n },
        ]);

        const { arkTx, checkpoints } = build([
            { script: senderPkScript, amount: CONTRACT_AMOUNT },
        ]);
        const result = await introspector.submitTx(
            base64.encode(arkTx.toPSBT()),
            checkpoints.map((c) => base64.encode(c.toPSBT()))
        );
        const { arkTxid } = await arkProvider.submitTx(
            result.signedArkTx,
            result.signedCheckpointTxs
        );
        expect(arkTxid).toBeTruthy();
    });
```

If `CLTVMultisigTapscript.encode` requires a parameter name other than `absoluteTimelock`, check `src/script/tapscript.ts` and adjust. (Some encoders take `{ locktime: bigint }` or `{ timelock: bigint }`; use whichever is exported.)

- [ ] **Step 2: Run the refund test**

```bash
ARK_ENV=docker pnpm vitest run test/e2e/arkade-htlc.test.ts -t "refund"
```

Expected: PASS.

- [ ] **Step 3: Run the whole HTLC suite end-to-end**

```bash
ARK_ENV=docker pnpm vitest run test/e2e/arkade-htlc.test.ts
```

Expected: 2 passing.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/arkade-htlc.test.ts
git commit -m "test(e2e): port TestCovenantHTLC refund path"
```

---

## Task 10: Port `TestCovenantDelegate` — VTXO setup + intent submission

Mirrors `delegate_test.go:69-248` (the part up to `RegisterIntent`). The VTXO has TWO closures:

1. **Forfeit (delegate)**: `MultisigClosure { [server, introspector_tweaked] }`
2. **Exit**: `CSVMultisigClosure { [alice], 512s }`

The covenant arkade script (`enforceSelfSend`) ensures any spend through the delegate closure preserves the spent VTXO's pkScript and value, and only via an intent proof tx (v=2).

The intent proof's input 1 carries `arkade.PrevArkTxField` (raw funding tx bytes) so `OP_INSPECTINPUTSCRIPTPUBKEY` can resolve the prevout pkScript. Input 0 is the BIP322-style message input (already shares the same VTXO pkScript per `intent.New`'s usual contract).

**Files:**
- Create: `test/e2e/arkade-delegate.test.ts`

- [ ] **Step 1: Scaffold the file**

Create `test/e2e/arkade-delegate.test.ts`:

```typescript
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { base64, hex } from "@scure/base";
import {
    arkade,
    ArkAddress,
    Batch,
    CSVMultisigTapscript,
    EsploraProvider,
    Intent,
    MultisigTapscript,
    networks,
    PrevArkTxField,
    RestArkProvider,
    RestIndexerProvider,
    RestIntrospectorProvider,
    setArkPsbtField,
    SingleKey,
    Transaction,
    VtxoTaprootTree,
} from "../../src";
import { addIntrospectorPacket, beforeEachFaucet, createTestArkWallet, enforceSelfSend } from "./utils";

const INTROSPECTOR_URL = "http://localhost:7073";
const ARK_SERVER_URL = "http://localhost:7070";
const DELEGATE_AMOUNT = 10_000;
const DELEGATE_EXIT_DELAY = 512;

describe("arkade delegate (covenant batch refresh)", () => {
    const introspector = new RestIntrospectorProvider(INTROSPECTOR_URL);
    const arkProvider = new RestArkProvider(ARK_SERVER_URL);
    const indexerProvider = new RestIndexerProvider(ARK_SERVER_URL);
    const onchainProvider = new EsploraProvider("http://localhost:3000");

    let serverXOnlyPubkey: Uint8Array;
    let introspectorPubkey: Uint8Array;

    beforeAll(async () => {
        serverXOnlyPubkey = hex.decode(
            (await arkProvider.getInfo()).signerPubkey
        ).slice(1);
        introspectorPubkey = hex.decode(
            (await introspector.getInfo()).signerPubkey
        );
    });

    beforeEach(beforeEachFaucet, 20000);
});
```

- [ ] **Step 2: Add the test body up to `registerIntent`**

Inside the `describe`, append:

```typescript
    it("non-interactive batch refresh", { timeout: 180000 }, async () => {
        const alice = await createTestArkWallet();
        const alicePubkey = await alice.identity.xOnlyPublicKey();
        const aliceWalletAddress = await alice.wallet.getAddress();

        const arkadeScript = enforceSelfSend();

        const delegateClosure = MultisigTapscript.encode({
            pubkeys: [
                serverXOnlyPubkey,
                arkade.computeArkadeScriptPublicKey(
                    introspectorPubkey,
                    arkadeScript
                ),
            ],
        });
        const exitClosure = CSVMultisigTapscript.encode({
            timelock: { type: "seconds", value: BigInt(DELEGATE_EXIT_DELAY) },
            pubkeys: [alicePubkey],
        });

        const vtxoScript = new arkade.ArkadeVtxoScript([
            {
                arkadeScript,
                introspectors: [introspectorPubkey],
                tapscript: MultisigTapscript.encode({
                    pubkeys: [serverXOnlyPubkey],
                }),
            },
            exitClosure.script,
        ]);

        const delegatePkScript = vtxoScript.pkScript;
        const contractAddress = vtxoScript
            .address(networks.regtest.hrp, serverXOnlyPubkey)
            .encode();

        // Fund delegate VTXO from Alice's wallet, capture the funding tx for PrevArkTxField.
        const fundingTxid = await alice.wallet.sendOffChain([
            { address: contractAddress, amount: BigInt(DELEGATE_AMOUNT) },
        ]);
        const { txs: virtualTxs } = await indexerProvider.getVirtualTxs([
            fundingTxid,
        ]);
        expect(virtualTxs).toHaveLength(1);
        const fundingTx = Transaction.fromPSBT(base64.decode(virtualTxs[0]));
        const fundingTxRaw = fundingTx.toBytes();
        const delegateOutputIndex = (() => {
            for (let i = 0; i < fundingTx.outputsLength; i++) {
                const out = fundingTx.getOutput(i);
                if (
                    out?.script &&
                    out.script.length === delegatePkScript.length &&
                    out.script.every((b, j) => b === delegatePkScript[j])
                )
                    return i;
            }
            throw new Error("delegate output not found in funding tx");
        })();

        // Find the arkade leaf to use for intent + forfeit input.
        const arkadeLeaf = vtxoScript.findLeaf(
            hex.encode(delegateClosure.script)
        );
        const tapTree = vtxoScript.encode();

        // Solver session — drives Musig2 for the absent user.
        const solverIdentity = SingleKey.fromRandomBytes();
        const session = solverIdentity.signerSession();
        const sessionPubKey = hex.encode(await session.getPublicKey());

        const message: Intent.RegisterMessage = {
            type: "register",
            onchain_output_indexes: [],
            valid_at: 0,
            expire_at: 0,
            cosigners_public_keys: [sessionPubKey],
        };

        // Build intent: self-send to the delegate pkScript.
        const coin = {
            txid: fundingTxid,
            vout: delegateOutputIndex,
            value: DELEGATE_AMOUNT,
            tapTree,
            forfeitTapLeafScript: arkadeLeaf,
            intentTapLeafScript: arkadeLeaf,
            status: { confirmed: true } as any,
            isSpent: false,
            virtualStatus: { state: "preconfirmed" as const, batchTxid: undefined },
        };

        const intentProof = Intent.create(
            message,
            [coin],
            [{ script: delegatePkScript, amount: BigInt(DELEGATE_AMOUNT) }]
        );

        // Decorate input 1 with prevarktx (input 0 is BIP322 message; per Go test
        // both inputs carry the same tapLeafScript via intent.New, but the arkade
        // covenant only checks input 1).
        addIntrospectorPacket(intentProof, [
            { vin: 1, script: arkadeScript, witness: new Uint8Array(0) },
        ]);
        setArkPsbtField(intentProof, 1, PrevArkTxField, fundingTxRaw);

        // Negative: wrong destination.
        const badDestProof = Intent.create(
            message,
            [coin],
            [
                {
                    script: (() => {
                        const r = new Uint8Array(34);
                        r[0] = 0x51;
                        r[1] = 0x20;
                        crypto.getRandomValues(r.subarray(2));
                        return r;
                    })(),
                    amount: BigInt(DELEGATE_AMOUNT),
                },
            ]
        );
        addIntrospectorPacket(badDestProof, [
            { vin: 1, script: arkadeScript, witness: new Uint8Array(0) },
        ]);
        setArkPsbtField(badDestProof, 1, PrevArkTxField, fundingTxRaw);
        await expect(
            introspector.submitIntent({
                proof: base64.encode(badDestProof.toPSBT()),
                message,
            })
        ).rejects.toThrow();

        // Negative: wrong amount.
        const badAmtProof = Intent.create(
            message,
            [coin],
            [{ script: delegatePkScript, amount: BigInt(DELEGATE_AMOUNT - 1) }]
        );
        addIntrospectorPacket(badAmtProof, [
            { vin: 1, script: arkadeScript, witness: new Uint8Array(0) },
        ]);
        setArkPsbtField(badAmtProof, 1, PrevArkTxField, fundingTxRaw);
        await expect(
            introspector.submitIntent({
                proof: base64.encode(badAmtProof.toPSBT()),
                message,
            })
        ).rejects.toThrow();

        // Valid intent submission.
        const signedProof = await introspector.submitIntent({
            proof: base64.encode(intentProof.toPSBT()),
            message,
        });

        const intentId = await arkProvider.registerIntent({
            proof: signedProof,
            message,
        });
        expect(intentId).toBeTruthy();
    });
```

If `alice.wallet.sendOffChain` is not the exact method name, replace with the corresponding test fixture used by `test/e2e/arkade.test.ts:165` (`faucetOffchain` may suffice — but Go's test funds via `alice.SendOffChain` on purpose so the funding tx is reachable via `getVirtualTxs`; `faucetOffchain` calls `arkd ark send` which produces the same lookup-able tx, so swap to `faucetOffchain(contractAddress, DELEGATE_AMOUNT)` followed by polling indexer for the new VTXO's txid if needed).

- [ ] **Step 3: Run the test, confirm it reaches `registerIntent`**

```bash
ARK_ENV=docker pnpm vitest run test/e2e/arkade-delegate.test.ts
```

Expected: PASS for the negative cases and the registerIntent call. The full batch session is added in Task 11; for now the test should end after `expect(intentId).toBeTruthy()`.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/arkade-delegate.test.ts
git commit -m "test(e2e): port delegate intent submission"
```

---

## Task 11: Port `TestCovenantDelegate` — custom batch handler + finalization

Mirrors `delegate_test.go:251-311` plus `utils_test.go`'s `delegateBatchEventsHandler`. The user (Alice) is **not** in the forfeit closure, so the existing `createArkadeBatchHandler` (which calls `signer.sign(forfeitTx, [0])` with the user identity) won't work. We write a custom handler inline in the test.

**Files:**
- Modify: `test/e2e/arkade-delegate.test.ts`

- [ ] **Step 1: Add the custom batch handler builder**

Append inside `describe(...)` but outside the `it`, just under `beforeEach`:

```typescript
    /**
     * Custom Batch.Handler for the delegate flow:
     * - Drives Musig2 with the solver session.
     * - Builds a forfeit per VTXO (no user-side signing).
     * - Submits forfeits to the introspector (which adds server + introspector sigs)
     *   and forwards to arkd via submitSignedForfeitTxs.
     */
    function delegateBatchHandler(opts: {
        intentId: string;
        signedProof: string;
        message: Intent.RegisterMessage;
        coin: {
            txid: string;
            vout: number;
            value: number;
            tapTree: Uint8Array;
            forfeitTapLeafScript: any;
        };
        session: Awaited<ReturnType<SingleKey["signerSession"]>> | any;
    }): Batch.Handler {
        let batchId: string;
        let sweepRoot: Uint8Array;
        return {
            async onBatchStarted(event) {
                const intentIdHash = hex.encode(
                    sha256(new TextEncoder().encode(opts.intentId))
                );
                if (!event.intentIdHashes.includes(intentIdHash)) {
                    return { skip: true };
                }
                await arkProvider.confirmRegistration(opts.intentId);
                batchId = event.id;
                const sweepTapscript = CSVMultisigTapscript.encode({
                    timelock: {
                        value: event.batchExpiry,
                        type: event.batchExpiry >= 512n ? "seconds" : "blocks",
                    },
                    pubkeys: [
                        hex
                            .decode(
                                (await arkProvider.getInfo()).forfeitPubkey
                            )
                            .subarray(1),
                    ],
                }).script;
                sweepRoot = tapLeafHash(sweepTapscript);
                return { skip: false };
            },
            async onTreeSigningStarted(event, vtxoTree) {
                const myPubkey = hex.encode(await opts.session.getPublicKey());
                if (
                    !event.cosignersPublicKeys.some(
                        (k: string) => k.slice(2) === myPubkey.slice(2)
                    )
                ) {
                    return { skip: true };
                }
                const commitment = Transaction.fromPSBT(
                    base64.decode(event.unsignedCommitmentTx)
                );
                const shared = commitment.getOutput(0)!;
                await opts.session.init(vtxoTree, sweepRoot, shared.amount!);
                await arkProvider.submitTreeNonces(
                    batchId,
                    myPubkey,
                    await opts.session.getNonces()
                );
                return { skip: false };
            },
            async onTreeNonces(event) {
                const { hasAllNonces } = await opts.session.aggregatedNonces(
                    event.txid,
                    event.nonces
                );
                if (!hasAllNonces) return { fullySigned: false };
                await arkProvider.submitTreeSignatures(
                    batchId,
                    hex.encode(await opts.session.getPublicKey()),
                    await opts.session.sign()
                );
                return { fullySigned: true };
            },
            async onBatchFinalization(event, _vtxoTree, connectorTree) {
                if (!connectorTree) throw new Error("missing connector tree");
                const info = await arkProvider.getInfo();
                const forfeitOutputScript = OutScript.encode(
                    Address(networks.regtest).decode(info.forfeitAddress)
                );

                const leaves = connectorTree.leaves();
                if (leaves.length < 1) throw new Error("no connectors");
                const connectorLeaf = leaves[0];
                const connectorOutput = connectorLeaf.getOutput(0)!;
                const forfeitTx = buildForfeitTx(
                    [
                        {
                            txid: opts.coin.txid,
                            index: opts.coin.vout,
                            witnessUtxo: {
                                amount: BigInt(opts.coin.value),
                                script: VtxoScript.decode(opts.coin.tapTree)
                                    .pkScript,
                            },
                            sighashType: SigHash.DEFAULT,
                            tapLeafScript: [opts.coin.forfeitTapLeafScript],
                        },
                        {
                            txid: connectorLeaf.id,
                            index: 0,
                            witnessUtxo: {
                                amount: connectorOutput.amount!,
                                script: connectorOutput.script!,
                            },
                        },
                    ],
                    forfeitOutputScript
                );

                // Convert the connector tree into the protocol shape.
                const connectorNodes = [];
                for (const sub of connectorTree.iterator()) {
                    const children: Record<string, string> = {};
                    for (const [vout, child] of sub.children) {
                        children[String(vout)] = child.txid;
                    }
                    connectorNodes.push({
                        txid: sub.txid,
                        tx: base64.encode(sub.root.toPSBT()),
                        children,
                    });
                }

                const result = await introspector.submitFinalization(
                    { proof: opts.signedProof, message: opts.message },
                    [base64.encode(forfeitTx.toPSBT())],
                    connectorNodes,
                    event.commitmentTx
                );

                await arkProvider.submitSignedForfeitTxs(
                    result.signedForfeits,
                    result.signedCommitmentTx
                );
            },
        };
    }
```

Add the missing imports to the file's top:

```typescript
import { Address, OutScript, SigHash } from "@scure/btc-signer";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { sha256 } from "@scure/btc-signer/utils.js";
import { buildForfeitTx } from "../../src/forfeit";
import { VtxoScript } from "../../src/script/base";
```

- [ ] **Step 2: Wire it into the test and assert refresh**

Replace the `expect(intentId).toBeTruthy();` ending in the `it` body with:

```typescript
        const handler = delegateBatchHandler({
            intentId,
            signedProof,
            message,
            coin,
            session,
        });

        const topics = [sessionPubKey, `${fundingTxid}:${delegateOutputIndex}`];
        const abortController = new AbortController();
        let commitmentTxid: string;
        try {
            const stream = arkProvider.getEventStream(
                abortController.signal,
                topics
            );
            commitmentTxid = await Batch.join(stream, handler, {
                timeout: 60000,
            });
        } finally {
            abortController.abort();
        }
        expect(commitmentTxid).toBeTruthy();

        // The refreshed VTXO is at the same delegate pkScript with the same value
        // and is now a batch leaf (not preconfirmed).
        await expect.poll(
            async () => {
                const resp = await indexerProvider.getVtxos({
                    scripts: [hex.encode(delegatePkScript)],
                    spendableOnly: true,
                });
                const refreshed = resp.vtxos.find(
                    (v) =>
                        v.value === DELEGATE_AMOUNT &&
                        v.virtualStatus?.state !== "preconfirmed"
                );
                return Boolean(refreshed);
            },
            { timeout: 15000, interval: 500 }
        ).toBe(true);
```

- [ ] **Step 3: Run the full delegate test**

```bash
ARK_ENV=docker pnpm vitest run test/e2e/arkade-delegate.test.ts
```

Expected: PASS. If `Batch.join`'s third options arg is differently named, check `src/wallet/batch.ts` and use whichever option is actually present (e.g., omit it).

If the introspector returns ANY error during `submitFinalization`, capture the response with `docker logs introspector -n 200` and adjust the forfeit construction. The most common gotcha is missing TaprootLeafScript on input 0 of the forfeit — both inputs come from non-user closures here.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/arkade-delegate.test.ts
git commit -m "test(e2e): port TestCovenantDelegate batch refresh"
```

---

## Task 12: Port `TestSubmitOnchainTx` (`onchain_test.go`)

Mirrors `introspector/test/onchain_test.go`. Validates the new `SubmitOnchainTx` RPC end-to-end: fund an arkade-tweaked taproot address directly with `nigiri faucet`, build a plain Bitcoin spend tx, sign with the user, send to introspector, verify multi-sig PSBT comes back, then add the third sig + finalize + broadcast.

**Files:**
- Create: `test/e2e/arkade-onchain.test.ts`

- [ ] **Step 1: Add a helper to wait for an onchain UTXO**

Append to `test/e2e/utils.ts`:

```typescript
export async function waitForUtxo(
    address: string,
    timeoutMs = 60_000
): Promise<{ txid: string; vout: number; value: number }> {
    const provider = new EsploraProvider("http://localhost:3000");
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const utxos = await provider.getCoins(address);
            if (utxos.length > 0) {
                const u = utxos[0];
                return { txid: u.txid, vout: u.vout, value: Number(u.value) };
            }
        } catch {
            // ignore, keep polling
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`waitForUtxo: timeout for ${address}`);
}
```

(Add `EsploraProvider` to the existing `../../src` import at the top of the file if it isn't already there.) If `getCoins` is named differently in `EsploraProvider`, grep for the actual method (`grep -n "async getCoins\|async getUtxos" src/providers/onchain.ts`) and adapt.

- [ ] **Step 2: Scaffold the test file**

Create `test/e2e/arkade-onchain.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { base64, hex } from "@scure/base";
import { Address, OutScript, p2tr, SigHash } from "@scure/btc-signer";
import {
    arkade,
    CSVMultisigTapscript,
    EsploraProvider,
    MultisigTapscript,
    networks,
    PrevoutTxField,
    RestArkProvider,
    RestIntrospectorProvider,
    setArkPsbtField,
    SingleKey,
    Transaction,
} from "../../src";
import { addIntrospectorPacket, enforcePayTo, execCommand, waitForUtxo } from "./utils";

const INTROSPECTOR_URL = "http://localhost:7073";
const ARK_SERVER_URL = "http://localhost:7070";
const FUNDING_BTC = "0.01";
const FUNDING_AMOUNT = 1_000_000n;
const FEE_AMOUNT = 500n;
const SPEND_AMOUNT = FUNDING_AMOUNT - FEE_AMOUNT;

describe("arkade SubmitOnchainTx", () => {
    const introspector = new RestIntrospectorProvider(INTROSPECTOR_URL);
    const arkProvider = new RestArkProvider(ARK_SERVER_URL);

    let introspectorPubkey: Uint8Array;

    beforeAll(async () => {
        introspectorPubkey = hex.decode(
            (await introspector.getInfo()).signerPubkey
        );
    });

    /** Builds an unsigned 1-in/1-out spend PSBT with all required arkade fields. */
    function buildOnchainSpendTx(opts: {
        fundingTxid: string;
        fundingVout: number;
        fundingValue: bigint;
        fundingPkScript: Uint8Array;
        rawFundingTx: Uint8Array;
        spendOutputScript: Uint8Array;
        spendOutputValue: bigint;
        tapLeafScript: any; // [controlBlock, scriptWithLeafVer]
        arkadeScript: Uint8Array | null;
        sequence?: number;
    }): Transaction {
        const tx = new Transaction({ allowUnknownInputs: true, version: 2 });
        tx.addInput({
            txid: hex.decode(opts.fundingTxid),
            index: opts.fundingVout,
            sequence: opts.sequence ?? 0xffffffff,
            witnessUtxo: {
                amount: opts.fundingValue,
                script: opts.fundingPkScript,
            },
            tapLeafScript: [opts.tapLeafScript],
            sighashType: SigHash.DEFAULT,
        });
        tx.addOutput({
            script: opts.spendOutputScript,
            amount: opts.spendOutputValue,
        });

        setArkPsbtField(tx, 0, PrevoutTxField, opts.rawFundingTx);

        if (opts.arkadeScript) {
            addIntrospectorPacket(tx, [
                { vin: 0, script: opts.arkadeScript, witness: new Uint8Array(0) },
            ]);
        }
        return tx;
    }
});
```

- [ ] **Step 3: Add the "valid" subtest with funding setup, signing, and broadcast**

Inside `describe(...)` and outside `beforeAll`, append:

```typescript
    /**
     * Sets up the funded contract address shared by most subtests:
     *  - 3-of-3 multisig [bob, alice, introspector_tweaked] with arkade closure
     *  - funded via `nigiri faucet 0.01`, 1 block mined
     */
    async function setupFundedContract() {
        const bob = SingleKey.fromRandomBytes();
        const alice = SingleKey.fromRandomBytes();
        const bobX = await bob.xOnlyPublicKey();
        const aliceX = await alice.xOnlyPublicKey();
        const bobP2TR = p2tr(bobX, undefined, networks.regtest).script;

        const arkadeScript = enforcePayTo(bobP2TR, SPEND_AMOUNT);
        const tweakedIntro = arkade.computeArkadeScriptPublicKey(
            introspectorPubkey,
            arkadeScript
        );

        const vtxoScript = new arkade.ArkadeVtxoScript([
            {
                arkadeScript,
                introspectors: [introspectorPubkey],
                tapscript: MultisigTapscript.encode({
                    pubkeys: [bobX, aliceX],
                }),
            },
        ]);

        const arkadeLeafScript = MultisigTapscript.encode({
            pubkeys: [bobX, aliceX, tweakedIntro],
        });
        const tapLeafScript = vtxoScript.findLeaf(
            hex.encode(arkadeLeafScript.script)
        );

        // Convert pkScript to bech32m address.
        const decoded = OutScript.decode(vtxoScript.pkScript);
        const contractAddress = Address(networks.regtest).encode(decoded);

        execCommand(`nigiri faucet ${contractAddress} ${FUNDING_BTC}`);
        execCommand(`nigiri rpc -generate 1`);

        const utxo = await waitForUtxo(contractAddress);
        const explorer = new EsploraProvider("http://localhost:3000");
        const rawHex = await explorer.getTxHex(utxo.txid);
        const rawFundingTx = hex.decode(rawHex);

        return {
            bob,
            alice,
            bobP2TR,
            arkadeScript,
            vtxoScript,
            tapLeafScript,
            utxo,
            rawFundingTx,
        };
    }

    it("valid: introspector co-signs and the tx broadcasts after the third sig", { timeout: 120000 }, async () => {
        const ctx = await setupFundedContract();

        const tx = buildOnchainSpendTx({
            fundingTxid: ctx.utxo.txid,
            fundingVout: ctx.utxo.vout,
            fundingValue: FUNDING_AMOUNT,
            fundingPkScript: ctx.vtxoScript.pkScript,
            rawFundingTx: ctx.rawFundingTx,
            spendOutputScript: ctx.bobP2TR,
            spendOutputValue: SPEND_AMOUNT,
            tapLeafScript: ctx.tapLeafScript,
            arkadeScript: ctx.arkadeScript,
        });

        const bobSigned = await ctx.bob.sign(tx, [0]);
        const result = await introspector.submitOnchainTx(
            base64.encode(bobSigned.toPSBT())
        );

        const parsed = Transaction.fromPSBT(base64.decode(result.signedTx));
        const sigs = parsed.getInput(0)?.tapScriptSig ?? [];
        expect(sigs.length).toBeGreaterThanOrEqual(2);

        // Add Alice's signature (the third member of the multisig).
        const aliceSigned = await ctx.alice.sign(parsed, [0]);
        aliceSigned.finalize();
        const txHex = hex.encode(aliceSigned.extract());

        const explorer = new EsploraProvider("http://localhost:3000");
        const broadcastTxid = await explorer.broadcastTransaction(txHex);
        expect(broadcastTxid).toBeTruthy();
    });
```

If `tx.getInput(0).tapScriptSig` doesn't match @scure's actual property name, grep for it: `grep -rn "tapScriptSig\|TaprootScriptSpendSig" node_modules/@scure/btc-signer/transaction.d.ts | head -5` and use the discovered name.

If `Transaction` constructor doesn't accept `version: 2`, set it after creation: `tx.version = 2;` — or omit (default is 2).

- [ ] **Step 4: Add the negative subtests**

Append:

```typescript
    it("rejects when no introspector packet is present", { timeout: 60000 }, async () => {
        const ctx = await setupFundedContract();

        const tx = buildOnchainSpendTx({
            fundingTxid: ctx.utxo.txid,
            fundingVout: ctx.utxo.vout,
            fundingValue: FUNDING_AMOUNT,
            fundingPkScript: ctx.vtxoScript.pkScript,
            rawFundingTx: ctx.rawFundingTx,
            spendOutputScript: ctx.bobP2TR,
            spendOutputValue: SPEND_AMOUNT,
            tapLeafScript: ctx.tapLeafScript,
            arkadeScript: null,
        });

        const bobSigned = await ctx.bob.sign(tx, [0]);
        await expect(
            introspector.submitOnchainTx(base64.encode(bobSigned.toPSBT()))
        ).rejects.toThrow(/failed to process onchain tx/);
    });

    it("rejects when PrevoutTxField is the wrong tx", { timeout: 60000 }, async () => {
        const ctx = await setupFundedContract();

        // A bogus tx whose hash != fundingTxid.
        const bogusTx = new Transaction();
        bogusTx.addOutput({
            script: new Uint8Array([0x6a]),
            amount: 1n,
        });
        const bogusRaw = bogusTx.toBytes();

        const tx = buildOnchainSpendTx({
            fundingTxid: ctx.utxo.txid,
            fundingVout: ctx.utxo.vout,
            fundingValue: FUNDING_AMOUNT,
            fundingPkScript: ctx.vtxoScript.pkScript,
            rawFundingTx: bogusRaw,
            spendOutputScript: ctx.bobP2TR,
            spendOutputValue: SPEND_AMOUNT,
            tapLeafScript: ctx.tapLeafScript,
            arkadeScript: ctx.arkadeScript,
        });

        const bobSigned = await ctx.bob.sign(tx, [0]);
        await expect(
            introspector.submitOnchainTx(base64.encode(bobSigned.toPSBT()))
        ).rejects.toThrow(/failed to process onchain tx/);
    });

    it("rejects when the arkade script fails (wrong amount)", { timeout: 60000 }, async () => {
        const ctx = await setupFundedContract();

        const tx = buildOnchainSpendTx({
            fundingTxid: ctx.utxo.txid,
            fundingVout: ctx.utxo.vout,
            fundingValue: FUNDING_AMOUNT,
            fundingPkScript: ctx.vtxoScript.pkScript,
            rawFundingTx: ctx.rawFundingTx,
            spendOutputScript: ctx.bobP2TR,
            spendOutputValue: SPEND_AMOUNT - 1n, // off by one
            tapLeafScript: ctx.tapLeafScript,
            arkadeScript: ctx.arkadeScript,
        });

        const bobSigned = await ctx.bob.sign(tx, [0]);
        await expect(
            introspector.submitOnchainTx(base64.encode(bobSigned.toPSBT()))
        ).rejects.toThrow(/failed to process onchain tx/);
    });

    it("rejects a tapscript that includes the arkd signer pubkey", { timeout: 60000 }, async () => {
        // Use arkd's signer as one of the multisig members — introspector must refuse.
        const arkdInfo = await arkProvider.getInfo();
        const arkdX = hex.decode(arkdInfo.signerPubkey).slice(1);

        const bob = SingleKey.fromRandomBytes();
        const bobX = await bob.xOnlyPublicKey();
        const bobP2TR = p2tr(bobX, undefined, networks.regtest).script;

        const arkadeScript = enforcePayTo(bobP2TR, SPEND_AMOUNT);

        const vtxoScript = new arkade.ArkadeVtxoScript([
            {
                arkadeScript,
                introspectors: [introspectorPubkey],
                tapscript: MultisigTapscript.encode({
                    pubkeys: [bobX, arkdX], // arkd as a member — should be rejected
                }),
            },
        ]);

        const arkadeLeaf = MultisigTapscript.encode({
            pubkeys: [
                bobX,
                arkdX,
                arkade.computeArkadeScriptPublicKey(
                    introspectorPubkey,
                    arkadeScript
                ),
            ],
        });
        const tapLeafScript = vtxoScript.findLeaf(
            hex.encode(arkadeLeaf.script)
        );

        // Funding doesn't matter — the reject runs before script execution.
        // Reuse a previously-known utxo shape; introspector will refuse on tapscript inspection.
        const tx = buildOnchainSpendTx({
            fundingTxid: "00".repeat(32),
            fundingVout: 0,
            fundingValue: FUNDING_AMOUNT,
            fundingPkScript: vtxoScript.pkScript,
            rawFundingTx: new Uint8Array([0x02, 0, 0, 0, 0, 0, 0, 0, 0]), // any
            spendOutputScript: bobP2TR,
            spendOutputValue: SPEND_AMOUNT,
            tapLeafScript,
            arkadeScript,
        });

        await expect(
            introspector.submitOnchainTx(base64.encode(tx.toPSBT()))
        ).rejects.toThrow(/failed to process onchain tx/);
    });
```

- [ ] **Step 5: Add the CSV exit closure subtest**

Append:

```typescript
    it("CSV exit closure: introspector signs after relative locktime is satisfied", { timeout: 180000 }, async () => {
        const CSV_BLOCKS = 3;

        const bob = SingleKey.fromRandomBytes();
        const alice = SingleKey.fromRandomBytes();
        const bobX = await bob.xOnlyPublicKey();
        const aliceX = await alice.xOnlyPublicKey();
        const bobP2TR = p2tr(bobX, undefined, networks.regtest).script;

        const arkadeScript = enforcePayTo(bobP2TR, SPEND_AMOUNT);
        const tweakedIntro = arkade.computeArkadeScriptPublicKey(
            introspectorPubkey,
            arkadeScript
        );

        // First closure: plain multisig [bob, alice]
        // Second closure: CSV [bob, introspector_tweaked] with `CSV_BLOCKS` blocks
        const vtxoScript = new arkade.ArkadeVtxoScript([
            MultisigTapscript.encode({ pubkeys: [bobX, aliceX] }).script,
            CSVMultisigTapscript.encode({
                timelock: { type: "blocks", value: BigInt(CSV_BLOCKS) },
                pubkeys: [bobX, tweakedIntro],
            }).script,
        ]);

        const csvLeaf = CSVMultisigTapscript.encode({
            timelock: { type: "blocks", value: BigInt(CSV_BLOCKS) },
            pubkeys: [bobX, tweakedIntro],
        });
        const tapLeafScript = vtxoScript.findLeaf(
            hex.encode(csvLeaf.script)
        );

        const decoded = OutScript.decode(vtxoScript.pkScript);
        const contractAddress = Address(networks.regtest).encode(decoded);

        execCommand(`nigiri faucet ${contractAddress} ${FUNDING_BTC}`);
        // Mine CSV_BLOCKS + 1 to satisfy the relative locktime.
        for (let i = 0; i < CSV_BLOCKS + 1; i++) {
            execCommand(`nigiri rpc -generate 1`);
        }

        const utxo = await waitForUtxo(contractAddress);
        const explorer = new EsploraProvider("http://localhost:3000");
        const rawFundingTx = hex.decode(await explorer.getTxHex(utxo.txid));

        const tx = buildOnchainSpendTx({
            fundingTxid: utxo.txid,
            fundingVout: utxo.vout,
            fundingValue: FUNDING_AMOUNT,
            fundingPkScript: vtxoScript.pkScript,
            rawFundingTx,
            spendOutputScript: bobP2TR,
            spendOutputValue: SPEND_AMOUNT,
            tapLeafScript,
            arkadeScript,
            sequence: CSV_BLOCKS, // BIP-68 block-based CSV
        });

        const bobSigned = await bob.sign(tx, [0]);
        const result = await introspector.submitOnchainTx(
            base64.encode(bobSigned.toPSBT())
        );

        const parsed = Transaction.fromPSBT(base64.decode(result.signedTx));
        const sigs = parsed.getInput(0)?.tapScriptSig ?? [];
        // Both [bob, introspector_tweaked] keys must have signed.
        expect(sigs.length).toBeGreaterThanOrEqual(2);
    });
```

- [ ] **Step 6: Run the suite**

```bash
ARK_ENV=docker pnpm vitest run test/e2e/arkade-onchain.test.ts
```

Expected: 5 passing.

If a subtest reports an unexpected error message, capture it with `docker logs introspector -n 200` and tighten or relax the `toThrow` regex accordingly. If the introspector returns `failed to validate tapscript` (or similar) instead of `failed to process onchain tx`, broaden the regex to match the actual prefix. **Do not weaken positive tests** — only adjust error matching.

- [ ] **Step 7: Commit**

```bash
git add test/e2e/utils.ts test/e2e/arkade-onchain.test.ts
git commit -m "test(e2e): port TestSubmitOnchainTx covenant subtests"
```

---

## Task 13: Final integration check

- [ ] **Step 1: Run all unit tests**

```bash
pnpm test:unit
```

Expected: PASS, including the new tests from Tasks 2/3/4.

- [ ] **Step 2: Run all e2e arkade tests against the local stack**

```bash
ARK_ENV=docker pnpm vitest run test/e2e/arkade.test.ts test/e2e/arkade-htlc.test.ts test/e2e/arkade-delegate.test.ts test/e2e/arkade-onchain.test.ts
```

Expected: PASS.

- [ ] **Step 3: Verify CI flow still runs locally end-to-end**

```bash
pnpm regtest:clean
pnpm regtest:start
pnpm test:setup-docker
ARK_ENV=docker pnpm vitest run test/e2e/arkade-htlc.test.ts test/e2e/arkade-delegate.test.ts test/e2e/arkade-onchain.test.ts
pnpm regtest:stop
```

Expected: each command exits 0.

- [ ] **Step 4: Commit any final touch-ups**

```bash
git status
# only commit if there are pending changes from Step 3 fixups
```

---

## Self-Review

- **Spec coverage**:
  - "Update PR to work with v0.0.1" — Tasks 1 (image), 2 (`submitOnchainTx`), 3 (auto-finalize detection in `submitTx`), 4 (new opcodes), 5 (`PrevArkTxField` + `PrevoutTxField`), 6 (`BigNum`). Existing tweak.ts already strips to x-only and prepends 0x02 (memory note), and v0.0.1's seckey-negate hotfix means odd-Y keys also work — no TS-side change needed.
  - "Port `htlc_test.go`" — Tasks 7, 8, 9.
  - "Port `delegate_test.go`" — Tasks 7, 10, 11.
  - "Test for `SubmitOnchainTx`" — Task 12 (5 subtests, mirrors `onchain_test.go`).
- **Placeholders**: none — every step shows the code/command. Soft fallbacks (`absoluteTimelock`, `sendOffChain`, `tapScriptSig`, `getCoins`, `ScriptNum(520, true)`) are framed with the exact file to grep and the alternative to swap in.
- **Type consistency**: `coin` shape used in Tasks 10/11 mirrors the existing `arkade.test.ts:301-311` ExtendedCoin shape; `delegateBatchHandler` re-uses `Batch.Handler` interface from `src/wallet/batch.ts:45`; `PrevArkTxField`/`PrevoutTxField` are both `ArkPsbtFieldCoder<Uint8Array>` in their definition (Task 5) and call sites (Tasks 10/11/12); `buildOnchainSpendTx` shares the same `tapLeafScript` shape used by every other test in this plan; `BigNum.encode/decode` signatures (Task 6) match where bigint operands appear in the e2e tests (`enforcePayTo`'s amount in Task 7 already uses bigint via the script encoder's bigint support).
