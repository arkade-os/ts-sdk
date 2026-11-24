import { hex } from "@scure/base";
import { describe, expect, it, vi } from "vitest";
import { MapArkPrevOutFetcher, newEngine, type VmTx } from "../src/arkade/vm";
import { SHA256_STATE_LEN, SHA256_STATE_PREFIX } from "../src/arkade/vm/hash";
import framing from "./fixtures/arkade-vm/sha256_framing.json";

// The core, arith and hashops cases run from the oracle corpus (arkade-vm.test.ts, "ops/*");
// what stays here is the constant hash.ts hardcodes instead of deriving it as Go does.
const TX: VmTx = {
    version: 2,
    locktime: 0,
    inputs: [
        { txid: new Uint8Array(32), index: 0, sequence: 0xffffffff, scriptSig: new Uint8Array(0) },
    ],
    outputs: [],
};

function run(script: string, seed: string[]): string[] {
    const vm = newEngine({
        script: hex.decode(script),
        tx: TX,
        inputIndex: 0,
        inputAmount: 0n,
        fetcher: new MapArkPrevOutFetcher(),
    });
    vm.setStack(seed.map((s) => hex.decode(s)));
    for (let done = false; !done; ) done = vm.step();
    return vm.getStack().map((e) => hex.encode(e));
}

describe("vm hash constants", () => {
    it("sha256 midstate framing is the oracle's dump and reproduces its states", () => {
        expect(hex.encode(SHA256_STATE_PREFIX)).toBe(framing.prefix_hex);
        expect(SHA256_STATE_LEN).toBe(framing.total_len);
        for (const s of framing.states) {
            expect(run("c4", [s.data_hex])).toEqual([s.state_hex]);
            expect(run("00c6", [s.state_hex])).toEqual([s.digest_hex]);
        }
    });

    it("refuses to load when noble's sha256 set() stops restoring a midstate", async () => {
        vi.resetModules();
        vi.doMock("@noble/hashes/sha2.js", async (importOriginal) => {
            const real = await importOriginal<typeof import("@noble/hashes/sha2.js")>();
            type Internals = {
                set(...words: number[]): void;
                process(view: DataView, offset: number): void;
            };
            // hashing still works; only a set() from outside, as hash.ts's decode makes, is lost
            const create = () => {
                const h = real.sha256.create() as unknown as Internals;
                const { set, process } = h;
                h.set = () => {};
                h.process = (view, offset) => {
                    h.set = set;
                    process.call(h, view, offset);
                    h.set = () => {};
                };
                return h;
            };
            return {
                ...real,
                sha256: Object.assign((m: Uint8Array) => real.sha256(m), { create }),
            };
        });
        await expect(import("../src/arkade/vm/hash")).rejects.toThrow(/sha256 internals/);
        vi.doUnmock("@noble/hashes/sha2.js");
    });
});
