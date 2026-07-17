import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    arkade,
    CLTVMultisigTapscript,
    CSVMultisigTapscript,
    MultisigTapscript,
    networks,
    VtxoScript,
    type EmulatorInfo,
    type EmulatorProvider,
} from "../src";

function xOnly(): Uint8Array {
    return schnorr.getPublicKey(schnorr.utils.randomSecretKey());
}

// Arkade covenant: output[witness[0]] pays `$payout` exactly `$wantAmount`.
const payToMaker = [
    "DUP",
    "INSPECTOUTPUTSCRIPTPUBKEY",
    1,
    "EQUALVERIFY",
    "$payout",
    "EQUALVERIFY",
    "INSPECTOUTPUTVALUE",
    "$wantAmount",
    "EQUAL",
] as arkade.AsmToken[];

const CANCEL_DELAY = 800_000n;
const EXIT_BLOCKS = 144n;

/**
 * A non-interactive swap: a taker `fulfill`s the offer (emulated covenant), the
 * maker can `cancel` after an absolute timeout (CLTV), and either party can
 * `exit` after a relative timeout (CSV). Proves a multi-path contract assembles
 * into the correct 3-leaf taproot tree.
 */
function swapProgram(): arkade.Program {
    return {
        version: 0,
        params: ["payout", "makerKey", "wantAmount", "server"],
        functions: {
            fulfill: {
                tapscript: { signers: ["$server"] },
                arkadeScript: { asm: payToMaker, witness: [0] },
            },
            cancel: {
                tapscript: { signers: ["$makerKey", "$server"], cltv: CANCEL_DELAY },
            },
            exit: {
                tapscript: {
                    signers: ["$makerKey", "$server"],
                    csv: { type: "blocks", value: EXIT_BLOCKS },
                },
            },
        },
    };
}

function stubProviders(server: Uint8Array, emulatorKey: Uint8Array) {
    const checkpointTapscript = hex.encode(
        CSVMultisigTapscript.encode({ timelock: { type: "blocks", value: 10n }, pubkeys: [server] })
            .script,
    );
    const arkProvider = {
        async getInfo() {
            return { signerPubkey: "02" + hex.encode(server), checkpointTapscript } as any;
        },
        async submitTx() {
            throw new Error("unused");
        },
        async finalizeTx() {},
    };
    const indexer = {
        async getVtxos() {
            return { vtxos: [] as any[] };
        },
    };
    const emulator: EmulatorProvider = {
        async getInfo(): Promise<EmulatorInfo> {
            return { signerPubkey: hex.encode(emulatorKey) };
        },
        async submitTx(arkTx: string, cps: string[]) {
            return { signedArkTx: arkTx, signedCheckpointTxs: cps };
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
    } as any;
    return { arkProvider, indexer, emulator };
}

describe("non-interactive swap (multi-path contract)", () => {
    const server = xOnly();
    const emulatorKey = xOnly();
    const args = { payout: xOnly(), makerKey: xOnly(), wantAmount: 50_000n };

    async function build() {
        const { arkProvider, indexer, emulator } = stubProviders(server, emulatorKey);
        const ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            indexer,
            network: networks.regtest,
        });
        return ark.contract(swapProgram(), args);
    }

    it("assembles the same 3-leaf tree as the hand-built VtxoScript tree", async () => {
        const contract = await build();

        // fulfill: covenant leaf = server + emulator-key tweaked by the covenant hash
        const tweaked = arkade.computeArkadeScriptPublicKey(
            emulatorKey,
            arkade.resolveAsm(payToMaker, args),
        );
        const raw = new VtxoScript([
            MultisigTapscript.encode({ pubkeys: [server, tweaked] }).script,
            CLTVMultisigTapscript.encode({
                absoluteTimelock: CANCEL_DELAY,
                pubkeys: [args.makerKey, server],
            }).script,
            CSVMultisigTapscript.encode({
                timelock: { type: "blocks", value: EXIT_BLOCKS },
                pubkeys: [args.makerKey, server],
            }).script,
        ]);

        expect(contract.vtxoScript.leaves.length).toBe(3);
        expect(contract.address).toBe(raw.address(networks.regtest.hrp, server).encode());
        expect(hex.encode(contract.pkScript)).toBe(hex.encode(raw.pkScript));
    });

    it("every spending path resolves to a tapleaf", async () => {
        const contract = await build();
        // fulfill(0), cancel(1), exit(2) are all findable in the committed tree
        expect(() => contract.leafScript(0)).not.toThrow();
        expect(() => contract.leafScript(1)).not.toThrow();
        expect(() => contract.leafScript(2)).not.toThrow();
    });
});
