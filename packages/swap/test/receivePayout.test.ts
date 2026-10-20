import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { ArkAddress, asset, type ArkadeInfo, type IWallet } from "@arkade-os/sdk";
import { requestArkadeSwap, type RfqTransport } from "../src/rfq";
import { acceptWallet } from "./client/fixtures";
import { decodeOffer, deriveOffer } from "../src/offer";

const server = hex.decode("4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa");
const makerKey = hex.decode("3c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1");
const recipientKey = hex.decode("466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27");
const makerAddress = new ArkAddress(server, makerKey, "tark").encode();
const recipientAddress = new ArkAddress(server, recipientKey, "tark").encode();
const info = {
    network: "regtest",
    signerPubkey: `02${hex.encode(server)}`,
    unilateralExitDelay: 144n,
} as ArkadeInfo;
const params = {
    wantAmount: 50_000n,
    wantAsset: asset.AssetId.fromString("aa".repeat(32) + "0000"),
    emulatorPubkey: `02${hex.encode(recipientKey)}`,
};
const fixture = () => {
    const getAddress = vi.fn(async () => makerAddress);
    const xOnlyPublicKey = vi.fn(async () => makerKey);
    const getArkadeInfo = vi.fn(async () => info);
    const getContractManager = vi.fn(() => {
        throw new Error("derivation must not register");
    });
    const wallet = {
        getAddress,
        getArkadeInfo,
        getContractManager,
        identity: { xOnlyPublicKey },
    } as unknown as IWallet;
    return { wallet, getAddress, getArkadeInfo, getContractManager, xOnlyPublicKey };
};

describe("offer receive payout derivation", () => {
    it("preserves the default encoding and maker key", async () => {
        const { wallet } = fixture();
        const plain = await deriveOffer(wallet, params);
        const explicit = await deriveOffer(wallet, { ...params, receiveAddress: makerAddress });
        expect(explicit.offerHex).toBe(plain.offerHex);
        expect(explicit.swapPkScript).toEqual(plain.swapPkScript);
    });

    it("binds the recipient payout while retaining the maker signing key", async () => {
        const f = fixture();
        const derived = await deriveOffer(f.wallet, {
            ...params,
            receiveAddress: recipientAddress,
        });
        const decoded = decodeOffer(hex.decode(derived.offerHex));
        expect(decoded.makerPkScript).toEqual(ArkAddress.decode(recipientAddress).pkScript);
        expect(decoded.makerPublicKey).toEqual(makerKey);
        expect(derived.binding.makerPublicKey).toEqual(makerKey);
        expect(f.getArkadeInfo).toHaveBeenCalledWith({ requireLive: true });
        expect(f.getContractManager).not.toHaveBeenCalled();
    });

    it("retains the supplied quote maker without re-reading a rotated address or key", async () => {
        const f = fixture();
        const maker = { pkScript: ArkAddress.decode(makerAddress).pkScript, publicKey: makerKey };
        const derived = await deriveOffer(f.wallet, {
            ...params,
            info,
            maker,
            receiveAddress: recipientAddress,
        });
        expect(derived.binding.makerPublicKey).toEqual(makerKey);
        expect(derived.binding.makerPkScript).toEqual(ArkAddress.decode(recipientAddress).pkScript);
        expect(derived.info).toBe(info);
        expect(f.getAddress).not.toHaveBeenCalled();
        expect(f.xOnlyPublicKey).not.toHaveBeenCalled();
        expect(f.getArkadeInfo).not.toHaveBeenCalled();
    });

    it.each([
        ["wrong network", new ArkAddress(server, recipientKey, "ark").encode(), /network/],
        [
            "different server",
            new ArkAddress(makerKey, recipientKey, "tark").encode(),
            /server public key/,
        ],
        ["noncanonical uppercase", recipientAddress.toUpperCase(), /canonical/],
        [
            "raw script",
            hex.encode(ArkAddress.decode(recipientAddress).pkScript),
            /valid Arkade address/,
        ],
        ["Bitcoin address", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", /valid Arkade address/],
    ])("refuses %s before contract registration", async (_name, receiveAddress, reason) => {
        const f = fixture();
        await expect(deriveOffer(f.wallet, { ...params, receiveAddress })).rejects.toThrow(reason);
        expect(f.getContractManager).not.toHaveBeenCalled();
    });
});

describe("RFQ offer receive payout", () => {
    const setup = async (receiveAddress?: string) => {
        const f = await acceptWallet();
        const address = await f.wallet.getAddress();
        const owner = ArkAddress.decode(address);
        const receiver = new ArkAddress(owner.serverPubKey, recipientKey, owner.hrp).encode();
        const destination = receiveAddress === "receiver" ? receiver : receiveAddress;
        const expected = await deriveOffer(f.wallet, { ...params, receiveAddress: destination });
        const requestQuote = vi.fn(async () => ({
            v: 1 as const,
            type: "rfq_quote" as const,
            rfq_id: "11".repeat(32),
            pair: `arkade:BTC->arkade:${params.wantAsset}`,
            from_amount: "700",
            to_amount: "50000",
            solver_pubkey: "22".repeat(32),
            valid_until: 1_800_000_060,
            profile: {
                offer_address: expected.address,
                offer_pk_script: hex.encode(expected.swapPkScript),
            },
        }));
        const transport: RfqTransport = {
            requestQuote,
            status: async () => null,
            close: async () => {},
        };
        return { ...f, address, receiver, destination, expected, requestQuote, transport };
    };
    const rfqParams = {
        wantAsset: params.wantAsset,
        amount: 700n,
        emulatorPubkey: params.emulatorPubkey,
        now: 1_800_000_000,
    };

    it("keeps the default own-address payout byte equivalent", async () => {
        const f = await setup();
        const result = await requestArkadeSwap(f.wallet, f.transport, rfqParams);
        expect(result.offerHex).toBe(f.expected.offerHex);
        expect(f.requestQuote).toHaveBeenCalledWith(
            expect.objectContaining({
                profile: expect.objectContaining({
                    maker_pk_script: hex.encode(ArkAddress.decode(f.address).pkScript),
                }),
            }),
        );
    });

    it("pins an external receiver script in both request and registered covenant while preserving the buyer key", async () => {
        const f = await setup("receiver");
        const buyerKey = await f.wallet.identity.xOnlyPublicKey();
        const getAddress = vi.spyOn(f.wallet, "getAddress");
        const getInfo = vi.spyOn(f.wallet, "getArkadeInfo");
        const publicKey = vi.spyOn(f.wallet.identity, "xOnlyPublicKey");
        const reply = await f.requestQuote();
        f.requestQuote.mockClear();
        const requestParams = { ...rfqParams, receiveAddress: f.receiver };
        f.requestQuote.mockImplementation(async () => {
            requestParams.receiveAddress = f.address;
            getAddress.mockResolvedValue(makerAddress);
            publicKey.mockResolvedValue(recipientKey);
            return reply;
        });
        const result = await requestArkadeSwap(f.wallet, f.transport, requestParams);
        const decoded = decodeOffer(hex.decode(result.offerHex));
        expect(result.offerHex).toBe(f.expected.offerHex);
        expect(decoded.makerPkScript).toEqual(ArkAddress.decode(f.receiver).pkScript);
        expect(decoded.makerPublicKey).toEqual(buyerKey);
        expect(f.requestQuote).toHaveBeenCalledWith(
            expect.objectContaining({
                profile: expect.objectContaining({
                    maker_pk_script: hex.encode(ArkAddress.decode(f.receiver).pkScript),
                    maker_public_key: hex.encode(buyerKey),
                }),
            }),
        );
        expect(getAddress).toHaveBeenCalledTimes(1);
        await expect(publicKey.mock.results[0]?.value).resolves.toEqual(buyerKey);
        expect(getInfo).toHaveBeenCalledTimes(1);
        expect(getInfo).toHaveBeenCalledWith({ requireLive: true });
        expect(f.contracts).toHaveLength(1);
        expect(f.contracts[0]?.script).toBe(hex.encode(result.swapPkScript));
        expect(f.sent).toHaveLength(0);
    });

    it.each([
        ["wrong network", new ArkAddress(server, recipientKey, "ark").encode(), /network/],
        [
            "different server",
            new ArkAddress(makerKey, recipientKey, "tark").encode(),
            /server public key/,
        ],
        ["uppercase", recipientAddress.toUpperCase(), /canonical/],
        [
            "raw script",
            hex.encode(ArkAddress.decode(recipientAddress).pkScript),
            /valid Arkade address/,
        ],
    ])(
        "refuses %s before RFQ disclosure or registration",
        async (_name, receiveAddress, reason) => {
            const f = await acceptWallet();
            const requestQuote = vi.fn();
            const transport = {
                requestQuote,
                status: async () => null,
                close: async () => {},
            } as RfqTransport;
            await expect(
                requestArkadeSwap(f.wallet, transport, { ...rfqParams, receiveAddress }),
            ).rejects.toThrow(reason);
            expect(requestQuote).not.toHaveBeenCalled();
            expect(f.contracts).toHaveLength(0);
            expect(f.sent).toHaveLength(0);
        },
    );
});
