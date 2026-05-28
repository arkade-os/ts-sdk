# Introspector Packet: Validations & Test Fixtures

**Date:** 2026-03-13
**Status:** Draft
**Reference:** [ArkLabsHQ/introspector#15](https://github.com/ArkLabsHQ/introspector/pull/15), Go `testdata/introspector_packet.json`

## Goal

Align the TS `IntrospectorPacket` with the Go introspector by:
1. Adding missing validation checks
2. Rewriting tests to use JSON fixtures loaded from `test/fixtures/introspector_packet.json`, matching the Go test pattern

## Scope

Client-side packet validation and tests only. No server-side engine/opcode logic.

## Changes

### 1. Missing Validations in `IntrospectorPacket.create()`

**File:** `src/extension/introspector/packet.ts`

Add two checks to `create()` before the existing duplicate-vin validation:

- **Empty entries:** Reject if `entries.length === 0`. Error: `"empty introspector packet"`.
- **Empty script:** Reject if any entry has `script.length === 0`. Error: `"empty script for vin <N>"`.

These match the Go implementation which rejects both cases at construction time.

Note: `fromBytes()` calls `create()` internally, so these validations also protect the deserialization path (e.g., deserializing `"00"` — zero entry count — will hit the empty-entries check).

### 2. JSON Test Fixtures

**File:** `test/fixtures/introspector_packet.json`

Follows the same structure as Go's `testdata/introspector_packet.json`:

```json
{
  "valid": [
    {
      "name": "description used as test case name",
      "encoded": "<hex of serialized packet>",
      "entries": [
        { "vin": 0, "script": "<hex>", "witness": "<hex>" }
      ]
    }
  ],
  "invalid": [
    {
      "name": "description used as test case name",
      "entries": [...],
      "encoded": "...",
      "expectedError": "exact error substring"
    }
  ]
}
```

**Adaptation from Go:** The Go JSON has `"witness": ["hex1", "hex2"]` (array of items for `wire.TxWitness`). The TS code uses flat `Uint8Array` for witness, so the JSON uses `"witness": "<hex>"` (single flat hex string). The `encoded` hex values reflect the TS wire format accordingly.

**Valid fixtures:**

| Name | Entries | Encoded | Notes |
|------|---------|---------|-------|
| single entry | vin=0, script=`51`, witness=`` | `010000015100` | Minimal: count=01, vin=0000, slen=01, script=51, wlen=00 |
| single entry with witness | vin=1, script=`aabb`, witness=`cc` | `01010002aabb01cc` | count=01, vin=0100, slen=02, script=aabb, wlen=01, witness=cc |
| multiple entries | vin=0 script=`51` wit=`` + vin=3 script=`aabb` wit=`ccddeeff` | `020000015100030002aabb04ccddeeff` | 2 entries |
| large vin | vin=65535, script=`51`, witness=`` | `01ffff015100` | u16 LE boundary |

**Invalid fixtures:**

| Name | Has entries? | Has encoded? | expectedError |
|------|-------------|-------------|---------------|
| empty packet | yes (empty array) | no | `empty introspector packet` |
| empty packet from bytes | no | yes (`00`) | `empty introspector packet` |
| empty script | yes | no | `empty script for vin 0` |
| duplicate vin | yes | no | `duplicate vin 0` |
| trailing bytes | no | yes | `trailing bytes` |
| truncated entry | no | yes | `unexpected end of buffer` |

### 3. Rewrite Test File

**File:** `test/introspector-packet.test.ts`

Rewrite to follow the Go test pattern:

**Loading fixtures:**
```ts
import { readFileSync } from "fs";
import { join } from "path";

const fixtures = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "introspector_packet.json"), "utf-8")
);
```

**Valid tests** — data-driven loop using `fixture.name` as test case name (`it(fixture.name, ...)`):
1. Decode entries from hex strings to `IntrospectorEntry[]`
2. Construct packet via `IntrospectorPacket.create(entries)`
3. Serialize and compare to `fixture.encoded` hex
4. Deserialize from `fixture.encoded` hex via `IntrospectorPacket.fromBytes()`
5. Compare deserialized entries field-by-field (vin, script hex, witness hex)

**Invalid tests** — data-driven loop using `fixture.name`:
- If `entries` present: `IntrospectorPacket.create()` should `toThrow(fixture.expectedError)`
- If `encoded` present: `IntrospectorPacket.fromBytes()` should `toThrow(fixture.expectedError)`
- Note: a fixture can have both (testing both paths)

**Extension integration tests** remain as standalone tests (not fixture-driven), since they test TLV envelope behavior not covered by Go's packet fixtures.

## Files Modified

1. `src/extension/introspector/packet.ts` — add 2 validation checks in `create()`
2. `test/fixtures/introspector_packet.json` — new fixture file
3. `test/introspector-packet.test.ts` — rewrite to fixture-driven pattern

## Out of Scope

- `FindEntryByVin` — only used by server-side opcode handlers
- Engine/opcode integration tests — server-side only
- Wire format changes — TS already uses flat `Uint8Array` witnesses, matching Go PR branch
