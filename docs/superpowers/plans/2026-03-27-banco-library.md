# Banco Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract banco business logic from the CLI into a reusable library (`@arkade-os/banco`) with `Maker`, `Taker`, TLV-encoded offers, and update the CLI to consume it.

**Architecture:** New `packages/banco/` workspace package exports `Maker`, `Taker`, `Offer`, `BancoSwap`. The library depends on `@arkade-os/sdk` and delegates all wallet ops to the `IWallet` interface. The existing CLI in `examples/banco/` becomes a thin shell.

**Tech Stack:** TypeScript, `@arkade-os/sdk`, `@scure/base` (hex), vitest

---

## File Structure

| Path | Action | Purpose |
|------|--------|---------|
| `packages/banco/package.json` | Create | Package manifest for `@arkade-os/banco` |
| `packages/banco/tsconfig.json` | Create | TypeScript config |
| `packages/banco/src/contract.ts` | Create | `BancoSwap` (moved from `examples/banco/src/contract/banco.ts`) |
| `packages/banco/src/offer.ts` | Create | `Offer` type + TLV encode/decode |
| `packages/banco/src/maker.ts` | Create | `Maker` class |
| `packages/banco/src/taker.ts` | Create | `Taker` class |
| `packages/banco/src/index.ts` | Create | Public exports |
| `test/unit/banco/offer.test.ts` | Create | Unit tests for TLV encoding |
| `test/e2e/banco.test.ts` | Modify | Update to use library classes |
| `pnpm-workspace.yaml` | Modify | Add `packages/banco` |
| `examples/banco/package.json` | Modify | Add dep on `@arkade-os/banco` |
| `examples/banco/src/index.ts` | Modify | Rewrite as thin CLI shell |
| `examples/banco/src/contract/banco.ts` | Delete | Moved to `packages/banco/src/contract.ts` |

---

### Task 1: Scaffold the `packages/banco` package

**Files:**
- Create: `packages/banco/package.json`
- Create: `packages/banco/tsconfig.json`
- Create: `packages/banco/src/index.ts`
- Modify: `pnpm-workspace.yaml`

- [ ] **Step 1: Create `packages/banco/package.json`**

```json
{
  "name": "@arkade-os/banco",
  "version": "0.0.1",
  "private": true,
  "description": "Banco swap library for Ark protocol",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@arkade-os/sdk": "workspace:*",
    "@scure/base": "1.2.4"
  },
  "devDependencies": {
    "typescript": "5.9.2"
  }
}
```

- [ ] **Step 2: Create `packages/banco/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2020",
    "lib": ["es2022"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "outDir": "./dist"
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create placeholder `packages/banco/src/index.ts`**

```ts
// Public API — populated as modules are implemented
export {};
```

- [ ] **Step 4: Add `packages/banco` to workspace**

Edit `pnpm-workspace.yaml` to add:

```yaml
packages:
    - "."
    - "examples/banco"
    - "packages/banco"
```

- [ ] **Step 5: Install dependencies**

Run: `cd /Users/louis/Code/ts-sdk && pnpm install`
Expected: lockfile updated, no errors

- [ ] **Step 6: Verify TypeScript resolves**

Run: `cd /Users/louis/Code/ts-sdk/packages/banco && npx tsc --noEmit`
Expected: No errors (empty index.ts)

---

### Task 2: Move `BancoSwap` contract into the library

**Files:**
- Create: `packages/banco/src/contract.ts`
- Delete: `examples/banco/src/contract/banco.ts`

- [ ] **Step 1: Create `packages/banco/src/contract.ts`**

Copy the content from `examples/banco/src/contract/banco.ts` as-is. The imports stay the same since both packages depend on `@arkade-os/sdk`:

```ts
import {
  arkade,
  CLTVMultisigTapscript,
  CSVMultisigTapscript,
  MultisigTapscript,
  RelativeTimelock,
  asset,
} from "@arkade-os/sdk";

const { ArkadeScript, ArkadeVtxoScript } = arkade;

export interface BancoSwapParams {
  wantAmount: bigint;
  want: "btc" | asset.AssetId;
  cltvCancelTimelock?: bigint;
  exitTimelock: RelativeTimelock;
  /** The full scriptPubKey (OP_1 <32-byte-key>) for the maker's output */
  makerPkScript: Uint8Array;
  /** The 32-byte witness program (x-only pubkey) extracted from makerPkScript */
  makerWitnessProgram: Uint8Array;
  makerPublicKey: Uint8Array;
}

export class BancoSwap {
  constructor(
    readonly params: BancoSwapParams,
    readonly serverPubkey: Uint8Array,
    readonly introspectors: Uint8Array[]
  ) {}

  /** Encode the arkade script for the fulfill cooperative path */
  fulfillScript(): Uint8Array {
    const scriptPubKeyCheck = [
      0,
      "INSPECTOUTPUTSCRIPTPUBKEY",
      1,
      "EQUALVERIFY",
      this.params.makerWitnessProgram,
      "EQUAL",
    ] as const;

    const valueCheck = [
      0,
      "INSPECTOUTPUTVALUE",
      Number(this.params.wantAmount),
      "SCRIPTNUMTOLE64",
      "GREATERTHANOREQUAL64",
      "VERIFY",
    ] as const;

    if (this.params.want === "btc") {
      return ArkadeScript.encode([...valueCheck, ...scriptPubKeyCheck]);
    }

    return ArkadeScript.encode([
      0,
      this.params.want.txid,
      Number(this.params.want.groupIndex),
      "INSPECTOUTASSETLOOKUP",
      "DUP",
      "1NEGATE",
      "EQUAL",
      "NOT",
      "VERIFY",
      Number(this.params.wantAmount),
      "SCRIPTNUMTOLE64",
      "GREATERTHANOREQUAL64",
      "VERIFY",
      ...scriptPubKeyCheck,
    ]);
  }

  vtxoScript(): arkade.ArkadeVtxoScript {
    const leaves: arkade.ArkadeVtxoInput[] = [
      {
        arkadeScript: this.fulfillScript(),
        introspectors: this.introspectors,
        tapscript: MultisigTapscript.encode({
          pubkeys: [this.serverPubkey],
        }),
      },
    ];

    if (this.params.cltvCancelTimelock !== undefined) {
      leaves.push(
        CLTVMultisigTapscript.encode({
          pubkeys: [this.params.makerPublicKey, this.serverPubkey],
          absoluteTimelock: this.params.cltvCancelTimelock,
        }).script
      );
    }

    leaves.push(
      CSVMultisigTapscript.encode({
        pubkeys: [this.params.makerPublicKey, this.serverPubkey],
        timelock: this.params.exitTimelock,
      }).script
    );

    return new ArkadeVtxoScript(leaves);
  }
}
```

- [ ] **Step 2: Export from index**

Update `packages/banco/src/index.ts`:

```ts
export { BancoSwap, type BancoSwapParams } from "./contract.js";
```

- [ ] **Step 3: Verify it compiles**

Run: `cd /Users/louis/Code/ts-sdk/packages/banco && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Delete the old file**

Delete `examples/banco/src/contract/banco.ts` and the now-empty `examples/banco/src/contract/` directory.

---

### Task 3: Implement TLV Offer encoding/decoding

**Files:**
- Create: `packages/banco/src/offer.ts`
- Create: `test/unit/banco/offer.test.ts`
- Modify: `packages/banco/src/index.ts`

- [ ] **Step 1: Write failing tests for Offer TLV encode/decode**

Create `test/unit/banco/offer.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { Offer } from "@arkade-os/banco";

describe("Offer TLV encoding", () => {
  const sampleOffer: Offer.Data = {
    swapAddress: "tark1qexampleaddress",
    wantAmount: 10_000n,
    makerPkScript: new Uint8Array(34).fill(0xaa),
    makerWitnessProgram: new Uint8Array(32).fill(0xbb),
    makerPublicKey: new Uint8Array(32).fill(0xcc),
    introspectorPubkey: new Uint8Array(32).fill(0xdd),
  };

  it("round-trips a BTC offer (no optional fields)", () => {
    const encoded = Offer.encode(sampleOffer);
    const decoded = Offer.decode(encoded);

    expect(decoded.swapAddress).toBe(sampleOffer.swapAddress);
    expect(decoded.wantAmount).toBe(sampleOffer.wantAmount);
    expect(decoded.wantAsset).toBeUndefined();
    expect(decoded.cancelDelay).toBeUndefined();
    expect(hex.encode(decoded.makerPkScript)).toBe(hex.encode(sampleOffer.makerPkScript));
    expect(hex.encode(decoded.makerWitnessProgram)).toBe(hex.encode(sampleOffer.makerWitnessProgram));
    expect(hex.encode(decoded.makerPublicKey)).toBe(hex.encode(sampleOffer.makerPublicKey));
    expect(hex.encode(decoded.introspectorPubkey)).toBe(hex.encode(sampleOffer.introspectorPubkey));
  });

  it("round-trips an asset offer with cancel delay", () => {
    const offer: Offer.Data = {
      ...sampleOffer,
      wantAsset: "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234:0",
      cancelDelay: 1_700_000_000n,
    };
    const decoded = Offer.decode(Offer.encode(offer));

    expect(decoded.wantAsset).toBe(offer.wantAsset);
    expect(decoded.cancelDelay).toBe(offer.cancelDelay);
  });

  it("hex round-trip", () => {
    const hexStr = Offer.toHex(sampleOffer);
    expect(typeof hexStr).toBe("string");
    const decoded = Offer.fromHex(hexStr);
    expect(decoded.swapAddress).toBe(sampleOffer.swapAddress);
    expect(decoded.wantAmount).toBe(sampleOffer.wantAmount);
  });

  it("rejects truncated data", () => {
    const encoded = Offer.encode(sampleOffer);
    // truncate to 5 bytes — enough for one TLV header but not enough value
    expect(() => Offer.decode(encoded.subarray(0, 5))).toThrow();
  });

  it("rejects unknown required type", () => {
    // craft a TLV with unknown type 0xFF
    const bad = new Uint8Array([0xff, 0x00, 0x01, 0x00]);
    expect(() => Offer.decode(bad)).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/louis/Code/ts-sdk && npx vitest run test/unit/banco/offer.test.ts`
Expected: FAIL — `@arkade-os/banco` module has no `Offer` export

- [ ] **Step 3: Implement `packages/banco/src/offer.ts`**

```ts
import { hex } from "@scure/base";

/**
 * TLV type tags for offer fields.
 */
const TLV = {
  SWAP_ADDRESS: 0x01,
  WANT_AMOUNT: 0x02,
  WANT_ASSET: 0x03,
  CANCEL_DELAY: 0x04,
  MAKER_PK_SCRIPT: 0x05,
  MAKER_WITNESS_PROGRAM: 0x06,
  MAKER_PUBLIC_KEY: 0x07,
  INTROSPECTOR_PUBKEY: 0x08,
} as const;

export namespace Offer {
  export interface Data {
    swapAddress: string;
    wantAmount: bigint;
    wantAsset?: string;
    cancelDelay?: bigint;
    makerPkScript: Uint8Array;
    makerWitnessProgram: Uint8Array;
    makerPublicKey: Uint8Array;
    introspectorPubkey: Uint8Array;
  }

  /** Encode an offer into a TLV byte sequence. */
  export function encode(offer: Data): Uint8Array {
    const parts: Uint8Array[] = [];

    parts.push(encodeTLV(TLV.SWAP_ADDRESS, encodeUTF8(offer.swapAddress)));
    parts.push(encodeTLV(TLV.WANT_AMOUNT, encodeUint64BE(offer.wantAmount)));

    if (offer.wantAsset !== undefined) {
      parts.push(encodeTLV(TLV.WANT_ASSET, encodeUTF8(offer.wantAsset)));
    }
    if (offer.cancelDelay !== undefined) {
      parts.push(encodeTLV(TLV.CANCEL_DELAY, encodeUint64BE(offer.cancelDelay)));
    }

    parts.push(encodeTLV(TLV.MAKER_PK_SCRIPT, offer.makerPkScript));
    parts.push(encodeTLV(TLV.MAKER_WITNESS_PROGRAM, offer.makerWitnessProgram));
    parts.push(encodeTLV(TLV.MAKER_PUBLIC_KEY, offer.makerPublicKey));
    parts.push(encodeTLV(TLV.INTROSPECTOR_PUBKEY, offer.introspectorPubkey));

    const totalLen = parts.reduce((s, p) => s + p.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }

  /** Decode a TLV byte sequence into an Offer. */
  export function decode(data: Uint8Array): Data {
    const fields = new Map<number, Uint8Array>();
    let offset = 0;

    while (offset < data.length) {
      if (offset + 3 > data.length) {
        throw new Error("Truncated TLV: not enough bytes for header");
      }
      const type = data[offset];
      const length = (data[offset + 1] << 8) | data[offset + 2];
      offset += 3;

      if (offset + length > data.length) {
        throw new Error(`Truncated TLV: field 0x${type.toString(16)} needs ${length} bytes but only ${data.length - offset} remain`);
      }

      if (!KNOWN_TYPES.has(type)) {
        throw new Error(`Unknown TLV type: 0x${type.toString(16)}`);
      }

      fields.set(type, data.subarray(offset, offset + length));
      offset += length;
    }

    const requireField = (type: number, name: string): Uint8Array => {
      const val = fields.get(type);
      if (!val) throw new Error(`Missing required field: ${name}`);
      return val;
    };

    return {
      swapAddress: decodeUTF8(requireField(TLV.SWAP_ADDRESS, "swapAddress")),
      wantAmount: decodeUint64BE(requireField(TLV.WANT_AMOUNT, "wantAmount")),
      wantAsset: fields.has(TLV.WANT_ASSET)
        ? decodeUTF8(fields.get(TLV.WANT_ASSET)!)
        : undefined,
      cancelDelay: fields.has(TLV.CANCEL_DELAY)
        ? decodeUint64BE(fields.get(TLV.CANCEL_DELAY)!)
        : undefined,
      makerPkScript: requireField(TLV.MAKER_PK_SCRIPT, "makerPkScript"),
      makerWitnessProgram: requireField(TLV.MAKER_WITNESS_PROGRAM, "makerWitnessProgram"),
      makerPublicKey: requireField(TLV.MAKER_PUBLIC_KEY, "makerPublicKey"),
      introspectorPubkey: requireField(TLV.INTROSPECTOR_PUBKEY, "introspectorPubkey"),
    };
  }

  /** Encode an offer to a hex string. */
  export function toHex(offer: Data): string {
    return hex.encode(encode(offer));
  }

  /** Decode an offer from a hex string. */
  export function fromHex(hexStr: string): Data {
    return decode(hex.decode(hexStr));
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

const KNOWN_TYPES = new Set(Object.values(TLV));

function encodeTLV(type: number, value: Uint8Array): Uint8Array {
  const buf = new Uint8Array(3 + value.length);
  buf[0] = type;
  buf[1] = (value.length >> 8) & 0xff;
  buf[2] = value.length & 0xff;
  buf.set(value, 3);
  return buf;
}

function encodeUTF8(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function decodeUTF8(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

function encodeUint64BE(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, value, false); // big-endian
  return buf;
}

function decodeUint64BE(data: Uint8Array): bigint {
  if (data.length !== 8) throw new Error(`Expected 8 bytes for uint64, got ${data.length}`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(0, false); // big-endian
}
```

- [ ] **Step 4: Export `Offer` from index**

Update `packages/banco/src/index.ts`:

```ts
export { BancoSwap, type BancoSwapParams } from "./contract.js";
export { Offer } from "./offer.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/louis/Code/ts-sdk && npx vitest run test/unit/banco/offer.test.ts`
Expected: All 5 tests PASS

---

### Task 4: Implement the `Maker` class

**Files:**
- Create: `packages/banco/src/maker.ts`
- Modify: `packages/banco/src/index.ts`

- [ ] **Step 1: Implement `packages/banco/src/maker.ts`**

```ts
import { hex } from "@scure/base";
import {
  ArkAddress,
  RestArkProvider,
  RestIndexerProvider,
  RestIntrospectorProvider,
  CSVMultisigTapscript,
  CLTVMultisigTapscript,
  Transaction,
  buildOffchainTx,
  asset,
  type IWallet,
  type RelativeTimelock,
} from "@arkade-os/sdk";
import { base64 } from "@scure/base";
import { BancoSwap } from "./contract.js";
import { Offer } from "./offer.js";

export interface OfferStatus {
  txid: string;
  vout: number;
  value: number;
  assets?: { assetId: string; amount: number }[];
  spendable: boolean;
}

export interface CreateOfferParams {
  wantAmount: bigint;
  wantAsset?: string;
  cancelDelay?: number;
}

export class Maker {
  private readonly arkProvider: RestArkProvider;
  private readonly indexer: RestIndexerProvider;
  private readonly introspector: RestIntrospectorProvider;

  constructor(
    private readonly wallet: IWallet,
    arkServerUrl: string,
    introspectorUrl: string
  ) {
    this.arkProvider = new RestArkProvider(arkServerUrl);
    this.indexer = new RestIndexerProvider(arkServerUrl);
    this.introspector = new RestIntrospectorProvider(introspectorUrl);
  }

  async createOffer(
    params: CreateOfferParams
  ): Promise<{ offer: string; swapAddress: string }> {
    const info = await this.arkProvider.getInfo();
    const serverPubKey = hex.decode(info.signerPubkey).slice(1);

    const introInfo = await this.introspector.getInfo();
    const introspectorPubkey = hex.decode(introInfo.signerPubkey);

    const makerAddress = await this.wallet.getAddress();
    const decoded = ArkAddress.decode(makerAddress);
    const makerPubkey = decoded.vtxoTaprootKey;
    const makerPkScript = decoded.pkScript;
    const makerWitnessProgram = makerPkScript.subarray(2);

    const exitDelay = BigInt(info.unilateralExitDelay);
    const exitTimelock: RelativeTimelock = {
      value: exitDelay,
      type: exitDelay < 512n ? "blocks" : "seconds",
    };

    const cancelTimestamp = params.cancelDelay
      ? BigInt(Math.floor(Date.now() / 1000) + params.cancelDelay)
      : undefined;

    let want: "btc" | asset.AssetId = "btc";
    if (params.wantAsset) {
      const [txid, voutStr] = params.wantAsset.split(":");
      want = asset.AssetId.create(txid, Number(voutStr ?? 0));
    }

    const swap = new BancoSwap(
      {
        wantAmount: params.wantAmount,
        want,
        cltvCancelTimelock: cancelTimestamp,
        exitTimelock,
        makerPkScript,
        makerWitnessProgram,
        makerPublicKey: makerPubkey,
      },
      serverPubKey,
      [introspectorPubkey]
    );

    const vtxoScript = swap.vtxoScript();
    const network = await this.arkProvider.getInfo();
    const hrp = this.getHrp(network.network);
    const swapAddress = vtxoScript.address(hrp, serverPubKey).encode();

    const offer: Offer.Data = {
      swapAddress,
      wantAmount: params.wantAmount,
      wantAsset: params.wantAsset,
      cancelDelay: cancelTimestamp,
      makerPkScript,
      makerWitnessProgram,
      makerPublicKey: makerPubkey,
      introspectorPubkey,
    };

    return { offer: Offer.toHex(offer), swapAddress };
  }

  async getOffers(swapAddress: string): Promise<OfferStatus[]> {
    const decoded = ArkAddress.decode(swapAddress);
    const pkScript = hex.encode(decoded.pkScript);

    const { vtxos } = await this.indexer.getVtxos({
      scripts: [pkScript],
      spendableOnly: false,
    });

    return vtxos.map((v) => ({
      txid: v.txid,
      vout: v.vout,
      value: v.value,
      assets: v.assets,
      spendable: v.virtualStatus?.state !== "spent",
    }));
  }

  async cancelOffer(offerHex: string): Promise<string> {
    const offer = Offer.fromHex(offerHex);

    if (!offer.cancelDelay) {
      throw new Error("Offer has no cancel path (no cancelDelay set)");
    }

    const info = await this.arkProvider.getInfo();
    const serverPubKey = hex.decode(info.signerPubkey).slice(1);
    const checkpointUnrollClosure = CSVMultisigTapscript.decode(
      hex.decode(info.checkpointTapscript)
    );

    const exitDelay = BigInt(info.unilateralExitDelay);
    const exitTimelock: RelativeTimelock = {
      value: exitDelay,
      type: exitDelay < 512n ? "blocks" : "seconds",
    };

    const swap = new BancoSwap(
      {
        wantAmount: offer.wantAmount,
        want: offer.wantAsset
          ? asset.AssetId.create(
              offer.wantAsset.split(":")[0],
              Number(offer.wantAsset.split(":")[1] ?? 0)
            )
          : "btc",
        cltvCancelTimelock: offer.cancelDelay,
        exitTimelock,
        makerPkScript: offer.makerPkScript,
        makerWitnessProgram: offer.makerWitnessProgram,
        makerPublicKey: offer.makerPublicKey,
      },
      serverPubKey,
      [offer.introspectorPubkey]
    );

    const vtxoScript = swap.vtxoScript();
    const swapPkScript = hex.encode(vtxoScript.pkScript);

    const { vtxos } = await this.indexer.getVtxos({
      scripts: [swapPkScript],
      spendableOnly: true,
    });
    if (vtxos.length === 0) {
      throw new Error("No spendable VTXO found at swap address");
    }
    const swapVtxo = vtxos[0];

    // Find the CLTV cancel leaf
    const cancelTapscript = CLTVMultisigTapscript.encode({
      pubkeys: [offer.makerPublicKey, serverPubKey],
      absoluteTimelock: offer.cancelDelay,
    });
    const cancelTapLeafScript = vtxoScript.findLeaf(
      hex.encode(cancelTapscript.script)
    );
    const swapTapTree = vtxoScript.encode();

    // Build output: send everything back to maker
    const makerAddress = await this.wallet.getAddress();
    const makerDecoded = ArkAddress.decode(makerAddress);
    const outputs = [
      { script: makerDecoded.pkScript, amount: BigInt(swapVtxo.value) },
    ];

    const { arkTx, checkpoints } = buildOffchainTx(
      [
        {
          ...swapVtxo,
          tapLeafScript: cancelTapLeafScript,
          tapTree: swapTapTree,
        },
      ],
      outputs,
      checkpointUnrollClosure
    );

    const signedArkTx = await this.wallet.identity.sign(arkTx);

    const { arkTxid, signedCheckpointTxs } = await this.arkProvider.submitTx(
      base64.encode(signedArkTx.toPSBT()),
      checkpoints.map((c) => base64.encode(c.toPSBT()))
    );

    const finalCheckpoints = await Promise.all(
      signedCheckpointTxs.map(async (cp) => {
        const tx = Transaction.fromPSBT(base64.decode(cp));
        const signed = await this.wallet.identity.sign(tx);
        return base64.encode(signed.toPSBT());
      })
    );

    await this.arkProvider.finalizeTx(arkTxid, finalCheckpoints);
    return arkTxid;
  }

  private getHrp(network: string): string {
    const hrpMap: Record<string, string> = {
      mainnet: "ark",
      testnet: "tark",
      regtest: "tark",
      signet: "tark",
      mutinynet: "tark",
    };
    return hrpMap[network] ?? "tark";
  }
}
```

- [ ] **Step 2: Export from index**

Update `packages/banco/src/index.ts`:

```ts
export { BancoSwap, type BancoSwapParams } from "./contract.js";
export { Offer } from "./offer.js";
export { Maker, type OfferStatus, type CreateOfferParams } from "./maker.js";
```

- [ ] **Step 3: Verify it compiles**

Run: `cd /Users/louis/Code/ts-sdk/packages/banco && npx tsc --noEmit`
Expected: No errors

---

### Task 5: Implement the `Taker` class

**Files:**
- Create: `packages/banco/src/taker.ts`
- Modify: `packages/banco/src/index.ts`

- [ ] **Step 1: Implement `packages/banco/src/taker.ts`**

```ts
import { hex, base64 } from "@scure/base";
import {
  ArkAddress,
  RestArkProvider,
  RestIndexerProvider,
  RestIntrospectorProvider,
  CSVMultisigTapscript,
  MultisigTapscript,
  arkade,
  asset,
  buildOffchainTx,
  combineTapscriptSigs,
  Extension,
  IntrospectorPacket,
  Transaction,
  type IWallet,
  type RelativeTimelock,
} from "@arkade-os/sdk";
import { BancoSwap } from "./contract.js";
import { Offer } from "./offer.js";

export class Taker {
  private readonly arkProvider: RestArkProvider;
  private readonly indexer: RestIndexerProvider;
  private readonly introspector: RestIntrospectorProvider;

  constructor(
    private readonly wallet: IWallet,
    arkServerUrl: string,
    introspectorUrl: string
  ) {
    this.arkProvider = new RestArkProvider(arkServerUrl);
    this.indexer = new RestIndexerProvider(arkServerUrl);
    this.introspector = new RestIntrospectorProvider(introspectorUrl);
  }

  async fulfill(offerHex: string): Promise<{ txid: string }> {
    const offer = Offer.fromHex(offerHex);

    // ── Fetch server config ──
    const info = await this.arkProvider.getInfo();
    const serverPubKey = hex.decode(info.signerPubkey).slice(1);
    const checkpointUnrollClosure = CSVMultisigTapscript.decode(
      hex.decode(info.checkpointTapscript)
    );

    const exitDelay = BigInt(info.unilateralExitDelay);
    const exitTimelock: RelativeTimelock = {
      value: exitDelay,
      type: exitDelay < 512n ? "blocks" : "seconds",
    };

    // ── Reconstruct the swap contract ──
    const swap = new BancoSwap(
      {
        wantAmount: offer.wantAmount,
        want: offer.wantAsset
          ? asset.AssetId.create(
              offer.wantAsset.split(":")[0],
              Number(offer.wantAsset.split(":")[1] ?? 0)
            )
          : "btc",
        cltvCancelTimelock: offer.cancelDelay,
        exitTimelock,
        makerPkScript: offer.makerPkScript,
        makerWitnessProgram: offer.makerWitnessProgram,
        makerPublicKey: offer.makerPublicKey,
      },
      serverPubKey,
      [offer.introspectorPubkey]
    );

    const swapVtxoScript = swap.vtxoScript();
    const swapPkScript = hex.encode(swapVtxoScript.pkScript);

    // ── Find the swap VTXO ──
    const { vtxos: swapVtxos } = await this.indexer.getVtxos({
      scripts: [swapPkScript],
      spendableOnly: true,
    });
    if (swapVtxos.length === 0) {
      throw new Error("No spendable VTXO found at swap address");
    }
    const swapVtxo = swapVtxos[0];

    // ── Locate the fulfill leaf ──
    const fulfillMultisig = MultisigTapscript.encode({
      pubkeys: [
        serverPubKey,
        arkade.computeArkadeScriptPublicKey(
          offer.introspectorPubkey,
          swap.fulfillScript()
        ),
      ],
    });
    const swapTapLeafScript = swapVtxoScript.findLeaf(
      hex.encode(fulfillMultisig.script)
    );
    const swapTapTree = swapVtxoScript.encode();

    // ── Gather taker's VTXOs ──
    const takerVtxos = await this.wallet.getVtxos();
    if (takerVtxos.length === 0) {
      throw new Error("Taker wallet has no VTXOs");
    }

    const takerAddress = await this.wallet.getAddress();
    const takerDecoded = ArkAddress.decode(takerAddress);
    const takerPkScript = takerDecoded.pkScript;

    const totalTaker = takerVtxos.reduce((s, v) => s + v.value, 0);
    const changeAmount = BigInt(totalTaker) - offer.wantAmount;

    if (changeAmount < 0n) {
      throw new Error(
        `Insufficient funds: have ${totalTaker} sats, need ${offer.wantAmount}`
      );
    }

    // ── Build outputs ──
    const outputs: { script: Uint8Array; amount: bigint }[] = [
      { script: offer.makerPkScript, amount: offer.wantAmount },
      { script: takerPkScript, amount: BigInt(swapVtxo.value) },
    ];

    if (changeAmount > 0n) {
      outputs.push({ script: takerPkScript, amount: changeAmount });
    }

    // ── Build extension packets ──
    const extensionPackets: Parameters<typeof Extension.create>[0] = [
      IntrospectorPacket.create([
        {
          vin: 0,
          script: swap.fulfillScript(),
          witness: new Uint8Array(0),
        },
      ]),
    ];

    if (swapVtxo.assets && swapVtxo.assets.length > 0) {
      const assetGroups = swapVtxo.assets.map(
        (a: { assetId: string; amount: number }) =>
          asset.AssetGroup.create(
            asset.AssetId.fromString(a.assetId),
            null,
            [asset.AssetInput.create(0, a.amount)],
            [asset.AssetOutput.create(1, a.amount)],
            []
          )
      );
      extensionPackets.unshift(asset.Packet.create(assetGroups));
    }

    outputs.push(Extension.create(extensionPackets).txOut());

    // ── Build offchain tx ──
    const swapInput = {
      ...swapVtxo,
      tapLeafScript: swapTapLeafScript,
      tapTree: swapTapTree,
    };
    const takerInputs = takerVtxos.map((v) => ({
      ...v,
      tapLeafScript: v.forfeitTapLeafScript,
      tapTree: v.tapTree,
    }));

    const { arkTx, checkpoints } = buildOffchainTx(
      [swapInput, ...takerInputs],
      outputs,
      checkpointUnrollClosure
    );

    // ── Sign taker inputs only (not the swap input at index 0) ──
    const takerInputIndexes = takerInputs.map((_, i) => i + 1);
    const signedArkTx = await this.wallet.identity.sign(
      arkTx,
      takerInputIndexes
    );

    // ── Submit to introspector ──
    const introResult = await this.introspector.submitTx(
      base64.encode(signedArkTx.toPSBT()),
      checkpoints.map((c) => base64.encode(c.toPSBT()))
    );

    // ── Submit to ark server ──
    const { arkTxid, signedCheckpointTxs } = await this.arkProvider.submitTx(
      introResult.signedArkTx,
      introResult.signedCheckpointTxs
    );

    // ── Merge checkpoint sigs and counter-sign ──
    const finalCheckpoints = await Promise.all(
      signedCheckpointTxs.map(async (serverCp, i) => {
        const serverTx = Transaction.fromPSBT(base64.decode(serverCp));
        const introTx = Transaction.fromPSBT(
          base64.decode(introResult.signedCheckpointTxs[i])
        );

        // Merge introspector sigs into server checkpoint
        combineTapscriptSigs(introTx, serverTx);

        // Counter-sign taker checkpoints (index > 0)
        if (i > 0) {
          const signed = await this.wallet.identity.sign(serverTx, [0]);
          return base64.encode(signed.toPSBT());
        }
        return base64.encode(serverTx.toPSBT());
      })
    );

    await this.arkProvider.finalizeTx(arkTxid, finalCheckpoints);

    return { txid: arkTxid };
  }
}
```

- [ ] **Step 2: Export from index**

Update `packages/banco/src/index.ts`:

```ts
export { BancoSwap, type BancoSwapParams } from "./contract.js";
export { Offer } from "./offer.js";
export { Maker, type OfferStatus, type CreateOfferParams } from "./maker.js";
export { Taker } from "./taker.js";
```

- [ ] **Step 3: Verify it compiles**

Run: `cd /Users/louis/Code/ts-sdk/packages/banco && npx tsc --noEmit`
Expected: No errors

---

### Task 6: Update the CLI to use the library

**Files:**
- Modify: `examples/banco/package.json`
- Rewrite: `examples/banco/src/index.ts`
- Delete: `examples/banco/src/contract/banco.ts`

- [ ] **Step 1: Add library dependency to CLI**

Edit `examples/banco/package.json` — add `@arkade-os/banco` to dependencies:

```json
{
  "name": "@arkade-os/banco-cli",
  "version": "0.0.1",
  "private": true,
  "description": "Banco CLI using @arkade-os/banco",
  "type": "module",
  "bin": {
    "banco": "src/index.ts"
  },
  "scripts": {
    "build": "tsc",
    "start": "tsx src/index.ts",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "@arkade-os/banco": "workspace:*",
    "@arkade-os/sdk": "workspace:*",
    "eventsource": "4.0.0"
  },
  "devDependencies": {
    "@types/node": "24.3.1",
    "tsx": "4.21.0",
    "typescript": "5.9.2"
  },
  "packageManager": "pnpm@10.25.0",
  "engines": {
    "node": ">=22.12.0 <23",
    "pnpm": ">=10.25.0 <11"
  }
}
```

- [ ] **Step 2: Rewrite `examples/banco/src/index.ts` as a thin CLI**

```ts
#!/usr/bin/env tsx
import { EventSource } from "eventsource";
(globalThis as any).EventSource = EventSource;

import * as fs from "node:fs";
import * as path from "node:path";
import {
  SingleKey,
  Wallet,
  InMemoryWalletRepository,
  InMemoryContractRepository,
} from "@arkade-os/sdk";
import { Maker, Taker, Offer } from "@arkade-os/banco";

// ── ANSI helpers ──────────────────────────────────────────────────────────

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

const bold = (s: string) => `${BOLD}${s}${RESET}`;
const dim = (s: string) => `${DIM}${s}${RESET}`;
const green = (s: string) => `${GREEN}${s}${RESET}`;
const red = (s: string) => `${RED}${s}${RESET}`;

function banner() {
  console.log(
    `\n${BOLD}${CYAN}  banco${RESET} ${dim("— peer-to-peer arkade swaps")}\n`
  );
}

function formatSats(sats: bigint | number): string {
  return Number(sats).toLocaleString("en-US");
}

// ── Spinner ───────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function spinner(msg: string): { stop: (result?: string) => void } {
  let i = 0;
  const id = setInterval(() => {
    process.stderr.write(
      `\r${DIM}${SPINNER_FRAMES[i++ % SPINNER_FRAMES.length]}${RESET} ${msg}`
    );
  }, 80);
  return {
    stop(result?: string) {
      clearInterval(id);
      process.stderr.write(`\r${green("✓")} ${msg}`);
      if (result) process.stderr.write(` ${dim(result)}`);
      process.stderr.write("\n");
    },
  };
}

// ── Config ────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(
  process.env.HOME ?? ".",
  ".banco",
  "config.json"
);

interface Config {
  serverUrl: string;
  introspectorUrl: string;
  network: string;
  privateKey: string;
}

function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(
      `\n  ${red("Error:")} Not initialized.\n  Run ${bold("banco init")} first.\n`
    );
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

function saveConfig(config: Config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ── Arg parsing ───────────────────────────────────────────────────────────

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!key?.startsWith("--") || !value) {
      fatal(`Unexpected argument: ${key ?? "(empty)"}`);
    }
    result[key.slice(2)] = value;
  }
  return result;
}

function requireArg(opts: Record<string, string>, key: string): string {
  const value = opts[key];
  if (!value) fatal(`Missing required argument: ${bold("--" + key)}`);
  return value;
}

function fatal(msg: string): never {
  console.error(`\n  ${red("Error:")} ${msg}\n`);
  process.exit(1);
}

// ── Wallet factory ────────────────────────────────────────────────────────

function createWallet(privkey: string, serverUrl: string) {
  return Wallet.create({
    identity: SingleKey.fromHex(privkey),
    arkServerUrl: serverUrl,
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
  });
}

// ── Commands ──────────────────────────────────────────────────────────────

async function init(args: string[]) {
  const opts = parseArgs(args);
  const serverUrl = requireArg(opts, "server-url");
  const introspectorUrl = requireArg(opts, "introspector-url");

  const privkey = SingleKey.fromRandomBytes().toHex();

  const config: Config = {
    serverUrl,
    introspectorUrl,
    network: "regtest",
    privateKey: privkey,
  };

  saveConfig(config);

  console.log();
  console.log(`  ${dim("Server")}        ${serverUrl}`);
  console.log(`  ${dim("Introspector")}  ${introspectorUrl}`);
  console.log(`  ${dim("Config")}        ${CONFIG_PATH}`);
  console.log(`\n  ${green("Ready.")}\n`);
}

async function make(args: string[]) {
  const config = loadConfig();
  const opts = parseArgs(args);
  const wantAmount = BigInt(requireArg(opts, "want-amount"));
  const wantAsset = opts["want-asset"];
  const cancelDelay = opts["cancel-delay"]
    ? Number(opts["cancel-delay"])
    : undefined;

  const s = spinner("Creating wallet");
  const wallet = await createWallet(config.privateKey, config.serverUrl);
  s.stop();

  const maker = new Maker(wallet, config.serverUrl, config.introspectorUrl);

  const s2 = spinner("Building swap offer");
  const { offer, swapAddress } = await maker.createOffer({
    wantAmount,
    wantAsset,
    cancelDelay,
  });
  s2.stop();

  const decoded = Offer.fromHex(offer);
  const wantLabel = decoded.wantAsset ?? "BTC";

  console.log();
  console.log(`  ${dim("Swap address")}  ${swapAddress}`);
  console.log(
    `  ${dim("Wants")}         ${bold(formatSats(decoded.wantAmount))} sats ${dim("(" + wantLabel + ")")}`
  );
  console.log(
    `\n  Send your offer amount to the swap address,`
  );
  console.log(`  then share the offer below with a taker.\n`);
  console.log(dim("  ── offer (copy this) ──────────────────────"));
  console.log(`\n  ${offer}\n`);
}

async function take(args: string[]) {
  const config = loadConfig();
  const opts = parseArgs(args);
  const offerHex = requireArg(opts, "offer");

  const s = spinner("Creating wallet");
  const wallet = await createWallet(config.privateKey, config.serverUrl);
  s.stop();

  const taker = new Taker(wallet, config.serverUrl, config.introspectorUrl);

  const s2 = spinner("Fulfilling swap");
  const { txid } = await taker.fulfill(offerHex);
  s2.stop(txid);

  console.log(`\n  ${green("Swap complete!")} ${dim("txid:")} ${txid}\n`);
}

async function status(args: string[]) {
  const config = loadConfig();
  const opts = parseArgs(args);
  const address = requireArg(opts, "address");

  const wallet = await createWallet(config.privateKey, config.serverUrl);
  const maker = new Maker(wallet, config.serverUrl, config.introspectorUrl);

  const s = spinner("Querying offers");
  const offers = await maker.getOffers(address);
  s.stop(`${offers.length} VTXO(s)`);

  if (offers.length === 0) {
    console.log(`\n  No VTXOs at this address.\n`);
    return;
  }

  for (const o of offers) {
    console.log(
      `  ${dim(o.txid + ":" + o.vout)}  ${bold(formatSats(o.value))} sats  ${o.spendable ? green("spendable") : red("spent")}`
    );
    if (o.assets && o.assets.length > 0) {
      for (const a of o.assets) {
        console.log(`    ${dim("asset")} ${a.assetId.slice(0, 16)}... × ${a.amount}`);
      }
    }
  }
  console.log();
}

async function cancel(args: string[]) {
  const config = loadConfig();
  const opts = parseArgs(args);
  const offerHex = requireArg(opts, "offer");

  const s = spinner("Creating wallet");
  const wallet = await createWallet(config.privateKey, config.serverUrl);
  s.stop();

  const maker = new Maker(wallet, config.serverUrl, config.introspectorUrl);

  const s2 = spinner("Cancelling offer");
  const txid = await maker.cancelOffer(offerHex);
  s2.stop(txid);

  console.log(`\n  ${green("Offer cancelled.")} ${dim("txid:")} ${txid}\n`);
}

// ── Help ──────────────────────────────────────────────────────────────────

function help() {
  banner();
  console.log(`  ${bold("COMMANDS")}\n`);
  console.log(
    `    ${bold("init")}     Configure server and introspector endpoints`
  );
  console.log(`    ${bold("make")}     Create a new swap offer`);
  console.log(`    ${bold("take")}     Accept an existing swap offer`);
  console.log(`    ${bold("status")}   Check VTXOs at a swap address`);
  console.log(`    ${bold("cancel")}   Cancel an existing swap offer`);
  console.log(`    ${bold("help")}     Show this help message`);

  console.log(`\n  ${bold("USAGE")}\n`);
  console.log(
    `    ${dim("$")} banco init --server-url ${dim("<url>")} --introspector-url ${dim("<url>")}`
  );
  console.log(
    `    ${dim("$")} banco make --want-amount ${dim("<sats>")} [--want-asset ${dim("<txid:vout>")}] [--cancel-delay ${dim("<secs>")}]`
  );
  console.log(`    ${dim("$")} banco take --offer ${dim("<hex>")}`);
  console.log(`    ${dim("$")} banco status --address ${dim("<swap-address>")}`);
  console.log(`    ${dim("$")} banco cancel --offer ${dim("<hex>")}`);
  console.log();
}

// ── Main ──────────────────────────────────────────────────────────────────

const [, , cmd, ...cmdArgs] = process.argv;

function run(fn: (args: string[]) => Promise<void>) {
  fn(cmdArgs)
    .then(() => process.exit(0))
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`\n  ${red("Error:")} ${msg}\n`);
      process.exit(1);
    });
}

switch (cmd) {
  case "init":
    run(init);
    break;
  case "make":
    run(make);
    break;
  case "take":
    run(take);
    break;
  case "status":
    run(status);
    break;
  case "cancel":
    run(cancel);
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    help();
    break;
  default:
    console.error(`\n  ${red("Unknown command:")} ${cmd}`);
    help();
    process.exit(1);
}
```

- [ ] **Step 3: Delete old contract file**

Remove `examples/banco/src/contract/banco.ts` and the empty `examples/banco/src/contract/` directory.

- [ ] **Step 4: Install deps and verify**

Run: `cd /Users/louis/Code/ts-sdk && pnpm install`
Expected: Resolves workspace links, no errors

Run: `cd /Users/louis/Code/ts-sdk/examples/banco && npx tsc --noEmit`
Expected: No errors

---

### Task 7: Update the e2e test to use the library

**Files:**
- Modify: `test/e2e/banco.test.ts`

- [ ] **Step 1: Rewrite `test/e2e/banco.test.ts` to use `Maker` and `Taker`**

The test should use `Maker.createOffer()` and `Taker.fulfill()` instead of manually building transactions. This validates the library end-to-end.

```ts
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { hex } from "@scure/base";
import {
  ArkAddress,
  networks,
  RestArkProvider,
  RestIndexerProvider,
  RestIntrospectorProvider,
  SingleKey,
} from "../../src";
import { Maker, Taker, Offer } from "../../packages/banco/src";
import {
  beforeEachFaucet,
  createTestArkWallet,
  faucetOffchain,
} from "./utils";

const ARK_SERVER_URL = "http://localhost:7070";
const INTROSPECTOR_URL = "http://localhost:7073";

describe("banco", () => {
  const indexer = new RestIndexerProvider(ARK_SERVER_URL);

  beforeEach(beforeEachFaucet, 20000);

  async function waitForVtxo(
    pkScript: Uint8Array,
    expectedCount = 1,
    timeout = 15000
  ) {
    let vtxos: any[] = [];
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const resp = await indexer.getVtxos({
        scripts: [hex.encode(pkScript)],
        spendableOnly: true,
      });
      vtxos = resp.vtxos;
      if (vtxos.length >= expectedCount) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return vtxos;
  }

  it(
    "swap asset for BTC: maker sells asset, taker pays 10k sats",
    { timeout: 120000 },
    async () => {
      // ── Setup ──
      const makerWallet = await createTestArkWallet();
      const takerWallet = await createTestArkWallet();

      const makerAddress = await makerWallet.wallet.getAddress();
      const takerAddress = await takerWallet.wallet.getAddress();

      // ── Step 1: Maker issues an asset ──
      const assetAmount = 1000;
      faucetOffchain(makerAddress, 20_000);
      await new Promise((r) => setTimeout(r, 1000));

      const issueResult = await makerWallet.wallet.assetManager.issue({
        amount: assetAmount,
      });
      expect(issueResult.assetId).toBeDefined();
      await new Promise((r) => setTimeout(r, 2000));

      // ── Step 2: Maker creates offer via library ──
      const maker = new Maker(
        makerWallet.wallet,
        ARK_SERVER_URL,
        INTROSPECTOR_URL
      );

      const wantAmount = 10_000n;
      const { offer: offerHex, swapAddress } = await maker.createOffer({
        wantAmount,
        cancelDelay: 86400, // 24h
      });

      // ── Step 3: Maker sends asset to swap address ──
      await makerWallet.wallet.send({
        address: swapAddress,
        amount: 0,
        assets: [
          { assetId: issueResult.assetId, amount: assetAmount },
        ],
      });
      await new Promise((r) => setTimeout(r, 2000));

      // Verify swap VTXO exists
      const offerData = Offer.fromHex(offerHex);
      const swapDecoded = ArkAddress.decode(swapAddress);
      const swapVtxos = await waitForVtxo(swapDecoded.pkScript);
      expect(swapVtxos).toHaveLength(1);

      // ── Step 4: Fund the taker with 10k sats BTC ──
      faucetOffchain(takerAddress, Number(wantAmount));
      await new Promise((r) => setTimeout(r, 1000));

      // ── Step 5: Taker fulfills the offer via library ──
      const taker = new Taker(
        takerWallet.wallet,
        ARK_SERVER_URL,
        INTROSPECTOR_URL
      );

      const { txid } = await taker.fulfill(offerHex);
      expect(txid).toBeDefined();

      // ── Step 6: Verify results ──
      await new Promise((r) => setTimeout(r, 2000));

      const makerDecoded = ArkAddress.decode(makerAddress);
      const makerFinalVtxos = await waitForVtxo(makerDecoded.pkScript, 2);
      const makerBtcReceived = makerFinalVtxos.reduce(
        (s: number, v: any) => s + v.value,
        0
      );
      expect(makerBtcReceived).toBeGreaterThanOrEqual(Number(wantAmount));

      const takerDecoded = ArkAddress.decode(takerAddress);
      const takerFinalVtxos = await waitForVtxo(takerDecoded.pkScript, 1);
      const takerAssets = takerFinalVtxos.flatMap(
        (v: any) => v.assets ?? []
      );
      const takerAsset = takerAssets.find(
        (a: any) => a.assetId === issueResult.assetId
      );
      expect(takerAsset).toBeDefined();
      expect(takerAsset!.amount).toBe(assetAmount);

      console.log(
        `Swap complete: maker got ${makerBtcReceived} sats BTC, ` +
          `taker got ${assetAmount} units of asset ${issueResult.assetId.slice(0, 16)}... ` +
          `(txid: ${txid})`
      );
    }
  );
});
```

- [ ] **Step 2: Verify the test compiles**

Run: `cd /Users/louis/Code/ts-sdk && npx tsc --noEmit --project tsconfig.json`
Expected: No type errors

---

### Task 8: Verify everything compiles and unit tests pass

**Files:** None (verification only)

- [ ] **Step 1: Full pnpm install**

Run: `cd /Users/louis/Code/ts-sdk && pnpm install`
Expected: No errors

- [ ] **Step 2: Type-check the library**

Run: `cd /Users/louis/Code/ts-sdk/packages/banco && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Type-check the CLI**

Run: `cd /Users/louis/Code/ts-sdk/examples/banco && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run unit tests**

Run: `cd /Users/louis/Code/ts-sdk && npx vitest run test/unit/banco/offer.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Delete the script test file (superseded)**

Delete `examples/banco/scripts/test-asset-swap.ts` — the e2e test now covers this via the library.

---
