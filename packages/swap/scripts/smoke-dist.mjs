// Node-only smoke: walk the exports map, import every repository subpath, and
// round-trip an offer payload through encodeOffer/decodeOffer byte-for-byte.
// Run after `pnpm build`: `pnpm smoke:dist`.
//
// Unlike the Boltz script's structural-only subpath check, the backends here
// import types only from @arkade-os/sdk/repositories/*, so nothing survives to
// runtime and a real import is safe — and it is the import, not the file-
// existence walk, that catches a broken exports map.
//
// So every import here goes through the package name, not `../dist/...`: a
// relative path resolves whatever is on disk and would pass with the exports
// map removed, malformed, or missing the subpath a consumer writes. Both
// conditions are exercised, since `import` and `require` resolve separately and
// a subpath can be correct under one and broken under the other.
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hex } from "@scure/base";
import { ArkAddress, asset } from "@arkade-os/sdk";
import { encodeOffer, decodeOffer, offerContract } from "@arkade-os/swap";
import { SQLiteAssetSwapRepository } from "@arkade-os/swap/repositories/sqlite";
import {
    AssetSwapRealmSchemas,
    RealmAssetSwapRepository,
} from "@arkade-os/swap/repositories/realm";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8"));

const walkExports = (node, label) => {
    if (typeof node === "string") {
        if (!existsSync(resolve(pkgRoot, node))) {
            throw new Error(`${label} → missing ${node}`);
        }
        return;
    }
    if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) walkExports(v, `${label}.${k}`);
    }
};
walkExports(pkg.exports, "exports");
for (const field of ["main", "types"]) {
    if (pkg[field] && !existsSync(resolve(pkgRoot, pkg[field]))) {
        throw new Error(`${field} → missing ${pkg[field]}`);
    }
}

// Resolve every declared subpath as a consumer would — by specifier, under both
// conditions. Driven off the exports keys, so a subpath added later is covered
// without touching this script. The static imports above already cover three
// specifiers under `import`; this is what covers `require`.
const require = createRequire(resolve(pkgRoot, "package.json"));
const specifiers = Object.keys(pkg.exports).map((key) =>
    key === "." ? pkg.name : `${pkg.name}${key.slice(1)}`,
);
for (const specifier of specifiers) {
    const [esm, cjs] = [await import(specifier), require(specifier)];
    for (const [condition, mod] of [
        ["import", esm],
        ["require", cjs],
    ]) {
        if (!mod || Object.keys(mod).length === 0) {
            throw new Error(`${specifier} (${condition}) → resolved to an empty module`);
        }
    }
}

// Constructing is the check: neither handle is touched.
const stubExecutor = { run: async () => {}, get: async () => undefined, all: async () => [] };
new SQLiteAssetSwapRepository(stubExecutor);
new RealmAssetSwapRepository({});
if (AssetSwapRealmSchemas.length !== 4) {
    throw new Error(`expected 4 Realm schemas, got ${AssetSwapRealmSchemas.length}`);
}

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

const script = offerContract(offer, server);
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
