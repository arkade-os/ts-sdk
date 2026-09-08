/** The wire shape asserted here is covclaimd's own, read off its handler and
 * proto — not one invented to match the code. */
import { describe, expect, it } from "vitest";
import { base64, hex } from "@scure/base";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";

import {
    CovclaimdRevealError,
    covclaimdClient,
    revealClaimPacket,
    revealFieldsFromScript,
} from "../src/reveal";
import { lightningReceiveContract } from "../src/rfq";
import { openClaimPacket } from "./helpers/claimPacket";

const PREIMAGE = new Uint8Array(32).fill(7);
const COVCLAIMD_SK = new Uint8Array(32).fill(0x22);
const COVCLAIMD_PK = secp256k1.getPublicKey(COVCLAIMD_SK, true);
const EMULATOR_PK = secp256k1.getPublicKey(new Uint8Array(32).fill(0x33), true);
const xonly = (key: Uint8Array): Uint8Array => key.slice(1);
const p2tr = (fill: number): Uint8Array =>
    Uint8Array.from([0x51, 0x20, ...new Uint8Array(32).fill(fill)]);

const covenant = (overrides: { payoutPkScript?: Uint8Array } = {}) =>
    lightningReceiveContract({
        solverPubkey: xonly(secp256k1.getPublicKey(new Uint8Array(32).fill(0x44), true)),
        refundLocktime: 1_800_000,
        operatorPubkey: xonly(secp256k1.getPublicKey(new Uint8Array(32).fill(0x55), true)),
        paymentHash: hex.encode(sha256(PREIMAGE)),
        claimDelay: 512,
        emulatorPubkey: xonly(EMULATOR_PK),
        solverRefundPkScript: p2tr(0x51),
        payoutPubkey: xonly(secp256k1.getPublicKey(new Uint8Array(32).fill(0x66), true)),
        payoutPkScript: overrides.payoutPkScript ?? p2tr(0x52),
    });

const addressOf = (script: ReturnType<typeof covenant>): string =>
    script.address("ark", script.options.server).encode();

/** A `fetch` double recording every call, answering from a queue of responses. */
const stubFetch = (
    replies: Array<{ status?: number; body?: string }>,
): { impl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const impl = (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const reply = replies.shift() ?? { status: 200, body: "{}" };
        const status = reply.status ?? 200;
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => JSON.parse(reply.body ?? "{}"),
            text: async () => reply.body ?? "",
        } as Response;
    }) as unknown as typeof fetch;
    return { impl, calls };
};

const infoBody = JSON.stringify({
    covclaimd_pub_key: hex.encode(COVCLAIMD_PK),
    emulator_pub_key: hex.encode(EMULATOR_PK),
});

describe("revealFieldsFromScript", () => {
    it("derives arkade_script as base64 of the covenant's own NIC arkade script", () => {
        const script = covenant();
        expect(revealFieldsFromScript(script).arkadeScript).toBe(
            base64.encode(script.nonInteractiveClaimArkadeScript!),
        );
    });

    it("derives taptree as hex of the covenant's serialized tree", () => {
        const script = covenant();
        expect(revealFieldsFromScript(script).taptree).toBe(hex.encode(script.encode()));
    });

    it("binds the arkade script to the address: a different payout gives both a new script and a new address", () => {
        const a = covenant();
        const b = covenant({ payoutPkScript: p2tr(0x53) });
        expect(revealFieldsFromScript(b).arkadeScript).not.toBe(
            revealFieldsFromScript(a).arkadeScript,
        );
        expect(addressOf(b)).not.toBe(addressOf(a));
    });

    it("refuses a covenant with no non-interactive claim leaf", () => {
        const script = covenant();
        const bare = Object.create(Object.getPrototypeOf(script), {
            nonInteractiveClaimArkadeScript: { value: undefined },
        }) as typeof script;
        expect(() => revealFieldsFromScript(bare)).toThrow(/no non-interactive claim leaf/);
    });
});

describe("covclaimdClient", () => {
    it("GETs the pubkey endpoint and decodes both keys", async () => {
        const { impl, calls } = stubFetch([{ body: infoBody }]);
        const info = await covclaimdClient("https://cov.example", { fetchImpl: impl }).info();
        expect(calls[0].url).toBe("https://cov.example/v1/preimage/covclaimd-pubkey");
        expect(hex.encode(info.covclaimdPubkey)).toBe(hex.encode(COVCLAIMD_PK));
        expect(info.emulatorPubkey).toBe(hex.encode(EMULATOR_PK));
    });

    it("strips trailing slashes from the base URL", async () => {
        const { impl, calls } = stubFetch([{ body: infoBody }]);
        await covclaimdClient("https://cov.example//", { fetchImpl: impl }).info();
        expect(calls[0].url).toBe("https://cov.example/v1/preimage/covclaimd-pubkey");
    });

    it("refuses plain http to a remote host: the key served decides where P is sealed", () => {
        const { impl } = stubFetch([{ body: infoBody }]);
        expect(() => covclaimdClient("http://cov.example", { fetchImpl: impl })).toThrow(
            /must be https/,
        );
    });

    it("allows plain http to loopback, which covclaimd itself defaults to", async () => {
        for (const base of [
            "http://localhost:7271",
            "http://127.0.0.1:7271",
            "http://[::1]:7271",
        ]) {
            const { impl, calls } = stubFetch([{ body: infoBody }]);
            await covclaimdClient(base, { fetchImpl: impl }).info();
            expect(calls[0].url, base).toBe(`${base}/v1/preimage/covclaimd-pubkey`);
        }
    });

    it("allows plain http to a remote host only on an explicit opt-out", async () => {
        const { impl, calls } = stubFetch([{ body: infoBody }]);
        await covclaimdClient("http://cov.example", {
            fetchImpl: impl,
            allowInsecureHttp: true,
        }).info();
        expect(calls[0].url).toBe("http://cov.example/v1/preimage/covclaimd-pubkey");
    });

    it("refuses redirects, which would move the key fetch off the vetted origin", async () => {
        const { impl, calls } = stubFetch([{ body: infoBody }]);
        await covclaimdClient("https://cov.example", { fetchImpl: impl }).info();
        expect(calls[0].init?.redirect).toBe("error");
    });

    it("refuses a pubkey that is not 33-byte compressed", async () => {
        const body = JSON.stringify({
            covclaimd_pub_key: hex.encode(COVCLAIMD_PK.slice(1)),
            emulator_pub_key: hex.encode(EMULATOR_PK),
        });
        const { impl } = stubFetch([{ body }]);
        await expect(
            covclaimdClient("https://cov.example", { fetchImpl: impl }).info(),
        ).rejects.toThrow(/covclaimd_pub_key must be 33-byte compressed, got 32/);
    });

    it("refuses a pubkey that is not hex", async () => {
        const body = JSON.stringify({ covclaimd_pub_key: "zz", emulator_pub_key: "00" });
        const { impl } = stubFetch([{ body }]);
        await expect(
            covclaimdClient("https://cov.example", { fetchImpl: impl }).info(),
        ).rejects.toThrow(/covclaimd_pub_key is not hex/);
    });

    it("reports a 200 carrying a non-JSON body as CovclaimdRevealError, not SyntaxError", async () => {
        const { impl } = stubFetch([{ body: "<html>502 Bad Gateway</html>" }]);
        const error = await covclaimdClient("https://cov.example", { fetchImpl: impl })
            .info()
            .catch((e: unknown) => e as CovclaimdRevealError);
        expect(error).toBeInstanceOf(CovclaimdRevealError);
        expect(error.status).toBe(200);
        expect(error.retryable).toBe(false);
        expect(error.message).toContain("502 Bad Gateway");
    });

    it("POSTs /v1/reveal with the nested packet body covclaimd parses", async () => {
        const { impl, calls } = stubFetch([{ body: "{}" }]);
        await covclaimdClient("https://cov.example", { fetchImpl: impl }).reveal({
            swapAddress: "ark1swap",
            ciphertext: "Y2lwaGVy",
            arkadeScript: "c2NyaXB0",
            taptree: "deadbeef",
        });
        expect(calls[0].url).toBe("https://cov.example/v1/reveal");
        expect(calls[0].init?.method).toBe("POST");
        expect(JSON.parse(String(calls[0].init?.body))).toEqual({
            swap_address: "ark1swap",
            packet: { ciphertext: "Y2lwaGVy", arkade_script: "c2NyaXB0" },
            taptree: "deadbeef",
        });
    });

    it("marks a 400 NOT retryable — the packet cannot bind to this address at this daemon", async () => {
        const { impl } = stubFetch([
            { status: 400, body: "aead open: message authentication failed" },
        ]);
        const error = await covclaimdClient("https://cov.example", { fetchImpl: impl })
            .reveal({ swapAddress: "a", ciphertext: "b", arkadeScript: "c", taptree: "d" })
            .catch((e: unknown) => e as CovclaimdRevealError);
        expect(error).toBeInstanceOf(CovclaimdRevealError);
        expect(error.retryable).toBe(false);
        expect(error.status).toBe(400);
        expect(error.detail).toBe("aead open: message authentication failed");
    });

    it("marks 429 and 503 retryable", async () => {
        for (const status of [429, 503]) {
            const { impl } = stubFetch([{ status, body: "busy" }]);
            const error = await covclaimdClient("https://cov.example", { fetchImpl: impl })
                .reveal({ swapAddress: "a", ciphertext: "b", arkadeScript: "c", taptree: "d" })
                .catch((e: unknown) => e as CovclaimdRevealError);
            expect(error.retryable, `status ${status}`).toBe(true);
        }
    });

    it("wraps a throwing fetch as a retryable error with status 0", async () => {
        const impl = (async () => {
            throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch;
        const error = await covclaimdClient("https://cov.example", { fetchImpl: impl })
            .reveal({ swapAddress: "a", ciphertext: "b", arkadeScript: "c", taptree: "d" })
            .catch((e: unknown) => e as CovclaimdRevealError);
        expect(error.status).toBe(0);
        expect(error.retryable).toBe(true);
        expect(error.message).toContain("ECONNREFUSED");
    });

    it("names which call failed", async () => {
        const { impl } = stubFetch([{ status: 500, body: "boom" }]);
        await expect(
            covclaimdClient("https://cov.example", { fetchImpl: impl }).info(),
        ).rejects.toThrow(/covclaimd info failed: 500 boom/);
    });
});

describe("revealClaimPacket", () => {
    const client = (replies: Array<{ status?: number; body?: string }>) => {
        const { impl, calls } = stubFetch(replies);
        return { client: covclaimdClient("https://cov.example", { fetchImpl: impl }), calls };
    };

    it("seals to the key the SAME daemon serves, then reveals there", async () => {
        const script = covenant();
        const { client: c, calls } = client([{ body: infoBody }, { body: "{}" }]);
        const { ciphertext } = await revealClaimPacket(c, {
            script,
            address: addressOf(script),
            preimage: PREIMAGE,
        });

        expect(calls.map((call) => call.url)).toEqual([
            "https://cov.example/v1/preimage/covclaimd-pubkey",
            "https://cov.example/v1/reveal",
        ]);
        expect(hex.encode(await openClaimPacket(ciphertext, COVCLAIMD_SK))).toBe(
            hex.encode(PREIMAGE),
        );
        expect(JSON.parse(String(calls[1].init?.body))).toEqual({
            swap_address: addressOf(script),
            packet: {
                ciphertext,
                arkade_script: base64.encode(script.nonInteractiveClaimArkadeScript!),
            },
            taptree: hex.encode(script.encode()),
        });
    });

    it("re-sealing produces a fresh packet: no ephemeral key or nonce is reused", async () => {
        const script = covenant();
        const first = await revealClaimPacket(client([{ body: infoBody }, { body: "{}" }]).client, {
            script,
            address: addressOf(script),
            preimage: PREIMAGE,
        });
        const second = await revealClaimPacket(
            client([{ body: infoBody }, { body: "{}" }]).client,
            {
                script,
                address: addressOf(script),
                preimage: PREIMAGE,
            },
        );
        expect(second.ciphertext).not.toBe(first.ciphertext);
    });

    it("refuses an address that is not this covenant's, before sealing anything", async () => {
        const script = covenant();
        const other = covenant({ payoutPkScript: p2tr(0x53) });
        const { client: c, calls } = client([{ body: infoBody }, { body: "{}" }]);
        await expect(
            revealClaimPacket(c, { script, address: addressOf(other), preimage: PREIMAGE }),
        ).rejects.toThrow(/address does not belong to this covenant/);
        expect(calls).toHaveLength(0);
    });

    it("refuses a preimage that does not open the covenant, before sealing anything", async () => {
        const script = covenant();
        const { client: c, calls } = client([{ body: infoBody }, { body: "{}" }]);
        await expect(
            revealClaimPacket(c, {
                script,
                address: addressOf(script),
                preimage: new Uint8Array(32).fill(9),
            }),
        ).rejects.toThrow(/preimage does not match the covenant's payment hash/);
        expect(calls).toHaveLength(0);
    });

    it("the covenant commits to ripemd160(sha256(P)), which is what the gate compares", () => {
        expect(hex.encode(covenant().options.preimageHash)).toBe(
            hex.encode(ripemd160(sha256(PREIMAGE))),
        );
    });

    it("propagates covclaimd's refusal with its retryability intact", async () => {
        const script = covenant();
        const { client: c } = client([
            { body: infoBody },
            { status: 400, body: "no such closure" },
        ]);
        const error = await revealClaimPacket(c, {
            script,
            address: addressOf(script),
            preimage: PREIMAGE,
        }).catch((e: unknown) => e as CovclaimdRevealError);
        expect(error).toBeInstanceOf(CovclaimdRevealError);
        expect(error.retryable).toBe(false);
    });
});
