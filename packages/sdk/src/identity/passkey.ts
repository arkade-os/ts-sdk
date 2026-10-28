import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

/** The two WebAuthn calls a passkey needs; `navigator.credentials` in a browser, or a native bridge. */
export interface WebAuthnClient {
    create(options: CredentialCreationOptions): Promise<Credential | null>;
    get(options: CredentialRequestOptions): Promise<Credential | null>;
}

/** The browser or the authenticator cannot return a PRF secret, so this passkey cannot derive a key. */
export class PrfUnavailable extends Error {
    name = "PrfUnavailable";
}

/** The user dismissed the passkey prompt. */
export class PasskeyCancelled extends Error {
    name = "PasskeyCancelled";
    constructor(message = "The passkey prompt was cancelled.") {
        super(message);
    }
}

/**
 * A new passkey failed its first use. A cancel and an authenticator that never repeats its PRF
 * (Windows Hello) are the same `NotAllowedError`, so offer another way rather than prompt again.
 */
export class PasskeyUnconfirmed extends PrfUnavailable {
    name = "PasskeyUnconfirmed";
}

/** The PRF salt and HKDF label keys derive under; changing either changes every key. */
export interface PasskeyDomain {
    salt: Uint8Array;
    label: string;
}

export const DEFAULT_PASSKEY_DOMAIN: PasskeyDomain = {
    salt: sha256(utf8ToBytes("arkade/passkey/mnemonic/v1")),
    label: "arkade/passkey/mnemonic/v1",
};

type Bytes = ArrayBuffer | ArrayBufferView | ArrayLike<number>;

// Some password managers return PRF results as plain arrays; everything is copied into a fresh Uint8Array.
function bytes(x: Bytes): Uint8Array<ArrayBuffer> {
    if (x instanceof ArrayBuffer) return new Uint8Array(x.slice(0));
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength).slice();
    return Uint8Array.from(x);
}

// A PRF output is exactly 32 bytes; anything else (a bridge's hex string, an empty buffer) is refused, never stretched into a key.
function secret(x: unknown): Uint8Array {
    const b = typeof x === "object" && x !== null ? bytes(x as Bytes) : null;
    if (!b || b.length !== 32) throw new PrfUnavailable("This passkey returned no usable secret.");
    return b;
}

const same = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((v, i) => v === b[i]);
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const prf = (salt: Uint8Array) =>
    ({ prf: { eval: { first: bytes(salt) } } }) as AuthenticationExtensionsClientInputs;
const prfOf = (c: Credential) =>
    (c as PublicKeyCredential).getClientExtensionResults().prf as
        | { enabled?: boolean; results?: { first?: Bytes } }
        | undefined;

function browser(): WebAuthnClient {
    if (typeof navigator === "undefined" || !navigator.credentials) {
        throw new PrfUnavailable("No WebAuthn here; pass a client.");
    }
    return navigator.credentials;
}

async function ask(prompt: () => Promise<Credential | null>): Promise<Credential> {
    let c: Credential | null;
    try {
        c = await prompt();
    } catch (e) {
        if (e instanceof DOMException && e.name === "NotAllowedError") throw new PasskeyCancelled();
        throw e;
    }
    if (!c) throw new PasskeyCancelled();
    return c;
}

/** Whether this browser says its passkeys can do PRF; `"unknown"` where it cannot tell before trying. */
export async function prfSupport(): Promise<"yes" | "no" | "unknown"> {
    if (typeof PublicKeyCredential === "undefined") return "no";
    const read = (
        PublicKeyCredential as unknown as {
            getClientCapabilities?: () => Promise<Record<string, boolean>>;
        }
    ).getClientCapabilities;
    const caps = await read?.call(PublicKeyCredential).catch(() => undefined);
    const has = caps?.["extension:prf"];
    return has === true ? "yes" : has === false ? "no" : "unknown";
}

/**
 * Creates a discoverable passkey that requires user verification, then uses it once and returns
 * that use's PRF secret: a key must never depend on a secret its passkey cannot give again. When
 * creation returns no PRF result there is nothing to compare that use against, so an authenticator
 * that changes its secret later is not caught here; it derives other words on the next sign-in.
 *
 * @throws PrfUnavailable when the authenticator cannot do PRF or gives another secret on reuse
 * @throws PasskeyUnconfirmed when the passkey fails its first use right after creation
 * @throws PasskeyCancelled when the user dismisses the prompt
 */
export async function createPrfPasskey(o: {
    rp: { id: string; name: string };
    userId: Uint8Array;
    userName: string;
    salt: Uint8Array;
    client?: WebAuthnClient;
}): Promise<{ credentialId: Uint8Array; prf: Uint8Array }> {
    const client = o.client ?? browser();
    const cred = await ask(() =>
        client.create({
            publicKey: {
                rp: o.rp,
                user: { id: bytes(o.userId), name: o.userName, displayName: o.userName },
                challenge: random(32),
                pubKeyCredParams: [
                    { type: "public-key", alg: -7 },
                    { type: "public-key", alg: -257 },
                ],
                authenticatorSelection: { residentKey: "required", userVerification: "required" },
                extensions: prf(o.salt),
            },
        }),
    );
    const credentialId = bytes((cred as PublicKeyCredential).rawId);
    const out = prfOf(cred);
    // No prf entry at all means the browser ignored the extension: a second prompt would fail the same way.
    if (!out?.results?.first && (!out || out.enabled === false))
        throw new PrfUnavailable("This passkey cannot derive a key.");
    const used = (
        await evaluatePrf({
            rpId: o.rp.id,
            salt: o.salt,
            credentialIds: [credentialId],
            client,
        }).catch((e) => {
            throw e instanceof PasskeyCancelled
                ? new PasskeyUnconfirmed(
                      "This passkey could not be used again right after it was made.",
                  )
                : e;
        })
    ).prf;
    if (out.results?.first && !same(secret(out.results.first), used)) {
        throw new PrfUnavailable("This passkey gave a different secret on its next use.");
    }
    return { credentialId, prf: used };
}

/**
 * Uses a passkey and returns its PRF secret for `salt`. With no `credentialIds` the browser offers
 * every passkey for `rpId`; `userHandle` then says which one was picked.
 */
export async function evaluatePrf(o: {
    rpId: string;
    salt: Uint8Array;
    credentialIds?: Uint8Array[];
    client?: WebAuthnClient;
}): Promise<{ credentialId: Uint8Array; userHandle: Uint8Array | null; prf: Uint8Array }> {
    const client = o.client ?? browser();
    const cred = await ask(() =>
        client.get({
            publicKey: {
                challenge: random(32),
                rpId: o.rpId,
                allowCredentials: o.credentialIds?.map((id) => ({
                    type: "public-key",
                    id: bytes(id),
                })),
                userVerification: "required",
                extensions: prf(o.salt),
            },
        }),
    );
    const first = prfOf(cred)?.results?.first;
    if (first === undefined) throw new PrfUnavailable("This passkey cannot derive a key.");
    const handle = ((cred as PublicKeyCredential).response as AuthenticatorAssertionResponse)
        .userHandle;
    return {
        credentialId: bytes((cred as PublicKeyCredential).rawId),
        userHandle: handle ? bytes(handle) : null,
        prf: secret(first),
    };
}

/** Twelve BIP39 words from a PRF secret: the same passkey and label always give the same words. */
export const mnemonicFromPrf = (prfSecret: Uint8Array, label: string): string =>
    entropyToMnemonic(hkdf(sha256, prfSecret, undefined, utf8ToBytes(label), 16), wordlist);
