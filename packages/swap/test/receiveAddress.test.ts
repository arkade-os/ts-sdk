import { describe, expect, it, vi, beforeEach } from "vitest";
import { hex } from "@scure/base";
import { ArkAddress, asset, ReadonlySingleKey, type IWallet } from "@arkade-os/sdk";
import { cancelOffer, createOffer, decodeOffer, swapProgramBinding } from "../src/offer";
import { InMemoryAssetSwapRepository } from "../src/repository";
import { requestArkadeSwap, verifyOfferAddress, type RfqTransport } from "../src/rfq";

// Only the network seam (the Rest providers) and the contract manager are
// stubbed; derivation, encoding and registration run for real.
const makerKey = hex.decode("3c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1");
const makerAddress =
    "tark1qp8n2k7uklxq4aegau7vawtptkgxsja4kt99lpv6krctwpq8tpc65wq0wnmwgr4nglzx999xqx7xahllp4gfh6638wkrjt5tl3k7c8vy6frzj2";
// Override destination: distinct from both the wallet address program and the
// identity key, bound to the connected server key.
const altServer = hex.decode("4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa");
const altKey = hex.decode("2a".repeat(32));
const altPkScript = hex.decode("5120" + hex.encode(altKey));
const altAddress = new ArkAddress(altServer, altPkScript.subarray(2), "tark").encode();
const mainnetAddress = new ArkAddress(altServer, altPkScript.subarray(2), "ark").encode();

const state = vi.hoisted(() => ({
    created: [] as Record<string, unknown>[],
    watched: [] as [string, string][],
    unilateralExitDelay: BigInt(4096),
    paidTo: [] as string[],
    utxos: [] as { txid: string; vout: number; value: number }[],
}));

vi.mock("@arkade-os/sdk", async (importOriginal) => {
    const mod = await importOriginal<typeof import("@arkade-os/sdk")>();
    const { hex } = await import("@scure/base");
    const checkpointTapscript = hex.encode(
        mod.CSVMultisigTapscript.encode({
            timelock: { type: "blocks", value: 10n },
            pubkeys: [
                hex.decode("4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa"),
            ],
        }).script,
    );
    return {
        ...mod,
        // Only the cancel seam: the real class derives the covenant (so
        // createOffer is untouched), but its VTXO read and broadcast are stubbed
        // and the refund output is captured.
        arkade: {
            ...mod.arkade,
            ArkadeContract: class extends mod.arkade.ArkadeContract {
                getUtxos = async () => state.utxos as never;
                functions = {
                    ...super.functions,
                    cancel: () => {
                        const chain = {
                            from: () => chain,
                            to: (script: Uint8Array) => {
                                state.paidTo.push(hex.encode(script));
                                return chain;
                            },
                            withAsset: () => chain,
                            send: async () => ({ txid: "cc".repeat(32) }),
                        };
                        return chain;
                    },
                };
            },
        },
        RestArkProvider: class {
            async getInfo() {
                return {
                    signerPubkey:
                        "02" + "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa",
                    checkpointTapscript,
                    network: "regtest",
                    unilateralExitDelay: state.unilateralExitDelay,
                };
            }
        },
        RestIndexerProvider: class {
            async getVtxos() {
                return { vtxos: [] };
            }
        },
        RestEmulatorProvider: class {
            async getInfo() {
                return {
                    signerPubkey:
                        "466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27",
                };
            }
        },
    };
});

// Wallet fixture: identity key, address and server key are self-consistent
// (address decodes against the mocked server) and pairwise distinct.
const identity = new ReadonlySingleKey(hex.decode("02" + hex.encode(makerKey)));
const makerPkScript = ArkAddress.decode(makerAddress).pkScript;
const realManager = {
    createContract: async (params: Record<string, unknown>) => {
        state.created.push(params);
        return { ...params, state: "active", createdAt: 0 };
    },
    setContractWatchState: async (script: string, watch: string) => {
        state.watched.push([script, watch]);
    },
    getContracts: async () => [],
};
const wallet = {
    identity,
    getAddress: async () => makerAddress,
    getContractManager: async () => realManager,
} as unknown as IWallet;

const emulatorPubkey = "02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27";
const testAsset = asset.AssetId.fromString("aa".repeat(32) + "0000");

const transportFor = (quote: Record<string, unknown>): RfqTransport => ({
    requestQuote: vi.fn(async () => quote),
    status: vi.fn(async () => null),
    close: vi.fn(async () => undefined),
});

beforeEach(() => {
    state.created = [];
    state.watched = [];
    state.unilateralExitDelay = BigInt(4096);
    state.paidTo = [];
    state.utxos = [];
});

describe("createOffer receiveAddress", () => {
    it("leaves the default derivation and encoding byte-identical when omitted", async () => {
        const plain = await createOffer(wallet, "http://ark", {
            wantAmount: BigInt(50_000),
            wantAsset: testAsset,
            emulatorPubkey,
        });
        const explicitUndefined = await createOffer(wallet, "http://ark", {
            wantAmount: BigInt(50_000),
            wantAsset: testAsset,
            emulatorPubkey,
            receiveAddress: undefined,
        });
        expect(explicitUndefined.offerHex).toBe(plain.offerHex);
        expect(explicitUndefined.address).toBe(plain.address);
        const decoded = decodeOffer(hex.decode(plain.offerHex));
        expect(hex.encode(decoded.makerPkScript)).toBe(hex.encode(makerPkScript));
    });

    it("binds an explicit valid P2TR destination into makerPkScript while keeping the cancel signer", async () => {
        const offer = await createOffer(wallet, "http://ark", {
            wantAmount: BigInt(50_000),
            wantAsset: testAsset,
            emulatorPubkey,
            receiveAddress: altAddress,
        });
        const decoded = decodeOffer(hex.decode(offer.offerHex));
        expect(hex.encode(decoded.makerPkScript)).toBe(hex.encode(altPkScript));
        expect(hex.encode(decoded.makerPublicKey)).toBe(
            hex.encode(await identity.xOnlyPublicKey()),
        );
        const plain = await createOffer(wallet, "http://ark", {
            wantAmount: BigInt(50_000),
            wantAsset: testAsset,
            emulatorPubkey,
        });
        expect(offer.address).not.toBe(plain.address);
    });

    it("registers the override-bearing covenant row, keyed to the override script", async () => {
        const offer = await createOffer(wallet, "http://ark", {
            wantAmount: BigInt(50_000),
            wantAsset: testAsset,
            emulatorPubkey,
            receiveAddress: altAddress,
        });
        expect(state.created).toHaveLength(1);
        expect(state.created[0].script).toBe(hex.encode(offer.swapPkScript));
        expect(state.created[0].address).toBe(offer.address);
    });

    it("accepts a covenant-derived taproot pkScript that has a tapscript tree", async () => {
        // A real second covenant, not a bare P2TR: its address commits to the
        // first offer's swapPkScript and carries a tapscript tree behind it.
        const funder = await createOffer(wallet, "http://ark", {
            wantAmount: BigInt(50_000),
            wantAsset: testAsset,
            emulatorPubkey,
        });
        const decodedSource = ArkAddress.decode(funder.address);
        expect(hex.encode(decodedSource.pkScript)).toBe(hex.encode(funder.swapPkScript));
        expect(hex.encode(decodedSource.pkScript)).not.toBe(hex.encode(makerPkScript));
        const offer = await createOffer(wallet, "http://ark", {
            wantAmount: BigInt(50_000),
            wantAsset: testAsset,
            emulatorPubkey,
            receiveAddress: funder.address,
        });
        const decoded = decodeOffer(hex.decode(offer.offerHex));
        expect(hex.encode(decoded.makerPkScript)).toBe(hex.encode(funder.swapPkScript));
        expect(hex.encode(decoded.makerPkScript)).not.toBe(hex.encode(makerPkScript));
        expect(hex.encode(decoded.makerPublicKey)).toBe(
            hex.encode(await identity.xOnlyPublicKey()),
        );
    });

    it("rejects a wrong-network HRP before any contract registration", async () => {
        await expect(
            createOffer(wallet, "http://ark", {
                wantAmount: BigInt(50_000),
                wantAsset: testAsset,
                emulatorPubkey,
                receiveAddress: mainnetAddress,
            }),
        ).rejects.toThrow(/network/i);
        expect(state.created).toHaveLength(0);
    });

    it("rejects an arbitrary Bitcoin address / raw script", async () => {
        await expect(
            createOffer(wallet, "http://ark", {
                wantAmount: BigInt(50_000),
                wantAsset: testAsset,
                emulatorPubkey,
                receiveAddress: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
            }),
        ).rejects.toThrow();
        await expect(
            createOffer(wallet, "http://ark", {
                wantAmount: BigInt(50_000),
                wantAsset: testAsset,
                emulatorPubkey,
                receiveAddress: hex.encode(altPkScript),
            }),
        ).rejects.toThrow();
        expect(state.created).toHaveLength(0);
    });

    it("rejects a non-canonical encoding before any contract registration", async () => {
        const mangled = altAddress.toUpperCase();
        expect(mangled).not.toBe(altAddress);
        await expect(
            createOffer(wallet, "http://ark", {
                wantAmount: BigInt(50_000),
                wantAsset: testAsset,
                emulatorPubkey,
                receiveAddress: mangled,
            }),
        ).rejects.toThrow(/canonical/i);
        expect(state.created).toHaveLength(0);
    });

    it("rejects an address bound to a different server public key", async () => {
        const otherServer = new ArkAddress(
            hex.decode("99".repeat(32)),
            altPkScript.subarray(2),
            "tark",
        ).encode();
        expect(ArkAddress.decode(otherServer).serverPubKey).not.toEqual(altServer);
        await expect(
            createOffer(wallet, "http://ark", {
                wantAmount: BigInt(50_000),
                wantAsset: testAsset,
                emulatorPubkey,
                receiveAddress: otherServer,
            }),
        ).rejects.toThrow(/server/i);
        expect(state.created).toHaveLength(0);
    });
});

describe("requestArkadeSwap receiveAddress", () => {
    const offerAsset = asset.AssetId.fromString("bb".repeat(32) + "0000");
    const pair = `arkade:${offerAsset}->arkade:${testAsset}`;

    it("carries the same override in the RFQ profile and the derived offer", async () => {
        const quoteLog: Record<string, unknown>[] = [];
        const transport: RfqTransport = {
            requestQuote: vi.fn(async (request: Record<string, unknown>) => {
                quoteLog.push(request);
                const derived = await createOffer(wallet, "http://ark", {
                    wantAmount: BigInt(50_000),
                    wantAsset: testAsset,
                    emulatorPubkey,
                    receiveAddress: altAddress,
                });
                return {
                    v: 1,
                    type: "rfq_quote",
                    rfq_id: "11".repeat(32),
                    pair,
                    from_amount: "700",
                    to_amount: "50000",
                    solver_pubkey: "22".repeat(32),
                    valid_until: 1_800_000_060,
                    profile: {
                        offer_address: derived.address,
                        offer_pk_script: hex.encode(derived.swapPkScript),
                    },
                };
            }),
            status: vi.fn(async () => null),
            close: vi.fn(async () => undefined),
        };
        const result = await requestArkadeSwap(wallet, "http://ark", transport, {
            offerAsset,
            wantAsset: testAsset,
            amount: 700n,
            rfqId: "11".repeat(32),
            emulatorPubkey,
            now: 1_800_000_000,
            receiveAddress: altAddress,
        });
        const sent = quoteLog[0].profile as Record<string, unknown>;
        expect(sent.maker_pk_script).toBe(hex.encode(altPkScript));
        expect(decodeOffer(hex.decode(result.offerHex)).makerPkScript).toEqual(altPkScript);
    });

    it("refuses a quote whose solver address was derived for the original destination", async () => {
        const defaultOffer = await createOffer(wallet, "http://ark", {
            wantAmount: BigInt(50_000),
            wantAsset: testAsset,
            emulatorPubkey,
        });
        const substituted = await createOffer(wallet, "http://ark", {
            wantAmount: BigInt(50_000),
            wantAsset: testAsset,
            emulatorPubkey,
            receiveAddress: altAddress,
        });
        expect(() =>
            verifyOfferAddress(
                {
                    v: 1,
                    type: "rfq_quote",
                    rfq_id: "11".repeat(32),
                    pair,
                    from_amount: "700",
                    to_amount: "50000",
                    solver_pubkey: "22".repeat(32),
                    valid_until: 1_800_000_060,
                    profile: {
                        offer_address: defaultOffer.address,
                        offer_pk_script: hex.encode(defaultOffer.swapPkScript),
                    },
                },
                { address: substituted.address, swapPkScript: substituted.swapPkScript },
            ),
        ).toThrow();

        const transport = transportFor({
            v: 1,
            type: "rfq_quote",
            rfq_id: "11".repeat(32),
            pair,
            from_amount: "700",
            to_amount: "50000",
            solver_pubkey: "22".repeat(32),
            valid_until: 1_800_000_060,
            profile: {
                offer_address: defaultOffer.address,
                offer_pk_script: hex.encode(defaultOffer.swapPkScript),
            },
        });
        await expect(
            requestArkadeSwap(wallet, "http://ark", transport, {
                offerAsset,
                wantAsset: testAsset,
                amount: 700n,
                rfqId: "11".repeat(32),
                emulatorPubkey,
                now: 1_800_000_000,
                receiveAddress: altAddress,
            }),
        ).rejects.toThrow();
    });
});

describe("cancelOffer receiveAddress", () => {
    it("refunds to the wallet's own address, never the bound override", async () => {
        state.paidTo = [];
        state.utxos = [{ txid: "a".repeat(64), vout: 0, value: 10_000 }];
        const offer = await createOffer(wallet, "http://ark", {
            wantAmount: BigInt(50_000),
            wantAsset: testAsset,
            emulatorPubkey,
            receiveAddress: altAddress,
        });
        const decoded = decodeOffer(hex.decode(offer.offerHex));
        expect(hex.encode(decoded.makerPkScript)).toBe(hex.encode(altPkScript));
        const { args } = swapProgramBinding(decoded, altServer);
        expect(hex.encode(args.user as Uint8Array)).toBe(
            hex.encode(await identity.xOnlyPublicKey()),
        );
        expect(hex.encode(args.makerWP as Uint8Array)).toBe(hex.encode(altPkScript.subarray(2)));

        const repository = new InMemoryAssetSwapRepository();
        await cancelOffer(wallet, "http://ark", offer.offerHex, { repository });
        expect(state.paidTo).toContain(hex.encode(makerPkScript));
        expect(state.paidTo).not.toContain(hex.encode(altPkScript));
    });
});
