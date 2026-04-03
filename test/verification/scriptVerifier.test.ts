import { describe, it, expect } from "vitest";
import { hash160, sha256 } from "@scure/btc-signer/utils.js";
import { randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import * as bip68 from "bip68";
import { SingleKey } from "../../src/identity/singleKey";
import {
    CSVMultisigTapscript,
    CLTVMultisigTapscript,
    ConditionCSVMultisigTapscript,
    ConditionMultisigTapscript,
    MultisigTapscript,
} from "../../src/script/tapscript";
import { VtxoScript } from "../../src/script/base";
import { Transaction as ArkTransaction } from "../../src/utils/transaction";
import { Script } from "@scure/btc-signer";
import {
    setArkPsbtField,
    ConditionWitness,
} from "../../src/utils/unknownFields";
import {
    verifyTaprootScriptTree,
    verifyCSV,
    verifyCLTV,
    verifyHashPreimage,
    verifyScriptSatisfaction,
} from "../../src/verification/scriptVerifier";
import type {
    ChainTip,
    ParentConfirmation,
} from "../../src/verification/scriptVerifier";

// ============================================================
// §1: Taproot script tree verification
// ============================================================

describe("verifyTaprootScriptTree", () => {
    it("should pass for a valid tapLeafScript with Merkle proof", async () => {
        const { tx } = await buildCSVTx();
        const result = verifyTaprootScriptTree(tx, 0);

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it("should fail when tapLeafScript is missing", async () => {
        const destScript = taprootOutputScript(
            await SingleKey.fromPrivateKey(
                randomPrivateKeyBytes()
            ).xOnlyPublicKey()
        );
        const tx = new ArkTransaction();
        tx.addInput({
            txid: new Uint8Array(32).fill(0x01),
            index: 0,
            witnessUtxo: { script: destScript, amount: 10_000n },
        });
        tx.addOutput({ script: destScript, amount: 10_000n });

        const result = verifyTaprootScriptTree(tx, 0);

        expect(result.valid).toBe(false);
        expect(
            result.errors.some((e) => /tapLeafScript|missing/i.test(e))
        ).toBe(true);
    });

    it("should verify leaf hash matches the script content", async () => {
        const { tx } = await buildCSVTx();
        const result = verifyTaprootScriptTree(tx, 0);

        expect(result.valid).toBe(true);
        expect(result.leafType).toBeDefined();
    });

    it("should fail when tapScriptSig leaf hash does not match tapLeafScript", async () => {
        const { tx } = await buildCSVTx();
        const txAny = tx as any;
        txAny.inputs[0].tapScriptSig = [
            [
                {
                    pubKey: new Uint8Array(32).fill(0x02),
                    leafHash: new Uint8Array(32).fill(0x04),
                },
                new Uint8Array(64).fill(0x03),
            ],
        ];

        const result = verifyTaprootScriptTree(tx, 0);

        expect(result.valid).toBe(false);
        expect(
            result.errors.some((e) => /leaf hash.*does not match/i.test(e))
        ).toBe(true);
    });
});

// ============================================================
// §2: CSV (OP_CHECKSEQUENCEVERIFY) verification
// ============================================================

describe("verifyCSV", () => {
    const chainTip: ChainTip = { height: 1000, time: 1700000000 };

    it("should pass when nSequence satisfies the CSV requirement", async () => {
        const { tx } = await buildCSVTx({ csvBlocks: 144n });
        const result = verifyCSV(tx, 0, chainTip);

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it("should fail when nSequence is too low for CSV", async () => {
        const { tx } = await buildCSVTx({
            csvBlocks: 144n,
            sequenceOverride: 10,
        });
        const result = verifyCSV(tx, 0, chainTip);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /sequence|CSV/i.test(e))).toBe(true);
    });

    it("should fail when CSV type (blocks vs seconds) is inconsistent", async () => {
        const { tx } = await buildCSVTx({
            csvSeconds: 512n,
            sequenceOverride: 10, // block-based sequence
        });
        const result = verifyCSV(tx, 0, chainTip);

        expect(result.valid).toBe(false);
        expect(
            result.errors.some((e) => /type|domain|inconsistent/i.test(e))
        ).toBe(true);
    });

    it("should handle seconds-based CSV correctly", async () => {
        const { tx } = await buildCSVTx({ csvSeconds: 512n });
        const result = verifyCSV(tx, 0, chainTip);

        expect(result.valid).toBe(true);
    });

    it("should fail when nSequence disables relative locktime", async () => {
        const { tx } = await buildCSVTx({
            csvBlocks: 144n,
            sequenceOverride: 0xffffffff,
        });
        const result = verifyCSV(tx, 0, chainTip);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /disable|sequence/i.test(e))).toBe(
            true
        );
    });

    it("should report leafType in the result", async () => {
        const { tx } = await buildCSVTx({ csvBlocks: 144n });
        const result = verifyCSV(tx, 0, chainTip);

        expect(result.leafType).toBe("csv-multisig");
    });

    describe("with parentConfirmation (elapsed time check)", () => {
        it("should pass when enough blocks have elapsed", async () => {
            const { tx } = await buildCSVTx({ csvBlocks: 144n });
            const parent: ParentConfirmation = {
                blockHeight: 800,
                blockTime: 1699999000,
            };
            // chainTip.height=1000, parent=800, elapsed=200 >= 144
            const result = verifyCSV(tx, 0, chainTip, parent);

            expect(result.valid).toBe(true);
        });

        it("should fail when not enough blocks have elapsed", async () => {
            const { tx } = await buildCSVTx({ csvBlocks: 144n });
            const parent: ParentConfirmation = {
                blockHeight: 900,
                blockTime: 1699999000,
            };
            // chainTip.height=1000, parent=900, elapsed=100 < 144
            const result = verifyCSV(tx, 0, chainTip, parent);

            expect(result.valid).toBe(false);
            expect(
                result.errors.some((e) =>
                    /not yet satisfiable|elapsed/i.test(e)
                )
            ).toBe(true);
        });

        it("should check seconds elapsed for seconds-based CSV", async () => {
            const { tx } = await buildCSVTx({ csvSeconds: 512n });
            const parent: ParentConfirmation = {
                blockHeight: 900,
                blockTime: 1700000000 - 600, // 600s ago
            };
            // chainTip.time=1700000000, parent.blockTime=1700000000-600, elapsed=600 >= 512
            const result = verifyCSV(tx, 0, chainTip, parent);

            expect(result.valid).toBe(true);
        });

        it("should fail when not enough seconds have elapsed", async () => {
            const { tx } = await buildCSVTx({ csvSeconds: 512n });
            const parent: ParentConfirmation = {
                blockHeight: 900,
                blockTime: 1700000000 - 100, // only 100s ago
            };
            // elapsed=100 < 512
            const result = verifyCSV(tx, 0, chainTip, parent);

            expect(result.valid).toBe(false);
            expect(
                result.errors.some((e) =>
                    /not yet satisfiable|elapsed/i.test(e)
                )
            ).toBe(true);
        });

        it("should still pass structural checks without parentConfirmation", async () => {
            const { tx } = await buildCSVTx({ csvBlocks: 144n });
            // No parentConfirmation — only structural check
            const result = verifyCSV(tx, 0, chainTip);

            expect(result.valid).toBe(true);
        });
    });
});

// ============================================================
// §2: CLTV (OP_CHECKLOCKTIMEVERIFY) verification
// ============================================================

describe("verifyCLTV", () => {
    const chainTip: ChainTip = { height: 1000, time: 1700000000 };

    it("should pass when nLockTime satisfies the CLTV requirement", async () => {
        const { tx } = await buildCLTVTx({ locktime: 900n });
        const result = verifyCLTV(tx, 0, chainTip);

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it("should fail when nLockTime is below the CLTV value", async () => {
        const { tx } = await buildCLTVTx({
            locktime: 2000n,
            nLockTimeOverride: 500,
        });
        const result = verifyCLTV(tx, 0, chainTip);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /locktime|CLTV/i.test(e))).toBe(true);
    });

    it("should fail when domain mismatch (blocks vs seconds)", async () => {
        const { tx } = await buildCLTVTx({
            locktime: 900n,
            nLockTimeOverride: 500_000_001,
        });
        const result = verifyCLTV(tx, 0, chainTip);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /domain|type/i.test(e))).toBe(true);
    });

    it("should fail when nSequence disables locktime (0xFFFFFFFF)", async () => {
        const { tx } = await buildCLTVTx({
            locktime: 900n,
            disableLocktime: true,
        });
        const result = verifyCLTV(tx, 0, chainTip);

        expect(result.valid).toBe(false);
        expect(
            result.errors.some((e) => /sequence.*disable|locktime/i.test(e))
        ).toBe(true);
    });

    it("should handle time-based CLTV (>=500M boundary)", async () => {
        const timeLocktime = 1_700_000_000n; // time-based (>=500M)
        const tipWithTime: ChainTip = {
            height: 900_000,
            time: 1_700_000_100,
        };
        const { tx } = await buildCLTVTx({ locktime: timeLocktime });
        const result = verifyCLTV(tx, 0, tipWithTime);

        expect(result.valid).toBe(true);
    });
});

// ============================================================
// §3: Hash preimage verification (VHTLC / Boltz swap)
// ============================================================

describe("verifyHashPreimage", () => {
    it("should pass when HASH160 preimage matches the script hash", async () => {
        const { tx } = await buildConditionTx();
        const result = verifyHashPreimage(tx, 0);

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it("should fail when preimage does not match the hash", async () => {
        const { tx } = await buildConditionTx({ wrongPreimage: true });
        const result = verifyHashPreimage(tx, 0);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /preimage|hash/i.test(e))).toBe(true);
    });

    it("should fail when condition witness is missing", async () => {
        const { tx } = await buildConditionTx({ noWitness: true });
        const result = verifyHashPreimage(tx, 0);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /witness|missing/i.test(e))).toBe(
            true
        );
    });

    it("should pass when SHA256 preimage matches the script hash", async () => {
        const { tx } = await buildConditionTx({ hashAlgo: "SHA256" });
        const result = verifyHashPreimage(tx, 0);

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it("should fail when condition script has no supported hash opcode", async () => {
        const { tx } = await buildConditionTx({ noHashOpcode: true });
        const result = verifyHashPreimage(tx, 0);

        expect(result.valid).toBe(false);
        expect(
            result.errors.some((e) =>
                /could not detect hash operation|unsupported/i.test(e)
            )
        ).toBe(true);
    });
});

// ============================================================
// §: Full script satisfaction dispatch
// ============================================================

describe("verifyScriptSatisfaction", () => {
    const chainTip: ChainTip = { height: 1000, time: 1700000000 };

    it("should dispatch to CSV verifier for CSVMultisig scripts", async () => {
        const { tx } = await buildCSVTx({ csvBlocks: 144n });
        const result = verifyScriptSatisfaction(tx, 0, chainTip);

        expect(result.valid).toBe(true);
        expect(result.leafType).toBe("csv-multisig");
    });

    it("should dispatch to CLTV verifier for CLTVMultisig scripts", async () => {
        const { tx } = await buildCLTVTx({ locktime: 900n });
        const result = verifyScriptSatisfaction(tx, 0, chainTip);

        expect(result.valid).toBe(true);
        expect(result.leafType).toBe("cltv-multisig");
    });

    it("should dispatch to hash verifier for ConditionMultisig scripts", async () => {
        const { tx } = await buildConditionTx();
        const result = verifyScriptSatisfaction(tx, 0, chainTip);

        expect(result.valid).toBe(true);
        expect(result.leafType).toBe("condition-multisig");
    });

    it("should verify CSV + hash preimage for ConditionCSVMultisig", async () => {
        const { tx } = await buildConditionCSVTx();
        const result = verifyScriptSatisfaction(tx, 0, chainTip);

        expect(result.valid).toBe(true);
        expect(result.leafType).toBe("condition-csv-multisig");
    });

    it("should fail ConditionCSVMultisig when hash preimage is wrong", async () => {
        const { tx } = await buildConditionCSVTx({ wrongPreimage: true });
        const result = verifyScriptSatisfaction(tx, 0, chainTip);

        expect(result.valid).toBe(false);
        expect(result.leafType).toBe("condition-csv-multisig");
        // CSV should pass but hash should fail
        expect(result.errors.some((e) => /preimage|hash/i.test(e))).toBe(true);
    });

    it("should fail ConditionCSVMultisig when CSV sequence is wrong", async () => {
        const { tx } = await buildConditionCSVTx({ sequenceOverride: 1 });
        const result = verifyScriptSatisfaction(tx, 0, chainTip);

        expect(result.valid).toBe(false);
        expect(result.leafType).toBe("condition-csv-multisig");
        expect(result.errors.some((e) => /sequence|CSV/i.test(e))).toBe(true);
    });

    it("should pass for plain Multisig (no extra conditions)", async () => {
        const { tx } = await buildMultisigTx();
        const result = verifyScriptSatisfaction(tx, 0, chainTip);

        expect(result.valid).toBe(true);
        expect(result.leafType).toBe("multisig");
    });

    it("should error when tapLeafScript is missing", async () => {
        const destScript = taprootOutputScript(
            await SingleKey.fromPrivateKey(
                randomPrivateKeyBytes()
            ).xOnlyPublicKey()
        );
        const tx = new ArkTransaction();
        tx.addInput({
            txid: new Uint8Array(32).fill(0x01),
            index: 0,
            witnessUtxo: { script: destScript, amount: 10_000n },
        });
        tx.addOutput({ script: destScript, amount: 10_000n });

        const result = verifyScriptSatisfaction(tx, 0, chainTip);

        expect(result.valid).toBe(false);
        expect(
            result.errors.some((e) => /tapLeafScript|missing/i.test(e))
        ).toBe(true);
    });
});

// ============================================================
// Test helpers
// ============================================================

function taprootOutputScript(xOnlyKey: Uint8Array): Uint8Array {
    const script = new Uint8Array(34);
    script[0] = 0x51;
    script[1] = 0x20;
    script.set(xOnlyKey, 2);
    return script;
}

function csvSequence(timelock: {
    value: bigint;
    type: "blocks" | "seconds";
}): number {
    return bip68.encode(
        timelock.type === "blocks"
            ? { blocks: Number(timelock.value) }
            : { seconds: Number(timelock.value) }
    );
}

async function buildCSVTx(
    opts: {
        csvBlocks?: bigint;
        csvSeconds?: bigint;
        sequenceOverride?: number;
    } = {}
) {
    const key = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const pub = await key.xOnlyPublicKey();

    const timelock = opts.csvSeconds
        ? { value: opts.csvSeconds, type: "seconds" as const }
        : { value: opts.csvBlocks ?? 144n, type: "blocks" as const };

    const csvScript = CSVMultisigTapscript.encode({
        timelock,
        pubkeys: [pub],
    });
    const vtxoScript = new VtxoScript([csvScript.script]);

    const destScript = taprootOutputScript(
        await SingleKey.fromPrivateKey(randomPrivateKeyBytes()).xOnlyPublicKey()
    );

    // Use correct BIP-68 sequence unless overridden
    const sequence =
        opts.sequenceOverride !== undefined
            ? opts.sequenceOverride
            : csvSequence(timelock);

    const tx = new ArkTransaction();
    tx.addInput({
        txid: new Uint8Array(32).fill(0x01),
        index: 0,
        witnessUtxo: { script: vtxoScript.pkScript, amount: 10_000n },
        tapLeafScript: [vtxoScript.leaves[0]],
        sequence,
    });
    tx.addOutput({ script: destScript, amount: 10_000n });

    return { tx, key, pub };
}

async function buildCLTVTx(
    opts: {
        locktime: bigint;
        nLockTimeOverride?: number;
        disableLocktime?: boolean;
    } = { locktime: 900n }
) {
    const key = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const pub = await key.xOnlyPublicKey();

    const cltvScript = CLTVMultisigTapscript.encode({
        absoluteTimelock: opts.locktime,
        pubkeys: [pub],
    });
    const vtxoScript = new VtxoScript([cltvScript.script]);

    const destScript = taprootOutputScript(
        await SingleKey.fromPrivateKey(randomPrivateKeyBytes()).xOnlyPublicKey()
    );

    const lockTime =
        opts.nLockTimeOverride !== undefined
            ? opts.nLockTimeOverride
            : Number(opts.locktime);

    const tx = new ArkTransaction({ lockTime });
    tx.addInput({
        txid: new Uint8Array(32).fill(0x01),
        index: 0,
        witnessUtxo: { script: vtxoScript.pkScript, amount: 10_000n },
        tapLeafScript: [vtxoScript.leaves[0]],
        sequence: opts.disableLocktime ? 0xffffffff : 0xfffffffe,
    });
    tx.addOutput({ script: destScript, amount: 10_000n });

    return { tx, key, pub };
}

async function buildConditionTx(
    opts: {
        wrongPreimage?: boolean;
        noWitness?: boolean;
        hashAlgo?: "HASH160" | "SHA256";
        noHashOpcode?: boolean;
    } = {}
) {
    const key = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const pub = await key.xOnlyPublicKey();
    const serverKey = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const serverPub = await serverKey.xOnlyPublicKey();

    const algo = opts.hashAlgo ?? "HASH160";
    const preimage = new Uint8Array(32);
    crypto.getRandomValues(preimage);
    const preimageHash =
        algo === "SHA256" ? sha256(preimage) : hash160(preimage);

    const conditionScript = opts.noHashOpcode
        ? Script.encode(["DUP", "EQUAL"])
        : Script.encode([algo, preimageHash, "EQUAL"]);
    const condMultisig = ConditionMultisigTapscript.encode({
        conditionScript,
        pubkeys: [pub, serverPub],
    });
    const vtxoScript = new VtxoScript([condMultisig.script]);

    const destScript = taprootOutputScript(
        await SingleKey.fromPrivateKey(randomPrivateKeyBytes()).xOnlyPublicKey()
    );

    const tx = new ArkTransaction();
    tx.addInput({
        txid: new Uint8Array(32).fill(0x01),
        index: 0,
        witnessUtxo: { script: vtxoScript.pkScript, amount: 10_000n },
        tapLeafScript: [vtxoScript.leaves[0]],
    });
    tx.addOutput({ script: destScript, amount: 10_000n });

    if (!opts.noWitness) {
        const witnessPreimage = opts.wrongPreimage
            ? new Uint8Array(32).fill(0xff)
            : preimage;
        setArkPsbtField(tx, 0, ConditionWitness, [witnessPreimage]);
    }

    return { tx, key, pub, preimage, preimageHash };
}

async function buildConditionCSVTx(
    opts: {
        wrongPreimage?: boolean;
        sequenceOverride?: number;
    } = {}
) {
    const key = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const pub = await key.xOnlyPublicKey();

    const preimage = new Uint8Array(32);
    crypto.getRandomValues(preimage);
    const preimageHash = hash160(preimage);

    const timelock = { value: 144n, type: "blocks" as const };
    const conditionScript = Script.encode(["HASH160", preimageHash, "EQUAL"]);
    const condCSV = ConditionCSVMultisigTapscript.encode({
        conditionScript,
        timelock,
        pubkeys: [pub],
    });
    const vtxoScript = new VtxoScript([condCSV.script]);

    const destScript = taprootOutputScript(
        await SingleKey.fromPrivateKey(randomPrivateKeyBytes()).xOnlyPublicKey()
    );

    const sequence =
        opts.sequenceOverride !== undefined
            ? opts.sequenceOverride
            : csvSequence(timelock);

    const tx = new ArkTransaction();
    tx.addInput({
        txid: new Uint8Array(32).fill(0x01),
        index: 0,
        witnessUtxo: { script: vtxoScript.pkScript, amount: 10_000n },
        tapLeafScript: [vtxoScript.leaves[0]],
        sequence,
    });
    tx.addOutput({ script: destScript, amount: 10_000n });

    const witnessPreimage = opts.wrongPreimage
        ? new Uint8Array(32).fill(0xff)
        : preimage;
    setArkPsbtField(tx, 0, ConditionWitness, [witnessPreimage]);

    return { tx, key, pub, preimage, preimageHash };
}

async function buildMultisigTx() {
    const key = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const pub = await key.xOnlyPublicKey();

    const multisig = MultisigTapscript.encode({
        pubkeys: [pub],
        type: MultisigTapscript.MultisigType.CHECKSIG,
    });
    const vtxoScript = new VtxoScript([multisig.script]);

    const destScript = taprootOutputScript(
        await SingleKey.fromPrivateKey(randomPrivateKeyBytes()).xOnlyPublicKey()
    );

    const tx = new ArkTransaction();
    tx.addInput({
        txid: new Uint8Array(32).fill(0x01),
        index: 0,
        witnessUtxo: { script: vtxoScript.pkScript, amount: 10_000n },
        tapLeafScript: [vtxoScript.leaves[0]],
    });
    tx.addOutput({ script: destScript, amount: 10_000n });

    return { tx, key, pub };
}
