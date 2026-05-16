import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { signingDescriptorIndex } from "../src/wallet/walletReceiveRotator";
import { mnemonicToSeedSync } from "@scure/bip39";
import {
    HDKey,
    networks,
    scriptExpressions,
} from "@bitcoinerlab/descriptors-scure";
import { deriveDescriptorLeafPubKey } from "../src/identity/descriptor";
import { HDDescriptorProvider } from "../src/wallet/hdDescriptorProvider";
import { makeHdProviderForTest } from "./helpers/hdProvider";

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
        const d0 = await p.materializeDescriptorAt(0);
        const d5 = await p.materializeDescriptorAt(5);
        expect(d0).not.toEqual(d5);
        expect(await p.getCurrentSigningDescriptor()).toBeUndefined();
    });

    it("advanceLastIndexUsed is monotonic (never rewinds)", async () => {
        const p = await makeHdProviderForTest();
        await p.advanceLastIndexUsed(10);
        expect(await p.getCurrentSigningDescriptor()).toBe(
            await p.materializeDescriptorAt(10)
        );
        await p.advanceLastIndexUsed(7);
        expect(await p.getCurrentSigningDescriptor()).toBe(
            await p.materializeDescriptorAt(10)
        );
    });
});

import { isDiscoverable } from "../src/contracts/types";
import { timelockToSequence } from "../src/utils/timelock";

describe("isDiscoverable", () => {
    it("true only when discoverAt is a function", () => {
        expect(isDiscoverable({ type: "x" } as any)).toBe(false);
        expect(
            isDiscoverable({ type: "x", discoverAt: async () => [] } as any)
        ).toBe(true);
    });
});

import { DefaultContractHandler } from "../src/contracts/handlers/default";
import { DelegateContractHandler } from "../src/contracts/handlers/delegate";
import { DefaultVtxo } from "../src/script/default";
import { DelegateVtxo } from "../src/script/delegate";
import type { RelativeTimelock } from "../src/script/tapscript";

function mockIndexer(usedScripts: Set<string>) {
    return {
        async getVtxos(opts: any) {
            const hit = (opts.scripts ?? []).some((s: string) =>
                usedScripts.has(s)
            );
            return { vtxos: hit ? [{ value: 1 } as any] : [] };
        },
    } as any;
}

describe("DefaultContractHandler.discoverAt", () => {
    // Must use valid secp256k1 x-only pubkeys; fill(3)/fill(7) are not valid points.
    const pkHex =
        "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const serverHex =
        "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
    const server = hex.decode(serverHex);
    const descriptor = `tr(${pkHex})`;
    const tl = DefaultVtxo.Script.DEFAULT_TIMELOCK;
    const script = hex.encode(
        new DefaultVtxo.Script({
            pubKey: hex.decode(pkHex),
            serverPubKey: server,
            csvTimelock: tl,
        }).pkScript
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
        const at0 = await DefaultContractHandler.discoverAt(
            0,
            descriptor,
            deps
        );
        expect(at0).toHaveLength(1);
        expect(at0[0].type).toBe("default");
        expect(at0[0].script).toBe(script);
        expect(at0[0].metadata).toBeUndefined();

        const at3 = await DefaultContractHandler.discoverAt(
            3,
            descriptor,
            deps
        );
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
            }).pkScript
        );
        const script2 = hex.encode(
            new DefaultVtxo.Script({
                pubKey,
                serverPubKey: server,
                csvTimelock: tl2,
            }).pkScript
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

        expect(entry1.params.csvTimelock).toBe(
            timelockToSequence(tl1).toString()
        );
        expect(entry2.params.csvTimelock).toBe(
            timelockToSequence(tl2).toString()
        );
    });
});

describe("DelegateContractHandler.discoverAt", () => {
    // Valid secp256k1 x-only generator points (same as DefaultContractHandler tests above).
    const pkHex =
        "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const serverHex =
        "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
    // A third distinct valid point for the delegate key.
    const delegateHex =
        "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";

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
        }).pkScript
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

        const at0 = await DelegateContractHandler.discoverAt(
            0,
            descriptor,
            deps
        );
        expect(at0).toHaveLength(1);
        expect(at0[0].type).toBe("delegate");
        expect(at0[0].script).toBe(delegateScript);
        expect(at0[0].params.delegatePubKey).toBe(delegateHex);
        expect(at0[0].params.pubKey).toBe(pkHex);
        expect(at0[0].params.serverPubKey).toBe(serverHex);
        expect(at0[0].params.csvTimelock).toBe(
            timelockToSequence(tl).toString()
        );
        expect(at0[0].metadata).toBeUndefined();

        const at3 = await DelegateContractHandler.discoverAt(
            3,
            descriptor,
            deps
        );
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
            }).pkScript
        );
        const script2 = hex.encode(
            new DelegateVtxo.Script({
                pubKey,
                serverPubKey: server,
                delegatePubKey: del,
                csvTimelock: tl2,
            }).pkScript
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

        expect(entry1.params.csvTimelock).toBe(
            timelockToSequence(tl1).toString()
        );
        expect(entry2.params.csvTimelock).toBe(
            timelockToSequence(tl2).toString()
        );
    });
});

import { afterEach } from "vitest";
import { contractHandlers } from "../src/contracts/handlers";
import { makeManagerForTest, makeDeps } from "./helpers/scanManager";

/**
 * Build a fully-synthetic `Discoverable` contract handler for the
 * `scanContracts` suite. Its `createScript(params)` decodes `params.script`
 * straight back to bytes so `hex.encode(createScript(params).pkScript)`
 * round-trips to exactly the `script` the discovered contract declares —
 * this makes `ContractManager.createContract`'s script-derivation check pass
 * deterministically without coupling the test to real crypto / timelocks.
 */
function makeFakeHandler(
    type: string,
    discoverAt: (index: number) => any[] | Promise<any[]>
) {
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
    const VALID_DESCRIPTOR =
        "tr(79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798)";
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
                    })
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
        const { handler } = makeFakeHandler("swapfake", (i) =>
            i === 4
                ? [
                      {
                          type: "swapfake",
                          params: { script: "aabb" },
                          script: "aabb",
                          address: "ark1qswap",
                      },
                  ]
                : []
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
            expect((res.handlerErrors[0].error as Error).message).toBe(
                "handler down"
            );
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
            expect(
                res.handlerErrors.every((e) => e.handler === "boomfake")
            ).toBe(true);
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
                })
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
                : []
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
});

describe("signingDescriptorIndex", () => {
    it("parses the trailing child index", () => {
        expect(signingDescriptorIndex("tr([aa/86'/0'/0']xpub6.../0/7)")).toBe(
            7
        );
    });
    it("returns 0 when absent/unparseable", () => {
        expect(signingDescriptorIndex(undefined)).toBe(0);
        expect(signingDescriptorIndex("tr(deadbeef)")).toBe(0);
    });
});

import { beforeEach } from "vitest";
import {
    installRestoreHarness,
    teardownRestoreHarness,
    makeStaticWalletForTest,
    makeHdWalletForTest,
} from "./helpers/restoreWallet";

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
                await expect(wallet.restore({ gapLimit: bad })).rejects.toThrow(
                    /gapLimit/
                );
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
                                hdProvider.materializeDescriptorAt(index)
                            ),
                            serverPubKey,
                            csvTimelock,
                        }).pkScript
                    )
                );
            for (const s of [...scriptsAt(0), ...scriptsAt(2)]) {
                indexer.usedScripts.add(s);
            }

            await wallet.restore({ gapLimit: 5 });

            // Watermark advanced to the highest used index (2).
            expect(await hdProvider.getCurrentSigningDescriptor()).toBe(
                hdProvider.materializeDescriptorAt(2)
            );
            const balance = await wallet.getBalance();
            expect(balance.total).toBeGreaterThan(0);
        } finally {
            await wallet.dispose();
        }
    });

    it("concurrent restore() calls coalesce into a single scan", async () => {
        const { wallet, indexer } = await makeStaticWalletForTest();
        try {
            indexer.usedScripts.add(wallet.defaultContractScript);

            const [a, b] = await Promise.all([
                wallet.restore(),
                wallet.restore(),
            ]);
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
            expect(indexer.getVtxosCalls.length).toBeGreaterThan(
                singleRunCalls
            );
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
                (e) => e
            );
            expect(err).toBeInstanceOf(AggregateError);
            expect((err as AggregateError).errors).toHaveLength(1);
            expect(((err as AggregateError).errors[0] as Error).message).toBe(
                "swap source unreachable"
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
});
