// Node-only smoke: walk the exports map, import every repository subpath, and
// round-trip an offer payload through encodeOffer/decodeOffer byte-for-byte.
// Run after `pnpm build`: `pnpm smoke:dist`.
//
// The backends here import types only from @arkade-os/sdk/repositories/*, so
// nothing survives to runtime and a real import is safe — and it is the
// import, not a file-existence walk, that catches a broken exports map.
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
// The TLV round-trip below reaches below the client, so it imports the way a
// consumer doing that now has to: off `/protocol`, not off the root.
import { encodeOffer, decodeOffer, offerContract } from "@arkade-os/swap/protocol";
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

// Named-symbol coverage: the walk above only proves each subpath resolves
// non-empty. A barrel that drops a name resolves fine and breaks the consumer's
// first import instead of the release, so the names are pinned here — and the
// list is not written twice. `scripts/dispositions.json` is the record M8 wrote
// as it rebuilt the barrels, `test/exports.test.ts` diffs it against the source,
// and this diffs the same record against the BUILT artifact, which is the half a
// source test cannot see: a dts rollup or an entry-point change can drop a name
// from `dist` while `src` still exports it.
//
// Only value exports are checkable at runtime. Types are covered by
// `tsconfig.test.json` and by the barrel typechecking at all.
const dispositions = JSON.parse(readFileSync(resolve(pkgRoot, "scripts/dispositions.json"), "utf8"));
const isValue = (mod, name) => Object.hasOwn(mod, name) && mod[name] !== undefined;

const [rootEsm, rootCjs] = [await import("@arkade-os/swap"), require("@arkade-os/swap")];
const [protoEsm, protoCjs] = [
    await import("@arkade-os/swap/protocol"),
    require("@arkade-os/swap/protocol"),
];

for (const [condition, root, protocol] of [
    ["import", rootEsm, protoEsm],
    ["require", rootCjs, protoCjs],
]) {
    // The v2 surface: the factory, the three verbs, and the taxonomy's base.
    for (const name of ["createSwapClient", "pay", "receive", "exchange"]) {
        if (typeof root[name] !== "function") {
            throw new Error(`@arkade-os/swap (${condition}) is missing ${name}`);
        }
    }
    // The taxonomy is sixteen members, and the count is the assertion: a class
    // that never made it onto the barrel leaves `SWAP_ERROR_NAMES` short while
    // every other check still passes.
    if (root.SWAP_ERROR_NAMES?.length !== 16) {
        throw new Error(
            `@arkade-os/swap (${condition}) publishes ${root.SWAP_ERROR_NAMES?.length} error names, not 16`,
        );
    }
    for (const name of ["ClientDisposed", "MaxFeeExceeded", "SwapRefusal"]) {
        if (typeof root[name] !== "function") {
            throw new Error(`@arkade-os/swap (${condition}) is missing ${name}`);
        }
    }

    // The deprecated floor: every P value on the subpath, and none of them on
    // the root. Which P names are values rather than types is read off the
    // built subpath rather than recorded a second time — a type simply is not
    // there at runtime — and the floor count guards against the degenerate pass
    // where the module resolved empty and nothing was checked.
    const values = dispositions.P.filter((name) => isValue(protoEsm, name));
    if (values.length < 100) {
        throw new Error(`@arkade-os/swap/protocol (${condition}) exports only ${values.length} values`);
    }
    const missing = values.filter((name) => !isValue(protocol, name));
    if (missing.length) {
        throw new Error(
            `@arkade-os/swap/protocol (${condition}) is missing ${missing.length} deprecated ` +
                `name(s): ${missing.slice(0, 8).join(", ")}`,
        );
    }
    // The window was collapsed on purpose: one break, one migration, and a root
    // that is the v2 surface rather than 41% v1. A P name back on the root is
    // that decision being undone by accident.
    const onRoot = values.filter((name) => isValue(root, name));
    if (onRoot.length) {
        throw new Error(
            `@arkade-os/swap (${condition}) re-exports ${onRoot.length} /protocol ` +
                `name(s): ${onRoot.slice(0, 8).join(", ")}`,
        );
    }

    // And what M8 removed stays removed. A D or I name back on the root is the
    // deprecation quietly reverting to a re-export.
    const returned = [...dispositions.I, ...dispositions.D].filter(
        (name) => isValue(root, name) || isValue(protocol, name),
    );
    if (returned.length) {
        throw new Error(`(${condition}) internalized/deleted names are exported again: ${returned}`);
    }
}

// Constructing is the check: neither handle is touched.
const stubExecutor = { run: async () => {}, get: async () => undefined, all: async () => [] };
new SQLiteAssetSwapRepository(stubExecutor);
new RealmAssetSwapRepository({});
// Name-based, not a magic count: the count is what makes adding a schema a
// build failure in a file that has no other reason to change, and what it
// actually needs to catch is a schema that never made it into the exported
// list — the one mistake that fails at a consumer's first `realm.objects(…)`
// rather than at open.
const schemaNames = AssetSwapRealmSchemas.map((s) => s.name);
for (const required of [
    "ArkadeAssetSwap",
    "ArkadeRfqSwap",
    "ArkadeSwapRecord",
    "ArkadeAssetSwapScannedTxid",
    "ArkadeAssetSwapMarketsCache",
]) {
    if (!schemaNames.includes(required)) {
        throw new Error(`AssetSwapRealmSchemas is missing ${required}: [${schemaNames}]`);
    }
}
if (new Set(schemaNames).size !== schemaNames.length) {
    throw new Error(`AssetSwapRealmSchemas has duplicate names: [${schemaNames}]`);
}

const operatorPubkey = hex.decode("4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa");
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

const contract = offerContract(offer, operatorPubkey);
offer.swapPkScript = contract.pkScript;
const address = new ArkAddress(operatorPubkey, contract.tweakedPublicKey, "tark").encode();

const payload = encodeOffer(offer);
const roundtripped = encodeOffer(decodeOffer(payload));
if (hex.encode(payload) !== hex.encode(roundtripped)) {
    throw new Error("TLV round-trip is not byte-identical");
}
const golden =
    "tark1qp8n2k7uklxq4aegau7vawtptkgxsja4kt99lpv6krctwpq8tpc65wq0wnmwgr4nglzx999xqx7xahllp4gfh6638wkrjt5tl3k7c8vy6frzj2";
if (address !== golden) throw new Error(`address drift: ${address}`);

console.log("smoke OK:", payload.length, "byte payload,", address);
