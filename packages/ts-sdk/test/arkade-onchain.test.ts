import { describe, it, expect, vi } from "vitest";
import { hex } from "@scure/base";
import { base64 } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { Script } from "@scure/btc-signer";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import {
    arkade,
    CSVMultisigTapscript,
    Extension,
    networks,
    SingleKey,
    Transaction,
    type EmulatorProvider,
} from "../src";
import { scriptFromTapLeafScript } from "../src/script/base";
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
    params: ["receiver", "amount", "server", "user"],
    functions: {
        covenant: {
            tapscript: { signers: ["$user"] },
            arkadeScript: { asm: payTo },
        },
        covenantServer: {
            tapscript: { signers: ["$server"] },
            arkadeScript: { asm: payTo },
        },
        collab: { tapscript: { signers: ["$user", "$server"] } },
        timed: { tapscript: { signers: ["$user"], cltv: 800_000n } },
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
        const identity = SingleKey.fromRandomBytes();
        const userKey = await identity.xOnlyPublicKey();
        const submitOnchainTx = vi.fn(async (psbt: string) => {
            const tx = Transaction.fromPSBT(base64.decode(psbt));
            const leaf = tx.getInput(0).tapLeafScript![0];
            const script = scriptFromTapLeafScript(leaf);
            const have = (tx.getInput(0).tapScriptSig ?? []).map(([k]) => hex.encode(k.pubKey));
            const missing = Script.decode(script).filter(
                (op): op is Uint8Array =>
                    op instanceof Uint8Array && op.length === 32 && !have.includes(hex.encode(op)),
            );
            tx.updateInput(0, {
                tapScriptSig: [
                    ...(tx.getInput(0).tapScriptSig ?? []),
                    ...missing.map(
                        (pubKey) =>
                            [
                                { pubKey, leafHash: tapLeafHash(script) },
                                new Uint8Array(64).fill(1),
                            ] as any,
                    ),
                ],
            });
            return { signedTx: base64.encode(tx.toPSBT()) };
        });
        const cosignOnchainTx = vi.fn(async (_psbt: string) => "arkd-txid");
        const broadcastTransaction = vi.fn(async (_hex: string) => "broadcast-txid");
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
            onchain: { getRawTransaction, broadcastTransaction },
            identity,
            network: networks.regtest,
            emulatorPubkey: "02" + hex.encode(emulatorKey),
        });
        const contract = ark.contract(program, { receiver, amount: AMOUNT });
        return {
            contract,
            submitOnchainTx,
            cosignOnchainTx,
            getRawTransaction,
            broadcastTransaction,
            userKey,
        };
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

    it("covenant non-server leaf: emulator cosigns, then finalize and broadcast", async () => {
        const { contract, submitOnchainTx, cosignOnchainTx, broadcastTransaction } = await setup();
        const txid = await contract.functions.covenant().from(COIN).to(out, AMOUNT).sendOnchain();
        expect(txid).toBe("broadcast-txid");
        expect(submitOnchainTx).toHaveBeenCalledTimes(1);
        expect(cosignOnchainTx).not.toHaveBeenCalled();
        const raw = Transaction.fromRaw(hex.decode(broadcastTransaction.mock.calls[0][0]));
        expect(raw.inputsLength).toBe(1);
    });

    it("rejects a covenant leaf containing the server key", async () => {
        const { contract } = await setup();
        await expect(
            contract.functions.covenantServer().from(COIN).to(out, AMOUNT).buildOnchain(),
        ).rejects.toThrow(/without the Arkade server key/);
    });

    it("user-only leaf is finalized and broadcast without arkd", async () => {
        const { contract, cosignOnchainTx, submitOnchainTx, broadcastTransaction } = await setup();
        const txid = await contract.functions.timed().from(COIN).to(out, AMOUNT).sendOnchain();
        expect(txid).toBe("broadcast-txid");
        expect(cosignOnchainTx).not.toHaveBeenCalled();
        expect(submitOnchainTx).not.toHaveBeenCalled();
        const raw = Transaction.fromRaw(hex.decode(broadcastTransaction.mock.calls[0][0]));
        expect(raw.lockTime).toBe(800_000);
    });

    it("server leaf goes to arkd with the user signature on input 0", async () => {
        const { contract, cosignOnchainTx, broadcastTransaction, userKey } = await setup();
        const txid = await contract.functions.collab().from(COIN).to(out, AMOUNT).sendOnchain();
        expect(txid).toBe("arkd-txid");
        expect(broadcastTransaction).not.toHaveBeenCalled();
        const sent = Transaction.fromPSBT(base64.decode(cosignOnchainTx.mock.calls[0][0]));
        const signers = (sent.getInput(0).tapScriptSig ?? []).map(([k]) => hex.encode(k.pubKey));
        expect(signers).toEqual([hex.encode(userKey)]);
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

    it("surplus without change is the whole fee", async () => {
        const { contract } = await setup();
        const tx = await contract.functions.collab().from(COIN).to(out, AMOUNT).buildOnchain();
        expect(tx.outputsLength).toBe(1);
    });

    it("change takes surplus minus onchainFee", async () => {
        const { contract } = await setup();
        const tx = await contract.functions
            .collab()
            .from(COIN)
            .to(out, AMOUNT)
            .change(out)
            .onchainFee(300n)
            .buildOnchain();
        expect(tx.getOutput(1).amount).toBe(700n);
    });

    it.each([
        ["without onchainFee", undefined, AMOUNT, /requires .onchainFee/],
        ["fee above surplus", 2_000n, AMOUNT, /exceeds surplus/],
        ["change below dust", 900n, AMOUNT, /below dust/],
    ])("change %s throws", async (_n, fee, amount, re) => {
        const { contract } = await setup();
        const b = contract.functions.collab().from(COIN).to(out, amount).change(out);
        if (fee !== undefined) b.onchainFee(fee);
        await expect(b.buildOnchain()).rejects.toThrow(re);
    });

    it("CLTV leaf sets lockTime and a non-final sequence", async () => {
        const { contract } = await setup();
        const tx = await contract.functions.timed().from(COIN).to(out, AMOUNT).buildOnchain();
        expect(tx.lockTime).toBe(800_000);
        expect(tx.getInput(0).sequence).toBeLessThan(0xffffffff);
    });
});
