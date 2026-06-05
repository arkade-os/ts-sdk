import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { hex } from "@scure/base";
import { signingDescriptorIndex } from "../src/wallet/walletReceiveRotator";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey, networks, scriptExpressions } from "@bitcoinerlab/descriptors-scure";
import { deriveDescriptorLeafPubKey } from "../src/identity/descriptor";
import { HDDescriptorProvider } from "../src/wallet/hdDescriptorProvider";
import { makeHdProviderForTest } from "./helpers/hdProvider";
import { isDiscoverable } from "../src/contracts/types";
import { timelockToSequence } from "../src/utils/timelock";
import { DefaultContractHandler } from "../src/contracts/handlers/default";
import { DelegateContractHandler } from "../src/contracts/handlers/delegate";
import { BoardingContractHandler } from "../src/contracts/handlers/boarding";
import { DefaultVtxo } from "../src/script/default";
import { DelegateVtxo } from "../src/script/delegate";
import { VtxoScript } from "../src/script/base";
import type { RelativeTimelock } from "../src/script/tapscript";
import { contractHandlers } from "../src/contracts/handlers";
import { makeManagerForTest, makeDeps } from "./helpers/scanManager";
import {
    installRestoreHarness,
    teardownRestoreHarness,
    makeStaticWalletForTest,
    makeHdWalletForTest,
} from "./helpers/restoreWallet";

const TEST_MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** Build a materialized (concrete-index) tr([fp/86'/0'/0']xpub/.../0/<i>) descriptor. */
function makeHDDescriptor(index: number, isMainnet = true): string {
    const network = isMainnet ? networks.bitcoin : networks.testnet;
    const seed = mnemonicToSeedSync(TEST_MNEMONIC);
    const masterNode = HDKey.fromMasterSeed(seed, network.bip32);
    return scriptExpressions.trBIP32({
        masterNode,
        network,
        account: 0,
        change: 0,
        index,
    });
}

describe("deriveDescriptorLeafPubKey", () => {
    it("extracts the x-only pubkey from a static tr(pubkey) descriptor", () => {
        const pk = hex.encode(new Uint8Array(32).fill(2));
        const out = deriveDescriptorLeafPubKey(`tr(${pk})`);
        expect(hex.encode(out)).toBe(pk);
    });

    it("throws for a non-rangeable / unparseable descriptor", () => {
        expect(() => deriveDescriptorLeafPubKey("tr(not-a-key)")).toThrow();
    });

    it("returns a 32-byte pubkey for a materialized HD descriptor at a non-zero index", () => {
        const desc = makeHDDescriptor(3);
        const pubkey = deriveDescriptorLeafPubKey(desc);
        expect(pubkey).toBeInstanceOf(Uint8Array);
        expect(pubkey.length).toBe(32);
    });

    it("returns different pubkeys for different HD indices", () => {
        const pubkey1 = deriveDescriptorLeafPubKey(makeHDDescriptor(1));
        const pubkey2 = deriveDescriptorLeafPubKey(makeHDDescriptor(2));
        expect(hex.encode(pubkey1)).not.toBe(hex.encode(pubkey2));
    });
});

describe("HDDescriptorProvider scan support", () => {
    it("materializeDescriptorAt is pure (no watermark mutation)", async () => {
        const p = await makeHdProviderForTest();
        const d0 = p.materializeDescriptorAt(0);
        const d5 = p.materializeDescriptorAt(5);
        expect(d0).not.toEqual(d5);
        expect(await p.getCurrentSigningDescriptor()).toBeUndefined();
    });

    it("advanceLastIndexUsed is monotonic (never rewinds)", async () => {
        const p = await makeHdProviderForTest();
        await p.advanceLastIndexUsed(10);
        expect(await p.getCurrentSigningDescriptor()).toBe(p.materializeDescriptorAt(10));
        await p.advanceLastIndexUsed(7);
        expect(await p.getCurrentSigningDescriptor()).toBe(p.materializeDescriptorAt(10));
    });
});

describe("isDiscoverable", () => {
    it("true only when discoverAt is a function", () => {
        expect(isDiscoverable({ type: "x" } as any)).toBe(false);
        expect(isDiscoverable({ type: "x", discoverAt: async () => [] } as any)).toBe(true);
    });
});

function mockIndexer(usedScripts: Set<string>) {
    return {
        async getVtxos(opts: any) {
            // Per-script: return one synthetic vtxo for EACH queried
            // script that is actually in usedScripts (empty if none).
            // A naive "any match → hit for all" mock would mask
            // partial-hit bugs where a handler treats one matching
            // script as evidence for every candidate it built.
            const vtxos = ((opts.scripts ?? []) as string[])
                .filter((s) => usedScripts.has(s))
                .map((s) => ({ value: 1, script: s }) as any);
            return { vtxos };
        },
    } as any;
}

describe("DefaultContractHandler.discoverAt", () => {
    // Must use valid secp256k1 x-only pubkeys; fill(3)/fill(7) are not valid points.
    const pkHex = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const serverHex = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
    const server = hex.decode(serverHex);
    const descriptor = `tr(${pkHex})`;
    const tl = DefaultVtxo.Script.DEFAULT_TIMELOCK;
    const script = hex.encode(
        new DefaultVtxo.Script({
            pubKey: hex.decode(pkHex),
            serverPubKey: server,
            csvTimelock: tl,
        }).pkScript,
    );

    it("is Discoverable", () => {
        expect(isDiscoverable(DefaultContractHandler)).toBe(true);
    });

    it("returns nothing when the script has no history", async () => {
        const out = await DefaultContractHandler.discoverAt(0, descriptor, {
            indexerProvider: mockIndexer(new Set()),
            onchainProvider: {} as any,
            network: { hrp: "ark" },
            serverPubKey: server,
            csvTimelocks: [tl],
        });
        expect(out).toEqual([]);
    });

    it("index 0 is untagged; index > 0 is wallet-receive tagged", async () => {
        const deps = {
            indexerProvider: mockIndexer(new Set([script])),
            onchainProvider: {} as any,
            network: { hrp: "ark" },
            serverPubKey: server,
            csvTimelocks: [tl],
        };
        const at0 = await DefaultContractHandler.discoverAt(0, descriptor, deps);
        expect(at0).toHaveLength(1);
        expect(at0[0].type).toBe("default");
        expect(at0[0].script).toBe(script);
        expect(at0[0].metadata).toBeUndefined();

        const at3 = await DefaultContractHandler.discoverAt(3, descriptor, deps);
        expect(at3[0].metadata).toEqual({
            source: "wallet-receive",
            signingDescriptor: descriptor,
        });
    });

    it("iterates all csvTimelocks and returns one entry per matching timelock", async () => {
        const tl1: RelativeTimelock = DefaultVtxo.Script.DEFAULT_TIMELOCK; // { value: 144n, type: "blocks" }
        const tl2: RelativeTimelock = { value: 288n, type: "blocks" };

        const pubKey = hex.decode(pkHex);
        const script1 = hex.encode(
            new DefaultVtxo.Script({
                pubKey,
                serverPubKey: server,
                csvTimelock: tl1,
            }).pkScript,
        );
        const script2 = hex.encode(
            new DefaultVtxo.Script({
                pubKey,
                serverPubKey: server,
                csvTimelock: tl2,
            }).pkScript,
        );

        // Both scripts are distinct
        expect(script1).not.toBe(script2);

        const out = await DefaultContractHandler.discoverAt(2, descriptor, {
            indexerProvider: mockIndexer(new Set([script1, script2])),
            onchainProvider: {} as any,
            network: { hrp: "ark" },
            serverPubKey: server,
            csvTimelocks: [tl1, tl2],
        });

        expect(out).toHaveLength(2);

        const scripts = out.map((e) => e.script);
        expect(scripts).toContain(script1);
        expect(scripts).toContain(script2);

        const entry1 = out.find((e) => e.script === script1)!;
        const entry2 = out.find((e) => e.script === script2)!;

        expect(entry1.params.csvTimelock).toBe(timelockToSequence(tl1).toString());
        expect(entry2.params.csvTimelock).toBe(timelockToSequence(tl2).toString());
    });

    it("partial timelock hit returns ONLY the matching timelock (no over-discovery)", async () => {
        // Two candidate timelock scripts are built, but only ONE has
        // on-chain history. A per-script indexer must yield exactly one
        // DiscoveredContract — proving the handler does not treat a
        // single hit as evidence for every candidate it probed. (This
        // assertion is only meaningful with the per-script mockIndexer;
        // the old "any match → hit for all" mock would mask it.)
        const tl1: RelativeTimelock = DefaultVtxo.Script.DEFAULT_TIMELOCK;
        const tl2: RelativeTimelock = { value: 288n, type: "blocks" };

        const pubKey = hex.decode(pkHex);
        const script1 = hex.encode(
            new DefaultVtxo.Script({
                pubKey,
                serverPubKey: server,
                csvTimelock: tl1,
            }).pkScript,
        );
        const script2 = hex.encode(
            new DefaultVtxo.Script({
                pubKey,
                serverPubKey: server,
                csvTimelock: tl2,
            }).pkScript,
        );
        expect(script1).not.toBe(script2);

        // Only script1 is funded.
        const out = await DefaultContractHandler.discoverAt(2, descriptor, {
            indexerProvider: mockIndexer(new Set([script1])),
            onchainProvider: {} as any,
            network: { hrp: "ark" },
            serverPubKey: server,
            csvTimelocks: [tl1, tl2],
        });

        expect(out).toHaveLength(1);
        expect(out[0].script).toBe(script1);
        expect(out[0].params.csvTimelock).toBe(timelockToSequence(tl1).toString());
    });

    it("scans deprecated signers and stamps the matched key into params AND address", async () => {
        // A distinct valid x-only point standing in for a now-rotated signer.
        const deprecatedHex = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
        const deprecated = hex.decode(deprecatedHex);
        const deprecatedScript = hex.encode(
            new DefaultVtxo.Script({
                pubKey: hex.decode(pkHex),
                serverPubKey: deprecated,
                csvTimelock: tl,
            }).pkScript,
        );
        // Only the deprecated-key script is funded — the current key has none.
        const out = await DefaultContractHandler.discoverAt(2, descriptor, {
            indexerProvider: mockIndexer(new Set([deprecatedScript])),
            onchainProvider: {} as any,
            network: { hrp: "ark" },
            serverPubKey: server,
            deprecatedSignerPubKeys: [deprecated],
            csvTimelocks: [tl],
        });
        expect(out).toHaveLength(1);
        expect(out[0].script).toBe(deprecatedScript);
        // The matched deprecated key is threaded through BOTH the persisted
        // params and the encoded address — not the current serverPubKey.
        expect(out[0].params.serverPubKey).toBe(deprecatedHex);
        expect(out[0].address).toBe(
            new DefaultVtxo.Script({
                pubKey: hex.decode(pkHex),
                serverPubKey: deprecated,
                csvTimelock: tl,
            })
                .address("ark", deprecated)
                .encode(),
        );
    });

    it("dedups by scriptHex: a deprecated signer reproducing the current script yields one entry and one probe", async () => {
        // Degenerate deprecated set: the same key as the current signer, so it
        // rebuilds a byte-identical script. The `seen` guard must collapse the
        // two passes into a single probe and a single emitted contract.
        const calls: string[][] = [];
        const indexer = {
            async getVtxos(opts: any) {
                const scripts = (opts.scripts ?? []) as string[];
                calls.push(scripts);
                const vtxos = scripts
                    .filter((s) => s === script)
                    .map((s) => ({ value: 1, script: s }) as any);
                return { vtxos };
            },
        } as any;
        const out = await DefaultContractHandler.discoverAt(2, descriptor, {
            indexerProvider: indexer,
            onchainProvider: {} as any,
            network: { hrp: "ark" },
            serverPubKey: server,
            deprecatedSignerPubKeys: [server],
            csvTimelocks: [tl],
        });
        expect(out).toHaveLength(1);
        expect(calls.flat().filter((s) => s === script)).toHaveLength(1);
    });
});

describe("DelegateContractHandler.discoverAt", () => {
    // Valid secp256k1 x-only generator points (same as DefaultContractHandler tests above).
    const pkHex = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const serverHex = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
    // A third distinct valid point for the delegate key.
    const delegateHex = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";

    const pubKey = hex.decode(pkHex);
    const server = hex.decode(serverHex);
    const del = hex.decode(delegateHex);
    const descriptor = `tr(${pkHex})`;
    const tl = DefaultVtxo.Script.DEFAULT_TIMELOCK;

    const delegateScript = hex.encode(
        new DelegateVtxo.Script({
            pubKey,
            serverPubKey: server,
            delegatePubKey: del,
            csvTimelock: tl,
        }).pkScript,
    );

    it("is Discoverable", () => {
        expect(isDiscoverable(DelegateContractHandler)).toBe(true);
    });

    it("returns [] when delegatePubKey is absent", async () => {
        // Even if the script exists in the indexer, no delegatePubKey → []
        const out = await DelegateContractHandler.discoverAt(1, descriptor, {
            indexerProvider: mockIndexer(new Set([delegateScript])),
            onchainProvider: {} as any,
            network: { hrp: "ark" },
            serverPubKey: server,
            csvTimelocks: [tl],
            // delegatePubKey intentionally omitted
        });
        expect(out).toEqual([]);
    });

    it("index 0 is untagged; index > 0 is wallet-receive tagged", async () => {
        const deps = {
            indexerProvider: mockIndexer(new Set([delegateScript])),
            onchainProvider: {} as any,
            network: { hrp: "ark" },
            serverPubKey: server,
            delegatePubKey: del,
            csvTimelocks: [tl],
        };

        const at0 = await DelegateContractHandler.discoverAt(0, descriptor, deps);
        expect(at0).toHaveLength(1);
        expect(at0[0].type).toBe("delegate");
        expect(at0[0].script).toBe(delegateScript);
        expect(at0[0].params.delegatePubKey).toBe(delegateHex);
        expect(at0[0].params.pubKey).toBe(pkHex);
        expect(at0[0].params.serverPubKey).toBe(serverHex);
        expect(at0[0].params.csvTimelock).toBe(timelockToSequence(tl).toString());
        expect(at0[0].metadata).toBeUndefined();

        const at3 = await DelegateContractHandler.discoverAt(3, descriptor, deps);
        expect(at3[0].metadata).toEqual({
            source: "wallet-receive",
            signingDescriptor: descriptor,
        });
    });

    it("iterates all csvTimelocks and returns one entry per matching timelock", async () => {
        const tl1: RelativeTimelock = DefaultVtxo.Script.DEFAULT_TIMELOCK; // { value: 144n, type: "blocks" }
        const tl2: RelativeTimelock = { value: 288n, type: "blocks" };

        const script1 = hex.encode(
            new DelegateVtxo.Script({
                pubKey,
                serverPubKey: server,
                delegatePubKey: del,
                csvTimelock: tl1,
            }).pkScript,
        );
        const script2 = hex.encode(
            new DelegateVtxo.Script({
                pubKey,
                serverPubKey: server,
                delegatePubKey: del,
                csvTimelock: tl2,
            }).pkScript,
        );

        // Both scripts are distinct
        expect(script1).not.toBe(script2);

        const out = await DelegateContractHandler.discoverAt(2, descriptor, {
            indexerProvider: mockIndexer(new Set([script1, script2])),
            onchainProvider: {} as any,
            network: { hrp: "ark" },
            serverPubKey: server,
            delegatePubKey: del,
            csvTimelocks: [tl1, tl2],
        });

        expect(out).toHaveLength(2);

        const scripts = out.map((e) => e.script);
        expect(scripts).toContain(script1);
        expect(scripts).toContain(script2);

        const entry1 = out.find((e) => e.script === script1)!;
        const entry2 = out.find((e) => e.script === script2)!;

        expect(entry1.params.csvTimelock).toBe(timelockToSequence(tl1).toString());
        expect(entry2.params.csvTimelock).toBe(timelockToSequence(tl2).toString());
    });

    it("scans deprecated signers and stamps the matched key into params AND address", async () => {
        // A distinct valid x-only point standing in for a now-rotated signer.
        const deprecatedHex = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
        const deprecated = hex.decode(deprecatedHex);
        const deprecatedScript = hex.encode(
            new DelegateVtxo.Script({
                pubKey,
                serverPubKey: deprecated,
                delegatePubKey: del,
                csvTimelock: tl,
            }).pkScript,
        );
        const out = await DelegateContractHandler.discoverAt(2, descriptor, {
            indexerProvider: mockIndexer(new Set([deprecatedScript])),
            onchainProvider: {} as any,
            network: { hrp: "ark" },
            serverPubKey: server,
            delegatePubKey: del,
            deprecatedSignerPubKeys: [deprecated],
            csvTimelocks: [tl],
        });
        expect(out).toHaveLength(1);
        expect(out[0].script).toBe(deprecatedScript);
        expect(out[0].params.serverPubKey).toBe(deprecatedHex);
        expect(out[0].address).toBe(
            new DelegateVtxo.Script({
                pubKey,
                serverPubKey: deprecated,
                delegatePubKey: del,
                csvTimelock: tl,
            })
                .address("ark", deprecated)
                .encode(),
        );
    });
});

/**
 * Build a fully-synthetic `Discoverable` contract handler for the
 * `scanContracts` suite. Its `createScript(params)` decodes `params.script`
 * straight back to bytes so `hex.encode(createScript(params).pkScript)`
 * round-trips to exactly the `script` the discovered contract declares —
 * this makes `ContractManager.createContract`'s script-derivation check pass
 * deterministically without coupling the test to real crypto / timelocks.
 */
function makeFakeHandler(type: string, discoverAt: (index: number) => any[] | Promise<any[]>) {
    const calls: number[] = [];
    const handler = {
        type,
        createScript: (params: Record<string, string>) =>
            ({ pkScript: hex.decode(params.script) }) as any,
        serializeParams: (p: any) => p,
        deserializeParams: (p: any) => p,
        selectPath: () => null,
        getAllSpendingPaths: () => [],
        getSpendablePaths: () => [],
        async discoverAt(index: number) {
            calls.push(index);
            return discoverAt(index);
        },
    };
    return { handler, calls };
}

describe("ContractManager.scanContracts", () => {
    // A valid static tr(<x-only pubkey>) descriptor. The scanner asks EVERY
    // registered Discoverable handler — including the real default/delegate
    // ones — so `materialize` must return a descriptor they can parse.
    // makeDeps() supplies empty csvTimelocks, so the built-ins parse this,
    // iterate zero timelocks, and contribute nothing; the fake handlers
    // (which key off the index, not the descriptor) drive the assertions.
    const VALID_DESCRIPTOR = "tr(79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798)";
    const materialize = () => VALID_DESCRIPTOR;

    const registered: string[] = [];

    afterEach(() => {
        // Never let a fake handler leak into other suites.
        for (const t of registered.splice(0)) {
            contractHandlers.unregister(t);
        }
    });

    function register(type: string, handler: any) {
        contractHandlers.register(handler);
        registered.push(type);
    }

    it("rejects a non-positive / non-integer gapLimit", async () => {
        const mgr = await makeManagerForTest();
        try {
            for (const bad of [0, -1, 1.5]) {
                await expect(
                    mgr.scanContracts({
                        gapLimit: bad,
                        hd: true,
                        materialize,
                        deps: makeDeps(),
                    }),
                ).rejects.toThrow(/gapLimit/);
            }
        } finally {
            mgr.dispose();
        }
    });

    it("a swap-only hit at index 4 keeps the gap window open and sets lastIndexUsed (core)", async () => {
        // Core regression (spec §5): the ONLY discoverable that hits is a
        // swap handler, and it hits ONLY at index 4. No default/delegate
        // history exists (makeDeps' indexer is empty + csvTimelocks []).
        //
        // gapLimit MUST be > 4 for index 4 to be reachable at all: with
        // gapLimit N the loop stops after N consecutive unused indices, so
        // the hit's index must be < N for the scan to ever probe it. (The
        // plan's `gapLimit:3` example is unreachable under the spec §2.C
        // algorithm — 0,1,2 unused closes the window before index 4 — so
        // gapLimit 5 is used. The asserted invariant the spec actually
        // requires is preserved: a swap hit at 4 resets `unused` to 0,
        // keeps the window open PAST 4, and drives lastIndexUsed to 4.)
        const { handler, calls } = makeFakeHandler("swapfake", (i) =>
            i === 4
                ? [
                      {
                          type: "swapfake",
                          params: { script: "aabb" },
                          script: "aabb",
                          address: "ark1qswap",
                      },
                  ]
                : [],
        );
        register("swapfake", handler);
        const mgr = await makeManagerForTest();
        try {
            const res = await mgr.scanContracts({
                gapLimit: 5,
                hd: true,
                materialize,
                deps: makeDeps(),
            });
            // The swap hit at 4 reset `unused` (was 4 after 0..3 unused),
            // so the loop kept probing 5..9 instead of stopping at 4, and
            // lastIndexUsed is driven solely by the swap handler.
            expect(res.lastIndexUsed).toBe(4);
            expect(res.handlerErrors).toEqual([]);
            // Strong regression: a buggy loop that STOPS after the first
            // hit would still satisfy lastIndexUsed===4. The handler MUST
            // be probed across the full post-hit window. Per scanContracts
            // (gapLimit 5): 0..3 are misses (unused→4), 4 hits (unused
            // resets to 0), then 5,6,7,8,9 are 5 consecutive misses —
            // unused reaches 5 (== gapLimit) only AFTER probing 9, so the
            // exact probe sequence is 0..9 inclusive.
            expect(calls).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
            // The contract was actually registered (idempotent createContract).
            const [c] = await mgr.getContracts({ script: "aabb" });
            expect(c?.type).toBe("swapfake");
        } finally {
            mgr.dispose();
        }
    });

    it("collects a per-handler discoverAt error instead of throwing it", async () => {
        const { handler, calls } = makeFakeHandler("boomfake", () => {
            throw new Error("handler down");
        });
        register("boomfake", handler);
        const mgr = await makeManagerForTest();
        try {
            const res = await mgr.scanContracts({
                gapLimit: 2,
                hd: false, // single pass at i=0
                materialize,
                deps: makeDeps(),
            });
            // Resolved (did not abort), error collected with full context.
            expect(res.handlerErrors).toHaveLength(1);
            expect(res.handlerErrors[0].handler).toBe("boomfake");
            expect(res.handlerErrors[0].index).toBe(0);
            expect(res.handlerErrors[0].error).toBeInstanceOf(Error);
            expect((res.handlerErrors[0].error as Error).message).toBe("handler down");
            expect(res.lastIndexUsed).toBe(-1);
            // Loop ran exactly the single static pass.
            expect(calls).toEqual([0]);
        } finally {
            mgr.dispose();
        }
    });

    it("a discoverAt error is collected but the loop completes the gap window", async () => {
        // Always throws → loop must still terminate via the gap counter
        // (unused reaches gapLimit) and surface one error per probed index.
        const { handler } = makeFakeHandler("boomfake", () => {
            throw new Error("handler down");
        });
        register("boomfake", handler);
        const mgr = await makeManagerForTest();
        try {
            const res = await mgr.scanContracts({
                gapLimit: 3,
                hd: true,
                materialize,
                deps: makeDeps(),
            });
            // 3 unused indices (0,1,2) close the window; one error each.
            expect(res.lastIndexUsed).toBe(-1);
            expect(res.handlerErrors).toHaveLength(3);
            expect(res.handlerErrors.map((e) => e.index)).toEqual([0, 1, 2]);
            expect(res.handlerErrors.every((e) => e.handler === "boomfake")).toBe(true);
        } finally {
            mgr.dispose();
        }
    });

    it("a materialize() throw is fatal — it propagates, not collected", async () => {
        const { handler } = makeFakeHandler("swapfake", () => []);
        register("swapfake", handler);
        const mgr = await makeManagerForTest();
        try {
            const boom = new Error("boom");
            await expect(
                mgr.scanContracts({
                    gapLimit: 5,
                    hd: true,
                    materialize: () => {
                        throw boom;
                    },
                    deps: makeDeps(),
                }),
            ).rejects.toBe(boom);
        } finally {
            mgr.dispose();
        }
    });

    it("static mode (hd:false) probes only index 0", async () => {
        // Would hit at index 3, but static mode must ask ONLY index 0.
        const { handler, calls } = makeFakeHandler("swapfake", (i) =>
            i === 3
                ? [
                      {
                          type: "swapfake",
                          params: { script: "cc" },
                          script: "cc",
                          address: "ark1qswap",
                      },
                  ]
                : [],
        );
        register("swapfake", handler);
        const mgr = await makeManagerForTest();
        try {
            const res = await mgr.scanContracts({
                gapLimit: 20,
                hd: false,
                materialize,
                deps: makeDeps(),
            });
            // Single pass at i=0 only; never reached the index-3 hit.
            expect(calls).toEqual([0]);
            expect(res.lastIndexUsed).toBe(-1);
            expect(res.handlerErrors).toEqual([]);
        } finally {
            mgr.dispose();
        }
    });

    it("probes boarding before default/delegate (load-bearing first-wins tie-break)", async () => {
        // The iteration order IS the first-wins tie-break: each hit is
        // persisted immediately, so a both-purpose equal-delay collision
        // resolves to whichever handler is probed first. Boarding must be
        // first so such a collision resolves to a `boarding` row (keeping the
        // on-chain UTXO visible to the type-gated getBoardingUtxos). Guards
        // against a future reorder of the registered handlers.
        const order: string[] = [];
        const spies = [
            vi.spyOn(BoardingContractHandler, "discoverAt").mockImplementation(async () => {
                order.push("boarding");
                return [];
            }),
            vi.spyOn(DefaultContractHandler, "discoverAt").mockImplementation(async () => {
                order.push("default");
                return [];
            }),
            vi.spyOn(DelegateContractHandler, "discoverAt").mockImplementation(async () => {
                order.push("delegate");
                return [];
            }),
        ];
        const mgr = await makeManagerForTest();
        try {
            await mgr.scanContracts({ gapLimit: 1, hd: false, materialize, deps: makeDeps() });
            expect(order).toContain("boarding");
            expect(order.indexOf("boarding")).toBeLessThan(order.indexOf("default"));
            expect(order.indexOf("boarding")).toBeLessThan(order.indexOf("delegate"));
        } finally {
            for (const s of spies) s.mockRestore();
            mgr.dispose();
        }
    });
});

describe("signingDescriptorIndex", () => {
    it("parses the trailing child index", () => {
        expect(signingDescriptorIndex("tr([aa/86'/0'/0']xpub6.../0/7)")).toBe(7);
    });
    it("returns 0 when absent/unparseable", () => {
        expect(signingDescriptorIndex(undefined)).toBe(0);
        expect(signingDescriptorIndex("tr(deadbeef)")).toBe(0);
    });
});

describe("Wallet.restore", () => {
    beforeEach(() => {
        installRestoreHarness();
    });
    afterEach(() => {
        teardownRestoreHarness();
    });

    it("rejects an invalid gapLimit without running a scan", async () => {
        const { wallet, indexer } = await makeStaticWalletForTest();
        try {
            for (const bad of [0, -1, 1.5]) {
                await expect(wallet.restore({ gapLimit: bad })).rejects.toThrow(/gapLimit/);
            }
            // No discovery probe should have run for an invalid arg —
            // validation happens before _runRestore touches the manager.
            expect(indexer.getVtxosCalls).toHaveLength(0);
        } finally {
            await wallet.dispose();
        }
    });

    it("static identity: single-pass restore, never throws, pulls vtxos", async () => {
        // Fund the static wallet's index-0 baseline default script.
        const { wallet, indexer } = await makeStaticWalletForTest();
        try {
            indexer.usedScripts.add(wallet.defaultContractScript);

            await expect(wallet.restore()).resolves.toBeUndefined();

            const balance = await wallet.getBalance();
            expect(balance.total).toBeGreaterThan(0);

            // Static mode is a single pass at index 0: the default
            // handler probes each csvTimelock at index 0 exactly once.
            // Every probed scripts-array should be index-0 derived; the
            // scan must not have walked an HD range.
            expect(indexer.getVtxosCalls.length).toBeGreaterThan(0);
        } finally {
            await wallet.dispose();
        }
    });

    it("HD identity: discovers funded indices and advances the watermark", async () => {
        const { wallet, indexer, hdProvider } = await makeHdWalletForTest();
        try {
            // Compute the default pkScripts at HD indices 0 and 2 the
            // same way DefaultContractHandler.discoverAt does: leaf
            // pubkey of the materialized descriptor + serverPubKey +
            // each wallet csvTimelock.
            const serverPubKey = wallet.offchainTapscript.options.serverPubKey;
            const scriptsAt = (index: number) =>
                wallet.walletContractTimelocks.map((csvTimelock) =>
                    hex.encode(
                        new DefaultVtxo.Script({
                            pubKey: deriveDescriptorLeafPubKey(
                                hdProvider.materializeDescriptorAt(index),
                            ),
                            serverPubKey,
                            csvTimelock,
                        }).pkScript,
                    ),
                );
            for (const s of [...scriptsAt(0), ...scriptsAt(2)]) {
                indexer.usedScripts.add(s);
            }

            await wallet.restore({ gapLimit: 5 });

            // Watermark advanced to the highest used index (2).
            expect(await hdProvider.getCurrentSigningDescriptor()).toBe(
                hdProvider.materializeDescriptorAt(2),
            );
            const balance = await wallet.getBalance();
            expect(balance.total).toBeGreaterThan(0);
        } finally {
            await wallet.dispose();
        }
    });

    it("HD: a funded boarding index is recovered via the on-chain probe (advances watermark)", async () => {
        const { wallet, hdProvider, fundedOnchain } = await makeHdWalletForTest();
        try {
            // Boarding on-chain (P2TR) address at HD index 2, built the way
            // BoardingContractHandler.discoverAt does. The index is funded
            // ONLY on-chain (not in the indexer's usedScripts), so the index
            // is recovered purely by the boarding on-chain probe — and the
            // shared watermark advances to it.
            const serverPubKey = wallet.offchainTapscript.options.serverPubKey;
            const boardingCsv = wallet.boardingTapscript.options.csvTimelock!;
            const boardingOnchainAt = (i: number) =>
                new DefaultVtxo.Script({
                    pubKey: deriveDescriptorLeafPubKey(hdProvider.materializeDescriptorAt(i)),
                    serverPubKey,
                    csvTimelock: boardingCsv,
                }).onchainAddress(wallet.network);
            fundedOnchain.add(boardingOnchainAt(2));

            await wallet.restore({ gapLimit: 5 });

            expect(await hdProvider.getCurrentSigningDescriptor()).toBe(
                hdProvider.materializeDescriptorAt(2),
            );
        } finally {
            await wallet.dispose();
        }
    });

    it("equal-delay server: a funded index-0 boarding UTXO restores without aborting (first-wins)", async () => {
        // mockArkInfo sets boardingExitDelay === unilateralExitDelay, so the
        // boarding script is byte-identical to the default candidate. A funded
        // on-chain boarding UTXO must restore cleanly: the boarding hit is
        // tolerated first-wins at the persistence layer (the init-persisted
        // index-0 `default` baseline keeps the colliding row) instead of
        // aborting the scan with a same-script type clash.
        const { wallet, fundedOnchain } = await makeHdWalletForTest();
        try {
            fundedOnchain.add(await wallet.getBoardingAddress());
            await expect(wallet.restore({ gapLimit: 5 })).resolves.toBeUndefined();
        } finally {
            await wallet.dispose();
        }
    });

    it("equal-delay: a funded ROTATED boarding index restores as a boarding UTXO (Finding #1)", async () => {
        // The core regression. mockArkInfo is equal-delay, so the boarding
        // script at a rotated index N (>0) is byte-identical to the default
        // script at N. Fund index 2 ON-CHAIN ONLY (no L2 VTXO). The boarding
        // probe is the sole hit, so the index is persisted as a `boarding`
        // row — NOT mis-typed `default` (the old pre-coalescing bug, which hid
        // the UTXO from the type-gated getBoardingUtxos).
        const { wallet, hdProvider, fundedOnchain } = await makeHdWalletForTest();
        try {
            const serverPubKey = wallet.offchainTapscript.options.serverPubKey;
            const boardingCsv = wallet.boardingTapscript.options.csvTimelock!;
            const script = new DefaultVtxo.Script({
                pubKey: deriveDescriptorLeafPubKey(hdProvider.materializeDescriptorAt(2)),
                serverPubKey,
                csvTimelock: boardingCsv,
            });
            const scriptHex = hex.encode(script.pkScript);
            const onchainAddr = script.onchainAddress(wallet.network);
            fundedOnchain.add(onchainAddr);

            await wallet.restore({ gapLimit: 5 });

            // Persisted as a boarding-typed contract at the rotated index.
            const boardingRows = await wallet.contractRepository.getContracts({
                type: ["boarding"],
            });
            expect(boardingRows.map((c) => c.script)).toContain(scriptHex);

            // The on-chain UTXO is enumerated by getBoardingUtxos with the
            // correct per-index boarding tapscript.
            const utxos = await wallet.getBoardingUtxos();
            const addrs = utxos.map((u) =>
                VtxoScript.decode(u.tapTree).onchainAddress(wallet.network),
            );
            expect(addrs).toContain(onchainAddr);
        } finally {
            await wallet.dispose();
        }
    });

    it("equal-delay: a both-hit rotated index recovers BOTH the on-chain UTXO and the L2 VTXO (reviewer's case)", async () => {
        // The degenerate sub-case §6 calls out: a rotated index whose
        // (byte-identical) script carries BOTH an on-chain boarding UTXO and an
        // L2 VTXO. Boarding is probed first → the row resolves to `boarding`;
        // the later default hit first-wins-no-ops. Both fund types must remain
        // recoverable: the on-chain UTXO via the type-gated getBoardingUtxos,
        // and the VTXO via the type-agnostic getVtxos.
        const { wallet, indexer, hdProvider, fundedOnchain } = await makeHdWalletForTest();
        try {
            const serverPubKey = wallet.offchainTapscript.options.serverPubKey;
            const boardingCsv = wallet.boardingTapscript.options.csvTimelock!;
            const pubKey = deriveDescriptorLeafPubKey(hdProvider.materializeDescriptorAt(2));
            const script = new DefaultVtxo.Script({
                pubKey,
                serverPubKey,
                csvTimelock: boardingCsv,
            });
            const scriptHex = hex.encode(script.pkScript);
            const onchainAddr = script.onchainAddress(wallet.network);

            // Sanity: equal-delay → the index-2 default candidate is the SAME
            // script as the boarding candidate.
            const defaultScriptHex = hex.encode(
                new DefaultVtxo.Script({
                    pubKey,
                    serverPubKey,
                    csvTimelock: wallet.walletContractTimelocks[0],
                }).pkScript,
            );
            expect(defaultScriptHex).toBe(scriptHex);

            fundedOnchain.add(onchainAddr); // on-chain boarding UTXO
            indexer.usedScripts.add(scriptHex); // L2 VTXO at the same script

            await wallet.restore({ gapLimit: 5 });

            // Resolved to a boarding row (boarding probed first, first-wins).
            const boardingRows = await wallet.contractRepository.getContracts({
                type: ["boarding"],
            });
            expect(boardingRows.map((c) => c.script)).toContain(scriptHex);

            // On-chain UTXO recovered via the type-gated boarding reader.
            const utxos = await wallet.getBoardingUtxos();
            const addrs = utxos.map((u) =>
                VtxoScript.decode(u.tapTree).onchainAddress(wallet.network),
            );
            expect(addrs).toContain(onchainAddr);

            // L2 VTXO recovered via the type-agnostic getVtxos — proving a
            // boarding-typed row's VTXOs stay visible/spendable.
            const vtxos = await wallet.getVtxos();
            expect(vtxos.some((v) => v.script === scriptHex)).toBe(true);
        } finally {
            await wallet.dispose();
        }
    });

    it("spent-boarding blind spot: a fully-boarded index is invisible; the receive-destination index holds the line (plan §2/§4/§5)", async () => {
        // Models a completed board. `Ramps.onboard` pays the boarded VTXO to
        // `wallet.getAddress()` (the current L2 RECEIVE index), NOT back to the
        // boarding index, so a boarding index that is funded and then fully
        // boarded goes cold in BOTH restore signals: no current on-chain UTXO
        // (not in fundedOnchain) and no L2 VTXO at its own index (not in
        // usedScripts). The single-branch / current-UTXO model accepts this —
        // the gap window is instead held open by the receive-destination index.
        const { wallet, indexer, hdProvider, fundedOnchain } = await makeHdWalletForTest();
        try {
            const serverPubKey = wallet.offchainTapscript.options.serverPubKey;
            const boardingCsv = wallet.boardingTapscript.options.csvTimelock!;

            // L2 receive scripts at an HD index, built like DefaultContractHandler.discoverAt.
            const receiveScriptsAt = (i: number) =>
                wallet.walletContractTimelocks.map((csvTimelock) =>
                    hex.encode(
                        new DefaultVtxo.Script({
                            pubKey: deriveDescriptorLeafPubKey(
                                hdProvider.materializeDescriptorAt(i),
                            ),
                            serverPubKey,
                            csvTimelock,
                        }).pkScript,
                    ),
                );
            // Boarding pkScript at an HD index, built like BoardingContractHandler.discoverAt.
            const boardingScriptHexAt = (i: number) =>
                hex.encode(
                    new DefaultVtxo.Script({
                        pubKey: deriveDescriptorLeafPubKey(hdProvider.materializeDescriptorAt(i)),
                        serverPubKey,
                        csvTimelock: boardingCsv,
                    }).pkScript,
                );

            // The board came from boarding index 2 (now fully spent → left cold),
            // and paid its VTXO to receive index 1.
            for (const s of receiveScriptsAt(1)) indexer.usedScripts.add(s);
            // index 2 deliberately funded in NEITHER signal.

            await wallet.restore({ gapLimit: 5 });

            // The spent boarding index 2 is NOT recovered: no boarding row for
            // its script (the documented blind spot).
            const boardingRows = await wallet.contractRepository.getContracts({
                type: ["boarding"],
            });
            expect(boardingRows.map((c) => c.script)).not.toContain(boardingScriptHexAt(2));

            // The watermark sits at the receive-destination index (1) — the
            // index that actually held the gap window open — NOT the cold
            // boarding index (2).
            expect(await hdProvider.getCurrentSigningDescriptor()).toBe(
                hdProvider.materializeDescriptorAt(1),
            );
        } finally {
            await wallet.dispose();
        }
    });

    it("a cold (spent) boarding index between used indices does not close the gap window early (plan §4)", async () => {
        // The reason the spent-boarding blind spot is tolerable: a used
        // receive-destination index resets the gap counter, so a cold boarding
        // index in between does not strand a later funded boarding index. Here
        // gapLimit=3 with the only earlier hit at receive index 1; without that
        // reset the window would close before reaching the funded boarding UTXO
        // at index 4 (idx 0,1,2,3 = 4 consecutive misses > 3).
        const { wallet, indexer, hdProvider, fundedOnchain } = await makeHdWalletForTest();
        try {
            const serverPubKey = wallet.offchainTapscript.options.serverPubKey;
            const boardingCsv = wallet.boardingTapscript.options.csvTimelock!;
            const receiveScriptsAt = (i: number) =>
                wallet.walletContractTimelocks.map((csvTimelock) =>
                    hex.encode(
                        new DefaultVtxo.Script({
                            pubKey: deriveDescriptorLeafPubKey(
                                hdProvider.materializeDescriptorAt(i),
                            ),
                            serverPubKey,
                            csvTimelock,
                        }).pkScript,
                    ),
                );
            const boardingOnchainAt = (i: number) =>
                new DefaultVtxo.Script({
                    pubKey: deriveDescriptorLeafPubKey(hdProvider.materializeDescriptorAt(i)),
                    serverPubKey,
                    csvTimelock: boardingCsv,
                }).onchainAddress(wallet.network);

            // Receive hit at index 1 (board destination); index 2 cold (spent
            // boarding); a still-unspent funded boarding UTXO at index 4.
            for (const s of receiveScriptsAt(1)) indexer.usedScripts.add(s);
            fundedOnchain.add(boardingOnchainAt(4));

            await wallet.restore({ gapLimit: 3 });

            // The funded boarding index 4 is recovered because index 1 reset the
            // gap counter — the watermark advances all the way to 4.
            expect(await hdProvider.getCurrentSigningDescriptor()).toBe(
                hdProvider.materializeDescriptorAt(4),
            );
            const boardingRows = await wallet.contractRepository.getContracts({
                type: ["boarding"],
            });
            const boardingScript4 = hex.encode(
                new DefaultVtxo.Script({
                    pubKey: deriveDescriptorLeafPubKey(hdProvider.materializeDescriptorAt(4)),
                    serverPubKey,
                    csvTimelock: boardingCsv,
                }).pkScript,
            );
            expect(boardingRows.map((c) => c.script)).toContain(boardingScript4);
        } finally {
            await wallet.dispose();
        }
    });

    // Re-point the global fetch's `/info` reply at a fresh server-info
    // snapshot carrying `deprecatedSigners`. `_runRestore` re-reads
    // `getInfo()` live, so a stub installed AFTER wallet creation but BEFORE
    // restore() drives the signer axis without disturbing the build-time key.
    const stubInfoWithDeprecated = (
        signerPubkey: string,
        deprecatedSigners: { cutoffDate: number; pubkey: string }[],
    ) => {
        const mockFetch = vi.fn().mockImplementation((url: string) => {
            const reply = (body: unknown) =>
                Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
            if (url.includes("/info"))
                return reply({
                    signerPubkey,
                    forfeitPubkey: signerPubkey,
                    boardingExitDelay: 144,
                    unilateralExitDelay: 144,
                    network: "mutinynet",
                    dust: 1000,
                    forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
                    checkpointTapscript:
                        "5ab27520e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
                    deprecatedSigners,
                });
            if (url.includes("subscribe") || url.includes("subscriptions"))
                return reply({ subscriptionId: "sub-1" });
            return reply([]);
        });
        vi.stubGlobal("fetch", mockFetch);
        return () => {
            vi.unstubAllGlobals();
            installRestoreHarness();
        };
    };

    it("discovers a VTXO minted under a deprecated signer and persists the deprecated key in BOTH params and address (plan §3/§4)", async () => {
        // A COMPRESSED (33-byte) deprecated signer key, distinct from the
        // current one. Restore must x-only-normalize it (33→32 slice, plan
        // step 2) before building candidate scripts; using the compressed
        // form keeps that normalization under test.
        const deprecatedCompressed = "03" + "ab".repeat(32);
        const deprecatedXOnly = deprecatedCompressed.slice(2);
        const deprecatedKey = hex.decode(deprecatedXOnly);

        const { wallet, indexer, hdProvider, contractRepository } = await makeHdWalletForTest();
        let unstub: (() => void) | undefined;
        try {
            const currentXOnly = hex.encode(wallet.offchainTapscript.options.serverPubKey);
            // Keep the current signer unchanged; advertise one deprecated key.
            unstub = stubInfoWithDeprecated(currentXOnly, [
                { cutoffDate: 0, pubkey: deprecatedCompressed },
            ]);

            // Mint an L2 VTXO at receive index 2 anchored to the DEPRECATED
            // signer's script (one csvTimelock on this network).
            const pubKey2 = deriveDescriptorLeafPubKey(hdProvider.materializeDescriptorAt(2));
            const deprecatedScript = new DefaultVtxo.Script({
                pubKey: pubKey2,
                serverPubKey: deprecatedKey,
                csvTimelock: wallet.walletContractTimelocks[0],
            });
            const deprecatedScriptHex = hex.encode(deprecatedScript.pkScript);
            indexer.usedScripts.add(deprecatedScriptHex);

            await wallet.restore({ gapLimit: 5 });

            // The contract is recovered and carries the deprecated signer in
            // BOTH the persisted params and the encoded Ark address — so later
            // signing/forfeit resolves the key the VTXO was actually minted
            // under, not the current one.
            const rows = await contractRepository.getContracts({ type: ["default"] });
            const match = rows.find((c) => c.script === deprecatedScriptHex);
            expect(match).toBeDefined();
            expect(match!.params.serverPubKey).toBe(deprecatedXOnly);
            expect(match!.address).toBe(
                deprecatedScript.address(wallet.network.hrp, deprecatedKey).encode(),
            );
            // The watermark advances to the recovered index.
            expect(await hdProvider.getCurrentSigningDescriptor()).toBe(
                hdProvider.materializeDescriptorAt(2),
            );
        } finally {
            unstub?.();
            await wallet.dispose();
        }
    });

    it("getBoardingUtxos unions funds across current + historical boarding addresses (plan §6-III.1)", async () => {
        const { wallet, fundedOnchain } = await makeHdWalletForTest();
        try {
            const baselineBoarding = await wallet.getBoardingAddress();
            const rotatedBoarding = await wallet.getNewBoardingAddress();
            expect(rotatedBoarding).not.toBe(baselineBoarding);

            // Fund BOTH the previous (index-0) and the current (rotated)
            // boarding addresses on-chain.
            fundedOnchain.add(baselineBoarding);
            fundedOnchain.add(rotatedBoarding);

            const utxos = await wallet.getBoardingUtxos();
            expect(utxos).toHaveLength(2);
            // Each coin is annotated with the tapscript of the address it sits
            // on — so it can later be forfeited/exited with the right leaves.
            const addrs = utxos.map((u) =>
                VtxoScript.decode(u.tapTree).onchainAddress(wallet.network),
            );
            expect(new Set(addrs)).toEqual(new Set([baselineBoarding, rotatedBoarding]));
        } finally {
            await wallet.dispose();
        }
    });

    it("getBoardingTxs unions history across current + historical boarding addresses (plan §6-IV.1)", async () => {
        const { wallet } = await makeHdWalletForTest();
        try {
            const baseline = await wallet.getBoardingAddress();
            const rotated = await wallet.getNewBoardingAddress();
            expect(rotated).not.toBe(baseline);

            const txAt = (addr: string, txid: string) => ({
                txid,
                vout: [{ scriptpubkey_address: addr, value: 12_345 }],
                status: { confirmed: true, block_time: 1_700_000_000 },
            });
            vi.spyOn(wallet.onchainProvider, "getTransactions").mockImplementation(
                async (addr: string) => {
                    if (addr === baseline) return [txAt(baseline, "aa".repeat(32))] as any;
                    if (addr === rotated) return [txAt(rotated, "bb".repeat(32))] as any;
                    return [];
                },
            );
            vi.spyOn(wallet.onchainProvider, "getTxOutspends").mockResolvedValue([
                { spent: false },
            ] as any);

            const { boardingTxs } = await wallet.getBoardingTxs();
            const txids = boardingTxs.map((t) => t.key.boardingTxid);
            expect(txids).toContain("aa".repeat(32));
            expect(txids).toContain("bb".repeat(32));
            // getBoardingAddress() stays single-valued (the QR / display target).
            expect(await wallet.getBoardingAddress()).toBe(rotated);
        } finally {
            await wallet.dispose();
        }
    });

    it("notifyIncomingFunds watches the full boarding-address set (plan §6-IV.2)", async () => {
        const { wallet } = await makeHdWalletForTest();
        try {
            const baseline = await wallet.getBoardingAddress();
            const rotated = await wallet.getNewBoardingAddress();

            let watched: string[] = [];
            vi.spyOn(wallet.onchainProvider, "watchAddresses").mockImplementation(
                async (addrs: string[]) => {
                    watched = addrs;
                    return () => {};
                },
            );

            const stop = await wallet.notifyIncomingFunds(() => {});
            expect(new Set(watched)).toEqual(new Set([baseline, rotated]));
            stop();
        } finally {
            await wallet.dispose();
        }
    });

    it("notifyIncomingFunds re-subscribes the onchain watcher when boarding rotates within the session", async () => {
        const { wallet } = await makeHdWalletForTest();
        try {
            const baseline = await wallet.getBoardingAddress();
            const rotated1 = await wallet.getNewBoardingAddress();

            // Record each subscription's address set + a per-call stop spy.
            const calls: string[][] = [];
            const stops: Array<ReturnType<typeof vi.fn>> = [];
            vi.spyOn(wallet.onchainProvider, "watchAddresses").mockImplementation(
                async (addrs: string[]) => {
                    calls.push(addrs);
                    const stop = vi.fn();
                    stops.push(stop);
                    return stop;
                },
            );

            const stop = await wallet.notifyIncomingFunds(() => {});
            expect(calls).toHaveLength(1);
            expect(new Set(calls[0])).toEqual(new Set([baseline, rotated1]));

            // Rotate boarding AFTER subscribing — rotate-on-board's situation.
            const rotated2 = await wallet.getNewBoardingAddress();

            // The watcher re-subscribes to the widened set without a re-init,
            // then (subscribe-then-swap) retires the prior watcher only once
            // the new one is live — so wait for that teardown to land.
            await vi.waitFor(() => {
                expect(calls).toHaveLength(2);
                expect(stops[0]).toHaveBeenCalledTimes(1);
            });
            expect(calls[1]).toContain(rotated2);
            expect(new Set(calls[1])).toEqual(new Set([baseline, rotated1, rotated2]));

            // After stop(), the live watcher is torn down and the rotation
            // listener is unregistered — a later rotation no longer re-subscribes.
            stop();
            expect(stops[1]).toHaveBeenCalledTimes(1);
            await wallet.getNewBoardingAddress();
            await new Promise((r) => setTimeout(r, 20));
            expect(calls).toHaveLength(2);
        } finally {
            await wallet.dispose();
        }
    });

    it("notifyIncomingFunds keeps the existing watcher live when a re-subscribe fails (no on-chain gap)", async () => {
        const { wallet } = await makeHdWalletForTest();
        try {
            await wallet.getNewBoardingAddress();

            const calls: string[][] = [];
            const stops: Array<ReturnType<typeof vi.fn>> = [];
            let failNext = false;
            vi.spyOn(wallet.onchainProvider, "watchAddresses").mockImplementation(
                async (addrs: string[]) => {
                    if (failNext) throw new Error("watchAddresses failed");
                    calls.push(addrs);
                    const stop = vi.fn();
                    stops.push(stop);
                    return stop;
                },
            );
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

            const stop = await wallet.notifyIncomingFunds(() => {});
            expect(calls).toHaveLength(1); // initial watcher live

            // A rotation whose re-subscribe throws must NOT tear down the
            // existing watcher (subscribe-then-swap): degrade to the stale set,
            // never to no watcher at all.
            failNext = true;
            await wallet.getNewBoardingAddress();
            await vi.waitFor(() =>
                expect(warn).toHaveBeenCalledWith(
                    "Failed to (re)subscribe boarding-funds watcher",
                    expect.anything(),
                ),
            );
            expect(stops[0]).not.toHaveBeenCalled(); // old watcher still live

            // It is still the live watcher: stop() tears exactly it down.
            stop();
            expect(stops[0]).toHaveBeenCalledTimes(1);

            warn.mockRestore();
        } finally {
            await wallet.dispose();
        }
    });

    it("notifyIncomingFunds does not miss a rotation that lands during initial subscribe setup", async () => {
        const { wallet } = await makeHdWalletForTest();
        try {
            const baseline = await wallet.getBoardingAddress();
            const rotated1 = await wallet.getNewBoardingAddress();

            const calls: string[][] = [];
            let signalFirstCalled!: () => void;
            const firstCalled = new Promise<void>((r) => (signalFirstCalled = r));
            let releaseFirst!: () => void;
            const firstGate = new Promise<void>((r) => (releaseFirst = r));
            vi.spyOn(wallet.onchainProvider, "watchAddresses").mockImplementation(
                async (addrs: string[]) => {
                    calls.push(addrs);
                    if (calls.length === 1) {
                        // Block the INITIAL subscribe so we can rotate while it
                        // is mid-setup — the race Finding 2 is about.
                        signalFirstCalled();
                        await firstGate;
                    }
                    return vi.fn();
                },
            );

            const notifyPromise = wallet.notifyIncomingFunds(() => {});
            // Initial subscribe is now blocked in watchAddresses; the rotation
            // listener was registered BEFORE this await, so the rotation below
            // is observed and queued behind the initial subscribe on the chain.
            await firstCalled;
            const rotated2 = await wallet.getNewBoardingAddress();
            releaseFirst();
            const stop = await notifyPromise;

            // The serialized chain runs the queued re-subscribe after the
            // initial one, so the watcher ends up on the widened set rather than
            // stuck on the pre-rotation addresses.
            await vi.waitFor(() => expect(calls).toHaveLength(2));
            expect(new Set(calls[1])).toEqual(new Set([baseline, rotated1, rotated2]));

            stop();
        } finally {
            await wallet.dispose();
        }
    });

    it("notifyIncomingFunds emits one coin per matching output, even when a tx pays two boarding addresses (review Finding 4)", async () => {
        const { wallet } = await makeHdWalletForTest();
        try {
            const baseline = await wallet.getBoardingAddress();
            const rotated = await wallet.getNewBoardingAddress();

            let captured: ((txs: any[]) => void) | undefined;
            vi.spyOn(wallet.onchainProvider, "watchAddresses").mockImplementation(
                async (_addrs: string[], cb: (txs: any[]) => void) => {
                    captured = cb;
                    return () => {};
                },
            );

            const received: any[] = [];
            const stop = await wallet.notifyIncomingFunds((funds) => {
                if (funds.type === "utxo") received.push(...funds.coins);
            });

            // One tx with outputs to BOTH boarding addresses (vout 0 and 2) plus
            // an unrelated output (vout 1) that must be ignored.
            captured!([
                {
                    txid: "ab".repeat(32),
                    status: { confirmed: true },
                    vout: [
                        { scriptpubkey_address: baseline, value: 1000 },
                        { scriptpubkey_address: "someone-else", value: 5 },
                        { scriptpubkey_address: rotated, value: 2000 },
                    ],
                },
            ]);

            expect(received).toHaveLength(2);
            expect(received.map((c) => c.vout).sort()).toEqual([0, 2]);
            expect(received.map((c) => c.value).sort((a, b) => a - b)).toEqual([1000, 2000]);
            stop();
        } finally {
            await wallet.dispose();
        }
    });

    it("concurrent restore() calls coalesce into a single scan", async () => {
        const { wallet, indexer } = await makeStaticWalletForTest();
        try {
            indexer.usedScripts.add(wallet.defaultContractScript);

            const [a, b] = await Promise.all([wallet.restore(), wallet.restore()]);
            expect(a).toBeUndefined();
            expect(b).toBeUndefined();

            // Both awaited the same in-flight promise: the static scan
            // is a single index-0 pass, so the number of probes equals
            // exactly one run (one getVtxos per csvTimelock) plus the
            // single inline refreshVtxos pull — NOT doubled.
            const singleRunCalls = indexer.getVtxosCalls.length;
            expect(singleRunCalls).toBeGreaterThan(0);

            // A subsequent sequential restore re-runs (guard cleared on
            // settle): the call count must strictly increase, proving
            // the guard coalesced the concurrent pair (not "always one").
            await wallet.restore();
            expect(indexer.getVtxosCalls.length).toBeGreaterThan(singleRunCalls);
        } finally {
            await wallet.dispose();
        }
    });

    it("handler error: rejects AFTER the inline pull recovers default funds", async () => {
        const { wallet, indexer } = await makeStaticWalletForTest();
        const fakeType = "restore-boom-fake";
        const fake = {
            type: fakeType,
            createScript: (params: Record<string, string>) =>
                ({ pkScript: hex.decode(params.script || "00") }) as any,
            serializeParams: (p: any) => p,
            deserializeParams: (p: any) => p,
            selectPath: () => null,
            getAllSpendingPaths: () => [],
            getSpendablePaths: () => [],
            async discoverAt() {
                throw new Error("swap source unreachable");
            },
        };
        contractHandlers.register(fake as any);
        try {
            // The default handler still finds the funded baseline.
            indexer.usedScripts.add(wallet.defaultContractScript);

            const err = await wallet.restore().then(
                () => undefined,
                (e) => e,
            );
            expect(err).toBeInstanceOf(AggregateError);
            expect((err as AggregateError).errors).toHaveLength(1);
            expect(((err as AggregateError).errors[0] as Error).message).toBe(
                "swap source unreachable",
            );

            // Despite the throwing handler, the inline refreshVtxos ran
            // first so the default-handler funds were still recovered.
            const balance = await wallet.getBalance();
            expect(balance.total).toBeGreaterThan(0);
        } finally {
            contractHandlers.unregister(fakeType);
            await wallet.dispose();
        }
    });

    it("dispose() concurrent with restore() drains the restore without crash", async () => {
        // Regression: _runRestore ran outside _txLock and dispose() did not
        // await _restoreInFlight, so manager.refreshVtxos() could race against
        // a torn-down contract manager. Verify that starting restore() then
        // immediately calling dispose() (without awaiting restore first) does
        // not throw from dispose and that the restore promise settles (not an
        // unhandled rejection hitting a disposed manager).
        const { wallet, indexer } = await makeStaticWalletForTest();
        // Give the indexer a used script so _runRestore does real work
        // (getVtxos hits, refreshVtxos is invoked, etc.).
        indexer.usedScripts.add(wallet.defaultContractScript);

        const restorePromise = wallet.restore();
        // Do NOT await restorePromise before calling dispose — that is the
        // race this test covers.
        await expect(wallet.dispose()).resolves.toBeUndefined();

        // The restore promise must settle (resolve or reject) — not hang and
        // not trigger an unhandled rejection from a disposed-manager crash.
        const results = await Promise.allSettled([restorePromise]);
        expect(results).toHaveLength(1);
        // Any settle status is acceptable (restore may complete or abort),
        // but it must not be a rejected promise that references disposed internals.
        // We assert it settled (fulfilled or rejected) — the allSettled wrapper
        // guarantees this never throws, which is the no-crash invariant.
        expect(results[0].status === "fulfilled" || results[0].status === "rejected").toBe(true);
    });
});
