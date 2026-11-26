import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { compile } from "@arkade-os/compiler";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { Script } from "@scure/btc-signer";
import {
    ArkadeHTLC,
    arkade,
    CLTVMultisigTapscript,
    ConditionMultisigTapscript,
    CSVMultisigTapscript,
    MultisigTapscript,
    networks,
    VHTLC,
} from "../src";
import artifact from "../src/script/contracts/arkade-htlc.json";

const CODE_HASH = "sha256:5d58e749e6ddcd46b30add050f3a2d13537a991e063974034d2d5c3d5b8bc11b";
const key = (byte: number) => schnorr.getPublicKey(new Uint8Array(32).fill(byte));
const [sender, receiver, server] = [0x01, 0x02, 0x03].map(key);
const LOCKUP = {
    sender,
    receiver,
    server,
    preimageHash: new Uint8Array(20).fill(0x07),
    refundLocktime: 800_000n,
    unilateralClaimDelay: { type: "blocks", value: 144n },
    unilateralRefundDelay: { type: "seconds", value: 1024n },
    unilateralRefundWithoutReceiverDelay: { type: "blocks", value: 288n },
} satisfies VHTLC.Options;
const SATS: ArkadeHTLC.Options = {
    ...LOCKUP,
    receiverScript: new Uint8Array(32).fill(0x0a),
    senderScript: new Uint8Array(32).fill(0x0b),
    amount: 10_000n,
};
const ASSET_TXID = Uint8Array.from({ length: 32 }, (_, i) => i);
const ASSET: ArkadeHTLC.Options = {
    ...SATS,
    asset: { txid: ASSET_TXID, groupIndex: 1, amount: 21n },
};

async function connect(emulator: Uint8Array) {
    const checkpoint = CSVMultisigTapscript.encode({
        timelock: { type: "blocks", value: 10n },
        pubkeys: [server],
    });
    const info = {
        signerPubkey: `02${hex.encode(server)}`,
        checkpointTapscript: hex.encode(checkpoint.script),
    };
    return arkade.Arkade.connect({
        arkade: { getInfo: async () => info as any },
        network: networks.regtest,
        emulatorPubkey: `02${hex.encode(emulator)}`,
    });
}

describe("ArkadeHTLC", () => {
    it("ships the source arkadec compiles into its artifact", async () => {
        const source = readFileSync(
            new URL("../src/script/contracts/arkade-htlc.ark", import.meta.url),
            "utf8",
        );
        expect(artifact.source.files["arkade-htlc.ark"]).toBe(source);
        expect(artifact.compiler).toMatchObject({ name: "arkadec", version: "0.1.1" });
        const fresh = await compile({
            entry: "arkade-htlc.ark",
            files: { "arkade-htlc.ark": source },
        });
        expect(fresh.artifact?.functions).toEqual(artifact.functions);
        expect([fresh.artifact?.codeHash, artifact.codeHash]).toEqual([CODE_HASH, CODE_HASH]);
    });

    it("orders its nine leaves as the artifact lists them, each in its spend group", () => {
        expect(ArkadeHTLC.script(SATS).compiled.map((fn) => [fn.name, fn.def.group])).toEqual([
            ["nonInteractiveClaim", "payReceiver"],
            ["nonInteractiveRefund", "paySender"],
            ["nonInteractiveRefundWithoutReceiver", "paySender"],
            ["claim", "claim"],
            ["refund", "refund"],
            ["refundWithoutReceiver", "refundWithoutReceiver"],
            ["unilateralClaim", "unilateralClaim"],
            ["unilateralRefund", "unilateralRefund"],
            ["unilateralRefundWithoutReceiver", "unilateralRefundWithoutReceiver"],
        ]);
    });

    it("signs each covenant leaf with the server key tweaked by its covenant, and no emulator", () => {
        const signing = (name: string) => {
            const { signers, emulator, emulatorIndex } =
                ArkadeHTLC.program.functions[name].tapscript;
            return { signers, emulator, emulatorIndex };
        };
        expect(
            [
                "nonInteractiveClaim",
                "nonInteractiveRefund",
                "nonInteractiveRefundWithoutReceiver",
            ].map(signing),
        ).toEqual([
            { signers: [{ tweak: "$server", fn: "payReceiver" }], emulator: null },
            { signers: ["$receiver", { tweak: "$server", fn: "paySender" }], emulator: null },
            { signers: [{ tweak: "$server", fn: "paySender" }], emulator: null },
        ]);
    });

    it.each([
        ["sats-only", SATS, "51202e9bbbb4000495f0b4319da50d95bed8f4c5bb8dbcf056552ded90b6c7426e3d"],
        ["asset", ASSET, "5120fc8bc9d425a3806725dbb72219341db3079b4fcb73c9b8cf002f03df407ab785"],
    ] as const)("compiles the %s lockup to its hand-built tree", (_, options, golden) => {
        const htlc = ArkadeHTLC.script(options);
        const tweaked = (name: string) =>
            arkade.computeArkadeScriptPublicKey(server, htlc.functionByName(name)!.arkadeScript!);
        const conditionScript = Script.encode([
            "SIZE",
            32,
            "EQUALVERIFY",
            "HASH160",
            LOCKUP.preimageHash,
            "EQUAL",
        ]);
        const covenantLeaves = [
            ConditionMultisigTapscript.encode({
                conditionScript,
                pubkeys: [tweaked("nonInteractiveClaim")],
            }),
            MultisigTapscript.encode({ pubkeys: [receiver, tweaked("nonInteractiveRefund")] }),
            CLTVMultisigTapscript.encode({
                absoluteTimelock: LOCKUP.refundLocktime,
                pubkeys: [tweaked("nonInteractiveRefund")],
            }),
        ];
        const v2 = new VHTLC.ScriptV2(LOCKUP);
        expect(htlc.compiled.map((fn) => hex.encode(fn.leafScript))).toEqual([
            ...covenantLeaves.map((leaf) => hex.encode(leaf.script)),
            v2.claimScript,
            v2.refundScript,
            v2.refundWithoutReceiverScript,
            v2.unilateralClaimScript,
            v2.unilateralRefundScript,
            v2.unilateralRefundWithoutReceiverScript,
        ]);
        expect(hex.encode(htlc.pkScript)).toBe(golden);
    });

    it("binds a sats-only lockup to the zero asset, and an asset's txid reversed", () => {
        expect(ArkadeHTLC.args(SATS)).toMatchObject({
            "asset.txid": new Uint8Array(32),
            "asset.gidx": 0,
            assetAmount: 0n,
        });
        expect(ArkadeHTLC.args(ASSET)).toMatchObject({
            "asset.txid": ASSET_TXID.slice().reverse(),
            "asset.gidx": 1,
            assetAmount: 21n,
        });
    });

    it("derives one address whatever co-signer key the deriving client holds", async () => {
        const expected = hex.encode(ArkadeHTLC.script(SATS).pkScript);
        for (const emulator of [server, key(0x09)]) {
            const ark = await connect(emulator);
            const contract = ark.contract(ArkadeHTLC.program, ArkadeHTLC.args(SATS));
            expect(hex.encode(contract.pkScript)).toBe(expected);
        }
    });

    it("refuses a lockup whose timelocks open at once, or whose asset it would not check", () => {
        expect(() => ArkadeHTLC.args({ ...SATS, refundLocktime: 0n })).toThrow(/refundLocktime/);
        expect(() =>
            ArkadeHTLC.args({ ...SATS, unilateralRefundDelay: { type: "blocks", value: 0n } }),
        ).toThrow(/unilateralRefundDelay/);
        expect(() => ArkadeHTLC.args({ ...ASSET, asset: { ...ASSET.asset!, amount: 0n } })).toThrow(
            /asset amount/,
        );
    });
});
