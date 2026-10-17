import { gcm } from "@noble/ciphers/aes.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { concatBytes } from "@scure/btc-signer/utils.js";
import { assertTimerMs } from "../utils/time";
import { baseFetch } from "../utils/fetch";

export interface DelegateeInfo {
    network: string;
    serverPubkey: string;
    emulatorPubkey: string;
    encryptionPubkey: string;
}

export interface DelegateeWatch {
    address: string;
    status: string;
    templateId: string;
    expiresAt: number;
}

export interface DelegateeProvider {
    getInfo(): Promise<DelegateeInfo>;
    registerDelegation(request: {
        templateId: string;
        variables: Record<string, string>;
        expiresAt: number;
    }): Promise<DelegateeWatch>;
}

export class RestDelegateeProvider implements DelegateeProvider {
    private readonly url: string;
    private readonly timeoutMs: number;
    private readonly fetchImpl: typeof fetch;

    constructor(
        url: string,
        options: { fetchImpl?: typeof fetch; timeoutMs?: number; allowInsecureHttp?: boolean } = {},
    ) {
        const target = new URL(url);
        if (
            target.protocol !== "https:" &&
            !(
                target.protocol === "http:" &&
                (options.allowInsecureHttp ||
                    ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))
            )
        ) {
            throw new Error("delegatee key discovery requires HTTPS");
        }
        this.url = url.replace(/\/+$/, "");
        this.timeoutMs = options.timeoutMs ?? 30_000;
        assertTimerMs("timeoutMs", this.timeoutMs);
        this.fetchImpl = options.fetchImpl ?? baseFetch;
    }

    private async request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
        const response = await this.fetchImpl(`${this.url}${path}`, {
            ...init,
            redirect: "error",
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) throw new Error(`delegatee request failed: ${response.status}`);
        const body: unknown = await response.json();
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw new Error("invalid delegatee response");
        }
        return body as Record<string, unknown>;
    }

    async getInfo(): Promise<DelegateeInfo> {
        const body = await this.request("/v1/info");
        if (
            !["network", "serverPubkey", "emulatorPubkey", "encryptionPubkey"].every(
                (key) => typeof body[key] === "string",
            )
        ) {
            throw new Error("invalid delegatee info");
        }
        for (const name of ["serverPubkey", "emulatorPubkey", "encryptionPubkey"]) {
            if (!/^(02|03)[0-9a-f]{64}$/.test(body[name] as string)) {
                throw new Error(`delegatee has no usable ${name}`);
            }
            secp256k1.Point.fromHex(body[name] as string);
        }
        return body as unknown as DelegateeInfo;
    }

    async registerDelegation(request: {
        templateId: string;
        variables: Record<string, string>;
        expiresAt: number;
    }): Promise<DelegateeWatch> {
        const body = await this.request("/v1/delegate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                template_id: request.templateId,
                variables: request.variables,
                expires_at: request.expiresAt,
            }),
        });
        const watch = body.delegation as Record<string, unknown> | undefined;
        const expiresAt = Number(watch?.expiresAt);
        if (
            !watch ||
            typeof watch.address !== "string" ||
            typeof watch.status !== "string" ||
            typeof watch.templateId !== "string" ||
            !Number.isSafeInteger(expiresAt) ||
            expiresAt <= 0
        ) {
            throw new Error("invalid delegatee watch");
        }
        return {
            address: watch.address,
            status: watch.status,
            templateId: watch.templateId,
            expiresAt,
        };
    }
}

export function sealDelegateeSecrets(input: {
    templateId: string;
    encryptionPubkey: Uint8Array;
    values: Record<string, Uint8Array>;
}): Uint8Array {
    if (!/^[0-9a-f]{64}$/.test(input.templateId)) throw new Error("invalid delegatee template id");
    if (input.encryptionPubkey.length !== 33) throw new Error("encryption key must be compressed");
    const plaintext = new TextEncoder().encode(
        JSON.stringify({
            format: "delegatee-secrets/v1",
            template_id: input.templateId,
            values: Object.fromEntries(
                Object.entries(input.values).map(([name, value]) => [name, hex.encode(value)]),
            ),
        }),
    );
    if (plaintext.length > 459) throw new Error("delegatee secrets exceed the template byte limit");
    const ephemeralKey = secp256k1.utils.randomSecretKey();
    const ephemeralPub = secp256k1.getPublicKey(ephemeralKey, true);
    const shared = secp256k1
        .getSharedSecret(ephemeralKey, input.encryptionPubkey, true)
        .subarray(1);
    // The domain is the deployed ECIES wire contract, shared with covclaimd.
    const key = hkdf(
        sha256,
        shared,
        ephemeralPub,
        new TextEncoder().encode("covclaimd/preimage/v1"),
        32,
    );
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    return concatBytes(ephemeralPub, nonce, gcm(key, nonce, ephemeralPub).encrypt(plaintext));
}
