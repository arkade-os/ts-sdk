/**
 * Why a refund is impossible, told apart by remedy. `RfqSwapManager` reads
 * `reason` to stop grinding against a push that cannot work, and a user acts
 * on it: restore the other wallet, attach a signer, or accept that the record
 * never named a key at all.
 */
import { describe, expect, it } from "vitest";
import {
    InMemoryWalletRepository,
    MnemonicIdentity,
    SingleKey,
    HDDescriptorProvider,
    type IWallet,
} from "@arkade-os/sdk";
import { RefundNotLocallyPossibleError, senderIdentityForSwapRecord } from "../src/refundBlocked";

const MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const staticWallet = (identity = SingleKey.fromRandomBytes()) =>
    ({ identity }) as unknown as IWallet;

const reasonOf = async (promise: Promise<unknown>) =>
    promise.then(
        () => undefined,
        (error: unknown) => (error as RefundNotLocallyPossibleError).reason,
    );

describe("senderIdentityForSwapRecord", () => {
    it("hands back the signer for a record this wallet owns", async () => {
        const identity = SingleKey.fromRandomBytes();
        const wallet = staticWallet(identity);
        const own = `tr(${Buffer.from(await identity.xOnlyPublicKey()).toString("hex")})`;

        expect(await senderIdentityForSwapRecord(wallet, { signingDescriptor: own })).toBe(
            identity,
        );
    });

    it("refuses a record that names no key: no-secrets", async () => {
        // The cause that is a RETURN VALUE one level down, so a caller wiring
        // the SDK directly would skip it and hit a TypeError at the push site
        // — which the manager retries for the whole window.
        expect(await reasonOf(senderIdentityForSwapRecord(staticWallet(), {}))).toBe("no-secrets");
    });

    it("refuses another wallet's key: foreign-descriptor", async () => {
        const other = MnemonicIdentity.fromMnemonic(MNEMONIC, { isMainnet: false });
        const provider = await HDDescriptorProvider.create(other, new InMemoryWalletRepository());

        expect(
            await reasonOf(
                senderIdentityForSwapRecord(staticWallet(), {
                    signingDescriptor: provider.materializeDescriptorAt(2),
                }),
            ),
        ).toBe("foreign-descriptor");
    });

    it("refuses an unreadable descriptor as foreign, not as an outage", async () => {
        expect(
            await reasonOf(
                senderIdentityForSwapRecord(staticWallet(), { signingDescriptor: "not a tr()" }),
            ),
        ).toBe("foreign-descriptor");
    });

    it("lets an operational failure stay retryable instead of terminal", async () => {
        // Every RefundNotLocallyPossibleError is terminal to RfqSwapManager,
        // so typing a signer outage as one would abandon a refundable swap
        // for the rest of its window. It must come back out unchanged.
        const identity = SingleKey.fromRandomBytes();
        const own = `tr(${Buffer.from(await identity.xOnlyPublicKey()).toString("hex")})`;
        const outage = new Error("remote signer unreachable");
        const flaky = {
            identity: {
                ...identity,
                xOnlyPublicKey: () => Promise.reject(outage),
                compressedPublicKey: () => identity.compressedPublicKey(),
                sign: () => Promise.reject(outage),
                signMessage: () => Promise.reject(outage),
                signerSession: () => identity.signerSession(),
            },
        } as unknown as IWallet;

        await expect(senderIdentityForSwapRecord(flaky, { signingDescriptor: own })).rejects.toBe(
            outage,
        );
        await expect(
            senderIdentityForSwapRecord(flaky, { signingDescriptor: own }),
        ).rejects.not.toBeInstanceOf(RefundNotLocallyPossibleError);
    });

    it("tells a missing signer apart from a wrong wallet: unsignable-wallet", async () => {
        // Watch-only, or a remote signer that is not attached. It IS our key,
        // so reporting "created on another wallet" would send the user after
        // a seed they already have; the remedy is to attach the signer.
        const identity = SingleKey.fromRandomBytes();
        const own = `tr(${Buffer.from(await identity.xOnlyPublicKey()).toString("hex")})`;
        const watchOnly = {
            identity: {
                xOnlyPublicKey: () => identity.xOnlyPublicKey(),
                compressedPublicKey: () => identity.compressedPublicKey(),
            },
        } as unknown as IWallet;

        const error = await senderIdentityForSwapRecord(watchOnly, {
            signingDescriptor: own,
        }).catch((e: unknown) => e as RefundNotLocallyPossibleError);

        expect(error).toBeInstanceOf(RefundNotLocallyPossibleError);
        expect((error as RefundNotLocallyPossibleError).reason).toBe("unsignable-wallet");
        expect((error as RefundNotLocallyPossibleError).message).toMatch(/attach its signer/);
    });
});
