/**
 * AWS Nitro attestation, as the enclave runtime serves it at `/enclave/attestation`. Port of the
 * enclave's Go client (`client/verify.go`, `hf/nitrite`): the document is a COSE_Sign1 whose
 * leaf certificate chains to the AWS Nitro root, and its `user_data` carries the Ed25519 key the
 * runtime signs responses with.
 */

import { randomBytes } from "@noble/curves/utils.js";
import { base64, hex } from "@scure/base";
import { equalBytes } from "@scure/btc-signer/utils.js";
import { EnclaveAttestationError, throwIfHttpUnavailable } from "../providers/errors";
import { baseFetch } from "../utils/fetch";
import { type CborMap, decodeCbor, encodeCbor } from "./cbor";
import { verifyChain, verifyP384 } from "./x509";

/**
 * The AWS Nitro Enclaves root certificate (CN=aws.nitro-enclaves, ECDSA P-384, valid 2019-10-28 to
 * 2049-10-28), DER. SHA-256 fingerprint
 * 641A0321A3E244EFE456463195D606317ED7CDCC3C1756E09893F3C68F79BB5B, as AWS documents and as the
 * enclave's Go client trusts it (hf/nitrite `DefaultCARoots`).
 */
export const AWS_NITRO_ROOTS: readonly Uint8Array[] = [
    base64.decode(
        "MIICETCCAZagAwIBAgIRAPkxdWgbkK/hHUbMtOTn+FYwCgYIKoZIzj0EAwMwSTELMAkGA1UEBhMCVVMxDzANBgNV" +
            "BAoMBkFtYXpvbjEMMAoGA1UECwwDQVdTMRswGQYDVQQDDBJhd3Mubml0cm8tZW5jbGF2ZXMwHhcNMTkxMDI4MTMy" +
            "ODA1WhcNNDkxMDI4MTQyODA1WjBJMQswCQYDVQQGEwJVUzEPMA0GA1UECgwGQW1hem9uMQwwCgYDVQQLDANBV1Mx" +
            "GzAZBgNVBAMMEmF3cy5uaXRyby1lbmNsYXZlczB2MBAGByqGSM49AgEGBSuBBAAiA2IABPwCVOumCMHzaHDimtqQ" +
            "vkY4MpJzbolL//Zy2YlES1BR5TSksfbb48C8WBoyt7F2Bw7eEtaaP+ohG2bnUs990d0JX28TcPQXCEPZ3BABIeTP" +
            "YwEoCWZEh8l5YoQwTcU/9KNCMEAwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUkCW1DdkFR+eWw5b6cp3Pmanf" +
            "S5YwDgYDVR0PAQH/BAQDAgGGMAoGCCqGSM49BAMDA2kAMGYCMQCjfy+Rocm9Xue4YnwWmNJVA44fA0P5W2OpYow9" +
            "OYCVRaEevL8uO1XYru5xtMPWrfMCMQCi85sWBbJwKKXdS6BptQFuZbT73o/gBh1qUxl/nNr12UO8Yfwr6wPLb+6N" +
            "IwLz3/Y=",
    ),
];

export interface EnclaveAttestationConfig {
    /** The enclave images (PCR0s, 96 hex chars each) to trust; list old and new during an upgrade. */
    pcr0: readonly string[];
    /**
     * Trust anchors (DER) for the attestation's certificate chain. Defaults to
     * {@link AWS_NITRO_ROOTS}; set only for tests or an enclave environment outside AWS.
     */
    roots?: readonly Uint8Array[];
}

export interface NitroDocument {
    moduleId: string;
    timestamp: number;
    pcrs: Map<number, Uint8Array>;
    nonce?: Uint8Array;
    userData?: Uint8Array;
}

const ES384 = -35;
const MAX_FIELD = 1024;

/** Verify the COSE_Sign1 envelope, payload bounds and certificate chain (at `nowMs`). */
export function verifyNitroAttestation(
    doc: Uint8Array,
    opts: { nowMs: number; roots?: readonly Uint8Array[] },
): NitroDocument {
    const envelope = decodeCbor(doc);
    if (!Array.isArray(envelope) || envelope.length !== 4) {
        throw new Error("attestation is not a COSE_Sign1 array");
    }
    const [protectedHeader, , payload, signature] = envelope;
    if (!isBytes(protectedHeader) || !isBytes(payload) || !isBytes(signature)) {
        throw new Error("malformed COSE_Sign1");
    }
    const alg = asMap(decodeCbor(protectedHeader), "protected header").get(1);
    if (alg !== ES384 && alg !== "ES384") throw new Error("COSE algorithm is not ES384");

    const fields = asMap(decodeCbor(payload), "payload");
    const moduleId = fields.get("module_id");
    const timestamp = fields.get("timestamp");
    const pcrs = asMap(fields.get("pcrs"), "pcrs");
    const certificate = fields.get("certificate");
    const cabundle = fields.get("cabundle");
    if (typeof moduleId !== "string" || moduleId === "") throw new Error("missing module_id");
    if (fields.get("digest") !== "SHA384") throw new Error("digest is not SHA384");
    if (typeof timestamp !== "number" || timestamp <= 0) throw new Error("missing timestamp");
    if (pcrs.size < 1 || pcrs.size > 32) throw new Error("pcrs out of bounds");
    for (const [index, value] of pcrs) {
        if (typeof index !== "number" || index < 0 || index > 31) throw new Error("bad PCR index");
        if (!isBytes(value) || ![32, 48, 64].includes(value.length)) {
            throw new Error("bad PCR value");
        }
    }
    if (!isBytes(certificate) || certificate.length === 0) throw new Error("missing certificate");
    if (
        !Array.isArray(cabundle) ||
        cabundle.length === 0 ||
        !cabundle.every((c) => isBytes(c) && c.length > 0 && c.length <= MAX_FIELD)
    ) {
        throw new Error("bad cabundle");
    }
    const optional = (key: string): Uint8Array | undefined => {
        const value = fields.get(key);
        if (value === undefined || value === null) return undefined;
        if (!isBytes(value) || value.length > MAX_FIELD) throw new Error(`bad ${key}`);
        return value;
    };
    const nonce = optional("nonce");
    const userData = optional("user_data");
    optional("public_key");

    const leaf = verifyChain(
        certificate,
        cabundle as Uint8Array[],
        opts.roots ?? AWS_NITRO_ROOTS,
        opts.nowMs,
    );
    const sigStructure = encodeCbor(["Signature1", protectedHeader, new Uint8Array(0), payload]);
    if (!verifyP384(signature, sigStructure, leaf.publicKey, "compact")) {
        throw new Error("invalid COSE signature");
    }
    return {
        moduleId,
        timestamp,
        pcrs: pcrs as Map<number, Uint8Array>,
        nonce,
        userData,
    };
}

const TLS_PREFIX = new TextEncoder().encode("sha256:");
const KEY_PREFIX = new TextEncoder().encode("ed25519:");

/**
 * Check what the app trusts: the nonce it sent, an accepted PCR0, and the 79-byte `user_data`
 * (`sha256:` + TLS key hash + `ed25519:` + response signing key). Returns the signing key.
 */
export function checkAttestationPolicy(
    doc: NitroDocument,
    policy: { nonce: Uint8Array; pcr0: readonly string[] },
): Uint8Array {
    if (!doc.nonce || !equalBytes(doc.nonce, policy.nonce)) {
        throw new Error("attestation nonce does not match the request");
    }
    const pcr0 = doc.pcrs.get(0);
    if (!pcr0 || !policy.pcr0.includes(hex.encode(pcr0))) {
        throw new Error(`PCR0 ${pcr0 ? hex.encode(pcr0) : "(missing)"} is not an accepted image`);
    }
    const data = doc.userData;
    if (data?.length !== 79) throw new Error("user_data is not the 79-byte key layout");
    if (
        !equalBytes(data.subarray(0, 7), TLS_PREFIX) ||
        !equalBytes(data.subarray(39, 47), KEY_PREFIX)
    ) {
        throw new Error("user_data prefixes are wrong");
    }
    if (data.subarray(7, 39).every((b) => b === 0)) throw new Error("TLS key hash is empty");
    const signingKey = data.slice(47, 79);
    if (signingKey.every((b) => b === 0)) {
        throw new Error("enclave has no response signing key yet");
    }
    return signingKey;
}

/** Normalize and validate an accepted-PCR0 list: non-empty, 96 hex chars each, lowercased. */
export function normalizePcr0s(config: EnclaveAttestationConfig): string[] {
    const list: unknown = config.pcr0;
    if (
        !Array.isArray(list) ||
        list.length === 0 ||
        !list.every((value) => typeof value === "string" && /^[0-9a-f]{96}$/i.test(value))
    ) {
        throw new Error(
            "Enclave attestation needs a non-empty pcr0 list of 96-hex-char (SHA-384) values.",
        );
    }
    return list.map((value: string) => value.toLowerCase());
}

/**
 * Attest the enclave behind `serverUrl` and return its Ed25519 response signing key, to verify
 * its signed responses with (`signedGet`). The runtime serves the document at the origin root,
 * whatever path `serverUrl` carries. A path works only when the enclave itself receives it:
 * signed responses cover the path the enclave saw, so a proxy that strips or rewrites it on the
 * way breaks them.
 *
 * @throws {Error} before any request, for an empty or malformed `pcr0` list or a `serverUrl`
 *   that isn't an absolute URL.
 * @throws {EnclaveAttestationError} the document fails verification or names an unaccepted image.
 * @throws {ProviderUnavailableError} the enclave answers 429/5xx (503 until its app starts).
 */
export async function attestEnclave(
    serverUrl: string,
    config: EnclaveAttestationConfig,
    signal?: AbortSignal,
): Promise<Uint8Array> {
    const pcr0 = normalizePcr0s(config);
    const nonce = randomBytes(20);
    const url = new URL("/enclave/attestation", serverUrl);
    url.searchParams.set("nonce", hex.encode(nonce));

    const response = await baseFetch(url.toString(), { redirect: "error", signal });
    const body = (await response.text()).trim();
    throwIfHttpUnavailable(response, "enclave");
    if (!response.ok) {
        throw new EnclaveAttestationError(`enclave attestation request failed: ${response.status}`);
    }
    try {
        const encoded = body.startsWith("{") ? JSON.parse(body).document : body;
        const doc = verifyNitroAttestation(base64.decode(encoded), {
            nowMs: Date.now(),
            roots: config.roots,
        });
        return checkAttestationPolicy(doc, { nonce, pcr0 });
    } catch (err) {
        throw new EnclaveAttestationError(
            `enclave attestation failed: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
        );
    }
}

function isBytes(value: unknown): value is Uint8Array {
    return value instanceof Uint8Array;
}

function asMap(value: unknown, what: string): CborMap {
    if (!(value instanceof Map)) throw new Error(`${what} is not a map`);
    return value;
}
