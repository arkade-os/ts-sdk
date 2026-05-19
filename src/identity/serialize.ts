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
 * `descriptor` carries the wildcard *template* (e.g.
 * `tr([fp/86'/0'/0']xpub.../0/*)`), not a concrete index — the
 * receiving factories require a template, and storing it directly
 * means nothing here has to convert concrete → template on rehydrate.
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
 * `descriptor` is the wildcard template (see
 * {@link SerializedSigningIdentity}).
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
 *
 * Envelopes store the wildcard template directly (see
 * `serializeSeedOwnedSigningIdentity` / `serializeSeedOwnedReadonlyIdentity`),
 * so the `descriptor` field is passed straight through to the
 * template-only factories.
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
        default:
            // Belt-and-suspenders: `normalizeSerializedIdentity` already
            // rejects unknown `type` values at the wire boundary. Without
            // this throw, an unknown type would fall through and return
            // undefined, which callers would then cast to Identity and
            // crash downstream with an opaque error.
            throw new Error(
                `Unknown serialized identity type: ${String(
                    (s as { type: unknown }).type
                )}`
            );
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
export function normalizeSerializedIdentity(
    shape: SerializedIdentity | LegacySerializedIdentity
): SerializedIdentity {
    if ("type" in shape) {
        assertValidSerializedIdentity(shape);
        return shape;
    }
    if (!warnedLegacyShape) {
        warnedLegacyShape = true;
        console.warn(
            "[ts-sdk] Received legacy serialized identity shape " +
                "(privateKey/publicKey). Upgrade the page build to the latest " +
                "@arkade-os/sdk — this compatibility path will be removed in " +
                "the next major."
        );
    }
    if ("privateKey" in shape && typeof shape.privateKey === "string") {
        return { type: "single-key", privateKey: shape.privateKey };
    }
    if ("publicKey" in shape && typeof shape.publicKey === "string") {
        return { type: "readonly-single-key", publicKey: shape.publicKey };
    }
    throw new Error("Unrecognized serialized identity shape");
}

/**
 * Runtime-validate that a tagged envelope carries the fields its variant
 * requires. The SDK's own serializer produces well-formed envelopes; this
 * guard exists so a malformed message (older SDK version mismatch,
 * hand-built config, etc.) fails loudly at the wire boundary rather than
 * with an opaque `"Cannot read properties of undefined"` deep inside a
 * hydrator.
 */
function assertValidSerializedIdentity(s: {
    type: unknown;
}): asserts s is SerializedIdentity {
    const kind = s.type;
    const bad = (field: string, expected: string): never => {
        throw new Error(
            `Malformed serialized identity ({ type: ${JSON.stringify(kind)} }): ` +
                `missing or invalid "${field}" (expected ${expected})`
        );
    };
    const asStr = (key: string): string => {
        const v = (s as Record<string, unknown>)[key];
        return typeof v === "string" ? v : bad(key, "string");
    };
    switch (kind) {
        case "single-key":
            asStr("privateKey");
            return;
        case "readonly-single-key":
            asStr("publicKey");
            return;
        case "seed":
            asStr("seed");
            asStr("descriptor");
            return;
        case "mnemonic": {
            asStr("mnemonic");
            asStr("descriptor");
            const passphrase = (s as Record<string, unknown>).passphrase;
            if (passphrase !== undefined && typeof passphrase !== "string") {
                bad("passphrase", "string | undefined");
            }
            return;
        }
        case "readonly-descriptor":
            asStr("descriptor");
            return;
        default:
            throw new Error(
                `Unknown serialized identity type: ${String(kind)}`
            );
    }
}
