import { hex } from "@scure/base";
import { Identity, isBatchSignable } from ".";
import {
    DescriptorProvider,
    DescriptorSigningRequest,
} from "./descriptorProvider";
import { normalizeToDescriptor, extractPubKey } from "./descriptor";
import { Transaction } from "../utils/transaction";

/**
 * Wraps a legacy Identity (single-key) as a DescriptorProvider.
 * The descriptor is always a simple tr(pubkey) format.
 */
export class StaticDescriptorProvider implements DescriptorProvider {
    private readonly identity: Identity;
    private readonly descriptor: string;
    private readonly pubKeyHex: string;

    constructor(identity: Identity, pubKeyHex: string) {
        this.identity = identity;
        this.pubKeyHex = pubKeyHex;
        this.descriptor = `tr(${pubKeyHex})`;
    }

    static async create(identity: Identity): Promise<StaticDescriptorProvider> {
        const pubKey = await identity.xOnlyPublicKey();
        return new StaticDescriptorProvider(identity, hex.encode(pubKey));
    }

    getSigningDescriptor(): string {
        return this.descriptor;
    }

    isOurs(descriptor: string): boolean {
        const normalized = normalizeToDescriptor(descriptor);
        try {
            const pubKey = extractPubKey(normalized);
            return pubKey.toLowerCase() === this.pubKeyHex.toLowerCase();
        } catch {
            return false;
        }
    }

    async signWithDescriptor(
        requests: DescriptorSigningRequest[]
    ): Promise<Transaction[]> {
        for (const request of requests) {
            if (!this.isOurs(request.descriptor)) {
                throw new Error(
                    `Descriptor ${request.descriptor} does not belong to this provider`
                );
            }
        }

        // Use batch signing when the identity supports it (fewer confirmation popups)
        if (isBatchSignable(this.identity)) {
            return this.identity.signMultiple(
                requests.map((r) => ({
                    tx: r.tx,
                    inputIndexes: r.inputIndexes,
                }))
            );
        }

        const results: Transaction[] = [];
        for (const request of requests) {
            const signed = await this.identity.sign(
                request.tx,
                request.inputIndexes
            );
            results.push(signed);
        }
        return results;
    }

    async signMessageWithDescriptor(
        descriptor: string,
        message: Uint8Array,
        type: "schnorr" | "ecdsa" = "schnorr"
    ): Promise<Uint8Array> {
        if (!this.isOurs(descriptor)) {
            throw new Error(
                `Descriptor ${descriptor} does not belong to this provider`
            );
        }
        return this.identity.signMessage(message, type);
    }
}
