import { describe, it, expect } from "vitest";
import { CompositeDescriptorSigner } from "../src/identity/compositeDescriptorSigner";
import { ProviderSigningSource, DescriptorSigningSource } from "../src/identity/signingSource";
import { UnknownSigningDescriptorError } from "../src/wallet/signingErrors";
import { Transaction } from "../src/utils/transaction";
import type {
    DescriptorProvider,
    DescriptorSigningRequest,
} from "../src/identity/descriptorProvider";

/**
 * A source that claims a fixed descriptor set and records every batch it
 * was handed, so tests can assert *how* the composite split the work, not
 * just what came back.
 */
function fakeSource(claimed: string[], tag: string) {
    const batches: DescriptorSigningRequest[][] = [];
    const messages: string[] = [];
    const source: DescriptorSigningSource = {
        canProvide: async (descriptor) => claimed.includes(descriptor),
        signWithDescriptor: async (requests) => {
            batches.push(requests);
            return requests.map((r) => r.tx);
        },
        signMessageWithDescriptor: async (descriptor) => {
            messages.push(descriptor);
            return new TextEncoder().encode(`${tag}:${descriptor}`);
        },
    };
    return { source, batches, messages };
}

/** Distinct transaction objects, so identity comparisons are meaningful. */
function tx(): Transaction {
    return new Transaction({ allowUnknown: true, allowUnknownOutputs: true });
}

describe("CompositeDescriptorSigner", () => {
    describe("routing", () => {
        it("routes each descriptor to the first source that claims it", async () => {
            const first = fakeSource(["tr(aa)"], "first");
            const second = fakeSource(["tr(bb)"], "second");
            const signer = new CompositeDescriptorSigner([first.source, second.source]);

            await signer.signWithDescriptor([
                { descriptor: "tr(aa)", tx: tx() },
                { descriptor: "tr(bb)", tx: tx() },
            ]);

            expect(first.batches.flat().map((r) => r.descriptor)).toEqual(["tr(aa)"]);
            expect(second.batches.flat().map((r) => r.descriptor)).toEqual(["tr(bb)"]);
        });

        it("gives the earlier source first refusal when both claim a descriptor", async () => {
            // source order is the collision rule: a key present in both the
            // derivation tree and the keyring keeps its established path
            const first = fakeSource(["tr(aa)"], "first");
            const second = fakeSource(["tr(aa)"], "second");
            const signer = new CompositeDescriptorSigner([first.source, second.source]);

            await signer.signWithDescriptor([{ descriptor: "tr(aa)", tx: tx() }]);

            expect(first.batches).toHaveLength(1);
            expect(second.batches).toHaveLength(0);
        });

        it("throws UnknownSigningDescriptorError when no source claims the descriptor", async () => {
            const only = fakeSource(["tr(aa)"], "only");
            const signer = new CompositeDescriptorSigner([only.source]);

            await expect(
                signer.signWithDescriptor([{ descriptor: "tr(zz)", tx: tx() }]),
            ).rejects.toThrow(UnknownSigningDescriptorError);
            expect(only.batches).toHaveLength(0);
        });

        it("reports the offending descriptor and how many sources were consulted", async () => {
            const signer = new CompositeDescriptorSigner([
                fakeSource([], "a").source,
                fakeSource([], "b").source,
            ]);

            const error = await signer
                .signWithDescriptor([{ descriptor: "tr(zz)", tx: tx() }])
                .catch((e: unknown) => e as UnknownSigningDescriptorError);

            expect(error.descriptor).toBe("tr(zz)");
            expect(error.sourceCount).toBe(2);
        });

        it("canProvide is true iff some source claims the descriptor", async () => {
            const signer = new CompositeDescriptorSigner([
                fakeSource(["tr(aa)"], "a").source,
                fakeSource(["tr(bb)"], "b").source,
            ]);

            expect(await signer.canProvide("tr(bb)")).toBe(true);
            expect(await signer.canProvide("tr(zz)")).toBe(false);
        });
    });

    describe("batching", () => {
        it("preserves request order across a mixed batch", async () => {
            const first = fakeSource(["tr(aa)"], "first");
            const second = fakeSource(["tr(bb)"], "second");
            const signer = new CompositeDescriptorSigner([first.source, second.source]);
            const requests = [
                { descriptor: "tr(bb)", tx: tx() },
                { descriptor: "tr(aa)", tx: tx() },
                { descriptor: "tr(bb)", tx: tx() },
            ];

            const signed = await signer.signWithDescriptor(requests);

            expect(signed).toHaveLength(3);
            for (const [i, result] of signed.entries()) {
                expect(result).toBe(requests[i].tx);
            }
        });

        it("hands each source all of its requests in one call", async () => {
            const first = fakeSource(["tr(aa)"], "first");
            const second = fakeSource(["tr(bb)"], "second");
            const signer = new CompositeDescriptorSigner([first.source, second.source]);

            await signer.signWithDescriptor([
                { descriptor: "tr(aa)", tx: tx() },
                { descriptor: "tr(bb)", tx: tx() },
                { descriptor: "tr(aa)", tx: tx() },
                { descriptor: "tr(bb)", tx: tx() },
            ]);

            expect(first.batches.map((b) => b.length)).toEqual([2]);
            expect(second.batches.map((b) => b.length)).toEqual([2]);
        });

        it("passes a single source its requests verbatim", async () => {
            // the byte-for-byte acceptance hook: with an empty keyring the
            // wallet's provider must see exactly what it saw before the
            // composite existed
            const only = fakeSource(["tr(aa)", "tr(bb)"], "only");
            const signer = new CompositeDescriptorSigner([only.source]);
            const requests = [
                { descriptor: "tr(aa)", tx: tx(), inputIndexes: [0, 2] },
                { descriptor: "tr(bb)", tx: tx() },
            ];

            await signer.signWithDescriptor(requests);

            expect(only.batches).toHaveLength(1);
            expect(only.batches[0]).toEqual(requests);
            for (const [i, request] of only.batches[0].entries()) {
                expect(request).toBe(requests[i]);
            }
        });

        it("resolves an empty batch without consulting any source", async () => {
            const only = fakeSource([], "only");
            const signer = new CompositeDescriptorSigner([only.source]);

            expect(await signer.signWithDescriptor([])).toEqual([]);
            expect(only.batches).toHaveLength(0);
        });

        it("throws when a source returns the wrong number of transactions", async () => {
            const source: DescriptorSigningSource = {
                canProvide: async () => true,
                signWithDescriptor: async () => [],
                signMessageWithDescriptor: async () => new Uint8Array(64),
            };
            const signer = new CompositeDescriptorSigner([source]);

            await expect(
                signer.signWithDescriptor([{ descriptor: "tr(aa)", tx: tx() }]),
            ).rejects.toThrow(/returned 0 transactions, expected 1/);
        });
    });

    describe("signMessageWithDescriptor", () => {
        it("routes to the first claiming source", async () => {
            const first = fakeSource(["tr(aa)"], "first");
            const second = fakeSource(["tr(aa)", "tr(bb)"], "second");
            const signer = new CompositeDescriptorSigner([first.source, second.source]);

            const decode = (b: Uint8Array) => new TextDecoder().decode(b);
            expect(
                decode(await signer.signMessageWithDescriptor("tr(aa)", new Uint8Array(32))),
            ).toBe("first:tr(aa)");
            expect(
                decode(await signer.signMessageWithDescriptor("tr(bb)", new Uint8Array(32))),
            ).toBe("second:tr(bb)");
        });

        it("throws UnknownSigningDescriptorError for an unclaimed descriptor", async () => {
            const signer = new CompositeDescriptorSigner([fakeSource(["tr(aa)"], "a").source]);

            await expect(
                signer.signMessageWithDescriptor("tr(zz)", new Uint8Array(32)),
            ).rejects.toThrow(UnknownSigningDescriptorError);
        });
    });
});

describe("ProviderSigningSource", () => {
    function fakeProvider() {
        const calls: { signed: DescriptorSigningRequest[][]; messages: unknown[][] } = {
            signed: [],
            messages: [],
        };
        const provider: DescriptorProvider = {
            getNextSigningDescriptor: async () => "tr(aa)",
            isOurs: (descriptor) => descriptor === "tr(aa)",
            signWithDescriptor: async (requests) => {
                calls.signed.push(requests);
                return requests.map((r) => r.tx);
            },
            signMessageWithDescriptor: async (descriptor, message, type) => {
                calls.messages.push([descriptor, message, type]);
                return new Uint8Array(64);
            },
        };
        return { provider, calls };
    }

    it("mirrors isOurs as canProvide", async () => {
        const { provider } = fakeProvider();
        const source = new ProviderSigningSource(provider);

        expect(await source.canProvide("tr(aa)")).toBe(true);
        expect(await source.canProvide("tr(bb)")).toBe(false);
    });

    it("passes signing requests through untouched", async () => {
        const { provider, calls } = fakeProvider();
        const source = new ProviderSigningSource(provider);
        const requests = [{ descriptor: "tr(aa)", tx: tx(), inputIndexes: [1] }];

        await source.signWithDescriptor(requests);

        expect(calls.signed).toEqual([requests]);
        expect(calls.signed[0]).toBe(requests);
    });

    it("forwards the message signature type, defaulting to schnorr", async () => {
        const { provider, calls } = fakeProvider();
        const source = new ProviderSigningSource(provider);
        const message = new Uint8Array(32).fill(7);

        await source.signMessageWithDescriptor("tr(aa)", message);
        await source.signMessageWithDescriptor("tr(aa)", message, "ecdsa");

        expect(calls.messages).toEqual([
            ["tr(aa)", message, "schnorr"],
            ["tr(aa)", message, "ecdsa"],
        ]);
    });
});
