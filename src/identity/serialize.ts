import { hex } from "@scure/base";
import type { Identity, ReadonlyIdentity } from ".";
import { SingleKey, ReadonlySingleKey } from "./singleKey";
import {
    SeedIdentity,
    MnemonicIdentity,
    ReadonlyDescriptorIdentity,
    serializeSeedOwnedSigningIdentity,
    serializeSeedOwnedReadonlyIdentity,
} from "./seedIdentity";

/**
 * Tagged envelope for a signing identity transported across the
 * service-worker boundary. All variants are structured-clone safe
 * (plain strings only — no functions or prototypes).
 *
 * Adding a new variant is a source change in every worker build; keep
 * old variants around until all deployed workers handle them.
 */
export type SerializedSigningIdentity =
    | { type: "single-key"; privateKey: string }
    | { type: "seed"; seed: string; descriptor: string }
    | {
          type: "mnemonic";
          mnemonic: string;
          descriptor: string;
          passphrase?: string;
      };

/**
 * Tagged envelope for a readonly identity transported across the
 * service-worker boundary. All variants are structured-clone safe.
 */
export type SerializedReadonlyIdentity =
    | { type: "readonly-single-key"; publicKey: string }
    | { type: "readonly-descriptor"; descriptor: string };

export type SerializedIdentity =
    | SerializedSigningIdentity
    | SerializedReadonlyIdentity;

/** Type guard — true for signing envelopes, false for readonly envelopes. */
export function isSigningSerialized(
    s: SerializedIdentity
): s is SerializedSigningIdentity {
    return (
        s.type === "single-key" || s.type === "seed" || s.type === "mnemonic"
    );
}

/** Identity that can expose a raw 32-byte private key via `toHex()`. */
type HexExportableIdentity = Identity & { toHex(): string };

function hasToHex(identity: Identity): identity is HexExportableIdentity {
    return typeof (identity as { toHex?: unknown }).toHex === "function";
}

/**
 * Serialize a signing identity into a structured-clone safe envelope for
 * transport across the service-worker boundary.
 *
 * Supports SDK-owned signing identities directly. For custom identities, a
 * duck-typed `toHex()` fallback preserves compatibility with existing
 * `SingleKey`-like implementations.
 */
export function serializeSigningIdentity(
    identity: Identity
): SerializedSigningIdentity {
    // Seed-backed identities (including MnemonicIdentity, which extends
    // SeedIdentity) delegate to the colocated helper so secret material
    // stays behind the WeakMap-backed internal state in seedIdentity.ts.
    if (identity instanceof SeedIdentity) {
        return serializeSeedOwnedSigningIdentity(identity);
    }
    if (identity instanceof SingleKey) {
        return { type: "single-key", privateKey: identity.toHex() };
    }
    if (hasToHex(identity)) {
        return { type: "single-key", privateKey: identity.toHex() };
    }
    throw new Error(
        "Unsupported signing identity: cannot serialize for service-worker transport"
    );
}

/**
 * Serialize a readonly identity into a structured-clone safe envelope.
 *
 * Works for any `ReadonlyIdentity` via `compressedPublicKey()`. When called
 * with a signing identity, produces a readonly envelope (never ships signing
 * material) — callers that need to preserve signing capability across the
 * boundary must use {@link serializeSigningIdentity}.
 */
export async function serializeReadonlyIdentity(
    identity: ReadonlyIdentity
): Promise<SerializedReadonlyIdentity> {
    if (
        identity instanceof SeedIdentity ||
        identity instanceof ReadonlyDescriptorIdentity
    ) {
        return serializeSeedOwnedReadonlyIdentity(identity);
    }
    return {
        type: "readonly-single-key",
        publicKey: hex.encode(await identity.compressedPublicKey()),
    };
}

/**
 * Rehydrate a serialized identity envelope back into an identity instance.
 * The return type is the union of signing and readonly; use
 * {@link isSigningSerialized} on the envelope before hydration if the caller
 * needs to know which side it ends up on.
 */
export function hydrateIdentity(
    s: SerializedIdentity
): Identity | ReadonlyIdentity {
    switch (s.type) {
        case "single-key":
            return SingleKey.fromHex(s.privateKey);
        case "readonly-single-key":
            return ReadonlySingleKey.fromPublicKey(hex.decode(s.publicKey));
        case "seed":
            return SeedIdentity.fromSeed(hex.decode(s.seed), {
                descriptor: s.descriptor,
            });
        case "mnemonic":
            return MnemonicIdentity.fromMnemonic(s.mnemonic, {
                descriptor: s.descriptor,
                passphrase: s.passphrase,
            });
        case "readonly-descriptor":
            return ReadonlyDescriptorIdentity.fromDescriptor(s.descriptor);
    }
}

/**
 * Legacy untagged shape emitted by page builds prior to the tagged
 * SerializedIdentity envelope. Retained so newer workers can still accept
 * older pages during a rolling upgrade. Slated for removal in the next major.
 *
 * @deprecated Use {@link SerializedIdentity}.
 */
export type LegacySerializedIdentity =
    | { privateKey: string }
    | { publicKey: string };

let warnedLegacyShape = false;

/**
 * Accept either a modern {@link SerializedIdentity} envelope or a legacy
 * `{ privateKey }` / `{ publicKey }` shape and normalize to a
 * {@link SerializedIdentity}. Emits a one-time deprecation warning when a
 * legacy shape is seen.
 *
 * Intended for the worker-side boundary; new page builds always emit tagged
 * envelopes via {@link serializeSigningIdentity} /
 * {@link serializeReadonlyIdentity}.
 */
/**
 * Map a tagged {@link SerializedIdentity} to the shape emitted on the
 * messageBus wire.
 *
 * - `single-key` → legacy `{ privateKey }`
 * - `readonly-single-key` → legacy `{ publicKey }`
 * - every other variant → returned unchanged (those variants did not exist
 *   before tagged envelopes, so there is no legacy shape to downgrade to).
 *
 * This downgrade preserves wire compatibility with workers that predate
 * `SerializedIdentity` for the historic `SingleKey` / `ReadonlySingleKey`
 * flows. Workers accept both shapes via {@link normalizeSerializedIdentity}.
 *
 * Slated for removal alongside the legacy adapter in the next major.
 */
export function toWireSerializedIdentity(
    s: SerializedIdentity
): SerializedIdentity | LegacySerializedIdentity {
    if (s.type === "single-key") return { privateKey: s.privateKey };
    if (s.type === "readonly-single-key") return { publicKey: s.publicKey };
    return s;
}

export function normalizeSerializedIdentity(
    shape: SerializedIdentity | LegacySerializedIdentity
): SerializedIdentity {
    if ("type" in shape) return shape;
    if (!warnedLegacyShape) {
        warnedLegacyShape = true;
        console.warn(
            "[ts-sdk] Received legacy serialized identity shape " +
                "(privateKey/publicKey). Upgrade the page build to the latest " +
                "@arkade-os/sdk — this compatibility path will be removed in " +
                "the next major."
        );
    }
    if ("privateKey" in shape) {
        return { type: "single-key", privateKey: shape.privateKey };
    }
    if ("publicKey" in shape) {
        return { type: "readonly-single-key", publicKey: shape.publicKey };
    }
    throw new Error("Unrecognized serialized identity shape");
}
