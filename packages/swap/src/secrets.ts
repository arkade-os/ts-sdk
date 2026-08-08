/**
 * RFQ swap secrets, derived from the wallet seed instead of stored.
 *
 * Both secrets an RFQ corridor needs — the VHTLC `sender` key and, for an
 * onchain send, the preimage — become functions of one HD-allocated
 * descriptor. The record keeps only that descriptor, which is public, so a
 * copied profile or a device backup yields nothing spendable and a wallet with
 * the seed can re-derive everything.
 *
 * Wallets that cannot allocate (static / `auto` / custom signers) get the
 * fallback arm instead, which carries real secrets the caller must store. That
 * arm is built by the caller, never in here: a restore probing for a derived
 * preimage must be able to come back empty rather than be handed a fresh
 * random one that will never match the chain.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    Identity,
    IWallet,
    ReadonlyIdentity,
    SingleKey,
    isHDAllocationCapable,
    isHDWalletCapable,
} from "@arkade-os/sdk";

/**
 * Domain separator for the preimage derivation.
 *
 * NArk scopes its tag by protocol+provider (`Arkade-Boltz-Preimage-v1`,
 * `SwapsManagementService.cs:128`) so any Arkade SDK reproduces the same
 * preimage. NArk has no RFQ corridor yet, so this tag defines the scheme
 * rather than mirroring one; it is deliberately distinct from the Boltz tag,
 * or the same wallet key would derive one preimage for both corridors.
 */
export const RFQ_PREIMAGE_TAG = "Arkade-RFQ-Preimage-v1";

/**
 * `TAG ‖ xonly(32) ‖ u32le(index)` — the message that gets BIP-340 signed.
 *
 * Anchored on the canonical x-only key rather than the descriptor string:
 * restore reconstructs a bare descriptor that serialises differently from the
 * signing descriptor used at create time, and only the key agrees across both.
 */
export function buildPreimageMessage(xonly: Uint8Array, index: number): Uint8Array {
    if (xonly.length !== 32) {
        throw new Error(`x-only pubkey must be 32 bytes, got ${xonly.length}`);
    }
    if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
        throw new Error(`index must be a u32, got ${index}`);
    }
    const tag = new TextEncoder().encode(RFQ_PREIMAGE_TAG);
    const message = new Uint8Array(tag.length + 32 + 4);
    message.set(tag, 0);
    message.set(xonly, tag.length);
    new DataView(message.buffer).setUint32(tag.length + 32, index, true);
    return message;
}

/**
 * Every swap allocates its own descriptor, so the key alone separates two
 * swaps and the message index stays pinned. Kept as a parameter of
 * {@link buildPreimageMessage} for cross-SDK vectors.
 */
const PREIMAGE_INDEX = 0;

/** No secrets at rest: everything re-derives from the seed plus this. */
export interface DerivedSwapSecrets {
    derivable: true;
    /** Public. Persist it on the swap record; it is what restore keys off. */
    signingDescriptor: string;
}

/** The wallet could not allocate. These are real secrets — persist them. */
export interface StoredSwapSecrets {
    derivable: false;
    senderPrivateKey: Uint8Array;
    /** Onchain-send only. A lightning send's preimage belongs to the payee. */
    preimage?: Uint8Array;
}

/**
 * Which arm a swap got. The discriminant makes the persistence obligation a
 * type-level fact: a consumer written against {@link DerivedSwapSecrets} alone
 * fails to compile when handed the stored arm.
 */
export type SwapSecrets = DerivedSwapSecrets | StoredSwapSecrets;

/**
 * Allocate a descriptor for one swap, or `undefined` when the wallet cannot.
 *
 * Allocates — never peeks. `getCurrentSigningDescriptor` returns the same
 * descriptor until the wallet rotates, and two swaps sharing a descriptor
 * derive the *identical* preimage, so one solver learning its own preimage
 * would learn the other swap's.
 */
export async function deriveSwapSecrets(wallet: IWallet): Promise<DerivedSwapSecrets | undefined> {
    if (!isHDAllocationCapable(wallet)) return undefined;
    const signingDescriptor = await wallet.getNextSigningDescriptor();
    if (!signingDescriptor) return undefined;
    return { derivable: true, signingDescriptor };
}

/**
 * The fallback arm. Separate from {@link deriveSwapSecrets} so nothing can
 * fabricate a preimage while probing for a derived one.
 */
export function randomSwapSecrets(opts: { preimage?: boolean } = {}): StoredSwapSecrets {
    return {
        derivable: false,
        senderPrivateKey: schnorr.utils.randomSecretKey(),
        ...(opts.preimage ? { preimage: schnorr.utils.randomSecretKey() } : {}),
    };
}

/**
 * The secrets arm a persisted record describes, or `undefined` when the record
 * predates derivation (or was written by a wallet that could not derive).
 *
 * Only the derivable arm is reconstructible from a record: `AssetSwap`
 * deliberately has no field for a sender private key, so a stored-arm swap's
 * key lives in whatever encrypted store the consumer provides and must be
 * supplied from there.
 */
export function rfqSecretsOfRecord(record: {
    signingDescriptor?: string;
    preimageHex?: string;
}): DerivedSwapSecrets | undefined {
    if (!record.signingDescriptor) return undefined;
    return { derivable: true, signingDescriptor: record.signingDescriptor };
}

/**
 * Claim a restored swap's index so a later allocation cannot reissue it —
 * which would derive that swap's preimage a second time, for a different swap.
 * Monotonic; a no-op on a wallet that cannot allocate.
 */
export async function adoptSwapDescriptor(
    wallet: IWallet,
    signingDescriptor: string,
): Promise<void> {
    if (!isHDAllocationCapable(wallet)) return;
    await wallet.advanceSigningDescriptorWatermark(signingDescriptor);
}

/** The VHTLC `sender` identity — the signer for every interactive refund. */
export async function senderIdentityForRfqSecrets(
    wallet: IWallet,
    secrets: SwapSecrets,
): Promise<Identity> {
    if (!secrets.derivable) return SingleKey.fromPrivateKey(secrets.senderPrivateKey);
    if (!isHDWalletCapable(wallet)) {
        throw new Error("swap was created on an HD wallet; this wallet cannot derive its key");
    }
    return wallet.signerForDescriptor(secrets.signingDescriptor);
}

/** The `sender` x-only pubkey, the only half the request flow needs. */
export async function senderPubkeyForRfqSecrets(
    wallet: IWallet,
    secrets: SwapSecrets,
): Promise<Uint8Array> {
    if (!secrets.derivable) return schnorr.getPublicKey(secrets.senderPrivateKey);
    return (await senderIdentityForRfqSecrets(wallet, secrets)).xOnlyPublicKey();
}

/**
 * An identity that signs with `aux_rand = 0`, which is what makes the
 * derivation reproducible. `DescriptorIdentity` satisfies it and throws rather
 * than degrading to a random-aux signer.
 */
export interface DeterministicSigner extends ReadonlyIdentity {
    signSchnorrDeterministic(messageHash: Uint8Array): Promise<Uint8Array>;
}

export function isDeterministicSigner(value: unknown): value is DeterministicSigner {
    if (typeof value !== "object" || value === null) return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.signSchnorrDeterministic === "function" && typeof v.xOnlyPublicKey === "function"
    );
}

/**
 * `sha256(sign(sha256(msg)))`, with the signing key and the message key being
 * the same identity — passing a key in separately is how this silently derives
 * an unrecoverable preimage.
 */
export async function derivePreimage(signer: DeterministicSigner): Promise<Uint8Array> {
    const xonly = await signer.xOnlyPublicKey();
    const message = buildPreimageMessage(xonly, PREIMAGE_INDEX);
    return sha256(await signer.signSchnorrDeterministic(sha256(message)));
}

/** The onchain-send preimage, re-derived or read back off the stored arm. */
export async function preimageForRfqSecrets(
    wallet: IWallet,
    secrets: SwapSecrets,
): Promise<Uint8Array> {
    if (!secrets.derivable) {
        if (!secrets.preimage) throw new Error("this swap carries no stored preimage");
        return secrets.preimage;
    }
    const signer = await senderIdentityForRfqSecrets(wallet, secrets);
    if (!isDeterministicSigner(signer)) {
        // Loud: a preimage from a random-aux signature is unrecoverable, and
        // the failure would otherwise only surface at claim time.
        throw new Error(
            `wallet cannot sign deterministically for ${secrets.signingDescriptor}; its preimage is not derivable`,
        );
    }
    return derivePreimage(signer);
}
