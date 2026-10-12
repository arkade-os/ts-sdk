import { readFileSync } from "node:fs";
import { hex } from "@scure/base";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/utils.js";
import { arkade, asset, timelockToSequence, type RelativeTimelock } from "@arkade-os/sdk";
import { swapProgramBinding, type Offer } from "../src/offer";

type Artifact = Parameters<typeof arkade.programFromArtifact>[0];
type ComparisonBinding = {
    name: string;
    source: string;
    artifact: string;
    offer: Omit<Offer, "swapPkScript">;
    args: ConstructorParameters<typeof arkade.ArkadeProgramScript>[1];
    manual: InstanceType<typeof arkade.ArkadeProgramScript>;
    generated: InstanceType<typeof arkade.ArkadeProgramScript>;
};
const operatorPubkey = hex.decode(
    "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa",
);
const keys = {
    makerPkScript: hex.decode(
        "51203c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1",
    ),
    makerPublicKey: hex.decode("3c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1"),
    emulatorPubkey: hex.decode("466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27"),
};
const testSecrets = [0x11, 0x22, 0x33].map((value) => new Uint8Array(32).fill(value));
const baseSecrets = Object.fromEntries(
    testSecrets.map((secret) => [hex.encode(schnorr.getPublicKey(secret)), hex.encode(secret)]),
);

function keySecrets(covenant?: Uint8Array) {
    if (!covenant) return baseSecrets;
    const order = secp256k1.Point.CURVE().n;
    const scalar = bytesToNumberBE(testSecrets[1]);
    const point = secp256k1.Point.BASE.multiply(scalar);
    const evenScalar = point.y % 2n === 0n ? scalar : order - scalar;
    const secret = numberToBytesBE(
        (evenScalar + bytesToNumberBE(arkade.arkadeScriptHash(covenant))) % order,
        32,
    );
    return { ...baseSecrets, [hex.encode(schnorr.getPublicKey(secret))]: hex.encode(secret) };
}

function expectedSignerKeys(path: string, covenant?: Uint8Array) {
    if (path === "exit") return [hex.encode(keys.makerPublicKey)];
    if (path === "cancel") return [hex.encode(keys.makerPublicKey), hex.encode(operatorPubkey)];
    if (path !== "fulfill" || !covenant) throw new Error(`Unknown signer policy: ${path}`);
    const emulator = Object.keys(keySecrets(covenant)).find((key) => !(key in baseSecrets));
    if (!emulator) throw new Error("Missing tweaked emulator key");
    return [hex.encode(operatorPubkey), emulator];
}

const txid = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const amounts = [0n, 1n, 16n, 17n, (1n << 63n) - 1n, (1n << 64n) - 1n];
const groupIndices = [0, 1, 255, 256, 65_535, 0];
const exits: (RelativeTimelock | undefined)[] = [
    undefined,
    { type: "blocks", value: 144n },
    { type: "seconds", value: 4_096n },
];

export function bindings(variant: "optimized" | "unoptimized" = "optimized"): ComparisonBinding[] {
    return ["btc", "asset"].flatMap((side) =>
        amounts.flatMap((wantAmount, index) =>
            exits.map((exitDelay) => {
                const id = asset.AssetId.create(txid, groupIndices[index]);
                const offer: Omit<Offer, "swapPkScript"> = {
                    ...keys,
                    wantAmount,
                    ...(side === "asset" ? { wantAsset: id } : { offerAsset: id }),
                    ...(exitDelay ? { exitDelay } : {}),
                };
                const suffix = exitDelay ? "-with-exit" : "";
                const stem = `swap-want-${side}${suffix}`;
                const artifactName = `${stem}${variant === "unoptimized" ? ".unoptimized" : ""}.artifact.json`;
                const artifactPath = `packages/swap/contracts/${artifactName}`;
                const artifact: Artifact = JSON.parse(
                    readFileSync(new URL(`../contracts/${artifactName}`, import.meta.url), "utf8"),
                );
                const binding = swapProgramBinding(offer, operatorPubkey);
                const generatedArgs = {
                    ...binding.args,
                    ...(exitDelay ? { exitSequence: BigInt(timelockToSequence(exitDelay)) } : {}),
                };
                const manual = new arkade.ArkadeProgramScript(
                    binding.program,
                    binding.args,
                    binding.keys,
                );
                const generated = new arkade.ArkadeProgramScript(
                    arkade.programFromArtifact(artifact),
                    generatedArgs,
                    binding.keys,
                );
                return {
                    name: `swap-want-${side}/amount-${wantAmount}${side === "asset" ? `/group-${id.groupIndex}` : ""}/${exitDelay?.type ?? "no-exit"}`,
                    source: `packages/swap/contracts/${stem}.ark`,
                    artifact: artifactPath,
                    offer,
                    args: binding.args,
                    manual,
                    generated,
                };
            }),
        ),
    );
}

export function comparisons(variant: "optimized" | "unoptimized" = "optimized") {
    return bindings(variant).flatMap(({ name, source, artifact, offer, args, manual, generated }) =>
        manual.compiled.map((leaf, index) => ({
            name: `${name}/${leaf.name}`,
            source,
            artifact,
            kind:
                leaf.name === "fulfill"
                    ? offer.wantAsset
                        ? "swap-asset"
                        : "swap-btc"
                    : "tapscript",
            context: {
                path: leaf.name,
                inputIndex: 0,
                inputValue: "330",
                destinationHex: hex.encode(offer.makerPkScript),
                refundLocktime: "0",
                sequence: offer.exitDelay ? timelockToSequence(offer.exitDelay).toString() : "0",
                preimageHex: "",
                wantAmount: offer.wantAmount.toString(),
                makerPkScript: hex.encode(offer.makerPkScript),
                ...(offer.wantAsset
                    ? {
                          wantAssetTxid: hex.encode(args.wantAssetTxid as Uint8Array),
                          wantAssetGroupIndex: offer.wantAsset.groupIndex,
                      }
                    : {}),
            },
            manual: {
                leafHex: hex.encode(leaf.leafScript),
                keySecrets: keySecrets(leaf.arkadeScript),
                expectedSignerKeys: expectedSignerKeys(leaf.name, leaf.arkadeScript),
                ...(leaf.arkadeScript ? { covenantHex: hex.encode(leaf.arkadeScript) } : {}),
            },
            generated: {
                leafHex: hex.encode(generated.compiled[index].leafScript),
                keySecrets: keySecrets(generated.compiled[index].arkadeScript),
                expectedSignerKeys: expectedSignerKeys(
                    leaf.name,
                    generated.compiled[index].arkadeScript,
                ),
                ...(generated.compiled[index].arkadeScript
                    ? { covenantHex: hex.encode(generated.compiled[index].arkadeScript!) }
                    : {}),
            },
        })),
    );
}
