import { describe, it, expect, vi } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { arkade, CSVMultisigTapscript, Extension, networks, type EmulatorProvider } from "../src";
import { getArkPsbtFields, PrevoutTxField } from "../src/utils/unknownFields";

const xOnly = () => schnorr.getPublicKey(schnorr.utils.randomSecretKey());
const COIN = { txid: "ab".repeat(32), vout: 1, value: 10_000 };
const AMOUNT = 9_000n;

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

const program = {
    version: 0,
    params: ["receiver", "amount", "server"],
    functions: {
        covenant: {
            tapscript: { signers: ["$server"] },
            arkadeScript: { asm: payTo },
        },
        collab: { tapscript: { signers: ["$server"] } },
    },
} satisfies arkade.Program;

describe("ArkadeTransactionBuilder onchain mode", () => {
    const server = xOnly();
    const emulatorKey = xOnly();
    const receiver = xOnly();
    const out = new Uint8Array([0x51, 0x20, ...receiver]);

    async function setup() {
        const checkpointTapscript = hex.encode(
            CSVMultisigTapscript.encode({
                timelock: { type: "blocks", value: 10n },
                pubkeys: [server],
            }).script,
        );
        const submitOnchainTx = vi.fn(async () => {
            throw new Error("emulator reached");
        });
        const cosignOnchainTx = vi.fn(async () => {
            throw new Error("arkd reached");
        });
        const getRawTransaction = vi.fn(async () => new Uint8Array([1, 2, 3]));
        const ark = await arkade.Arkade.connect({
            arkade: {
                getInfo: async () =>
                    ({ signerPubkey: "02" + hex.encode(server), checkpointTapscript }) as any,
                submitTx: async () => {
                    throw new Error("not used");
                },
                finalizeTx: async () => {},
                cosignOnchainTx,
            },
            emulator: { submitOnchainTx } as unknown as EmulatorProvider,
            onchain: { getRawTransaction, broadcastTransaction: async () => "txid" },
            network: networks.regtest,
            emulatorPubkey: "02" + hex.encode(emulatorKey),
        });
        const contract = ark.contract(program, { receiver, amount: AMOUNT });
        return { contract, submitOnchainTx, cosignOnchainTx, getRawTransaction };
    }

    it("buildOnchain assembles a covenant spend with packet and prevout tx", async () => {
        const { contract } = await setup();
        const fn = contract.compiled.find((f) => f.name === "covenant")!;
        const tx = await contract.functions.covenant().from(COIN).to(out, AMOUNT).buildOnchain();

        expect(tx.inputsLength).toBe(1);
        const input = tx.getInput(0);
        expect(input.tapLeafScript).toEqual([fn.tapLeafScript]);
        expect(hex.encode(input.witnessUtxo!.script)).toBe(hex.encode(contract.pkScript));
        expect(getArkPsbtFields(tx, 0, PrevoutTxField)).toHaveLength(1);
        const ext = [...Array(tx.outputsLength).keys()]
            .map((i) => tx.getOutput(i).script!)
            .find((s) => Extension.isExtension(s))!;
        expect(Extension.fromBytes(ext).getEmulatorPacket()!.entries[0].vin).toBe(0);
    });

    it("sendOnchain routes covenant functions to the emulator", async () => {
        const { contract, submitOnchainTx, cosignOnchainTx } = await setup();
        await expect(
            contract.functions.covenant().from(COIN).to(out, AMOUNT).sendOnchain(),
        ).rejects.toThrow("emulator reached");
        expect(submitOnchainTx).toHaveBeenCalledTimes(1);
        expect(cosignOnchainTx).not.toHaveBeenCalled();
    });

    it("sendOnchain routes collaborative functions to arkd", async () => {
        const { contract, submitOnchainTx, cosignOnchainTx } = await setup();
        await expect(
            contract.functions.collab().from(COIN).to(out, AMOUNT).sendOnchain(),
        ).rejects.toThrow("arkd reached");
        expect(cosignOnchainTx).toHaveBeenCalledTimes(1);
        expect(submitOnchainTx).not.toHaveBeenCalled();
    });

    it("rejects fund() onchain", async () => {
        const { contract } = await setup();
        const funded = contract.functions
            .collab()
            .from(COIN)
            .fund([{ txid: "cd".repeat(32), vout: 0, value: 1 } as any])
            .to(out, AMOUNT);
        await expect(funded.buildOnchain()).rejects.toThrow(/fund\(\) is not supported onchain/);
    });

    it("requires an explicit from() coin", async () => {
        const { contract } = await setup();
        await expect(contract.functions.collab().to(out, AMOUNT).buildOnchain()).rejects.toThrow(
            /from\(coin\)/,
        );
    });

    it("surplus without change is the fee; a fee-less spend throws", async () => {
        const { contract } = await setup();
        const tx = await contract.functions.collab().from(COIN).to(out, AMOUNT).buildOnchain();
        expect(tx.outputsLength).toBe(1);
        await expect(
            contract.functions.collab().from(COIN).to(out, BigInt(COIN.value)).buildOnchain(),
        ).rejects.toThrow(/needs a fee/);
        await expect(
            contract.functions.collab().from(COIN).to(out, AMOUNT).change(out).buildOnchain(),
        ).rejects.toThrow(/needs a fee/);
    });
});
