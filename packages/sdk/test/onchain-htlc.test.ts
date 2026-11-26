import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { compile } from "@arkade-os/compiler";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { Script } from "@scure/btc-signer";
import {
    arkade,
    CLTVMultisigTapscript,
    ConditionMultisigTapscript,
    CSVMultisigTapscript,
    decodeTapscript,
    networks,
    OnchainHTLC,
    VHTLC,
} from "../src";
import artifact from "../src/script/contracts/onchain-htlc.json";

const CODE_HASH = "sha256:99cbb4e5997fc46247dbb667af143e4bd5706ed4abb0145409140403c107ea7d";
const key = (byte: number) => schnorr.getPublicKey(new Uint8Array(32).fill(byte));
const [sender, receiver, server] = [0x01, 0x02, 0x03].map(key);
const SATS: OnchainHTLC.Options = {
    sender,
    receiver,
    server,
    preimageHash: new Uint8Array(20).fill(0x07),
    refundLocktime: 800_000n,
    refundDelay: { type: "seconds", value: 1024n },
    claimDelay: { type: "seconds", value: 2048n },
    receiverScript: new Uint8Array(32).fill(0x0a),
    senderScript: new Uint8Array(32).fill(0x0b),
    amount: 10_000n,
    fee: 1_000n,
};
const ASSET_TXID = Uint8Array.from({ length: 32 }, (_, i) => i);
const ASSET: OnchainHTLC.Options = {
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

describe("OnchainHTLC", () => {
    it("ships the source arkadec compiles into its artifact", async () => {
        const source = readFileSync(
            new URL("../src/script/contracts/onchain-htlc.ark", import.meta.url),
            "utf8",
        );
        expect(artifact.source.files["onchain-htlc.ark"]).toBe(source);
        expect(artifact.compiler).toMatchObject({ name: "arkadec", version: "0.1.1" });
        const fresh = await compile({
            entry: "onchain-htlc.ark",
            files: { "onchain-htlc.ark": source },
        });
        expect(fresh.artifact?.functions).toEqual(artifact.functions);
        expect([fresh.artifact?.codeHash, artifact.codeHash]).toEqual([CODE_HASH, CODE_HASH]);
    });

    it("orders its six leaves as the artifact lists them, each in its spend group", () => {
        expect(OnchainHTLC.script(SATS).compiled.map((fn) => [fn.name, fn.def.group])).toEqual([
            ["nonInteractiveClaim", "payReceiver"],
            ["nonInteractiveRefundWithoutReceiver", "paySender"],
            ["claim", "claim"],
            ["refundWithoutReceiver", "refundWithoutReceiver"],
            ["unilateralRefundWithoutReceiver", "unilateralRefundWithoutReceiver"],
            ["unilateralClaim", "unilateralClaim"],
        ]);
    });

    it("signs each covenant leaf with the server key tweaked by its covenant, and no emulator", () => {
        const signing = (name: string) => {
            const { signers, emulator, emulatorIndex } =
                OnchainHTLC.program.functions[name].tapscript;
            return { signers, emulator, emulatorIndex };
        };
        expect(["nonInteractiveClaim", "nonInteractiveRefundWithoutReceiver"].map(signing)).toEqual(
            [
                { signers: [{ tweak: "$server", fn: "payReceiver" }], emulator: null },
                { signers: [{ tweak: "$server", fn: "paySender" }], emulator: null },
            ],
        );
    });

    it("names the operator once in each leaf without a CSV, plain or tweaked, and in no CSV leaf", () => {
        const operator = ({ leafScript, arkadeScript }: arkade.CompiledProgramFunction) => {
            const tweaked = arkadeScript
                ? hex.encode(arkade.computeArkadeScriptPublicKey(server, arkadeScript))
                : undefined;
            return decodeTapscript(leafScript).params.pubkeys.flatMap((pubkey: Uint8Array) => {
                const k = hex.encode(pubkey);
                return k === hex.encode(server) ? ["plain"] : k === tweaked ? ["tweaked"] : [];
            });
        };
        const htlc = OnchainHTLC.script(SATS);
        expect(htlc.compiled.map((fn) => [fn.name, !!fn.def.tapscript.csv, operator(fn)])).toEqual([
            ["nonInteractiveClaim", false, ["tweaked"]],
            ["nonInteractiveRefundWithoutReceiver", false, ["tweaked"]],
            ["claim", false, ["plain"]],
            ["refundWithoutReceiver", false, ["plain"]],
            ["unilateralRefundWithoutReceiver", true, []],
            ["unilateralClaim", true, []],
        ]);
    });

    it("carries refundDelay and claimDelay as BIP 68 sequences in its two CSV leaves", () => {
        const htlc = OnchainHTLC.script(SATS);
        const csv = (name: string) =>
            decodeTapscript(htlc.functionByName(name)!.leafScript).params.timelock;
        expect(OnchainHTLC.args(SATS)).toMatchObject({
            refundDelay: 0x400002n,
            claimDelay: 0x400004n,
        });
        expect([csv("unilateralRefundWithoutReceiver"), csv("unilateralClaim")]).toEqual([
            SATS.refundDelay,
            SATS.claimDelay,
        ]);
    });

    it.each([
        ["sats-only", SATS, "5120c1ab97731c70021a50e43c592016e1918c0618b59b251b88d6cf51a477862d7e"],
        ["asset", ASSET, "51207ba3eebe0753a7edbc48d5ef52be8900d928c5ba5aa4517c53218c2a1d61fc78"],
    ] as const)("compiles the %s lockup to its hand-built tree", async (_, options, golden) => {
        const htlc = OnchainHTLC.script(options);
        const tweaked = (name: string) =>
            arkade.computeArkadeScriptPublicKey(server, htlc.functionByName(name)!.arkadeScript!);
        const conditionScript = Script.encode([
            "SIZE",
            32,
            "EQUALVERIFY",
            "HASH160",
            SATS.preimageHash,
            "EQUAL",
        ]);
        const covenantLeaves = [
            ConditionMultisigTapscript.encode({
                conditionScript,
                pubkeys: [tweaked("nonInteractiveClaim")],
            }),
            CLTVMultisigTapscript.encode({
                absoluteTimelock: SATS.refundLocktime,
                pubkeys: [tweaked("nonInteractiveRefundWithoutReceiver")],
            }),
        ];
        const v2 = new VHTLC.ScriptV2({
            sender,
            receiver,
            server,
            preimageHash: SATS.preimageHash,
            refundLocktime: SATS.refundLocktime,
            unilateralClaimDelay: SATS.claimDelay,
            unilateralRefundDelay: SATS.claimDelay, // its leaf has no OnchainHTLC counterpart
            unilateralRefundWithoutReceiverDelay: SATS.refundDelay,
        });
        expect(htlc.compiled.map((fn) => hex.encode(fn.leafScript))).toEqual([
            ...covenantLeaves.map((leaf) => hex.encode(leaf.script)),
            v2.claimScript,
            v2.refundWithoutReceiverScript,
            v2.unilateralRefundWithoutReceiverScript,
            v2.unilateralClaimScript,
        ]);
        expect(hex.encode(htlc.pkScript)).toBe(golden);
        const folded = (await connect(server)).contract(
            arkade.programFromArtifact(artifact as arkade.ContractArtifact),
            OnchainHTLC.args(options),
        );
        expect(hex.encode(folded.pkScript)).toBe(golden);
    });

    it("binds a sats-only lockup to the zero asset, and an asset's txid reversed", () => {
        expect(OnchainHTLC.args(SATS)).toMatchObject({
            "asset.txid": new Uint8Array(32),
            "asset.gidx": 0,
            assetAmount: 0n,
            fee: 1_000n,
        });
        expect(OnchainHTLC.args(ASSET)).toMatchObject({
            "asset.txid": ASSET_TXID.slice().reverse(),
            "asset.gidx": 1,
            assetAmount: 21n,
        });
    });

    it("derives one address whatever co-signer key the deriving client holds", async () => {
        const expected = hex.encode(OnchainHTLC.script(SATS).pkScript);
        for (const emulator of [server, key(0x09)]) {
            const ark = await connect(emulator);
            const contract = ark.contract(OnchainHTLC.program, OnchainHTLC.args(SATS));
            expect(hex.encode(contract.pkScript)).toBe(expected);
        }
    });

    it("refuses a sender refund that opens no earlier than the claim, or before arkd's exit delay", () => {
        expect(() => OnchainHTLC.args({ ...SATS, refundDelay: SATS.claimDelay })).toThrow(
            /refundDelay must open before claimDelay/,
        );
        expect(() =>
            OnchainHTLC.args({ ...SATS, refundDelay: { type: "seconds", value: 4096n } }),
        ).toThrow(/refundDelay must open before claimDelay/);
        expect(() =>
            OnchainHTLC.args({ ...SATS, refundDelay: { type: "blocks", value: 144n } }),
        ).toThrow(/refundDelay must open before claimDelay/);
        expect(() =>
            OnchainHTLC.args({ ...SATS, minExitDelay: { type: "seconds", value: 1536n } }),
        ).toThrow(/minExitDelay/);
        expect(() =>
            OnchainHTLC.args({ ...SATS, minExitDelay: { type: "blocks", value: 1n } }),
        ).toThrow(/minExitDelay/);
        expect(() => OnchainHTLC.args({ ...SATS, minExitDelay: SATS.refundDelay })).not.toThrow();
    });

    it("refuses a timelock that opens at once, an amount that is not positive, or a negative fee", () => {
        expect(() => OnchainHTLC.args({ ...SATS, refundLocktime: 0n })).toThrow(/refundLocktime/);
        expect(() =>
            OnchainHTLC.args({ ...SATS, refundDelay: { type: "seconds", value: 0n } }),
        ).toThrow(/refundDelay must be greater than 0/);
        expect(() => OnchainHTLC.args({ ...SATS, amount: 0n })).toThrow(/amount/);
        expect(() =>
            OnchainHTLC.args({ ...ASSET, asset: { ...ASSET.asset!, amount: 0n } }),
        ).toThrow(/asset amount/);
        expect(() => OnchainHTLC.args({ ...SATS, fee: -1n })).toThrow(/fee/);
        expect(() => OnchainHTLC.args({ ...SATS, fee: 0n })).not.toThrow();
    });
});
