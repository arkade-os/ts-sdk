import { schnorr } from "@noble/curves/secp256k1";
import { pubSchnorr, randomPrivateKeyBytes } from "@scure/btc-signer/utils";
import { hex } from "@scure/base";
import { TreeSignerSession } from "./signingSession";
import { SignerSession } from "./signingSession";

// Interface for external signers
export interface ExternalSignerInterface {
    sign(message: Uint8Array): Promise<Uint8Array>;
    getPublicKey(): Uint8Array;
}

export interface Identity {
    sign(message: Uint8Array): Promise<Uint8Array>;
    xOnlyPublicKey(): Uint8Array;
    privateKey(): Uint8Array;
    // TODO deterministic signer session
    getSignerSession(): SignerSession;
}

export class InMemoryKey implements Identity {
    private key: Uint8Array;

    private constructor(key: Uint8Array | undefined) {
        this.key = key || randomPrivateKeyBytes();
    }

    static fromPrivateKey(privateKey: Uint8Array): InMemoryKey {
        return new InMemoryKey(privateKey);
    }

    static fromHex(privateKeyHex: string): InMemoryKey {
        return new InMemoryKey(hex.decode(privateKeyHex));
    }

    async sign(message: Uint8Array): Promise<Uint8Array> {
        return schnorr.sign(message, this.key);
    }

    xOnlyPublicKey(): Uint8Array {
        return pubSchnorr(this.key);
    }

    privateKey(): Uint8Array {
        return this.key;
    }

    getSignerSession(): SignerSession {
        return TreeSignerSession.random();
    }
}

export class ExternalSigner implements Identity {
    private signer: ExternalSignerInterface;

    private constructor(signer: ExternalSignerInterface) {
        this.signer = signer;
    }

    static fromSigner(signer: ExternalSignerInterface): ExternalSigner {
        return new ExternalSigner(signer);
    }

    async sign(message: Uint8Array): Promise<Uint8Array> {
        return this.signer.sign(message);
    }

    xOnlyPublicKey(): Uint8Array {
        return this.signer.getPublicKey();
    }

    privateKey(): Uint8Array {
        throw new Error("External signer does not expose private key");
    }

    getSignerSession(): SignerSession {
        return TreeSignerSession.random();
    }
}
