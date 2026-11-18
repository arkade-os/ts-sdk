import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/secp256k1";
import { pubSchnorr } from "@scure/btc-signer/utils.js";
import { HDKey, networks, scriptExpressions } from "@bitcoinerlab/descriptors-scure";
import vectors from "./fixtures/aez-tiny-vectors.json";
import {
    aezDecrypt,
    aezEncrypt,
    decodeAezeed,
    encodeAezeed,
    isAezeedMnemonic,
} from "../src/identity/aezeed";
import { AezeedIdentity, SeedIdentity } from "../src/identity/seedIdentity";

// Inputs of lnd's `version0TestVectors`, words from lnd v0.19.1-beta `aezeed.New(...).ToMnemonic`
// at production scrypt cost: lnd's own expected words use N=16 (set in its test `init()`).
const ENTROPY = hex.decode("81b637d86359e6960de795e41e0b4cfd");
const SALT = new TextEncoder().encode("salt1");
const GENESIS = 1231006505;
const LND_VECTORS = [
    {
        passphrase: "",
        time: GENESIS,
        days: 0,
        words: "above judge emerge veteran reform crunch system all snap please shoulder vault hurt city quarter cover enlist swear success suggest drink wagon enrich body",
    },
    {
        passphrase: "!very_safe_55345_password*",
        time: 1521799345,
        days: 3365,
        words: "absorb century submit father path glove gloom super divert garden ice mirror wisdom grass dice kit ugly castle success suggest drink monster congress flight",
    },
];
const birthdayMs = (days: number) => (GENESIS + days * 86400) * 1000;

describe("AEZ-tiny known answers", () => {
    it.each(vectors.map((v, i) => [i, v] as const))("vector %i", (_, v) => {
        const key = hex.decode(v.key);
        const nonce = hex.decode(v.nonce);
        const ad = v.ad.map((a) => hex.decode(a));
        const ciphertext = aezEncrypt(key, nonce, ad, v.tau, hex.decode(v.message));
        expect(hex.encode(ciphertext)).toBe(v.result);
        expect(hex.encode(aezDecrypt(key, nonce, ad, v.tau, ciphertext)!)).toBe(v.message);
    });
});

describe("aezeed", () => {
    it.each(LND_VECTORS)("matches lnd's vector for birthday day $days", async (v) => {
        const words = await encodeAezeed(
            { version: 0, birthday: new Date(v.time * 1000), entropy: ENTROPY },
            { passphrase: v.passphrase, salt: SALT },
        );
        expect(words).toBe(v.words);

        const seed = await decodeAezeed(v.words, v.passphrase);
        expect(seed.version).toBe(0);
        expect(seed.entropy).toEqual(ENTROPY);
        expect(seed.birthday.getTime()).toBe(birthdayMs(v.days));
    });

    it("rejects a wrong passphrase", async () => {
        await expect(decodeAezeed(LND_VECTORS[1].words, "wrong")).rejects.toThrow(
            "Invalid aezeed passphrase",
        );
    });

    it("rejects malformed words before deriving a key", async () => {
        const words = LND_VECTORS[0].words.split(" ");
        await expect(decodeAezeed(words.slice(1).join(" "))).rejects.toThrow("expected 24 words");
        await expect(decodeAezeed(["notaword", ...words.slice(1)].join(" "))).rejects.toThrow(
            'unknown word "notaword"',
        );
        const swapped = [...words];
        [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
        await expect(decodeAezeed(swapped.join(" "))).rejects.toThrow("Invalid aezeed checksum");
    });

    it("refuses an internal version this SDK does not know", async () => {
        const words = await encodeAezeed(
            { version: 1, birthday: new Date(), entropy: ENTROPY },
            { salt: SALT },
        );
        await expect(decodeAezeed(words)).rejects.toThrow("Unsupported aezeed version 1");
    });

    it("tells an aezeed phrase from BIP39 without the passphrase", () => {
        expect(isAezeedMnemonic(LND_VECTORS[1].words)).toBe(true);
        expect(isAezeedMnemonic(`${"abandon ".repeat(23)}art`)).toBe(false);
        expect(isAezeedMnemonic(`${"abandon ".repeat(11)}about`)).toBe(false);
    });
});

describe("AezeedIdentity", () => {
    it("uses the entropy as the BIP32 root, as lnd does", async () => {
        const v = LND_VECTORS[1];
        const identity = await AezeedIdentity.fromMnemonic(v.words, {
            passphrase: v.passphrase,
            isMainnet: true,
        });
        const expected = scriptExpressions.trBIP32({
            masterNode: HDKey.fromMasterSeed(ENTROPY, networks.bitcoin.bip32),
            network: networks.bitcoin,
            account: 0,
            change: 0,
            index: "*",
        });
        expect(identity.descriptor).toBe(expected);
        expect(identity.birthday.getTime()).toBe(birthdayMs(v.days));
        expect(identity.aezeedVersion).toBe(0);
    });

    it("mints words that reopen to the same wallet, dated today", async () => {
        const mintedAt = Date.now();
        const { identity, mnemonic } = await AezeedIdentity.generate({
            passphrase: "pw",
            isMainnet: false,
        });
        const reopened = await AezeedIdentity.fromMnemonic(mnemonic, {
            passphrase: "pw",
            isMainnet: false,
        });
        expect(reopened.descriptor).toBe(identity.descriptor);
        expect(await reopened.xOnlyPublicKey()).toEqual(await identity.xOnlyPublicKey());
        const age = mintedAt - identity.birthday.getTime();
        expect(age).toBeGreaterThanOrEqual(-1000);
        expect(age).toBeLessThan(86400 * 1000);
    });

    it("keeps birthday and version on the watch-only copy, immune to mutation", async () => {
        const identity = await AezeedIdentity.fromMnemonic(LND_VECTORS[0].words);
        const readonly = await identity.toReadonly();
        expect(readonly.descriptor).toBe(identity.descriptor);
        expect(readonly.birthday).toEqual(identity.birthday);
        expect(readonly.aezeedVersion).toBe(0);

        identity.birthday.setUTCFullYear(2099);
        readonly.birthday!.setUTCFullYear(2099);
        expect(identity.birthday.getTime()).toBe(birthdayMs(0));
        expect(readonly.birthday!.getTime()).toBe(birthdayMs(0));
    });

    it("signs at a rotated index with the key BIP32 derives from the entropy", async () => {
        const identity = await AezeedIdentity.fromMnemonic(LND_VECTORS[0].words, {
            isMainnet: false,
        });
        const message = new Uint8Array(32).fill(7);
        const signature = await identity.signDescriptorMessage(
            identity.descriptor.replace("/*)", "/3)"),
            message,
        );
        const node = HDKey.fromMasterSeed(ENTROPY, networks.testnet.bip32).derive(
            "m/86'/1'/0'/0/3",
        );
        expect(await schnorr.verifyAsync(signature, message, pubSchnorr(node.privateKey!))).toBe(
            true,
        );
    });

    it("leaves SeedIdentity's 64-byte guard in place", () => {
        expect(() => SeedIdentity.fromSeed(ENTROPY)).toThrow("Seed must be 64 bytes");
    });
});
