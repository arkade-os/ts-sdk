/**
 * MuSig2 signing wrapper built on @scure/btc-signer/musig2.js primitives.
 * Provides the same chainable API as boltz-core's Musig class:
 *   create(privKey, pubKeys)
 *     .message(msg)
 *     .generateNonce()
 *     .aggregateNonces(pairs)
 *     .initializeSession()
 *     .signPartial()
 *     .aggregatePartials()
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import {
    Session,
    keyAggregate,
    keyAggExport,
    nonceAggregate,
    nonceGen,
    type Nonces,
} from "@scure/btc-signer/musig2.js";
import { equalBytes } from "@scure/btc-signer/utils.js";

type PublicKey = Uint8Array;
type PrivateKey = Uint8Array;
type NonceBytes = Uint8Array;
type PartialSignature = Uint8Array;
export type NoncePair = readonly [PublicKey, NonceBytes];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const findKeyIndex = (keys: readonly PublicKey[], target: PublicKey): number =>
    keys.findIndex((k) => equalBytes(target, k));

const assertPublicKeys = (keys: PublicKey[]): void => {
    const seen = new Set<string>();
    for (const key of keys) {
        if (key.length !== 33)
            throw new Error(`public key must be 33 bytes, got ${key.length}`);
        const enc = hex.encode(key);
        if (seen.has(enc)) throw new Error(`duplicate public key ${enc}`);
        seen.add(enc);
    }
};

export const aggregateKeys = (
    publicKeys: readonly PublicKey[],
    tweak?: Uint8Array
): Uint8Array => {
    assertPublicKeys([...publicKeys]);
    return keyAggExport(
        keyAggregate([...publicKeys], tweak ? [tweak] : [], tweak ? [true] : [])
    );
};

// ---------------------------------------------------------------------------
// Chainable state machine classes
// ---------------------------------------------------------------------------

export class MusigKeyAgg {
    constructor(
        private readonly privateKey: PrivateKey,
        private readonly myPublicKey: PublicKey,
        readonly publicKeys: readonly PublicKey[],
        private readonly myIndex: number,
        readonly aggPubkey: PublicKey,
        readonly internalKey: PublicKey,
        private readonly _tweak?: Uint8Array
    ) {}

    xonlyTweakAdd(tweak: Uint8Array): MusigKeyAgg {
        if (this._tweak) throw new Error("musig key already tweaked");
        return new MusigKeyAgg(
            this.privateKey,
            this.myPublicKey,
            this.publicKeys,
            this.myIndex,
            aggregateKeys(this.publicKeys, tweak),
            this.internalKey,
            tweak
        );
    }

    message(msg: Uint8Array): MusigWithMessage {
        return new MusigWithMessage(
            this.privateKey,
            this.myPublicKey,
            this.publicKeys,
            this.myIndex,
            this.aggPubkey,
            this._tweak,
            msg
        );
    }
}

export class MusigWithMessage {
    constructor(
        private readonly privateKey: PrivateKey,
        private readonly myPublicKey: PublicKey,
        private readonly publicKeys: readonly PublicKey[],
        private readonly myIndex: number,
        private readonly aggPubkey: PublicKey,
        private readonly tweak: Uint8Array | undefined,
        private readonly msg: Uint8Array
    ) {}

    generateNonce(): MusigWithNonce {
        const nonce = nonceGen(
            this.myPublicKey,
            this.privateKey,
            this.aggPubkey,
            this.msg
        );
        return new MusigWithNonce(
            this.privateKey,
            this.myPublicKey,
            this.publicKeys,
            this.myIndex,
            this.aggPubkey,
            this.tweak,
            this.msg,
            nonce
        );
    }
}

export class MusigWithNonce {
    constructor(
        private readonly privateKey: PrivateKey,
        private readonly myPublicKey: PublicKey,
        private readonly publicKeys: readonly PublicKey[],
        private readonly myIndex: number,
        private readonly aggPubkey: PublicKey,
        private readonly tweak: Uint8Array | undefined,
        private readonly msg: Uint8Array,
        private readonly nonce: Nonces
    ) {}

    get publicNonce(): NonceBytes {
        return this.nonce.public;
    }

    aggregateNonces(nonces: Iterable<NoncePair>): MusigNoncesAggregated {
        const pairs = Array.from(nonces);

        // Add our own nonce if not already present
        const ours = pairs.find(([k]) => equalBytes(this.myPublicKey, k));
        if (!ours) {
            pairs.push([this.myPublicKey, this.publicNonce]);
        } else if (!equalBytes(ours[1], this.publicNonce)) {
            throw new Error("nonce for our public key does not match");
        }

        if (this.publicKeys.length !== pairs.length) {
            throw new Error("number of nonces != number of public keys");
        }

        // Order nonces to match publicKeys order
        const nonceByKey = new Map<string, NonceBytes>();
        for (const [key, nonce] of pairs) {
            nonceByKey.set(hex.encode(key), nonce);
        }

        const ordered: NonceBytes[] = [];
        for (const key of this.publicKeys) {
            const n = nonceByKey.get(hex.encode(key));
            if (!n) throw new Error("missing nonce for public key");
            ordered.push(n);
        }

        const aggregatedNonce = nonceAggregate([...ordered]);
        return new MusigNoncesAggregated(
            this.privateKey,
            this.myPublicKey,
            this.publicKeys,
            this.myIndex,
            this.aggPubkey,
            this.tweak,
            this.msg,
            this.nonce,
            Object.freeze(ordered),
            aggregatedNonce
        );
    }
}

export class MusigNoncesAggregated {
    constructor(
        private readonly privateKey: PrivateKey,
        private readonly myPublicKey: PublicKey,
        private readonly publicKeys: readonly PublicKey[],
        private readonly myIndex: number,
        private readonly aggPubkey: PublicKey,
        private readonly tweak: Uint8Array | undefined,
        private readonly msg: Uint8Array,
        private readonly nonce: Nonces,
        private readonly pubNonces: readonly NonceBytes[],
        private readonly aggregatedNonce: NonceBytes
    ) {}

    get publicNonce(): NonceBytes {
        return this.nonce.public;
    }

    initializeSession(): MusigSession {
        const session = new Session(
            this.aggregatedNonce,
            [...this.publicKeys],
            this.msg,
            this.tweak ? [this.tweak] : [],
            this.tweak ? [true] : []
        );
        return new MusigSession(
            this.privateKey,
            this.publicKeys,
            this.myIndex,
            this.nonce,
            this.pubNonces,
            session
        );
    }
}

export class MusigSession {
    private readonly partialSignatures: Array<PartialSignature | null>;

    constructor(
        private readonly privateKey: PrivateKey,
        private readonly publicKeys: readonly PublicKey[],
        private readonly myIndex: number,
        private readonly nonce: Nonces,
        private readonly pubNonces: readonly NonceBytes[],
        private readonly session: Session
    ) {
        this.partialSignatures = Array(publicKeys.length).fill(null);
    }

    get publicNonce(): NonceBytes {
        return this.nonce.public;
    }

    addPartial(
        publicKeyOrIndex: PublicKey | number,
        signature: PartialSignature
    ): this {
        const index =
            typeof publicKeyOrIndex === "number"
                ? publicKeyOrIndex
                : findKeyIndex(this.publicKeys, publicKeyOrIndex);
        if (index < 0 || index >= this.publicKeys.length)
            throw new Error("public key not found or index out of range");

        if (
            !this.session.partialSigVerify(
                signature,
                [...this.pubNonces],
                index
            )
        ) {
            throw new Error("invalid partial signature");
        }
        this.partialSignatures[index] = signature;
        return this;
    }

    signPartial(): MusigSigned {
        const sig = this.session.sign(this.nonce.secret, this.privateKey, true);
        this.partialSignatures[this.myIndex] = sig;
        return new MusigSigned(
            this.session,
            [...this.partialSignatures],
            sig,
            this.nonce.public
        );
    }
}

export class MusigSigned {
    constructor(
        private readonly session: Session,
        private readonly partialSignatures: Array<PartialSignature | null>,
        readonly ourPartialSignature: PartialSignature,
        readonly publicNonce: NonceBytes
    ) {}

    aggregatePartials(): Uint8Array {
        if (this.partialSignatures.some((s) => s === null)) {
            throw new Error("not all partial signatures are set");
        }
        return this.session.partialSigAgg(
            this.partialSignatures as PartialSignature[]
        );
    }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const create = (
    privateKey: PrivateKey,
    publicKeys: readonly PublicKey[]
): MusigKeyAgg => {
    if (publicKeys.length < 2)
        throw new Error("need at least 2 keys to aggregate");

    const keys = [...publicKeys];
    assertPublicKeys(keys);
    Object.freeze(keys);

    const myPublicKey = secp256k1.getPublicKey(privateKey);
    const myIndex = findKeyIndex(keys, myPublicKey);
    if (myIndex === -1) throw new Error("our key is not in publicKeys");

    const aggPubkey = aggregateKeys(keys);
    return new MusigKeyAgg(
        privateKey,
        myPublicKey,
        keys,
        myIndex,
        aggPubkey,
        aggPubkey
    );
};
