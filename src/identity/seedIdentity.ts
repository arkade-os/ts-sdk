import { HDKey } from "@scure/bip32";
import { validateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { hex } from "@scure/base";
import { pubECDSA, pubSchnorr } from "@scure/btc-signer/utils.js";
import { SigHash } from "@scure/btc-signer";
import { Identity, ReadonlyIdentity } from ".";
import { Transaction } from "../utils/transaction";
import { SignerSession, TreeSignerSession } from "../tree/signingSession";
import { schnorr, signAsync } from "@noble/secp256k1";

const ALL_SIGHASH = Object.values(SigHash).filter((x) => typeof x === "number");

// BIP32 version bytes for xpub/xprv
const VERSIONS = { private: 0x0488ade4, public: 0x0488b21e };

export interface SeedIdentityOptions {
    isMainnet: boolean;
}

export interface MnemonicOptions extends SeedIdentityOptions {
    passphrase?: string;
}

// Helper function for parsing descriptor
function parseDescriptor(descriptor: string): {
    fingerprint: string;
    path: string;
    xpub: string;
} {
    // Format: tr([fingerprint/path']xpub.../0/*)
    // The /0/* template is required for future HD wallet compatibility
    const match = descriptor.match(
        /^tr\(\[([a-f0-9]{8})\/(\d+'\/\d+'\/\d+')\]([a-zA-Z0-9]+)\/0\/\*\)$/
    );
    if (!match) {
        throw new Error(
            "Invalid descriptor format. Expected: tr([fingerprint/86'/coinType'/0']xpub.../0/*)"
        );
    }
    return {
        fingerprint: match[1],
        path: match[2],
        xpub: match[3],
    };
}

export class SeedIdentity implements Identity {
    private readonly seed: Uint8Array;
    private readonly mnemonic?: string;
    private readonly isMainnet: boolean;
    private readonly masterFingerprint: string;
    private readonly accountNode: HDKey;
    private readonly derivedKey: Uint8Array;

    private constructor(
        seed: Uint8Array,
        isMainnet: boolean,
        mnemonic?: string
    ) {
        if (seed.length !== 64) {
            throw new Error("Seed must be 64 bytes");
        }

        this.seed = seed;
        this.mnemonic = mnemonic;
        this.isMainnet = isMainnet;

        // Derive master key
        const master = HDKey.fromMasterSeed(seed, VERSIONS);

        // Extract fingerprint (first 4 bytes as hex)
        this.masterFingerprint = master.fingerprint
            .toString(16)
            .padStart(8, "0");

        // Derive account node: m/86'/{0|1}'/0'
        const coinType = isMainnet ? 0 : 1;
        const accountPath = `m/86'/${coinType}'/0'`;
        this.accountNode = master.derive(accountPath);

        // Derive address key: /0/0
        const addressNode = this.accountNode.derive("m/0/0");
        if (!addressNode.privateKey) {
            throw new Error("Failed to derive private key");
        }
        this.derivedKey = addressNode.privateKey;
    }

    static fromSeed(seed: Uint8Array, opts: SeedIdentityOptions): SeedIdentity {
        return new SeedIdentity(seed, opts.isMainnet);
    }

    static fromMnemonic(phrase: string, opts: MnemonicOptions): SeedIdentity {
        if (!validateMnemonic(phrase, wordlist)) {
            throw new Error("Invalid mnemonic");
        }
        const seed = mnemonicToSeedSync(phrase, opts.passphrase);
        return new SeedIdentity(seed, opts.isMainnet, phrase);
    }

    static fromJSON(json: string): SeedIdentity {
        const parsed = JSON.parse(json);

        if (!parsed.descriptor) {
            throw new Error("Missing descriptor");
        }

        const { xpub } = parseDescriptor(parsed.descriptor);

        // Infer isMainnet from coin type in path (86'/0'/0' vs 86'/1'/0')
        const coinTypeMatch = parsed.descriptor.match(/86'\/(\d+)'\/0'/);
        if (!coinTypeMatch) {
            throw new Error("Invalid path in descriptor");
        }
        const isMainnet = coinTypeMatch[1] === "0";

        let seed: Uint8Array;
        let mnemonic: string | undefined;

        if (parsed.mnemonic) {
            if (!validateMnemonic(parsed.mnemonic, wordlist)) {
                throw new Error("Invalid mnemonic");
            }
            mnemonic = parsed.mnemonic;
            seed = mnemonicToSeedSync(parsed.mnemonic);
        } else if (parsed.seed) {
            seed = hex.decode(parsed.seed);
        } else {
            throw new Error("Missing mnemonic or seed");
        }

        // Create identity and validate xpub matches
        const identity = new SeedIdentity(seed, isMainnet, mnemonic);

        if (identity.accountNode.publicExtendedKey !== xpub) {
            throw new Error(
                "xpub mismatch: derived key does not match descriptor"
            );
        }

        return identity;
    }

    async xOnlyPublicKey(): Promise<Uint8Array> {
        return pubSchnorr(this.derivedKey);
    }

    async compressedPublicKey(): Promise<Uint8Array> {
        return pubECDSA(this.derivedKey, true);
    }

    async sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction> {
        const txCpy = tx.clone();

        if (!inputIndexes) {
            try {
                if (!txCpy.sign(this.derivedKey, ALL_SIGHASH)) {
                    throw new Error("Failed to sign transaction");
                }
            } catch (e) {
                if (
                    e instanceof Error &&
                    e.message.includes("No inputs signed")
                ) {
                    // ignore
                } else {
                    throw e;
                }
            }
            return txCpy;
        }

        for (const inputIndex of inputIndexes) {
            if (!txCpy.signIdx(this.derivedKey, inputIndex, ALL_SIGHASH)) {
                throw new Error(`Failed to sign input #${inputIndex}`);
            }
        }

        return txCpy;
    }

    async signMessage(
        message: Uint8Array,
        signatureType: "schnorr" | "ecdsa" = "schnorr"
    ): Promise<Uint8Array> {
        if (signatureType === "ecdsa") {
            return signAsync(message, this.derivedKey, { prehash: false });
        }
        return schnorr.signAsync(message, this.derivedKey);
    }

    signerSession(): SignerSession {
        return TreeSignerSession.random();
    }

    toJSON(): string {
        const coinType = this.isMainnet ? 0 : 1;
        const path = `86'/${coinType}'/0'`;
        const xpub = this.accountNode.publicExtendedKey;
        const descriptor = `tr([${this.masterFingerprint}/${path}]${xpub}/0/*)`;

        if (this.mnemonic) {
            return JSON.stringify({ mnemonic: this.mnemonic, descriptor });
        } else {
            return JSON.stringify({ seed: hex.encode(this.seed), descriptor });
        }
    }

    async toReadonly(): Promise<ReadonlySeedIdentity> {
        const json = this.toJSON();
        const descriptor = JSON.parse(json).descriptor;
        return ReadonlySeedIdentity.fromDescriptor(descriptor);
    }
}

export class ReadonlySeedIdentity implements ReadonlyIdentity {
    private readonly accountXpub: HDKey;
    private readonly descriptor: string;

    private constructor(descriptor: string, accountXpub: HDKey) {
        this.descriptor = descriptor;
        this.accountXpub = accountXpub;
    }

    static fromDescriptor(descriptor: string): ReadonlySeedIdentity {
        const { xpub } = parseDescriptor(descriptor);
        const accountXpub = HDKey.fromExtendedKey(xpub, VERSIONS);
        return new ReadonlySeedIdentity(descriptor, accountXpub);
    }

    static fromJSON(json: string): ReadonlySeedIdentity {
        const parsed = JSON.parse(json);
        if (!parsed.descriptor) {
            throw new Error("Missing descriptor");
        }
        return ReadonlySeedIdentity.fromDescriptor(parsed.descriptor);
    }

    async xOnlyPublicKey(): Promise<Uint8Array> {
        const addressNode = this.accountXpub.derive("m/0/0");
        if (!addressNode.publicKey) {
            throw new Error("Failed to derive public key");
        }
        // x-only is compressed pubkey without the prefix byte
        return addressNode.publicKey.slice(1);
    }

    async compressedPublicKey(): Promise<Uint8Array> {
        const addressNode = this.accountXpub.derive("m/0/0");
        if (!addressNode.publicKey) {
            throw new Error("Failed to derive public key");
        }
        return addressNode.publicKey;
    }

    toJSON(): string {
        return JSON.stringify({ descriptor: this.descriptor });
    }
}
