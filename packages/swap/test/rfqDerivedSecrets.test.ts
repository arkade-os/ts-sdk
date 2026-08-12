/**
 * The wiring: what the two maker entrypoints hand back on an HD wallet.
 *
 * `secrets.test.ts` proves the derivation; this proves the request flow uses
 * it — that the covenant is built from the allocated key, that the payment
 * hash commits to the derived preimage, and that nothing secret leaves the
 * function at all.
 */
import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";

const state = vi.hoisted(() => ({
    arkInfo: { signerPubkey: "", unilateralExitDelay: 4096, network: "regtest" },
}));

vi.mock("@arkade-os/sdk", async (importOriginal) => {
    const mod = await importOriginal<typeof import("@arkade-os/sdk")>();
    return {
        ...mod,
        RestArkProvider: class {
            async getInfo() {
                return state.arkInfo;
            }
        },
    };
});

import {
    ArkAddress,
    DescriptorIdentity,
    HDDescriptorProvider,
    InMemoryWalletRepository,
    MnemonicIdentity,
    SingleKey,
    type IWallet,
} from "@arkade-os/sdk";
import {
    LIGHTNING_SEND_PAIR,
    ONCHAIN_SEND_PAIR,
    lightningSendVtxoScript,
    requestLightningSend,
    requestOnchainSend,
    type RfqQuote,
    type RfqTransport,
} from "../src/rfq";
import { onchainHtlcScript, paymentHashOf } from "../src/onchainHtlc";
import { contractPreimage } from "@arkade-os/sdk";
import { swapSecretsToRecord } from "../src/store";

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill));
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program]);

const MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SERVER = key(3);
const SOLVER = key(1);
const RECEIVER_PK_SCRIPT = p2tr(key(1));
const EMULATOR_PUBKEY = key(9);
const EMULATOR_PUBKEY_HEX = "02" + hex.encode(EMULATOR_PUBKEY);
const PAYOUT_PUBKEY = key(15);
const HTLC_PUBKEY = key(11);
const REFUND_ADDRESS = new ArkAddress(SERVER, key(21), "tark").encode();

state.arkInfo.signerPubkey = hex.encode(SERVER);

const NOW = Math.floor(Date.now() / 1000);
const VALID_UNTIL = NOW + 3600;
const REFUND_LOCKTIME = NOW + 60 * 24 * 3600;
const HTLC_LOCKTIME = NOW + 30 * 24 * 3600;

/** A wallet backed by the real allocator and the real deterministic signer. */
const hdWallet = async (): Promise<IWallet> => {
    const identity = MnemonicIdentity.fromMnemonic(MNEMONIC, { isMainnet: false });
    const provider = await HDDescriptorProvider.create(identity, new InMemoryWalletRepository());
    return {
        identity,
        getAddress: async () => REFUND_ADDRESS,
        // Both entrypoints register the lockup before returning an address to
        // fund; what they write is `rfqRegister.test.ts`'s subject.
        getContractManager: async () => ({ createContract: async () => ({}) }),
        getCurrentSigningDescriptor: () => provider.getCurrentSigningDescriptor(),
        getNextSigningDescriptor: () => provider.getNextSigningDescriptor(),
        getUsedSigningDescriptors: async () => [],
        advanceSigningDescriptorWatermark: async () => {},
        signerForDescriptor: async (descriptor: string) =>
            new DescriptorIdentity({ descriptor, signer: provider, base: identity }),
    } as unknown as IWallet;
};

const staticWallet = (): IWallet =>
    ({
        identity: SingleKey.fromHex(
            "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2",
        ),
        getAddress: async () => REFUND_ADDRESS,
        // Both entrypoints register the lockup before returning an address to
        // fund; what they write is `rfqRegister.test.ts`'s subject.
        getContractManager: async () => ({ createContract: async () => ({}) }),
    }) as unknown as IWallet;

/** Quotes back whatever the maker derived, so the flow reaches its gates. */
const lightningTransport = (): RfqTransport => ({
    async requestQuote(payload) {
        const profile = (payload as { profile: Record<string, unknown> }).profile;
        const script = lightningSendVtxoScript({
            solverPubkey: SOLVER,
            refundLocktime: REFUND_LOCKTIME,
            serverPubkey: SERVER,
            paymentHash: PAYMENT_HASH,
            claimDelay: 4096,
            emulatorPubkey: EMULATOR_PUBKEY,
            senderPubkey: hex.decode(profile.client_refund_pubkey as string),
            receiverPkScript: RECEIVER_PK_SCRIPT,
            refundPkScript: ArkAddress.decode(REFUND_ADDRESS).pkScript,
        });
        return {
            v: 1,
            type: "rfq_quote",
            rfq_id: payload.rfq_id as string,
            pair: LIGHTNING_SEND_PAIR,
            from_amount: 1000,
            to_amount: 1000,
            solver_pubkey: hex.encode(SOLVER),
            valid_until: VALID_UNTIL,
            refund_locktime: REFUND_LOCKTIME,
            profile: {
                receiver_pk_script: hex.encode(RECEIVER_PK_SCRIPT),
                lockup_address: script.address("tark", SERVER).encode(),
            },
        } satisfies RfqQuote;
    },
    async status() {
        return null;
    },
    async close() {},
});

const PAYMENT_HASH = "ab".repeat(32);
const INVOICE = {
    raw: "lnbcrt10u1p",
    paymentHash: PAYMENT_HASH,
    amountSats: 1000,
    expiresAt: NOW + 7200,
};

/** Records the payment hash the maker sent, and quotes to match it. */
const onchainTransport = (seen: { paymentHash?: string; senderPubkey?: string }): RfqTransport => ({
    async requestQuote(payload) {
        const profile = (payload as { profile: Record<string, unknown> }).profile;
        seen.paymentHash = profile.payment_hash as string;
        seen.senderPubkey = profile.client_refund_pubkey as string;
        const lockup = lightningSendVtxoScript({
            solverPubkey: SOLVER,
            refundLocktime: REFUND_LOCKTIME,
            serverPubkey: SERVER,
            paymentHash: seen.paymentHash,
            claimDelay: 4096,
            emulatorPubkey: EMULATOR_PUBKEY,
            senderPubkey: hex.decode(seen.senderPubkey),
            receiverPkScript: RECEIVER_PK_SCRIPT,
            refundPkScript: ArkAddress.decode(REFUND_ADDRESS).pkScript,
        });
        const htlc = onchainHtlcScript(
            {
                paymentHash: seen.paymentHash,
                claimKey: PAYOUT_PUBKEY,
                refundKey: HTLC_PUBKEY,
                refundLocktime: HTLC_LOCKTIME,
            },
            "regtest",
        );
        return {
            v: 1,
            type: "rfq_quote",
            rfq_id: payload.rfq_id as string,
            pair: ONCHAIN_SEND_PAIR,
            from_amount: 100_000,
            to_amount: 99_000,
            solver_pubkey: hex.encode(SOLVER),
            valid_until: VALID_UNTIL,
            refund_locktime: REFUND_LOCKTIME,
            profile: {
                lockup_address: lockup.address("tark", SERVER).encode(),
                htlc_pubkey: hex.encode(HTLC_PUBKEY),
                htlc_locktime: HTLC_LOCKTIME,
                htlc_address: htlc.address,
                min_confirmations: 2,
                receiver_pk_script: hex.encode(RECEIVER_PK_SCRIPT),
            },
        } satisfies RfqQuote;
    },
    async status() {
        return null;
    },
    async close() {},
});

describe("requestLightningSend and the corridor spread", () => {
    /** The lightning harness with a fee on the quote: from = to + 72. */
    const spreadTransport = (fromAmount: number, toAmount: number): RfqTransport => ({
        async requestQuote(payload) {
            const profile = (payload as { profile: Record<string, unknown> }).profile;
            const script = lightningSendVtxoScript({
                solverPubkey: SOLVER,
                refundLocktime: REFUND_LOCKTIME,
                serverPubkey: SERVER,
                paymentHash: PAYMENT_HASH,
                claimDelay: 4096,
                emulatorPubkey: EMULATOR_PUBKEY,
                senderPubkey: hex.decode(profile.client_refund_pubkey as string),
                receiverPkScript: RECEIVER_PK_SCRIPT,
                refundPkScript: ArkAddress.decode(REFUND_ADDRESS).pkScript,
            });
            return {
                v: 1,
                type: "rfq_quote",
                rfq_id: payload.rfq_id as string,
                pair: LIGHTNING_SEND_PAIR,
                from_amount: fromAmount,
                to_amount: toAmount,
                solver_pubkey: hex.encode(SOLVER),
                valid_until: VALID_UNTIL,
                refund_locktime: REFUND_LOCKTIME,
                profile: {
                    receiver_pk_script: hex.encode(RECEIVER_PK_SCRIPT),
                    lockup_address: script.address("tark", SERVER).encode(),
                },
            } satisfies RfqQuote;
        },
        async status() {
            return null;
        },
        async close() {},
    });

    it("funds from_amount — the invoice PLUS the fee, never the bare invoice", async () => {
        const wallet = await hdWallet();
        const result = await requestLightningSend(
            wallet,
            "http://ark",
            spreadTransport(1072, 1000),
            { emulatorPubkey: EMULATOR_PUBKEY_HEX, invoice: INVOICE },
        );
        expect(result.fundAmount).toBe(1072);
    });

    it("refuses a quote whose to_amount reprices the invoice", async () => {
        const wallet = await hdWallet();
        await expect(
            requestLightningSend(wallet, "http://ark", spreadTransport(1000, 999), {
                emulatorPubkey: EMULATOR_PUBKEY_HEX,
                invoice: INVOICE,
            }),
        ).rejects.toThrow(/does not match the invoice/);
    });

    it("refuses a quote whose from_amount is below the invoice — a negative spread is not a quote", async () => {
        const wallet = await hdWallet();
        await expect(
            requestLightningSend(wallet, "http://ark", spreadTransport(999, 1000), {
                emulatorPubkey: EMULATOR_PUBKEY_HEX,
                invoice: INVOICE,
            }),
        ).rejects.toThrow(/below the invoice amount/);
    });
});
/**
 * The loop a persisting consumer depends on: what the entry point hands back
 * must rebuild the very covenant it just funded. Without it a consumer would
 * re-fetch `getInfo()` and re-derive the tree itself, and any drift between the
 * two derivations is a lockup nobody can spend.
 */
describe("treeParams round-trips to the funded script", () => {
    it.each([
        ["hd", async () => await hdWallet()],
        ["static", async () => staticWallet()],
    ] as const)("on a %s wallet", async (_kind, makeWallet) => {
        const result = await requestLightningSend(
            await makeWallet(),
            "http://ark",
            lightningTransport(),
            { invoice: INVOICE, emulatorPubkey: EMULATOR_PUBKEY_HEX },
        );

        const rebuilt = lightningSendVtxoScript(result.treeParams);
        expect(hex.encode(rebuilt.pkScript)).toBe(hex.encode(result.swapPkScript));
        expect(hex.encode(rebuilt.pkScript)).toBe(hex.encode(result.script.pkScript));
    });

    it("carries the inputs no quote and no second round trip could supply", async () => {
        const result = await requestLightningSend(
            staticWallet(),
            "http://ark",
            lightningTransport(),
            { invoice: INVOICE, emulatorPubkey: EMULATOR_PUBKEY_HEX },
        );
        // serverPubkey and claimDelay come from this wallet's own getInfo(),
        // emulatorPubkey from a per-network pin, refundPkScript from decoding an
        // address. None of them is on the quote.
        expect(result.treeParams.serverPubkey).toHaveLength(32);
        expect(result.treeParams.emulatorPubkey).toHaveLength(32);
        expect(result.treeParams.claimDelay % 512).toBe(0);
        expect(result.treeParams.refundPkScript.length).toBeGreaterThan(0);
        expect(result.treeParams.paymentHash).toBe(INVOICE.paymentHash);
    });
});

describe("requestLightningSend on an HD wallet", () => {
    it("returns a descriptor and no key material", async () => {
        const wallet = await hdWallet();
        const result = await requestLightningSend(wallet, "http://ark", lightningTransport(), {
            emulatorPubkey: EMULATOR_PUBKEY_HEX,
            invoice: INVOICE,
        });

        // The covenant is bound to the allocated key, so the pubkey the solver
        // was given has to be the descriptor's.
        const signer = await (
            wallet as never as {
                signerForDescriptor: (
                    d: string,
                ) => Promise<{ xOnlyPublicKey: () => Promise<Uint8Array> }>;
            }
        ).signerForDescriptor(result.secrets.descriptor);
        expect(hex.encode(result.senderPubkey)).toBe(hex.encode(await signer.xOnlyPublicKey()));
    });
});

describe("requestOnchainSend on an HD wallet", () => {
    it("commits to the derived preimage and returns neither it nor the key", async () => {
        const wallet = await hdWallet();
        const seen: { paymentHash?: string; senderPubkey?: string } = {};
        const result = await requestOnchainSend(wallet, "http://ark", onchainTransport(seen), {
            emulatorPubkey: EMULATOR_PUBKEY_HEX,
            amount: 100_000,
            amountSide: "to",
            payoutPubkey: PAYOUT_PUBKEY,
        });

        expect(result).not.toHaveProperty("preimage");

        // The quote was requested against sha256 of the derived preimage, and
        // the preimage re-derives from the returned descriptor alone.
        const preimage = await contractPreimage(wallet, result.secrets.descriptor, {
            stored: result.secrets.preimage,
        });
        expect(seen.paymentHash).toBe(paymentHashOf(preimage));
        expect(seen.senderPubkey).toBe(hex.encode(result.senderPubkey));
    });

    it("gives a second swap on the same wallet a different key and preimage", async () => {
        const wallet = await hdWallet();
        const first: { paymentHash?: string; senderPubkey?: string } = {};
        const second: { paymentHash?: string; senderPubkey?: string } = {};
        const params = {
            amount: 100_000,
            amountSide: "to" as const,
            payoutPubkey: PAYOUT_PUBKEY,
            emulatorPubkey: EMULATOR_PUBKEY_HEX,
        };

        await requestOnchainSend(wallet, "http://ark", onchainTransport(first), params);
        await requestOnchainSend(wallet, "http://ark", onchainTransport(second), params);

        expect(second.senderPubkey).not.toBe(first.senderPubkey);
        expect(second.paymentHash).not.toBe(first.paymentHash);
    });

    it("keeps the HD sender key when the caller brings its own preimage", async () => {
        const wallet = await hdWallet();
        const preimage = new Uint8Array(32).fill(7);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const result = await requestOnchainSend(wallet, "http://ark", onchainTransport({}), {
                emulatorPubkey: EMULATOR_PUBKEY_HEX,
                amount: 100_000,
                amountSide: "to",
                payoutPubkey: PAYOUT_PUBKEY,
                preimage,
            });

            expect(result.secrets.preimage).toEqual(preimage);
            expect(
                await contractPreimage(wallet, result.secrets.descriptor, {
                    stored: result.secrets.preimage,
                }),
            ).toEqual(preimage);

            const signer = await wallet.signerForDescriptor!(result.secrets.descriptor);
            expect(hex.encode(result.senderPubkey)).toBe(hex.encode(await signer.xOnlyPublicKey()));
            // A P the wallet did not derive cannot be re-derived, HD descriptor
            // or not — so the record must carry it. The flag is what callers
            // branch on; the warning only tells a human the same thing.
            expect(result.secrets.mustPersistPreimage).toBe(true);
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining("cannot be re-derived from the seed"),
            );
        } finally {
            warn.mockRestore();
        }
    });

    it("binds a static wallet's swap to its identity key, never a minted one", async () => {
        // The wallet that cannot allocate still provides ITS key. This case
        // supplies its own preimage, so the record does carry one — see the
        // next test for what a static wallet stores when it does not.
        const wallet = staticWallet();
        const preimage = new Uint8Array(32).fill(8);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const result = await requestOnchainSend(wallet, "http://ark", onchainTransport({}), {
                emulatorPubkey: EMULATOR_PUBKEY_HEX,
                amount: 100_000,
                amountSide: "to",
                payoutPubkey: PAYOUT_PUBKEY,
                preimage,
            });

            expect(result.secrets.descriptor).toBe(
                `tr(${hex.encode(await wallet.identity.xOnlyPublicKey())})`,
            );
            expect(hex.encode(result.senderPubkey)).toBe(
                hex.encode(await wallet.identity.xOnlyPublicKey()),
            );
            expect(result.secrets.preimage).toEqual(preimage);
            expect(
                await contractPreimage(wallet, result.secrets.descriptor, {
                    stored: result.secrets.preimage,
                }),
            ).toEqual(preimage);
            expect(result.secrets.mustPersistPreimage).toBe(true);
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining("cannot be re-derived from the seed"),
            );
        } finally {
            warn.mockRestore();
        }
    });

    it("derives a static wallet's preimage from a per-swap salt, storing nothing secret", async () => {
        const wallet = staticWallet();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const send = () =>
                requestOnchainSend(wallet, "http://ark", onchainTransport({}), {
                    emulatorPubkey: EMULATOR_PUBKEY_HEX,
                    amount: 100_000,
                    amountSide: "to",
                    payoutPubkey: PAYOUT_PUBKEY,
                });
            const first = await send();
            const second = await send();

            // Same key for both swaps — that is the static policy — but the
            // salts, and therefore the preimages, must never repeat.
            expect(second.secrets.descriptor).toBe(first.secrets.descriptor);
            expect(first.secrets.preimageSalt).toHaveLength(32);
            expect(hex.encode(second.secrets.preimageSalt!)).not.toBe(
                hex.encode(first.secrets.preimageSalt!),
            );
            expect(hex.encode(second.secrets.preimage)).not.toBe(
                hex.encode(first.secrets.preimage),
            );

            // Nothing to persist, and therefore no warning: the salt is public
            // and the preimage re-derives from it.
            for (const result of [first, second]) {
                expect(result.secrets.mustPersistPreimage).toBe(false);
                expect(swapSecretsToRecord(result.secrets).preimageHex).toBeUndefined();
                expect(
                    hex.encode(
                        await contractPreimage(wallet, result.secrets.descriptor, {
                            salt: result.secrets.preimageSalt,
                        }),
                    ),
                ).toBe(hex.encode(result.secrets.preimage));
            }
            expect(warn).not.toHaveBeenCalledWith(
                expect.stringContaining("cannot be re-derived from the seed"),
            );
        } finally {
            warn.mockRestore();
        }
    });

    it("writes only public fields on a derived-arm record, on either wallet", async () => {
        // Backstop against a future change putting a secret back on disk. An
        // allowlist rather than a hex pattern: `preimageSaltHex` is 64 hex too,
        // and the difference between it and `preimageHex` is what they mean,
        // not what they look like.
        const send = (wallet: IWallet) =>
            requestOnchainSend(wallet, "http://ark", onchainTransport({}), {
                emulatorPubkey: EMULATOR_PUBKEY_HEX,
                amount: 100_000,
                amountSide: "to",
                payoutPubkey: PAYOUT_PUBKEY,
            });

        for (const wallet of [await hdWallet(), staticWallet()]) {
            const record = swapSecretsToRecord((await send(wallet)).secrets);
            expect(record.preimageHex).toBeUndefined();
            expect(Object.keys(record).sort()).toEqual(
                expect.arrayContaining(["signingDescriptor"]),
            );
            for (const field of Object.keys(record)) {
                expect(["signingDescriptor", "preimageSaltHex"]).toContain(field);
            }
        }
    });
});
