import { describe, it, expect, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    arkade,
    asset,
    CSVMultisigTapscript,
    MultisigTapscript,
    SingleKey,
    VtxoScript,
    Extension,
    Transaction,
    networks,
    type EmulatorInfo,
    type EmulatorProvider,
} from "../src";

function xOnly(): Uint8Array {
    return schnorr.getPublicKey(schnorr.utils.randomSecretKey());
}
function p2tr(prog = xOnly()): Uint8Array {
    return new Uint8Array([0x51, 0x20, ...prog]);
}

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

function claimProgram(): arkade.Program {
    return {
        version: 0,
        params: ["receiver", "amount"],
        functions: {
            claim: {
                inputs: ["preimage"],
                tapscript: {
                    signers: ["server"],
                    asm: ["HASH160", "$h", "EQUALVERIFY"],
                    witness: ["preimage"],
                },
                arkadeScript: { asm: payTo, witness: [0] },
            },
        },
    };
}

/** A funding coin from a throwaway multisig leaf (taker's own input). */
function fundingCoin(value: number) {
    const vs = new VtxoScript([MultisigTapscript.encode({ pubkeys: [xOnly(), xOnly()] }).script]);
    return {
        txid: hex.encode(xOnly()),
        vout: 0,
        value,
        tapLeafScript: vs.leaves[0],
        tapTree: vs.encode(),
    };
}

function mockIdentity(key = xOnly()) {
    const sign = vi.fn(async (tx: Transaction, _idx?: number[]) => tx);
    const identity = {
        xOnlyPublicKey: async () => key,
        sign,
    } as any;
    return { identity, sign, key };
}

function providers(
    server: Uint8Array,
    emulatorKey: Uint8Array,
    coins: { txid: string; vout: number; value: number }[],
) {
    const checkpointTapscript = hex.encode(
        CSVMultisigTapscript.encode({ timelock: { type: "blocks", value: 10n }, pubkeys: [server] })
            .script,
    );
    const captured: { arkTx?: string; cps?: string[]; via?: "emulator" | "ark" } = {};
    const arkProvider = {
        async getInfo() {
            return { signerPubkey: "02" + hex.encode(server), checkpointTapscript } as any;
        },
        submitTx: vi.fn(async (arkTx: string, cps: string[]) => {
            captured.arkTx = arkTx;
            captured.cps = cps;
            captured.via = "ark";
            return { arkTxid: "arktxid", finalArkTx: arkTx, signedCheckpointTxs: cps };
        }),
        finalizeTx: vi.fn(async () => {}),
    };
    const indexer = {
        async getVtxos() {
            return { vtxos: coins.map((c) => ({ ...c }) as any) };
        },
    };
    const emulator: EmulatorProvider = {
        async getInfo(): Promise<EmulatorInfo> {
            return { signerPubkey: hex.encode(emulatorKey) };
        },
        submitTx: vi.fn(async (arkTx: string, cps: string[]) => {
            captured.arkTx = arkTx;
            captured.cps = cps;
            captured.via = "emulator";
            return { signedArkTx: arkTx, signedCheckpointTxs: cps };
        }),
        async submitIntent() {
            throw new Error("x");
        },
        async submitFinalization() {
            throw new Error("x");
        },
        async submitOnchainTx() {
            throw new Error("x");
        },
    } as any;
    return { arkProvider, indexer, emulator, captured };
}

describe("ArkadeContract — extended features", () => {
    const server = xOnly();
    const emulatorKey = xOnly();
    const receiver = xOnly();
    const COIN = { txid: hex.encode(new Uint8Array(32).fill(9)), vout: 0, value: 10_000 };

    it("resolves the 'user' signer from the client identity", async () => {
        const { identity, key } = mockIdentity();
        const { arkProvider, indexer, emulator } = providers(server, emulatorKey, [COIN]);
        const ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            indexer,
            identity,
            network: networks.regtest,
        });
        // A pure-tapscript path that requires the user's key.
        const c = ark.contract(
            {
                version: 0,
                functions: {
                    move: {
                        tapscript: {
                            signers: ["user", "server"],
                            csv: { type: "blocks", value: 20n },
                        },
                    },
                },
            },
            {},
        );
        const raw = new VtxoScript([
            CSVMultisigTapscript.encode({
                timelock: { type: "blocks", value: 20n },
                pubkeys: [key, server],
            }).script,
        ]);
        expect(c.address).toBe(raw.address(networks.regtest.hrp, server).encode());
    });

    it("`.fund()` adds taker inputs and signs them (emulator path)", async () => {
        const { identity, sign } = mockIdentity();
        const { arkProvider, indexer, emulator, captured } = providers(server, emulatorKey, [COIN]);
        const ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            indexer,
            identity,
            network: networks.regtest,
        });
        const c = ark.contract(claimProgram(), { receiver, amount: AMOUNT, h: new Uint8Array(20) });

        await c.functions
            .claim(new Uint8Array(32).fill(0x42))
            .from(COIN)
            .fund([fundingCoin(60_000)])
            .to(p2tr(receiver), AMOUNT)
            .change(p2tr()) // surplus from the funded input
            .send();

        const tx = Transaction.fromPSBT(base64.decode(captured.arkTx!));
        expect(tx.inputsLength).toBe(2); // contract coin + 1 funding input
        // funding input (index 1) signed by the identity
        expect(
            sign.mock.calls.some((c2) => Array.isArray(c2[1]) && (c2[1] as number[]).includes(1)),
        ).toBe(true);
    });

    it("coin.sourceTx sets the PrevArkTx field on the contract input", async () => {
        const { arkProvider, indexer, emulator, captured } = providers(server, emulatorKey, [COIN]);
        const ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            indexer,
            network: networks.regtest,
        });
        const c = ark.contract(claimProgram(), { receiver, amount: AMOUNT, h: new Uint8Array(20) });
        const sourceTx = new Uint8Array(64).fill(7);
        const preimage = new Uint8Array(32).fill(0x42);

        // baseline (no sourceTx)
        await c.functions.claim(preimage).from(COIN).to(p2tr(receiver), AMOUNT).send();
        const base = Transaction.fromPSBT(base64.decode(captured.arkTx!)).getInput(0).unknown ?? [];

        // with sourceTx → exactly one more unknown field on input 0
        await c.functions
            .claim(preimage)
            .from({ ...COIN, sourceTx })
            .to(p2tr(receiver), AMOUNT)
            .send();
        const withPrev =
            Transaction.fromPSBT(base64.decode(captured.arkTx!)).getInput(0).unknown ?? [];

        expect(withPrev.length).toBe(base.length + 1);
    });

    it("selects the smallest contract coin covering the outputs", async () => {
        const small = { txid: hex.encode(new Uint8Array(32).fill(1)), vout: 0, value: 5_000 };
        const big = { txid: hex.encode(new Uint8Array(32).fill(2)), vout: 0, value: 20_000 };
        const { arkProvider, indexer, emulator, captured } = providers(server, emulatorKey, [
            small,
            big,
        ]);
        const ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            indexer,
            network: networks.regtest,
        });
        const c = ark.contract(claimProgram(), { receiver, amount: AMOUNT, h: new Uint8Array(20) });

        // outputs require 10_000 → must pick `big` (5_000 can't cover)
        await c.functions
            .claim(new Uint8Array(32).fill(0x42))
            .to(p2tr(receiver), AMOUNT)
            .change(p2tr()) // surplus from the 20_000 coin
            .send();
        // the checkpoint spends the selected VTXO directly → its input is the coin
        const cp0 = Transaction.fromPSBT(base64.decode(captured.cps![0]));
        expect(hex.encode(cp0.getInput(0).txid!)).toBe(big.txid);
    });

    it("routes pure-tapscript paths to arkd (not the emulator)", async () => {
        const { identity } = mockIdentity();
        const { arkProvider, indexer, emulator, captured } = providers(server, emulatorKey, [COIN]);
        const ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            indexer,
            identity,
            network: networks.regtest,
        });
        const c = ark.contract(
            {
                version: 0,
                functions: {
                    exit: {
                        tapscript: {
                            signers: ["user", "server"],
                            csv: { type: "blocks", value: 20n },
                        },
                    },
                },
            },
            {},
        );
        await c.functions.exit().from(COIN).to(p2tr(receiver), AMOUNT).send();
        expect(captured.via).toBe("ark");
        expect(arkProvider.submitTx).toHaveBeenCalled();
        expect(arkProvider.finalizeTx).toHaveBeenCalled();
        expect(emulator.submitTx).not.toHaveBeenCalled();
    });

    it("rejects Arkade opcodes inside a tapscript segment", async () => {
        const { arkProvider, indexer, emulator } = providers(server, emulatorKey, [COIN]);
        const ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            indexer,
            network: networks.regtest,
        });
        expect(() =>
            ark.contract(
                {
                    version: 0,
                    functions: {
                        bad: {
                            tapscript: {
                                signers: ["server"],
                                asm: ["INSPECTOUTPUTVALUE", "$amount", "EQUAL"],
                            },
                        },
                    },
                },
                { amount: AMOUNT },
            ),
        ).toThrow(/arkade opcode/i);
    });

    it("rejects conflicting timelocks (csv + cltv)", async () => {
        const { arkProvider, indexer, emulator } = providers(server, emulatorKey, [COIN]);
        const ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            indexer,
            network: networks.regtest,
        });
        expect(() =>
            ark.contract(
                {
                    version: 0,
                    functions: {
                        bad: {
                            tapscript: {
                                signers: ["server"],
                                csv: { type: "blocks", value: 1n },
                                cltv: 5n,
                            },
                        },
                    },
                },
                {},
            ),
        ).toThrow(/csv.*cltv|cltv.*csv|conflict/i);
    });

    it("parseArtifact converts a JSON artifact (0x bytes) into a Program", async () => {
        const { arkProvider, indexer, emulator } = providers(server, emulatorKey, [COIN]);
        const ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            indexer,
            network: networks.regtest,
        });
        const artifact = {
            params: ["receiver", "amount"],
            functions: {
                claim: {
                    inputs: ["preimage"],
                    tapscript: {
                        signers: ["server"],
                        asm: ["HASH160", "$h", "EQUALVERIFY"],
                        witness: ["preimage"],
                    },
                    arkadeScript: {
                        asm: [
                            "DUP",
                            "INSPECTOUTPUTSCRIPTPUBKEY",
                            1,
                            "EQUALVERIFY",
                            "$receiver",
                            "EQUALVERIFY",
                            "INSPECTOUTPUTVALUE",
                            "$amount",
                            "EQUAL",
                        ],
                        witness: [0],
                    },
                },
            },
        };
        const program = arkade.parseArtifact(artifact);
        const fromArtifact = ark.contract(program, {
            receiver,
            amount: AMOUNT,
            h: new Uint8Array(20),
        });
        const fromObject = ark.contract(claimProgram(), {
            receiver,
            amount: AMOUNT,
            h: new Uint8Array(20),
        });
        expect(fromArtifact.address).toBe(fromObject.address);
    });

    it("covenant path: real user signature lands on BOTH the ark-tx input and its checkpoint (fix #1)", async () => {
        // Use a real signer (not a no-op mock) so we verify the actual surface:
        // the collaborative closure governs both the ark-tx input and the
        // checkpoint input, so the user must sign both.
        const identity = SingleKey.fromHex(hex.encode(new Uint8Array(32).fill(0x11)));
        const userKey = await identity.xOnlyPublicKey();
        const { arkProvider, indexer, emulator, captured } = providers(server, emulatorKey, [COIN]);
        const ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            indexer,
            identity,
            network: networks.regtest,
        });
        const prog: arkade.Program = {
            version: 0,
            params: ["receiver", "amount"],
            functions: {
                spend: {
                    tapscript: { signers: ["user", "server"] },
                    arkadeScript: { asm: payTo, witness: [0] },
                },
            },
        };
        const c = ark.contract(prog, { receiver, amount: AMOUNT });
        await c.functions.spend().from(COIN).to(p2tr(receiver), AMOUNT).send();

        const hasUserSig = (tx: Transaction) =>
            (tx.getInput(0).tapScriptSig ?? []).some(
                ([d]) => hex.encode(d.pubKey) === hex.encode(userKey),
            );

        const arkTx = Transaction.fromPSBT(base64.decode(captured.arkTx!));
        const cp0 = Transaction.fromPSBT(base64.decode(captured.cps![0]));
        expect(hasUserSig(arkTx)).toBe(true); // ark-tx input 0
        expect(hasUserSig(cp0)).toBe(true); // checkpoint 0 input 0
    });

    it("arkd path signs once per tx, no checkpoint double-signing (fix #2/#3)", async () => {
        const { identity, sign } = mockIdentity();
        const { arkProvider, indexer, emulator } = providers(server, emulatorKey, [COIN]);
        const ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            indexer,
            identity,
            network: networks.regtest,
        });
        const c = ark.contract(
            {
                version: 0,
                functions: {
                    exit: {
                        tapscript: {
                            signers: ["user", "server"],
                            csv: { type: "blocks", value: 20n },
                        },
                    },
                },
            },
            {},
        );
        await c.functions.exit().from(COIN).to(p2tr(receiver), AMOUNT).send();
        // exactly: sign(arkTx) once + sign(returned checkpoint) once. The old code
        // also pre-signed the checkpoint before submit → 3 calls.
        expect(sign.mock.calls.length).toBe(2);
        expect(arkProvider.finalizeTx).toHaveBeenCalled();
    });

    it("requires a change output for surplus, and appends it when set (fix #4)", async () => {
        const { arkProvider, indexer, emulator, captured } = providers(server, emulatorKey, [COIN]);
        const ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            indexer,
            network: networks.regtest,
        });
        const c = ark.contract(claimProgram(), { receiver, amount: AMOUNT, h: new Uint8Array(20) });
        const bigCoin = { txid: hex.encode(new Uint8Array(32).fill(5)), vout: 0, value: 25_000 };
        const preimage = new Uint8Array(32).fill(0x42);

        // surplus (25_000 in, 10_000 out) with no change → throws
        await expect(
            c.functions.claim(preimage).from(bigCoin).to(p2tr(receiver), AMOUNT).send(),
        ).rejects.toThrow(/surplus/i);

        // with change → succeeds, surplus routed to the change script
        const changeScript = p2tr();
        await c.functions
            .claim(preimage)
            .from(bigCoin)
            .change(changeScript)
            .to(p2tr(receiver), AMOUNT)
            .send();
        const tx = Transaction.fromPSBT(base64.decode(captured.arkTx!));
        let found = false;
        for (let i = 0; i < tx.outputsLength; i++) {
            const o = tx.getOutput(i);
            if (
                o?.amount === 15_000n &&
                o.script &&
                hex.encode(o.script) === hex.encode(changeScript)
            ) {
                found = true;
            }
        }
        expect(found).toBe(true);
    });

    it("attaches an asset group alongside the emulator packet", async () => {
        const { arkProvider, indexer, emulator, captured } = providers(server, emulatorKey, [COIN]);
        const ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            indexer,
            network: networks.regtest,
        });
        const c = ark.contract(claimProgram(), { receiver, amount: AMOUNT, h: new Uint8Array(20) });

        const assetId = asset.AssetId.create(hex.encode(new Uint8Array(32).fill(3)), 0);
        await c.functions
            .claim(new Uint8Array(32).fill(0x42))
            .from(COIN)
            .to(p2tr(receiver), AMOUNT)
            .withAsset({
                assetId: assetId.toString(),
                inputs: [{ vin: 0, amount: 330n }],
                outputs: [{ vout: 0, amount: 330n }],
            })
            .send();

        const tx = Transaction.fromPSBT(base64.decode(captured.arkTx!));
        let ext: Extension | undefined;
        for (let i = 0; i < tx.outputsLength; i++) {
            const o = tx.getOutput(i);
            if (o?.script && Extension.isExtension(o.script)) {
                ext = Extension.fromBytes(o.script);
                break;
            }
        }
        expect(ext).toBeDefined();
        const ap = ext!.getAssetPacket();
        expect(ap).not.toBeNull();
        expect(ap!.groups[0].outputs[0].vout).toBe(0);
        expect(ap!.groups[0].outputs[0].amount).toBe(330n);
        expect(ap!.groups[0].inputs[0].amount).toBe(330n);
        expect(ext!.getEmulatorPacket()).not.toBeNull(); // both packets in one extension
    });

    it("builds a pure-tapscript contract without an emulator", async () => {
        const { arkProvider, indexer } = providers(server, emulatorKey, [COIN]);
        const ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            indexer,
            network: networks.regtest, // no emulator
        });
        const c = ark.contract(
            {
                version: 0,
                functions: {
                    exit: {
                        tapscript: { signers: ["server"], csv: { type: "blocks", value: 20n } },
                    },
                },
            },
            {},
        );
        const raw = new VtxoScript([
            CSVMultisigTapscript.encode({
                timelock: { type: "blocks", value: 20n },
                pubkeys: [server],
            }).script,
        ]);
        expect(c.address).toBe(raw.address(networks.regtest.hrp, server).encode());
    });

    it("throws when a covenant function is built without an emulator", async () => {
        const { arkProvider, indexer } = providers(server, emulatorKey, [COIN]);
        const ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            indexer,
            network: networks.regtest, // no emulator
        });
        expect(() =>
            ark.contract(claimProgram(), { receiver, amount: AMOUNT, h: new Uint8Array(20) }),
        ).toThrow(/emulator/i);
    });
});
