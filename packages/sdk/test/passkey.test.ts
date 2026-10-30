import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { hex } from "@scure/base";
import { MnemonicIdentity } from "../src/identity/seedIdentity";
import {
    createPrfPasskey,
    evaluatePrf,
    mnemonicFromPrf,
    PasskeyCancelled,
    PasskeyUnconfirmed,
    PrfUnavailable,
} from "../src/identity/passkey";
import { FakeAuthenticator } from "./passkeyFixture";

const rp = { id: "wallet.test", name: "Test wallet" };
const salt = new Uint8Array(32).fill(7);
const make = (client: FakeAuthenticator, n = 1) =>
    createPrfPasskey({
        rp,
        userId: new Uint8Array(16).fill(n),
        userName: `key ${n}`,
        salt,
        client,
    });
const pubkey = async (i: MnemonicIdentity) => hex.encode(await i.xOnlyPublicKey());

describe("passkey identity", () => {
    it("signs back in to the same identity and words the passkey created", async () => {
        const client = new FakeAuthenticator();
        const made = await MnemonicIdentity.createPasskey({
            rp,
            userName: "alice",
            client,
            isMainnet: false,
        });
        const back = await MnemonicIdentity.fromPasskey({ rpId: rp.id, client, isMainnet: false });
        expect(made.mnemonic.split(" ")).toHaveLength(12);
        expect(validateMnemonic(made.mnemonic, wordlist)).toBe(true);
        expect(back.mnemonic).toBe(made.mnemonic);
        expect(back.credentialId).toEqual(made.credentialId);
        expect(await pubkey(back.identity)).toBe(await pubkey(made.identity));
        expect(await pubkey(made.identity)).toBe(
            await pubkey(MnemonicIdentity.fromMnemonic(made.mnemonic, { isMainnet: false })),
        );
    });

    it("gives another passkey other words", async () => {
        const client = new FakeAuthenticator();
        const a = await MnemonicIdentity.createPasskey({ rp, userName: "a", client });
        const b = await MnemonicIdentity.createPasskey({ rp, userName: "b", client });
        expect(b.mnemonic).not.toBe(a.mnemonic);
        const again = await MnemonicIdentity.fromPasskey({
            rpId: rp.id,
            credentialIds: [a.credentialId],
            client,
        });
        expect(again.mnemonic).toBe(a.mnemonic);
    });

    it("keeps an app's own salt and label, so words it already derived stay the same", async () => {
        const client = new FakeAuthenticator();
        const domain = { salt, label: "my app seed v1" };
        const own = await MnemonicIdentity.createPasskey({ rp, userName: "a", client, domain });
        const { prf } = await evaluatePrf({
            rpId: rp.id,
            salt,
            credentialIds: [own.credentialId],
            client,
        });
        expect(own.mnemonic).toBe(mnemonicFromPrf(prf, "my app seed v1"));
        const defaults = await MnemonicIdentity.fromPasskey({
            rpId: rp.id,
            credentialIds: [own.credentialId],
            client,
        });
        expect(defaults.mnemonic).not.toBe(own.mnemonic);
    });
});

describe("PRF passkeys", () => {
    it("asks once more when the authenticator enables PRF at creation without a result", async () => {
        const client = new FakeAuthenticator({ prfOnCreate: false });
        const a = await make(client);
        expect(client.gets).toBe(1);
        expect(
            (await evaluatePrf({ rpId: rp.id, salt, credentialIds: [a.credentialId], client })).prf,
        ).toEqual(a.prf);
    });

    it("reads PRF results given as a plain array the same as bytes", async () => {
        const client = new FakeAuthenticator({ arrays: true });
        const a = await make(client);
        client.knobs.arrays = false;
        expect(
            (await evaluatePrf({ rpId: rp.id, salt, credentialIds: [a.credentialId], client })).prf,
        ).toEqual(a.prf);
    });

    it("refuses a PRF result that is not 32 bytes rather than stretching it into a key", async () => {
        await expect(make(new FakeAuthenticator({ result: "string" }))).rejects.toThrow(
            PrfUnavailable,
        );
        await expect(make(new FakeAuthenticator({ result: "empty" }))).rejects.toThrow(
            PrfUnavailable,
        );
    });

    it("refuses a passkey whose next use gives another secret", async () => {
        await expect(make(new FakeAuthenticator({ drift: true }))).rejects.toThrow(PrfUnavailable);
    });

    it("refuses a passkey whose first use right after creation fails, as unconfirmed", async () => {
        await expect(make(new FakeAuthenticator({ getFails: true }))).rejects.toThrow(
            PasskeyUnconfirmed,
        );
    });

    it("refuses an authenticator without PRF", async () => {
        await expect(make(new FakeAuthenticator({ prf: false }))).rejects.toThrow(PrfUnavailable);
    });

    it("reads a cancelled prompt as cancelled", async () => {
        const client = new FakeAuthenticator();
        const a = await make(client);
        client.knobs.cancel = true;
        await expect(make(client)).rejects.toThrow(PasskeyCancelled);
        await expect(
            evaluatePrf({ rpId: rp.id, salt, credentialIds: [a.credentialId], client }),
        ).rejects.toThrow(PasskeyCancelled);
    });

    it("returns the user handle set at creation from a discoverable use", async () => {
        const client = new FakeAuthenticator();
        await make(client, 5);
        expect((await evaluatePrf({ rpId: rp.id, salt, client })).userHandle).toEqual(
            new Uint8Array(16).fill(5),
        );
    });

    it("keeps the credential id when the client reuses its buffers", async () => {
        const shared = new Uint8Array(16).fill(9);
        const prfBytes = new Uint8Array(32).fill(3);
        const client = {
            create: async () => null,
            get: async () =>
                ({
                    rawId: shared.buffer,
                    response: { userHandle: null },
                    getClientExtensionResults: () => ({
                        prf: { results: { first: prfBytes.buffer } },
                    }),
                }) as unknown as Credential,
        };
        const { credentialId, prf } = await evaluatePrf({ rpId: rp.id, salt, client });
        shared.fill(0);
        prfBytes.fill(0);
        expect(credentialId).toEqual(new Uint8Array(16).fill(9));
        expect(prf).toEqual(new Uint8Array(32).fill(3));
    });

    it("compares a drifting secret against the creation result even when the client reuses its buffer", async () => {
        const result = new Uint8Array(32).fill(1);
        const credential = () =>
            ({
                rawId: new Uint8Array(16).fill(4).buffer,
                response: { userHandle: null },
                getClientExtensionResults: () => ({
                    prf: { enabled: true, results: { first: result.buffer } },
                }),
            }) as unknown as Credential;
        const client = {
            create: async () => credential(),
            get: async () => {
                result.fill(2);
                return credential();
            },
        };
        await expect(
            createPrfPasskey({ rp, userId: new Uint8Array(16), userName: "a", salt, client }),
        ).rejects.toThrow(PrfUnavailable);
    });

    it("reads an ArrayBuffer made in another realm", async () => {
        const foreign = runInNewContext("(n) => new Uint8Array(32).fill(n).buffer")(
            6,
        ) as ArrayBuffer;
        expect(foreign instanceof ArrayBuffer).toBe(false);
        const client = {
            create: async () => null,
            get: async () =>
                ({
                    rawId: new Uint8Array(16).buffer,
                    response: { userHandle: null },
                    getClientExtensionResults: () => ({ prf: { results: { first: foreign } } }),
                }) as unknown as Credential,
        };
        expect((await evaluatePrf({ rpId: rp.id, salt, client })).prf).toEqual(
            new Uint8Array(32).fill(6),
        );
    });
});
