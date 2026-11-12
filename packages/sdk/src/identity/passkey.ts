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
    /** Set when the passkey was created before this failure, so an app can still use it some other way. */
    credentialId?: Uint8Array;
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

/** The label of a passkey's first wallet, as in Breez's seedless-restore implementation. */
export const DEFAULT_PASSKEY_LABEL = "Default";

type Bytes = ArrayBuffer | ArrayBufferView | ArrayLike<number>;

const UNUSABLE = "This passkey returned no usable secret.";

// Some password managers return PRF results as plain arrays; everything is copied into a fresh Uint8Array.
function bytes(x: Bytes): Uint8Array<ArrayBuffer> {
    // A tag check, since `instanceof` fails for a buffer from another realm (an iframe bridge).
    if (Object.prototype.toString.call(x) === "[object ArrayBuffer]")
        return new Uint8Array((x as ArrayBuffer).slice(0));
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength).slice();
    // Uint8Array.from reads holes, nulls and out-of-range values as bytes, so a broken bridge's output could become a fixed, public secret.
    if (!Array.isArray(x)) throw new PrfUnavailable(UNUSABLE);
    for (let i = 0; i < x.length; i++) {
        const v: unknown = x[i];
        if (!(i in x) || !Number.isInteger(v) || (v as number) < 0 || (v as number) > 255)
            throw new PrfUnavailable(UNUSABLE);
    }
    return Uint8Array.from(x as number[]);
}

// A PRF output is exactly 32 bytes; anything else (a bridge's hex string, an empty buffer) is refused, never stretched into a key.
function secret(x: unknown): Uint8Array {
    const b = typeof x === "object" && x !== null ? bytes(x as Bytes) : null;
    if (!b || b.length !== 32) throw new PrfUnavailable(UNUSABLE);
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
        // By name: a bridge's error may come from another realm, and React Native has no DOMException.
        if (
            typeof e === "object" &&
            e !== null &&
            (e as { name?: unknown }).name === "NotAllowedError"
        )
            throw new PasskeyCancelled();
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
 * @throws PasskeyUnconfirmed when the passkey fails its first use right after creation, for any
 *   reason (`cause` holds the error); this and PrfUnavailable carry the new passkey's
 *   `credentialId`, since the passkey exists by then
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
    return confirmPrf(cred, credentialId, o, client).then(
        (prf) => ({ credentialId, prf }),
        (e) => {
            const err =
                e instanceof PrfUnavailable
                    ? e
                    : new PasskeyUnconfirmed(
                          "This passkey could not be used again right after it was made.",
                          { cause: e },
                      );
            err.credentialId = credentialId;
            throw err;
        },
    );
}

async function confirmPrf(
    cred: Credential,
    credentialId: Uint8Array,
    o: { rp: { id: string }; salt: Uint8Array },
    client: WebAuthnClient,
): Promise<Uint8Array> {
    const out = prfOf(cred);
    // No prf entry at all means the browser ignored the extension: a second prompt would fail the same way.
    if (!out?.results?.first && (!out || out.enabled === false))
        throw new PrfUnavailable("This passkey cannot derive a key.");
    // Copied before the next ceremony: a client may reuse the buffer for its result.
    const made = out.results?.first ? secret(out.results.first) : null;
    const { prf: used } = await evaluatePrf({
        rpId: o.rp.id,
        salt: o.salt,
        credentialIds: [credentialId],
        client,
    });
    if (made && !same(made, used)) {
        throw new PrfUnavailable("This passkey gave a different secret on its next use.");
    }
    return used;
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

/**
 * BIP39 words from a PRF secret. Twelve, from its first 16 bytes, is what Breez's SDK derives
 * (`prf_to_mnemonic`), so a Breez wallet using the same passkey and salt gets the same words.
 * Twenty-four, from all 32 bytes, is what the seedless-restore spec text's `BIP39(root_key)` reads as.
 */
export const mnemonicFromPrf = (prfSecret: Uint8Array, words: 12 | 24 = 12): string =>
    entropyToMnemonic(secret(prfSecret).slice(0, words === 24 ? 32 : 16), wordlist);
