import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { createVHTLCScript } from "../src/utils/vhtlc";
import { swapToContractParams, registerSwapContract } from "../src/utils/swap-contract";
import {
    makeReverseSwapFixture,
    makeSubmarineSwapFixture,
    makeChainSwapFixture,
    makeChainSwapFromArkFixture,
    makeArkInfoFixture,
} from "./fixtures/swaps";

describe("swapToContractParams", () => {
    it("maps a reverse swap to a vhtlc CreateContractParams whose script matches the real VHTLC", () => {
        const arkInfo = makeArkInfoFixture();
        const swap = makeReverseSwapFixture(arkInfo); // lockupAddress derived from current signer
        const params = swapToContractParams(swap, arkInfo);

        // Rebuild the script the canonical way and compare.
        const { vhtlcScript, vhtlcAddress } = createVHTLCScript({
            network: arkInfo.network,
            preimageHash: hex.decode(swap.request.preimageHash),
            receiverPubkey: swap.request.claimPublicKey, // fixture wires the counterparty key
            senderPubkey: arkInfo.signerPubkey, // fixture wires the counterparty key
            serverPubkey: arkInfo.signerPubkey,
            timeoutBlockHeights: swap.response.timeoutBlockHeights!,
        });

        expect(params.type).toBe("vhtlc");
        expect(params.script).toBe(hex.encode(vhtlcScript.pkScript));
        expect(params.address).toBe(vhtlcAddress);
        // critical: HASH160 commitment, not raw sha256
        expect(params.params.hash).toBe(
            hex.encode(ripemd160(hex.decode(swap.request.preimageHash))),
        );
        expect(params.metadata).toMatchObject({
            swapId: swap.id,
            swapType: "reverse",
            source: `swap:${swap.id}`,
        });
        expect(params.state).toBe("active");
    });

    it("maps a submarine swap to a vhtlc CreateContractParams whose script matches the real VHTLC", () => {
        const arkInfo = makeArkInfoFixture();
        const swap = makeSubmarineSwapFixture(arkInfo);
        const params = swapToContractParams(swap, arkInfo);

        // Submarine: receiver = Boltz claimPublicKey, sender = wallet refundPublicKey.
        const { vhtlcScript, vhtlcAddress } = createVHTLCScript({
            network: arkInfo.network,
            preimageHash: hex.decode(swap.preimageHash!),
            receiverPubkey: swap.response.claimPublicKey!,
            senderPubkey: swap.request.refundPublicKey,
            serverPubkey: arkInfo.signerPubkey,
            timeoutBlockHeights: swap.response.timeoutBlockHeights!,
        });

        expect(params.type).toBe("vhtlc");
        expect(params.script).toBe(hex.encode(vhtlcScript.pkScript));
        expect(params.address).toBe(vhtlcAddress);
        expect(params.params.hash).toBe(hex.encode(ripemd160(hex.decode(swap.preimageHash!))));
        expect(params.metadata).toMatchObject({
            swapId: swap.id,
            swapType: "submarine",
            source: `swap:${swap.id}`,
        });
        expect(params.state).toBe("active");
    });

    it("maps a chain swap (BTC→ARK) to a vhtlc CreateContractParams whose script matches the real VHTLC", () => {
        const arkInfo = makeArkInfoFixture();
        const swap = makeChainSwapFixture(arkInfo);
        const params = swapToContractParams(swap, arkInfo);

        // Chain BTC→ARK: receiver = wallet claimPublicKey, sender = claimDetails.serverPublicKey.
        const { vhtlcScript, vhtlcAddress } = createVHTLCScript({
            network: arkInfo.network,
            preimageHash: hex.decode(swap.request.preimageHash),
            receiverPubkey: swap.request.claimPublicKey,
            senderPubkey: swap.response.claimDetails.serverPublicKey,
            serverPubkey: arkInfo.signerPubkey,
            timeoutBlockHeights: swap.response.claimDetails.timeouts!,
        });

        expect(params.type).toBe("vhtlc");
        expect(params.script).toBe(hex.encode(vhtlcScript.pkScript));
        expect(params.address).toBe(vhtlcAddress);
        expect(params.params.hash).toBe(
            hex.encode(ripemd160(hex.decode(swap.request.preimageHash))),
        );
        expect(params.metadata).toMatchObject({
            swapId: swap.id,
            swapType: "chain",
            source: `swap:${swap.id}`,
        });
        expect(params.state).toBe("active");
    });

    it("maps a chain swap (ARK→BTC) to a vhtlc CreateContractParams whose script matches the real VHTLC", () => {
        const arkInfo = makeArkInfoFixture();
        const swap = makeChainSwapFromArkFixture(arkInfo);
        const params = swapToContractParams(swap, arkInfo);

        // Chain ARK→BTC: receiver = lockupDetails.serverPublicKey (Boltz), sender = wallet refundPublicKey.
        const { vhtlcScript, vhtlcAddress } = createVHTLCScript({
            network: arkInfo.network,
            preimageHash: hex.decode(swap.request.preimageHash),
            receiverPubkey: swap.response.lockupDetails.serverPublicKey,
            senderPubkey: swap.request.refundPublicKey,
            serverPubkey: arkInfo.signerPubkey,
            timeoutBlockHeights: swap.response.lockupDetails.timeouts!,
        });

        expect(params.type).toBe("vhtlc");
        expect(params.script).toBe(hex.encode(vhtlcScript.pkScript));
        expect(params.address).toBe(vhtlcAddress);
        expect(params.params.hash).toBe(
            hex.encode(ripemd160(hex.decode(swap.request.preimageHash))),
        );
        expect(params.metadata).toMatchObject({
            swapId: swap.id,
            swapType: "chain",
            source: `swap:${swap.id}`,
        });
        expect(params.state).toBe("active");
    });
});

describe("registerSwapContract", () => {
    it("registers the swap's vhtlc contract idempotently", async () => {
        const arkInfo = makeArkInfoFixture();
        const swap = makeReverseSwapFixture(arkInfo);
        const calls: any[] = [];
        const fakeManager = {
            createContract: async (p: any) => {
                calls.push(p);
                return { ...p, state: "active", createdAt: 0 };
            },
        } as any;

        await registerSwapContract(fakeManager, swap, arkInfo);
        await registerSwapContract(fakeManager, swap, arkInfo);

        expect(calls).toHaveLength(2); // createContract itself is idempotent on script; helper always calls
        expect(calls[0].script).toBe(swapToContractParams(swap, arkInfo).script);
        expect(calls[0].metadata.swapId).toBe(swap.id);
    });
});
