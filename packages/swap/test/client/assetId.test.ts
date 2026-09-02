import { asset } from "@arkade-os/sdk";
import { describe, expect, it } from "vitest";
import {
    AssetIdError,
    arkadeAsset,
    assetPartOf,
    bitcoinNetworkOf,
    btcOn,
    formatAssetId,
    isAssetId,
    issuanceOf,
    parseAssetId,
    railOf,
    sameAsset,
} from "../../src/client/assetId";

const BTC_ON_ARKADE = "arkade:bitcoin/slip44:0";
const issued = (hex: string): asset.AssetId => asset.AssetId.fromString(hex);

describe("asset id grammar", () => {
    it("parses the chain part as rail plus network", () => {
        expect(parseAssetId(BTC_ON_ARKADE)).toEqual({
            rail: "arkade",
            reference: "bitcoin",
            assetNamespace: "slip44",
            assetReference: "0",
        });
    });

    it("round-trips every id it accepts", () => {
        const ids = [
            BTC_ON_ARKADE,
            "bitcoin:regtest/slip44:0",
            "bolt11:signet/slip44:0",
            `arkade:regtest/asset:${"a1".repeat(32)}0000`,
            "eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7",
        ];
        for (const id of ids) {
            expect(formatAssetId(parseAssetId(id))).toBe(id);
        }
    });

    it("names the rail as the CAIP-2 namespace, so lightning is bolt11", () => {
        expect(railOf("bolt11:bitcoin/slip44:0")).toBe("bolt11");
        // `lightning` is nine characters, over CAIP-2's eight-character cap:
        // the reason the rail is not simply the corridor's name.
        expect(() => parseAssetId("lightning:bitcoin/slip44:0")).toThrow(AssetIdError);
    });

    it("admits every network core resolves, not only the indexed ones", () => {
        // `testnet` has no market index. It still has assets, and amputating
        // the identity to match the index would make them unnameable.
        expect(bitcoinNetworkOf("arkade:testnet/slip44:0")).toBe("testnet");
        expect(bitcoinNetworkOf("bitcoin:regtest/slip44:0")).toBe("regtest");
        expect(bitcoinNetworkOf("eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7")).toBe(
            undefined,
        );
    });

    describe("refusals", () => {
        const cases: ReadonlyArray<[string, string, string]> = [
            ["a bare 0x address", "0xdac17f958d2ee523a2206206994597c13d831ec7", "malformed"],
            ["no asset part", "arkade:bitcoin", "malformed"],
            ["no asset namespace", "arkade:bitcoin/slip440", "malformed"],
            ["a nine-character namespace", "lightning:bitcoin/slip44:0", "unknown_rail"],
            ["a rail nobody implements", "solana:mainnet/slip44:501", "unknown_rail"],
            ["a network nobody runs", "arkade:liquid/slip44:0", "unknown_network"],
            ["an eip155 chain id with a leading zero", "eip155:01/erc20:0x00", "invalid_chain_id"],
            [
                "a colon in the asset reference",
                "arkade:bitcoin/slip44:0:1",
                "invalid_asset_reference",
            ],
            ["a CAIP-19 token id", "eip155:1/erc721:0xabc/1", "token_id_unsupported"],
            [
                "an asset namespace nothing serves",
                "arkade:bitcoin/erc721:0",
                "unknown_asset_namespace",
            ],
            [
                "an EIP-55 checksummed reference",
                "eip155:1/erc20:0xdAC17F958D2ee523a2206206994597C13D831ec7",
                "uppercase",
            ],
            [
                "an arkade reference that is not the identity form",
                "arkade:bitcoin/asset:notanidentity",
                "invalid_asset_reference",
            ],
            [
                "an identity core itself refuses",
                `arkade:bitcoin/asset:${"00".repeat(32)}0000`,
                "invalid_asset_reference",
            ],
        ];
        for (const [label, value, reason] of cases) {
            it(`refuses ${label}`, () => {
                expect(isAssetId(value)).toBe(false);
                expect(() => parseAssetId(value)).toThrowError(
                    expect.objectContaining({ name: "AssetIdError", reason }),
                );
            });
        }
    });
});

describe("sameness across rails", () => {
    it("is the shared asset part, not a shared id", () => {
        // The whole reason the rail is the namespace: one BTC per rail, and
        // sameness stays a comparison instead of a string both sides must agree on.
        expect(sameAsset(btcOn("arkade", "bitcoin"), btcOn("bitcoin", "bitcoin"))).toBe(true);
        expect(sameAsset(btcOn("bolt11", "bitcoin"), btcOn("arkade", "bitcoin"))).toBe(true);
        expect(btcOn("arkade", "bitcoin")).not.toBe(btcOn("bitcoin", "bitcoin"));
        expect(assetPartOf(btcOn("arkade", "regtest"))).toBe("slip44:0");
    });

    it("does not confuse two arkade assets", () => {
        const one = arkadeAsset("regtest", issued(`${"a1".repeat(32)}0000`));
        const two = arkadeAsset("regtest", issued(`${"a1".repeat(32)}0100`));
        expect(sameAsset(one, two)).toBe(false);
    });

    it("keeps BTC and an issued asset apart on the same rail", () => {
        const asset0 = arkadeAsset("bitcoin", issued(`${"ff".repeat(32)}0000`));
        expect(sameAsset(asset0, btcOn("arkade", "bitcoin"))).toBe(false);
        expect(issuanceOf(btcOn("arkade", "bitcoin"))).toBe(undefined);
    });
});

/**
 * The identity form is implemented in seven places across three repos and every
 * disagreement between them fails silently, which is what the shared vectors
 * exist to catch. The public id adds no eighth spelling: its asset reference is
 * `AssetId.toString()` verbatim.
 */
describe("arkade asset ids, against the shared vector", () => {
    const V = asset.ASSET_ID_VECTORS;
    const drift = (label: string) => `asset id encoding drifted from ASSET_ID_VECTORS (${label})`;

    V.valid.forEach((v) => {
        it(`carries the identity form verbatim -- ${v.label}`, () => {
            const id = arkadeAsset("regtest", asset.AssetId.create(V.txid_hex, v.group_index));
            expect(id, drift(v.label)).toBe(`arkade:regtest/asset:${v.asset_id_hex}`);
            expect(parseAssetId(id).assetReference, drift(v.label)).toMatch(/^[0-9a-f]{68}$/);
            // ...and the same 34 bytes back out.
            expect(issuanceOf(id)?.serialize(), drift(v.label)).toEqual(
                asset.AssetId.fromString(v.asset_id_hex).serialize(),
            );
        });
    });

    V.invalid_identity
        .filter((v) => v.normalizes_to !== undefined)
        .forEach((v) => {
            it(`normalises through core rather than propagating -- ${v.label}`, () => {
                // Taking an `asset.AssetId` rather than a string is what
                // enforces the case rule: `hex.decode` accepts uppercase and
                // `hex.encode` emits only lowercase.
                expect(arkadeAsset("regtest", issued(v.value)), drift(v.label)).toBe(
                    `arkade:regtest/asset:${v.normalizes_to}`,
                );
                expect(() => parseAssetId(`arkade:regtest/asset:${v.value}`)).toThrow(AssetIdError);
            });
        });
});
