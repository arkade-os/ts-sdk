/**
 * Enclave response signatures (ArkLabsHQ/enclave#205): a request carrying `X-Enclave-Sign-Nonce`
 * gets back `X-Enclave-Signature`, an Ed25519 signature by the attested key over the request it
 * received and the response it produced. Port of the Go client's `client/signed_request.go`.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "@noble/curves/utils.js";
import { base64, hex } from "@scure/base";
import { sha256 } from "@scure/btc-signer/utils.js";
import { EnclaveAttestationError } from "../providers/errors";
import { baseFetch } from "../utils/fetch";

export const SIGN_NONCE_HEADER = "X-Enclave-Sign-Nonce";
export const SIGNATURE_HEADER = "X-Enclave-Signature";
// The request headers a signature covers; every other header varies in transit.
const COVERED_HEADERS = ["authorization", "content-type", "x-enclave-sign-nonce"];

/**
 * SHA-256 of the covered request headers: per present name, sorted, `name:` then the base64 of
 * each value (edge spaces and tabs trimmed) joined by commas, then a newline.
 */
export function canonicalHeadersHash(headers: Iterable<[string, string]>): Uint8Array {
    const fields = new Map<string, string[]>();
    for (const [name, value] of headers) {
        const lower = name.toLowerCase();
        if (!COVERED_HEADERS.includes(lower)) continue;
        fields.set(lower, [...(fields.get(lower) ?? []), value.replace(/^[ \t]+|[ \t]+$/g, "")]);
    }
    const canonical = [...fields]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(
            ([name, values]) =>
                `${name}:${values.map((v) => base64.encode(rawBytes(v))).join(",")}\n`,
        )
        .join("");
    return sha256(new TextEncoder().encode(canonical));
}

export interface SignedRequest {
    method: string;
    /** Path, then `?query` only when the query is non-empty. */
    target: string;
    /** Lowercase `Host`, including an explicit port. */
    authority: string;
    headersHash: Uint8Array;
    bodyHash: Uint8Array;
}

/** The bytes the enclave signs for `request` answered with `status` and a body hashing to `bodyHash`. */
export function signedResponseMessage(
    request: SignedRequest,
    status: number,
    responseBodyHash: Uint8Array,
): Uint8Array {
    return new TextEncoder().encode(
        [
            "enclave-signed-response",
            `${request.method} ${request.target}`,
            request.authority,
            hex.encode(request.headersHash),
            hex.encode(request.bodyHash),
            String(status),
            hex.encode(responseBodyHash),
        ].join("\n"),
    );
}

/**
 * GET `url` asking the enclave to sign its answer, and verify a 2xx answer with `signingKey`
 * (from `attestEnclave`). Other statuses come back unverified for the caller's error path:
 * their bodies are never trusted, and the runtime's 503 before its app starts is unsigned.
 *
 * Uses `baseFetch`, so the only extra header is the nonce (the one the CORS preflight must
 * allow), and no `cache` option: React Native turns `no-store` into a query parameter, which
 * would change the signed path.
 *
 * @throws {EnclaveAttestationError} a 2xx response whose signature is missing or invalid.
 */
export async function signedGet(
    url: string,
    signingKey: Uint8Array,
    init?: { signal?: AbortSignal },
): Promise<{ response: Response; body: Uint8Array }> {
    const nonce = hex.encode(randomBytes(16));
    const response = await baseFetch(url, {
        headers: { [SIGN_NONCE_HEADER]: nonce },
        redirect: "error",
        signal: init?.signal,
    });
    const body = new Uint8Array(await response.arrayBuffer());
    if (!response.ok) return { response, body };

    const parsed = new URL(url);
    const message = signedResponseMessage(
        {
            method: "GET",
            target: parsed.pathname + parsed.search,
            authority: parsed.host.toLowerCase(),
            headersHash: canonicalHeadersHash([[SIGN_NONCE_HEADER, nonce]]),
            bodyHash: sha256(new Uint8Array(0)),
        },
        response.status,
        sha256(body),
    );
    const signature = response.headers.get(SIGNATURE_HEADER);
    if (!signature) {
        throw new EnclaveAttestationError(
            `no ${SIGNATURE_HEADER} from ${parsed.origin}${parsed.pathname}; the enclave runtime ` +
                `must sign responses, and in a browser expose the header ` +
                `(Access-Control-Expose-Headers)`,
        );
    }
    if (!verifyEd25519(signature, message, signingKey)) {
        throw new EnclaveAttestationError(
            `invalid ${SIGNATURE_HEADER} from ${parsed.origin}${parsed.pathname}`,
        );
    }
    return { response, body };
}

function verifyEd25519(signature: string | null, message: Uint8Array, key: Uint8Array): boolean {
    if (!signature) return false;
    try {
        return ed25519.verify(base64.decode(signature), message, key, { zip215: false });
    } catch {
        return false;
    }
}

/** Header values are byte strings; the signature covers those raw bytes. */
function rawBytes(value: string): Uint8Array {
    return Uint8Array.from(value, (char) => {
        const code = char.charCodeAt(0);
        if (code > 0xff) throw new Error("header value is not a byte string");
        return code;
    });
}
