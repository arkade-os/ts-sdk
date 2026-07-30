import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import {
    contractHandlers,
    DefaultContractHandler,
    VHTLCContractHandler,
} from "../src/contracts/handlers";
import { Contract } from "../src/contracts/types";
import { InMemoryContractRepository } from "../src/repositories/inMemory/contractRepository";
import { DefaultVtxo } from "../src/script/default";
import { VHTLC } from "../src/script/vhtlc";
import { timelockToSequence } from "../src/utils/timelock";
import { ExitPathError, resolveUnilateralPath } from "../src/wallet/exit/path";

const owner = schnorr.getPublicKey(new Uint8Array(32).fill(0xaa));
const server = schnorr.getPublicKey(new Uint8Array(32).fill(0xbb));
const sender = schnorr.getPublicKey(new Uint8Array(32).fill(0xcc));
const timelock = { type: "blocks", value: 144n } as const;
const expectedSequence = timelockToSequence(timelock);

function defaultFixture() {
    const script = new DefaultVtxo.Script({
        pubKey: owner,
        serverPubKey: server,
        csvTimelock: timelock,
    });
    const contract: Contract = {
        type: "default",
        params: DefaultContractHandler.serializeParams({
            pubKey: owner,
            serverPubKey: server,
            csvTimelock: timelock,
        }),
        script: hex.encode(script.pkScript),
        address: "unused",
        state: "active",
        createdAt: 1,
    };
    return { script, contract };
}

function vhtlcFixture(withPreimage: boolean) {
    const params = {
        sender,
        receiver: owner,
        server,
        preimageHash: new Uint8Array(20).fill(7),
        refundLocktime: 800_000n,
        unilateralClaimDelay: timelock,
        unilateralRefundDelay: timelock,
        unilateralRefundWithoutReceiverDelay: timelock,
    };
    const script = new VHTLC.Script(params);
    const serialized = VHTLCContractHandler.serializeParams(params);
    if (withPreimage) {
        serialized.preimage = hex.encode(new Uint8Array(32).fill(5));
    }
    const contract: Contract = {
        type: "vhtlc",
        params: serialized,
        script: hex.encode(script.pkScript),
        address: "unused",
        state: "active",
        createdAt: 1,
    };
    return { script, contract };
}

async function repoWith(contract: Contract) {
    const repo = new InMemoryContractRepository();
    await repo.saveContract(contract);
    return repo;
}

describe("resolveUnilateralPath", () => {
    it("registers built-in handlers via the handlers index", () => {
        expect(contractHandlers.has("default")).toBe(true);
        expect(contractHandlers.has("vhtlc")).toBe(true);
    });

    it("resolves the default contract exit path through the handler", async () => {
        const { script, contract } = defaultFixture();
        const resolved = await resolveUnilateralPath({
            vtxo: { txid: "11".repeat(32), vout: 0, tapTree: script.encode() },
            scriptHex: contract.script,
            contractRepository: await repoWith(contract),
            walletPubKeyHex: hex.encode(owner),
            currentTime: 1_000,
        });
        expect(resolved.label).toBe("default:unilateral");
        expect(resolved.selection.sequence).toBe(expectedSequence);
        expect(resolved.selection.extraWitness).toBeUndefined();
    });

    it("resolves VHTLC receiver unilateralClaim with preimage extraWitness", async () => {
        const { script, contract } = vhtlcFixture(true);
        const resolved = await resolveUnilateralPath({
            vtxo: { txid: "22".repeat(32), vout: 0, tapTree: script.encode() },
            scriptHex: contract.script,
            contractRepository: await repoWith(contract),
            walletPubKeyHex: hex.encode(owner),
            currentTime: 1_000,
        });
        expect(resolved.label).toBe("vhtlc:unilateral");
        expect(resolved.selection.sequence).toBe(expectedSequence);
        expect(resolved.selection.extraWitness).toEqual([new Uint8Array(32).fill(5)]);
    });

    it("falls back to tapTree exitPaths when no contract row exists", async () => {
        const { script } = defaultFixture();
        const resolved = await resolveUnilateralPath({
            vtxo: { txid: "33".repeat(32), vout: 0, tapTree: script.encode() },
            scriptHex: hex.encode(script.pkScript),
            contractRepository: new InMemoryContractRepository(),
            walletPubKeyHex: hex.encode(owner),
            currentTime: 1_000,
        });
        expect(resolved.label).toBe("default:exit");
        expect(resolved.selection.sequence).toBe(expectedSequence);
    });

    it("throws no-unilateral-path when the handler offers nothing", async () => {
        const { script, contract } = vhtlcFixture(false); // receiver without preimage
        const promise = resolveUnilateralPath({
            vtxo: { txid: "44".repeat(32), vout: 0, tapTree: script.encode() },
            scriptHex: contract.script,
            contractRepository: await repoWith(contract),
            walletPubKeyHex: hex.encode(owner),
            currentTime: 1_000,
        });
        await expect(promise).rejects.toThrow(ExitPathError);
        await expect(promise).rejects.toMatchObject({ reason: "no-unilateral-path" });
    });

    it("throws no-handler for unregistered contract types", async () => {
        const { script, contract } = defaultFixture();
        const promise = resolveUnilateralPath({
            vtxo: { txid: "55".repeat(32), vout: 0, tapTree: script.encode() },
            scriptHex: contract.script,
            contractRepository: await repoWith({ ...contract, type: "no-such-type" }),
            walletPubKeyHex: hex.encode(owner),
            currentTime: 1_000,
        });
        await expect(promise).rejects.toMatchObject({ reason: "no-handler" });
    });
});
