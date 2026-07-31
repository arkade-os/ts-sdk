// Node-only smoke: build an offer payload with deterministic keys and
// round-trip it through encodeOffer/decodeOffer byte-for-byte. Run after
// `pnpm build`: `pnpm smoke`.
import { hex } from "@scure/base";
import { ArkAddress, asset } from "@arkade-os/sdk";
import { encodeOffer, decodeOffer, offerVtxoScript } from "../dist/index.js";

const server = hex.decode("4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa");
const offer = {
    swapPkScript: new Uint8Array(0),
    wantAmount: 50_000n,
    wantAsset: asset.AssetId.fromString("aa".repeat(32) + "0000"),
    makerPkScript: hex.decode(
        "51203c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1",
    ),
    makerPublicKey: hex.decode("3c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1"),
    emulatorPubkey: hex.decode("466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27"),
};

const script = offerVtxoScript(offer, server);
offer.swapPkScript = script.pkScript;
const address = new ArkAddress(server, script.tweakedPublicKey, "tark").encode();

const payload = encodeOffer(offer);
const roundtripped = encodeOffer(decodeOffer(payload));
if (hex.encode(payload) !== hex.encode(roundtripped)) {
    throw new Error("TLV round-trip is not byte-identical");
}
const golden =
    "tark1qp8n2k7uklxq4aegau7vawtptkgxsja4kt99lpv6krctwpq8tpc65wq0wnmwgr4nglzx999xqx7xahllp4gfh6638wkrjt5tl3k7c8vy6frzj2";
if (address !== golden) throw new Error(`address drift: ${address}`);

console.log("smoke OK:", payload.length, "byte payload,", address);
