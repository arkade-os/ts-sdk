import { hex } from "@scure/base";
import { Identity } from ".";
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
        descriptor: string,
        requests: DescriptorSigningRequest[]
    ): Promise<Transaction[]> {
        if (!this.isOurs(descriptor)) {
            throw new Error(
                `Descriptor ${descriptor} does not belong to this provider`
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
