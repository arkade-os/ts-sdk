/**
 * covclaimd's Reveal API, client side: deliver your own sealed claim packet,
 * then go offline — instead of handing it to the solver to courier.
 *
 * The courier forwards a ciphertext it cannot read to whichever daemon its own
 * config names, and nothing checks that is the daemon the client sealed to.
 * Sealing to the key THIS base URL serves removes the mismatch by construction.
 */
import { base64, hex } from "@scure/base";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ArkAddress, type VHTLC } from "@arkade-os/sdk";

import { sealClaimPacket } from "./claimPacket";

/**
 * `retryable` is the point of the type: a 400 says the packet does not bind to
 * this address at this daemon — wrong key, script or taptree — and retrying
 * changes none of them. Only a full registry (429) and a transport fault (5xx,
 * or `status` 0 for a throwing `fetch`) are worth trying again.
 */
export class CovclaimdRevealError extends Error {
    readonly name = "CovclaimdRevealError";
    readonly status: number;
    readonly detail: string;
    readonly retryable: boolean;
    constructor(what: string, status: number, detail: string) {
        super(`covclaimd ${what} failed: ${status || "no response"} ${detail}`.trimEnd());
        this.status = status;
        this.detail = detail;
        this.retryable = status === 0 || status === 429 || status >= 500;
    }
}

export interface CovclaimdInfo {
    /** 33-byte compressed — feeds {@link sealClaimPacket} unchanged. */
    covclaimdPubkey: Uint8Array;
    /** Compressed hex — feeds `requestLightningReceive`'s `emulatorPubkey`. */
    emulatorPubkey: string;
}

/** The four fields `POST /v1/reveal` takes. */
export interface RevealParams {
    /** The funded lockup's Arkade address, bech32m. */
    swapAddress: string;
    /** `sealClaimPacket(...).ciphertext`, base64. */
    ciphertext: string;
    /** The covenant's `enforcePayTo` ArkadeScript, base64. */
    arkadeScript: string;
    /** The lockup's serialized taptree, hex. */
    taptree: string;
}

export interface CovclaimdClient {
    info(): Promise<CovclaimdInfo>;
    reveal(params: RevealParams): Promise<void>;
}

const decodeKey = (value: unknown, field: string): Uint8Array => {
    if (typeof value !== "string") throw new Error(`covclaimd info: ${field} is not a string`);
    let bytes: Uint8Array;
    try {
        bytes = hex.decode(value);
    } catch {
        throw new Error(`covclaimd info: ${field} is not hex`);
    }
    if (bytes.length !== 33) {
        throw new Error(`covclaimd info: ${field} must be 33-byte compressed, got ${bytes.length}`);
    }
    return bytes;
};

/** `fetchImpl` is injectable, matching `httpTransport` in `rfq.ts`. */
export const covclaimdClient = (
    baseUrl: string,
    options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): CovclaimdClient => {
    const url = baseUrl.replace(/\/+$/, "");
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? 30_000;

    const send = async (what: string, path: string, init: RequestInit): Promise<Response> => {
        let response: Response;
        try {
            response = await fetchImpl(`${url}${path}`, {
                ...init,
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (error) {
            throw new CovclaimdRevealError(what, 0, String(error));
        }
        if (!response.ok) {
            throw new CovclaimdRevealError(what, response.status, await response.text());
        }
        return response;
    };

    return {
        async info() {
            const response = await send("info", "/v1/preimage/covclaimd-pubkey", {
                method: "GET",
            });
            const body = (await response.json()) as Record<string, unknown> | null;
            return {
                covclaimdPubkey: decodeKey(body?.covclaimd_pub_key, "covclaimd_pub_key"),
                emulatorPubkey: hex.encode(decodeKey(body?.emulator_pub_key, "emulator_pub_key")),
            };
        },

        async reveal(params) {
            await send("reveal", "/v1/reveal", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    swap_address: params.swapAddress,
                    packet: { ciphertext: params.ciphertext, arkade_script: params.arkadeScript },
                    taptree: params.taptree,
                }),
            });
        },
    };
};

/**
 * The two wire fields that are functions of the covenant alone.
 *
 * A client-derived `arkadeScript` can differ from the funder's only if the
 * covenants differ: the script is tweaked into the non-interactive claim leaf's
 * co-signer key, so a different one is a different leaf, root, and lockup
 * address — already covered by the address check made before funding.
 */
export function revealFieldsFromScript(script: InstanceType<typeof VHTLC.ScriptV2>): {
    arkadeScript: string;
    taptree: string;
} {
    if (!script.nonInteractiveClaimArkadeScript) {
        throw new Error("this covenant has no non-interactive claim leaf to reveal against");
    }
    return {
        arkadeScript: base64.encode(script.nonInteractiveClaimArkadeScript),
        taptree: hex.encode(script.encode()),
    };
}

/**
 * Seal `P` to the daemon `client` speaks to and register it there, so covclaimd
 * claims the lockup once the solver funds it and the trader can go offline.
 *
 * Registration EXPIRES — covclaimd drops it 15 minutes after the last reveal —
 * and re-revealing refreshes rather than duplicates it, so a caller waiting on
 * a slow funding should reveal again, not once. The two gates below name a
 * cause covclaimd would otherwise report as an opaque 400.
 */
export async function revealClaimPacket(
    client: CovclaimdClient,
    input: {
        script: InstanceType<typeof VHTLC.ScriptV2>;
        address: string;
        /** `P`, 32 bytes, from the swap's `secrets`. */
        preimage: Uint8Array;
    },
): Promise<{ ciphertext: string }> {
    const fields = revealFieldsFromScript(input.script);

    if (
        hex.encode(ArkAddress.decode(input.address).pkScript) !== hex.encode(input.script.pkScript)
    ) {
        throw new Error("address does not belong to this covenant");
    }
    if (
        hex.encode(ripemd160(sha256(input.preimage))) !==
        hex.encode(input.script.options.preimageHash)
    ) {
        throw new Error("preimage does not match the covenant's payment hash");
    }

    const { ciphertext } = await sealClaimPacket({
        preimage: input.preimage,
        covclaimdPubkey: (await client.info()).covclaimdPubkey,
    });
    await client.reveal({ swapAddress: input.address, ciphertext, ...fields });
    return { ciphertext };
}
