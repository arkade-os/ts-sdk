/**
 * The record↔secret round trip, and the read path that inverts it.
 *
 * The write side (`swapSecretsToRecord`) and the read side
 * (`preimageForSwapRecord`) have to agree about which fields are derivation
 * inputs. When they disagree the failure is silent — a wallet that CAN derive
 * hands back a preimage the chain will never match — so the round trip is
 * asserted end to end rather than field by field.
 */
import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import {
    SingleKey,
    provisionClaimSecret,
    type IWallet,
    type ProvisionedClaimSecret,
} from "@arkade-os/sdk";
import {
    PreimageNotRecoverableError,
    preimageForSwapRecord,
    swapSecretsToRecord,
} from "../src/store";

/** A wallet with no descriptor surface: its identity is its whole policy. */
const staticWallet = (key = SingleKey.fromRandomBytes()) =>
    ({ identity: key }) as unknown as IWallet;

/** What a consumer persists: the projection, plus the committed hash. */
const recordOf = (secrets: ProvisionedClaimSecret) => ({
    ...swapSecretsToRecord(secrets),
    paymentHash: hex.encode(secrets.paymentHash),
});

describe("swapSecretsToRecord", () => {
    it("stores the salt in the clear and no preimage, on the salted arm", async () => {
        const secrets = await provisionClaimSecret(staticWallet());
        const record = swapSecretsToRecord(secrets);

        expect(record.signingDescriptor).toBe(secrets.descriptor);
        expect(record.preimageSaltHex).toBe(hex.encode(secrets.preimageSalt!));
        expect(record.preimageHex).toBeUndefined();
    });

    it("stores the preimage and no salt when the wallet cannot derive", async () => {
        // A COMPLETE identity that simply cannot sign deterministically — an
        // extension or remote signer. A partial one is refused outright by
        // `contractSigner`, so it never reaches this arm.
        const key = SingleKey.fromRandomBytes();
        const identity = {
            sign: (tx: unknown) => key.sign(tx as never),
            signMessage: (m: Uint8Array) => key.signMessage(m),
            signerSession: () => key.signerSession(),
            xOnlyPublicKey: () => key.xOnlyPublicKey(),
        };
        const secrets = await provisionClaimSecret({ identity } as unknown as IWallet);
        const record = swapSecretsToRecord(secrets);

        expect(record.preimageHex).toBe(hex.encode(secrets.preimage));
        expect(record.preimageSaltHex).toBeUndefined();
    });

    it("never writes both a preimage and a salt", async () => {
        // They are alternatives, not a pair: a record carrying both invites a
        // reader to pick the wrong one.
        for (const secrets of [
            await provisionClaimSecret(staticWallet()),
            await provisionClaimSecret(staticWallet(), { preimage: new Uint8Array(32).fill(4) }),
        ]) {
            const record = swapSecretsToRecord(secrets);
            expect(Boolean(record.preimageHex) && Boolean(record.preimageSaltHex)).toBe(false);
        }
    });
});

describe("preimageForSwapRecord", () => {
    it("re-derives a static wallet's preimage from public record fields alone", async () => {
        // The restore case: the repository survived, nothing secret is in it,
        // and a wallet rebuilt from the seed reproduces P.
        const key = SingleKey.fromRandomBytes();
        const secrets = await provisionClaimSecret(staticWallet(key));
        const record = recordOf(secrets);
        expect(record.preimageHex).toBeUndefined();

        const restored = staticWallet(SingleKey.fromHex(key.toHex()));
        expect(hex.encode(await preimageForSwapRecord(restored, record))).toBe(
            hex.encode(secrets.preimage),
        );
    });

    it("returns a stored preimage whatever the wallet can do", async () => {
        // Pinned as a literal rather than a record the current code produces:
        // this is the back-compat line for rows written by 0.0.1–0.0.3, and it
        // has to stay honest as the write path keeps moving.
        const preimage = new Uint8Array(32).fill(7);
        const key = SingleKey.fromRandomBytes();
        const record = {
            signingDescriptor: `tr(${hex.encode(await key.xOnlyPublicKey())})`,
            preimageHex: hex.encode(preimage),
            paymentHash: hex.encode(sha256(preimage)),
        };

        expect(hex.encode(await preimageForSwapRecord(staticWallet(key), record))).toBe(
            hex.encode(preimage),
        );
    });

    /** The reason of the `PreimageNotRecoverableError` a call throws. */
    const reasonOf = async (call: Promise<unknown>): Promise<string> => {
        try {
            await call;
        } catch (error) {
            expect(error).toBeInstanceOf(PreimageNotRecoverableError);
            return (error as PreimageNotRecoverableError).reason;
        }
        throw new Error("expected the call to throw");
    };

    it("refuses a record with no signing descriptor", async () => {
        // Typed, so a caller can tell this from a corrupt salt without
        // matching on message text.
        expect(await reasonOf(preimageForSwapRecord(staticWallet(), {}))).toBe("no-secrets");
    });

    it("refuses a salt that is not 32 bytes", async () => {
        const key = SingleKey.fromRandomBytes();
        expect(
            await reasonOf(
                preimageForSwapRecord(staticWallet(key), {
                    signingDescriptor: `tr(${hex.encode(await key.xOnlyPublicKey())})`,
                    preimageSaltHex: "aabb",
                }),
            ),
        ).toBe("malformed-record");
    });

    it("refuses a static record carrying neither a preimage nor a salt", async () => {
        const key = SingleKey.fromRandomBytes();
        expect(
            await reasonOf(
                preimageForSwapRecord(staticWallet(key), {
                    signingDescriptor: `tr(${hex.encode(await key.xOnlyPublicKey())})`,
                }),
            ),
        ).toBe("not-derivable");
    });

    describe("the payment-hash guard", () => {
        it("catches a tampered salt", async () => {
            // The right wallet, so the descriptor check passes and the guard
            // is the only thing standing between a swapped salt and a claim
            // attempt with a preimage the chain will never match.
            const key = SingleKey.fromRandomBytes();
            const secrets = await provisionClaimSecret(staticWallet(key));
            const record = recordOf(secrets);
            // Same length, different bytes: derives cleanly, matches nothing.
            record.preimageSaltHex = "ab".repeat(32);

            expect(await reasonOf(preimageForSwapRecord(staticWallet(key), record))).toBe(
                "hash-mismatch",
            );
        });

        it("catches the wrong wallet", async () => {
            // The salted arm has two inputs that can be wrong where the HD arm
            // had one. Without this the mistake surfaces as a dead script.
            // Refused as `not-derivable` rather than `hash-mismatch`: the key
            // check fires first, before anything is derived.
            const secrets = await provisionClaimSecret(staticWallet());
            const record = recordOf(secrets);

            expect(
                await reasonOf(
                    preimageForSwapRecord(staticWallet(SingleKey.fromRandomBytes()), record),
                ),
            ).toBe("not-derivable");
        });

        it("stays quiet when the record carries no payment hash", async () => {
            const key = SingleKey.fromRandomBytes();
            const secrets = await provisionClaimSecret(staticWallet(key));
            const record = swapSecretsToRecord(secrets);

            await expect(
                preimageForSwapRecord(staticWallet(SingleKey.fromHex(key.toHex())), record),
            ).resolves.toHaveLength(32);
        });
    });
});
