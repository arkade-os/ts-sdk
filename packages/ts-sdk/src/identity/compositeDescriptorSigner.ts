import { DescriptorSigningRequest } from "./descriptorProvider";
import { DescriptorSigningSource } from "./signingSource";
import { UnknownSigningDescriptorError } from "../wallet/signingErrors";
import { Transaction } from "../utils/transaction";

/**
 * Signs descriptor requests by routing each one to the first
 * {@link DescriptorSigningSource} that claims it.
 *
 * Source order is the collision rule: the wallet's own provider comes
 * first, so a key that happens to exist in both the derivation tree and
 * the keyring keeps its established signing path and importing it cannot
 * reroute existing contracts.
 *
 * Requests are partitioned, not signed one by one: each claiming source
 * receives a single {@link DescriptorSigningSource.signWithDescriptor}
 * call with all of its requests, so a batch-signing identity behind the
 * wallet's provider still sees one interaction. Results come back in
 * request order regardless of how the batch split.
 *
 * @internal Composition is a wallet-wiring concern; consumers hold
 * sources, not the composite.
 */
export class CompositeDescriptorSigner implements DescriptorSigningSource {
    constructor(private readonly sources: readonly DescriptorSigningSource[]) {}

    async canProvide(descriptor: string): Promise<boolean> {
        return (await this.claimantOf(descriptor)) !== undefined;
    }

    async signWithDescriptor(requests: DescriptorSigningRequest[]): Promise<Transaction[]> {
        const results = new Array<Transaction>(requests.length);
        const batches = new Map<number, { request: DescriptorSigningRequest; index: number }[]>();

        // Memoized per call, not stored on the instance: a source's answer
        // may change between calls (an imported key can be purged), and a
        // cache that outlived the call would keep routing to a source that
        // no longer holds the key.
        const claimants = new Map<string, number>();
        for (const [index, request] of requests.entries()) {
            let source = claimants.get(request.descriptor);
            if (source === undefined) {
                source = await this.requireClaimantOf(request.descriptor);
                claimants.set(request.descriptor, source);
            }
            const batch = batches.get(source);
            if (batch) {
                batch.push({ request, index });
            } else {
                batches.set(source, [{ request, index }]);
            }
        }

        // Ascending source order so the sequence of signing interactions is
        // deterministic rather than dependent on request order.
        for (const source of Array.from(batches.keys()).sort((a, b) => a - b)) {
            const batch = batches.get(source)!;
            const signed = await this.sources[source].signWithDescriptor(
                batch.map((entry) => entry.request),
            );
            if (signed.length !== batch.length) {
                throw new Error(
                    `Signing source ${source} returned ${signed.length} transactions, expected ${batch.length}`,
                );
            }
            for (const [i, { index }] of batch.entries()) {
                results[index] = signed[i];
            }
        }

        return results;
    }

    async signMessageWithDescriptor(
        descriptor: string,
        message: Uint8Array,
        type: "schnorr" | "ecdsa" = "schnorr",
    ): Promise<Uint8Array> {
        const source = await this.requireClaimantOf(descriptor);
        return this.sources[source].signMessageWithDescriptor(descriptor, message, type);
    }

    /** Index of the first source claiming `descriptor`, or `undefined`. */
    private async claimantOf(descriptor: string): Promise<number | undefined> {
        for (const [index, source] of this.sources.entries()) {
            if (await source.canProvide(descriptor)) return index;
        }
        return undefined;
    }

    private async requireClaimantOf(descriptor: string): Promise<number> {
        const source = await this.claimantOf(descriptor);
        if (source === undefined) {
            throw new UnknownSigningDescriptorError(descriptor, this.sources.length);
        }
        return source;
    }
}
