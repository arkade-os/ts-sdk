import { afterEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base64, hex } from "@scure/base";
import { sha256 } from "@scure/btc-signer/utils.js";

import {
    arkade,
    CSVMultisigTapscript,
    EnclaveAttestationError,
    ProviderUnavailableError,
} from "../src";
import { REGTEST_EMULATOR_PUBKEY, networks } from "../src/networks";
import { RestEmulatorProvider } from "../src/providers/emulator";
import { makeNitroChain, makeNitroFixture, type NitroFixture } from "./helpers/nitroFixture";
import { textResponse } from "./helpers/response";

// The stub enclave's chain root stands in for AWS's, passed through `roots`.
const chain = makeNitroChain();
const EMULATOR_URL = "https://emulator.example";
const PCR0 = new Uint8Array(48).fill(0xab);
const OTHER_KEY = "03" + "cd".repeat(32);
const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * An emulator enclave: answers `/enclave/attestation` with a fixture echoing the nonce and
 * `/v1/info` (reporting `signerPubkey`) signed by that fixture's key. The signed message is
 * built inline, not with the module under test.
 */
function stubEmulatorEnclave(
    opts: {
        pcr0?: Uint8Array;
        signerPubkey?: string;
        tamperInfo?: boolean;
        /** Answer `/v1/info` with this status, unsigned, as the runtime does before its app starts. */
        infoStatus?: number;
    } = {},
) {
    let fixture: NitroFixture | undefined;
    const requests: string[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string, init?: RequestInit) => {
            const url = new URL(input);
            requests.push(url.pathname);
            if (url.pathname === "/enclave/attestation") {
                fixture = makeNitroFixture({
                    chain,
                    nonce: hex.decode(url.searchParams.get("nonce")!),
                    pcr0: opts.pcr0 ?? PCR0,
                });
                return textResponse(base64.encode(fixture.doc));
            }
            if (opts.infoStatus) return new Response("starting", { status: opts.infoStatus });
            const body = JSON.stringify({
                signerPubkey: opts.signerPubkey ?? REGTEST_EMULATOR_PUBKEY,
            });
            const nonce = new Headers(init?.headers).get("X-Enclave-Sign-Nonce") ?? "";
            const message =
                `enclave-signed-response\nGET ${url.pathname}\n${url.host}\n` +
                `${hex.encode(sha256(utf8(`x-enclave-sign-nonce:${btoa(nonce)}\n`)))}\n` +
                `${hex.encode(sha256(new Uint8Array(0)))}\n200\n` +
                hex.encode(sha256(utf8(body)));
            const signature = ed25519.sign(utf8(message), fixture!.signingSecret);
            // Still valid JSON, but not the bytes the enclave signed.
            return new Response(opts.tamperInfo ? `${body} ` : body, {
                headers: { "X-Enclave-Signature": base64.encode(signature) },
            });
        }),
    );
    return { requests, fixture: () => fixture! };
}

/** A regtest server, so the regtest co-signer pin applies. */
function arkProvider() {
    const serverXOnly = "11".repeat(32);
    const checkpointTapscript = hex.encode(
        CSVMultisigTapscript.encode({
            timelock: { type: "blocks", value: 10n },
            pubkeys: [hex.decode(serverXOnly)],
        }).script,
    );
    return {
        async getInfo() {
            return { signerPubkey: "02" + serverXOnly, checkpointTapscript, network: "regtest" };
        },
    } as any;
}

const attestation = { pcr0: [hex.encode(PCR0)], roots: [chain.rootDer] };
const connect = (extra: Partial<arkade.ArkadeConnectOptions> = {}) =>
    arkade.Arkade.connect({
        arkade: arkProvider(),
        emulator: new RestEmulatorProvider(EMULATOR_URL),
        emulatorAttestation: attestation,
        ...extra,
    });

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("RestEmulatorProvider.getInfo with a signing key", () => {
    it("returns the signer key from a response the enclave signed", async () => {
        const enclave = stubEmulatorEnclave();
        await fetch(`${EMULATOR_URL}/enclave/attestation?nonce=${"00".repeat(20)}`);
        const info = await new RestEmulatorProvider(EMULATOR_URL).getInfo(
            enclave.fixture().signingKey,
        );
        expect(info.signerPubkey).toBe(REGTEST_EMULATOR_PUBKEY);
    });

    it("throws EnclaveAttestationError when the response doesn't match its signature", async () => {
        const enclave = stubEmulatorEnclave({ tamperInfo: true });
        await fetch(`${EMULATOR_URL}/enclave/attestation?nonce=${"00".repeat(20)}`);
        await expect(
            new RestEmulatorProvider(EMULATOR_URL).getInfo(enclave.fixture().signingKey),
        ).rejects.toThrow(EnclaveAttestationError);
    });
});

describe("Arkade.connect with emulatorAttestation", () => {
    it("keeps the pinned key once the attested emulator proves it signs with it", async () => {
        const enclave = stubEmulatorEnclave();
        const ark = await connect();
        expect(hex.encode(ark.emulatorKey!)).toBe(REGTEST_EMULATOR_PUBKEY);
        expect(ark.enclaveResponseSigningKey).toEqual(enclave.fixture().signingKey);
        expect(enclave.requests).toEqual(["/enclave/attestation", "/v1/info"]);
    });

    it("fails closed when the attested emulator signs with another key", async () => {
        stubEmulatorEnclave({ signerPubkey: OTHER_KEY });
        await expect(connect()).rejects.toThrow(/not the configured key/);
    });

    it("verifies an emulatorPubkey override the same way", async () => {
        stubEmulatorEnclave({ signerPubkey: OTHER_KEY });
        const ark = await connect({ emulatorPubkey: OTHER_KEY });
        expect(hex.encode(ark.emulatorKey!)).toBe(OTHER_KEY);
    });

    it("fails closed for an image not in the list", async () => {
        stubEmulatorEnclave({ pcr0: new Uint8Array(48).fill(1) });
        await expect(connect()).rejects.toThrow(EnclaveAttestationError);
    });

    it("fails closed when /v1/info isn't what the enclave signed", async () => {
        stubEmulatorEnclave({ tamperInfo: true });
        await expect(connect()).rejects.toThrow(EnclaveAttestationError);
    });

    it("verifies /v1/info itself, even through a provider whose getInfo ignores the key", async () => {
        stubEmulatorEnclave({ tamperInfo: true });
        class UnsignedReads extends RestEmulatorProvider {
            override getInfo() {
                return super.getInfo();
            }
        }
        await expect(connect({ emulator: new UnsignedReads(EMULATOR_URL) })).rejects.toThrow(
            EnclaveAttestationError,
        );
    });

    it("ignores a trailing slash on the emulator URL", async () => {
        const enclave = stubEmulatorEnclave();
        await connect({ emulator: new RestEmulatorProvider(`${EMULATOR_URL}/`) });
        expect(enclave.requests).toEqual(["/enclave/attestation", "/v1/info"]);
    });

    it("reports a /v1/info that isn't up yet as retryable", async () => {
        stubEmulatorEnclave({ infoStatus: 503 });
        await expect(connect()).rejects.toThrow(ProviderUnavailableError);
    });

    it("names the missing pin before attesting on an unpinned network", async () => {
        const enclave = stubEmulatorEnclave();
        await expect(connect({ network: networks.signet })).rejects.toThrow(/pass emulatorPubkey/);
        expect(enclave.requests).toEqual([]);
    });

    it("needs an emulator that exposes its serverUrl", async () => {
        stubEmulatorEnclave();
        const { serverUrl: _unused, ...withoutUrl } = new RestEmulatorProvider(EMULATOR_URL);
        await expect(connect({ emulator: withoutUrl as any })).rejects.toThrow(/serverUrl/);
    });

    it("refuses emulatorAttestation without an emulator rather than skip it", async () => {
        const enclave = stubEmulatorEnclave();
        await expect(connect({ emulator: undefined })).rejects.toThrow(
            /emulatorAttestation needs an emulator/,
        );
        expect(enclave.requests).toEqual([]);
    });

    it("leaves the pinned-key path untouched without the option", async () => {
        const enclave = stubEmulatorEnclave();
        const ark = await connect({ emulatorAttestation: undefined, network: networks.regtest });
        expect(hex.encode(ark.emulatorKey!)).toBe(REGTEST_EMULATOR_PUBKEY);
        expect(ark.enclaveResponseSigningKey).toBeUndefined();
        expect(enclave.requests).toEqual([]);
    });
});
