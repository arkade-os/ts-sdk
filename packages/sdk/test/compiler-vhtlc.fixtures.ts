import { readFileSync } from "node:fs";
import { hex } from "@scure/base";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/utils.js";
import { hash160 } from "@scure/btc-signer/utils.js";
import { programFromArtifact, type ContractArtifact } from "../src/arkade/artifact";
import { ArkadeProgramScript, type ArkadeParamValue } from "../src/arkade/program";
import { arkadeScriptHash } from "../src/arkade/tweak";
import { VHTLC } from "../src/script/vhtlc";
import { timelockToSequence } from "../src/utils/timelock";

export const leafNames = [
    "claim",
    "refund",
    "refundWithoutReceiver",
    "unilateralClaim",
    "unilateralRefund",
    "unilateralRefundWithoutReceiver",
    "nonInteractiveClaim",
    "nonInteractiveRefund",
    "nonInteractiveRefundWithoutReceiver",
] as const;

type Version = "v1" | "v2";
type Denomination = "btc" | "asset";
type Optimization = "optimized" | "unoptimized";

export const profiles = [
    { name: "block-minimum", type: "blocks", delay: 1n, locktime: 500_000_000n, group: 0, seed: 1 },
    {
        name: "block-maximum",
        type: "blocks",
        delay: 65_535n,
        locktime: 4_294_967_295n,
        group: 65_535,
        seed: 7,
    },
    {
        name: "seconds-minimum",
        type: "seconds",
        delay: 512n,
        locktime: 1_800_000_000n,
        group: 1,
        seed: 13,
    },
    {
        name: "seconds-maximum",
        type: "seconds",
        delay: 33_553_920n,
        locktime: 499_999_999n,
        group: 255,
        seed: 19,
    },
] as const;

export function artifactFile(
    name: string,
    optimization: Optimization = "optimized",
): { source: string; artifact: string; value: ContractArtifact } {
    const source = `packages/sdk/contracts/vhtlc/${name}.ark`;
    const suffix = optimization === "optimized" ? ".artifact.json" : ".unoptimized.artifact.json";
    const artifact = source.replace(/\.ark$/, suffix);
    return {
        source,
        artifact,
        value: JSON.parse(
            readFileSync(new URL(`../contracts/vhtlc/${name}${suffix}`, import.meta.url), "utf8"),
        ),
    };
}

function tweakedSecret(secret: Uint8Array, covenant: Uint8Array): Uint8Array {
    const order = secp256k1.Point.CURVE().n;
    const scalar = bytesToNumberBE(secret);
    const point = secp256k1.Point.BASE.multiply(scalar);
    const evenScalar = point.y % 2n === 0n ? scalar : order - scalar;
    return numberToBytesBE((evenScalar + bytesToNumberBE(arkadeScriptHash(covenant))) % order, 32);
}

export function fixture(
    version: Version,
    denomination: Denomination,
    profile: (typeof profiles)[number],
    legacy = false,
    preimageLength = 32,
    optimization: Optimization = "optimized",
) {
    const secrets = Object.fromEntries(
        ["sender", "receiver", "server", "emulator"].map((name, index) => [
            name,
            new Uint8Array(32).fill(profile.seed + index),
        ]),
    );
    const keys = Object.fromEntries(
        Object.entries(secrets).map(([name, secret]) => [name, schnorr.getPublicKey(secret)]),
    );
    const p2tr = (program: Uint8Array) => Uint8Array.from([0x51, 0x20, ...program]);
    const preimage = new Uint8Array(preimageLength).fill(0x42);
    const assetTxid = Uint8Array.from({ length: 32 }, (_, index) => index + profile.seed);
    const delay = { type: profile.type, value: profile.delay };
    const options: VHTLC.Options = {
        sender: keys.sender,
        receiver: keys.receiver,
        server: keys.server,
        preimageHash: hash160(preimage),
        refundLocktime: profile.locktime,
        unilateralClaimDelay: delay,
        unilateralRefundDelay: delay,
        unilateralRefundWithoutReceiverDelay: delay,
        nonInteractiveParameters: {
            emulatorPubkey: keys.emulator,
            receiverPkScript: p2tr(keys.receiver),
            senderPkScript: p2tr(keys.sender),
            ...(legacy ? { legacy: "preTimelockedRefund" as const } : {}),
        },
        ...(denomination === "asset"
            ? { asset: { txid: assetTxid, groupIndex: profile.group } }
            : {}),
    };
    const manual = version === "v1" ? new VHTLC.Script(options) : new VHTLC.ScriptV2(options);
    const suffix = version === "v1" ? "v1" : "v2-candidate";
    const signatureArtifact = artifactFile(`signatures-${suffix}`, optimization);
    const payoutArtifact = artifactFile(`payout-${denomination}-${suffix}`, optimization);
    const sequence = BigInt(timelockToSequence(delay));
    const args: Record<string, ArkadeParamValue> = {
        sender: keys.sender,
        receiver: keys.receiver,
        preimageHash: options.preimageHash,
        refundLocktime: profile.locktime,
        claimSequence: sequence,
        refundSequence: sequence,
        refundWithoutReceiverSequence: sequence,
        receiverProgram: keys.receiver,
        senderProgram: keys.sender,
        assetWireTxid: Uint8Array.from(assetTxid).reverse(),
        assetGroupIndex: BigInt(profile.group),
        server: keys.server,
    };
    const bindings = { serverKey: keys.server, emulatorKey: keys.emulator };
    const signatures = new ArkadeProgramScript(
        programFromArtifact(signatureArtifact.value),
        args,
        bindings,
    );
    const payouts = new ArkadeProgramScript(
        programFromArtifact(payoutArtifact.value),
        args,
        bindings,
    );
    const compiled = new Map(
        [...signatures.compiled, ...payouts.compiled].map((leaf) => [
            leaf.name.includes(":") ? leaf.name.slice(leaf.name.lastIndexOf(":") + 1) : leaf.name,
            leaf,
        ]),
    );
    const baseSecrets = Object.fromEntries(
        Object.entries(secrets).map(([name, secret]) => [
            hex.encode(keys[name]),
            hex.encode(secret),
        ]),
    );
    const keySecrets = (covenant?: Uint8Array) => {
        if (!covenant) return baseSecrets;
        const secret = tweakedSecret(secrets.emulator, covenant);
        return { ...baseSecrets, [hex.encode(schnorr.getPublicKey(secret))]: hex.encode(secret) };
    };
    const signerPolicy = {
        claim: ["receiver", "server"],
        refund: ["sender", "receiver", "server"],
        refundWithoutReceiver: ["sender", "server"],
        unilateralClaim: ["receiver"],
        unilateralRefund: ["sender", "receiver"],
        unilateralRefundWithoutReceiver: ["sender"],
        nonInteractiveClaim: ["server", "emulator"],
        nonInteractiveRefund: ["server", "receiver", "emulator"],
        nonInteractiveRefundWithoutReceiver: ["server", "emulator"],
    };
    const expectedSignerKeys = (path: (typeof leafNames)[number], covenant?: Uint8Array) =>
        signerPolicy[path].map((name) =>
            hex.encode(
                name === "emulator" && covenant
                    ? schnorr.getPublicKey(tweakedSecret(secrets.emulator, covenant))
                    : keys[name],
            ),
        );
    const rows = leafNames
        .filter((path) => !legacy || path !== "nonInteractiveRefundWithoutReceiver")
        .map((path) => {
            const candidate = compiled.get(path)!;
            const manualCovenant =
                path === "nonInteractiveClaim"
                    ? manual.nonInteractiveClaimArkadeScript
                    : path.startsWith("nonInteractiveRefund")
                      ? manual.nonInteractiveRefundArkadeScript
                      : undefined;
            const manualLeaf = manual[`${path}Script` as keyof typeof manual] as string;
            const files = path.startsWith("nonInteractive") ? payoutArtifact : signatureArtifact;
            return {
                name: `vhtlc/${version}/${denomination}/${profile.name}/${legacy ? "legacy" : "full"}/${path}${preimageLength === 32 ? "" : `/preimage-${preimageLength}`}`,
                kind: manualCovenant ? "covenant" : "tapscript",
                source: files.source,
                artifact: files.artifact,
                manual: {
                    leafHex: manualLeaf,
                    ...(manualCovenant ? { covenantHex: hex.encode(manualCovenant) } : {}),
                    keySecrets: keySecrets(manualCovenant),
                    expectedSignerKeys: expectedSignerKeys(path, manualCovenant),
                },
                generated: {
                    leafHex: hex.encode(candidate.leafScript),
                    ...(candidate.arkadeScript
                        ? { covenantHex: hex.encode(candidate.arkadeScript) }
                        : {}),
                    keySecrets: keySecrets(candidate.arkadeScript),
                    expectedSignerKeys: expectedSignerKeys(path, candidate.arkadeScript),
                },
                context: {
                    version,
                    denomination,
                    profile: profile.name,
                    optimization,
                    legacy,
                    path,
                    preimageHex: hex.encode(preimage),
                    inputIndex: 1,
                    inputValue: "330",
                    destinationHex: hex.encode(
                        path === "nonInteractiveClaim" ? p2tr(keys.receiver) : p2tr(keys.sender),
                    ),
                    refundLocktime: profile.locktime.toString(),
                    sequence: sequence.toString(),
                    ...(denomination === "asset"
                        ? {
                              inputAsset: {
                                  txidHex: hex.encode(assetTxid),
                                  wireTxidHex: hex.encode(Uint8Array.from(assetTxid).reverse()),
                                  groupIndex: profile.group,
                                  amount: "1000",
                              },
                          }
                        : {}),
                },
            };
        });
    return { manual, compiled, rows, signatureArtifact, payoutArtifact, preimage, options };
}

export function comparisons(optimization: Optimization = "optimized") {
    const rows = profiles.flatMap((profile) =>
        (["v1", "v2"] as const).flatMap((version) =>
            (["btc", "asset"] as const).flatMap((denomination) =>
                [false, true].flatMap(
                    (legacy) =>
                        fixture(version, denomination, profile, legacy, 32, optimization).rows,
                ),
            ),
        ),
    );
    const counterexamples = ([31, 33] as const).flatMap((length) =>
        (["v1", "v2"] as const).flatMap((version) =>
            (["btc", "asset"] as const).flatMap((denomination) =>
                fixture(
                    version,
                    denomination,
                    profiles[0],
                    false,
                    length,
                    optimization,
                ).rows.filter((row) =>
                    ["claim", "unilateralClaim", "nonInteractiveClaim"].includes(row.context.path),
                ),
            ),
        ),
    );
    return [...rows, ...counterexamples];
}
