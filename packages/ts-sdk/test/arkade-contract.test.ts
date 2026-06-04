import { describe, it, expect } from "vitest";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { Script } from "@scure/btc-signer";
import {
    arkade,
    ConditionMultisigTapscript,
    CSVMultisigTapscript,
    Extension,
    networks,
    Transaction,
    VtxoScript,
    type EmulatorInfo,
    type EmulatorProvider,
} from "../src";

function xOnly(): Uint8Array {
    return schnorr.getPublicKey(schnorr.utils.randomSecretKey());
}

const COIN = { txid: hex.encode(new Uint8Array(32).fill(1)), vout: 0, value: 10_000 };
const HASH = new Uint8Array(20).fill(7);
const AMOUNT = 10_000n;

const payTo = [
    "DUP",
    "INSPECTOUTPUTSCRIPTPUBKEY",
    1,
    "EQUALVERIFY",
    "$receiver",
    "EQUALVERIFY",
    "INSPECTOUTPUTVALUE",
    "$amount",
    "EQUAL",
] as arkade.AsmToken[];

function htlcProgram(): arkade.Program {
    return {
        params: ["hash", "receiver", "amount"],
        functions: {
            claim: {
                inputs: ["preimage"],
                tapscript: {
                    signers: ["server"],
                    asm: ["HASH160", "$hash", "EQUALVERIFY"],
                    witness: ["preimage"],
                },
                arkadeScript: { asm: payTo, witness: [0] },
            },
        },
    };
}

function stubProviders(server: Uint8Array, emulatorKey: Uint8Array) {
    const checkpointTapscript = hex.encode(
        CSVMultisigTapscript.encode({
            timelock: { type: "blocks", value: 10n },
            pubkeys: [server],
        }).script,
    );
    const arkProvider = {
        async getInfo() {
            return { signerPubkey: "02" + hex.encode(server), checkpointTapscript } as any;
        },
        async submitTx() {
            throw new Error("not used");
        },
        async finalizeTx() {},
    };
    const indexer = {
        async getVtxos() {
            return { vtxos: [{ ...COIN } as any] };
        },
    };
    const captured: { arkTx?: string } = {};
    const emulator: EmulatorProvider = {
        async getInfo(): Promise<EmulatorInfo> {
            return { version: "t", signerPubkey: hex.encode(emulatorKey) };
        },
        async submitTx(arkTx: string, checkpointTxs: string[]) {
            captured.arkTx = arkTx;
            return { signedArkTx: arkTx, signedCheckpointTxs: checkpointTxs };
        },
        async submitIntent() {
            throw new Error("x");
        },
        async submitFinalization() {
            throw new Error("x");
        },
        async submitOnchainTx() {
            throw new Error("x");
        },
    };
    return { arkProvider, indexer, emulator, captured };
}

describe("arkade.Arkade / ArkadeContract", () => {
    const server = xOnly();
    const emulatorKey = xOnly();
    const receiver = xOnly(); // 32-byte witness program
    const args = { hash: HASH, receiver, amount: AMOUNT };

    async function connect() {
        const { arkProvider, indexer, emulator, captured } = stubProviders(server, emulatorKey);
        const ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            indexer,
            network: networks.regtest,
        });
        return { ark, captured };
    }

    it("derives the same address as the hand-built VtxoScript tree", async () => {
        const { ark } = await connect();
        const contract = ark.contract(htlcProgram(), args);

        const conditionScript = arkade.resolveAsm(["HASH160", "$hash", "EQUALVERIFY"], args);
        const arkadeScript = arkade.resolveAsm(payTo, args);
        // Independently rebuild the covenant leaf: server + emulator-key tweaked
        // by the arkade-script hash, in a ConditionMultisig.
        const tweaked = arkade.computeArkadeScriptPublicKey(emulatorKey, arkadeScript);
        const leaf = ConditionMultisigTapscript.encode({
            conditionScript,
            pubkeys: [server, tweaked],
        }).script;
        const raw = new VtxoScript([leaf]);

        expect(contract.address).toBe(raw.address(networks.regtest.hrp, server).encode());
        expect(hex.encode(contract.pkScript)).toBe(hex.encode(raw.pkScript));
    });

    it("getBalance sums spendable coins", async () => {
        const { ark } = await connect();
        const contract = ark.contract(htlcProgram(), args);
        expect(await contract.getBalance()).toBe(BigInt(COIN.value));
    });

    it("send() resolves the covenant + encodes the witness ([0] → empty push)", async () => {
        const { ark, captured } = await connect();
        const contract = ark.contract(htlcProgram(), args);

        const preimage = new Uint8Array(32).fill(0x42);
        // a valid 34-byte p2tr output for the `.to(...)`
        const out = new Uint8Array([0x51, 0x20, ...receiver]);
        const { txid } = await contract.functions.claim(preimage).to(out, AMOUNT).send();
        expect(txid).toBeTruthy();

        const tx = Transaction.fromPSBT(base64.decode(captured.arkTx!));
        let packet: ReturnType<Extension["getEmulatorPacket"]> = null;
        for (let i = 0; i < tx.outputsLength; i++) {
            const o = tx.getOutput(i);
            if (o?.script && Extension.isExtension(o.script)) {
                packet = Extension.fromBytes(o.script).getEmulatorPacket();
                break;
            }
        }
        expect(packet).not.toBeNull();
        expect(packet!.entries[0].vin).toBe(0);
        expect(hex.encode(packet!.entries[0].script)).toBe(
            hex.encode(arkade.resolveAsm(payTo, args)),
        );
        expect(Array.from(packet!.entries[0].witness!)).toEqual([0x01, 0x00]);
    });

    it("validates the function arity", async () => {
        const { ark } = await connect();
        const contract = ark.contract(htlcProgram(), args);
        expect(() => (contract.functions.claim as any)()).toThrow(/expected 1 argument/);
    });

    it("resolveAsm substitutes $params and passes opcodes through", () => {
        const bytes = arkade.resolveAsm(["HASH160", "$hash", "EQUAL"], { hash: HASH });
        // HASH160 (0xa9) <push20> <hash> EQUAL (0x87)
        const decoded = Script.decode(bytes);
        expect(decoded[0]).toBe("HASH160");
        expect(hex.encode(decoded[1] as Uint8Array)).toBe(hex.encode(HASH));
        expect(decoded[2]).toBe("EQUAL");
    });
});
