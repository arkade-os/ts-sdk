import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { WebAuthnClient } from "../src/identity/passkey";

interface Held {
    id: Uint8Array;
    secret: Uint8Array;
    userHandle: Uint8Array;
    rpId: string;
}

export interface FakeKnobs {
    prf: boolean;
    prfOnCreate: boolean;
    arrays: boolean;
    cancel: boolean;
    getFails: boolean;
    result: "bytes" | "string" | "empty";
    drift: boolean;
}

const copy = (b: BufferSource) =>
    new Uint8Array(
        b instanceof ArrayBuffer ? b : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
    );
const saltOf = (e: unknown) =>
    (e as { prf?: { eval?: { first: BufferSource } } } | undefined)?.prf?.eval?.first;

/** In-memory authenticator; its PRF is HMAC-SHA256 under a per-credential secret, as CTAP hmac-secret is. */
export class FakeAuthenticator implements WebAuthnClient {
    readonly held: Held[] = [];
    gets = 0;
    knobs: FakeKnobs;

    constructor(knobs: Partial<FakeKnobs> = {}) {
        this.knobs = {
            prf: true,
            prfOnCreate: true,
            arrays: false,
            cancel: false,
            getFails: false,
            result: "bytes",
            drift: false,
            ...knobs,
        };
    }

    async create(o: CredentialCreationOptions): Promise<Credential | null> {
        if (this.knobs.cancel) throw new DOMException("cancelled", "NotAllowedError");
        const pk = o.publicKey!;
        const held = {
            id: crypto.getRandomValues(new Uint8Array(16)),
            secret: crypto.getRandomValues(new Uint8Array(32)),
            userHandle: copy(pk.user.id),
            rpId: pk.rp.id!,
        };
        this.held.push(held);
        const salt = saltOf(pk.extensions);
        if (!this.knobs.prf) return this.credential(held, { enabled: false });
        return this.credential(
            held,
            this.knobs.prfOnCreate && salt
                ? { enabled: true, first: this.prf(held, salt) }
                : { enabled: true },
        );
    }

    async get(o: CredentialRequestOptions): Promise<Credential | null> {
        this.gets++;
        if (this.knobs.cancel || this.knobs.getFails)
            throw new DOMException("cancelled", "NotAllowedError");
        const pk = o.publicKey!;
        const allowed = pk.allowCredentials?.map((c) => bytesToHex(copy(c.id)));
        const held = [...this.held]
            .reverse()
            .find(
                (h) =>
                    h.rpId === pk.rpId && (!allowed?.length || allowed.includes(bytesToHex(h.id))),
            );
        if (!held) throw new DOMException("no such passkey", "NotAllowedError");
        const salt = saltOf(pk.extensions);
        return this.credential(
            held,
            this.knobs.prf && salt ? { first: this.prf(held, salt, this.knobs.drift) } : {},
        );
    }

    private prf = (h: Held, salt: BufferSource, drift = false) =>
        hmac(sha256, drift ? h.secret.map((b) => b ^ 1) : h.secret, copy(salt));

    private credential(h: Held, prf: { enabled?: boolean; first?: Uint8Array }): Credential {
        const out = (b: Uint8Array) =>
            this.knobs.result === "string"
                ? bytesToHex(b)
                : this.knobs.result === "empty"
                  ? new ArrayBuffer(0)
                  : this.knobs.arrays
                    ? [...b]
                    : b.slice().buffer;
        const results = prf.first ? { results: { first: out(prf.first) } } : {};
        return {
            id: bytesToHex(h.id),
            type: "public-key",
            rawId: h.id.slice().buffer,
            response: { userHandle: h.userHandle.slice().buffer },
            getClientExtensionResults: () => ({
                prf: { ...(prf.enabled === undefined ? {} : { enabled: prf.enabled }), ...results },
            }),
        } as unknown as Credential;
    }
}
