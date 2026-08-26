import { p2tr } from "@scure/btc-signer";
import { describe, expect, it, vi } from "vitest";
import { SingleKey } from "../src/identity/singleKey";
import { networks } from "../src/networks";
import type { OnchainProvider } from "../src/providers/onchain";
import { createBoardingProgramScript } from "../src/script/boarding";
import { recoverBoardingProgram } from "../src/wallet/boardingRecovery";
import { extendCoinWithTapscript } from "../src/wallet/utils";

const privateKey = (fill: number) => new Uint8Array(32).fill(fill);
const recoveryIdentity = SingleKey.fromPrivateKey(privateKey(4));
const network = networks.mutinynet;
const boardingDelay = { type: "seconds", value: 604672n } as const;
const operatorPubKey = SingleKey.fromPrivateKey(privateKey(3)).xOnlyPublicKey();

async function fixture() {
    const operator = await operatorPubKey;
    const program = {
        name: "example-board-v1" as const,
        boardingPubKey: await SingleKey.fromPrivateKey(privateKey(1)).xOnlyPublicKey(),
        cosignerPubKey: await SingleKey.fromPrivateKey(privateKey(2)).xOnlyPublicKey(),
        recoveryPubKey: await recoveryIdentity.xOnlyPublicKey(),
    };
    const script = createBoardingProgramScript(program, operator, boardingDelay);
    const destination = p2tr(program.recoveryPubKey, undefined, network).address!;
    const input = extendCoinWithTapscript(script, {
        txid: "11".repeat(32),
        vout: 0,
        value: 100_000,
        status: {
            confirmed: true,
            block_height: 1,
            block_time: Math.floor(Date.now() / 1000) - Number(boardingDelay.value) - 1,
        },
    });
    const provider = {
        getFeeRate: vi.fn().mockResolvedValue(1),
        broadcastTransaction: vi.fn().mockResolvedValue("22".repeat(32)),
        getChainTip: vi.fn().mockResolvedValue({ height: 1_000, time: 0, hash: "" }),
    } as unknown as OnchainProvider;
    return { program, operator, script, destination, input, provider };
}

describe("named boarding one-shot recovery", () => {
    it("signs a matured exact-program output to the recovery identity address", async () => {
        const { program, operator, destination, input, provider } = await fixture();

        await expect(
            recoverBoardingProgram({
                program,
                operatorPubKey: operator,
                boardingTimelock: boardingDelay,
                inputs: [input],
                recoveryIdentity,
                destination,
                network,
                onchainProvider: provider,
                maxFeeRateSatVb: 10,
                absoluteFeeCapSats: 2_000n,
            }),
        ).resolves.toBe("22".repeat(32));
        expect(provider.broadcastTransaction).toHaveBeenCalledOnce();
    });

    it("rejects a destination not controlled by the recovery identity", async () => {
        const { program, operator, input, provider } = await fixture();
        const foreignDestination = p2tr(
            await SingleKey.fromPrivateKey(privateKey(5)).xOnlyPublicKey(),
            undefined,
            network,
        ).address!;

        await expect(
            recoverBoardingProgram({
                program,
                operatorPubKey: operator,
                boardingTimelock: boardingDelay,
                inputs: [input],
                recoveryIdentity,
                destination: foreignDestination,
                network,
                onchainProvider: provider,
                maxFeeRateSatVb: 10,
                absoluteFeeCapSats: 2_000n,
            }),
        ).rejects.toThrow("not controlled");
        expect(provider.broadcastTransaction).not.toHaveBeenCalled();
    });

    it("rejects an immature or foreign-program input before signing", async () => {
        const { program, operator, script, destination, input, provider } = await fixture();
        const unconfirmed = {
            ...input,
            status: { confirmed: false as const },
        };
        await expect(
            recoverBoardingProgram({
                program,
                operatorPubKey: operator,
                boardingTimelock: boardingDelay,
                inputs: [unconfirmed],
                recoveryIdentity,
                destination,
                network,
                onchainProvider: provider,
                maxFeeRateSatVb: 10,
                absoluteFeeCapSats: 2_000n,
            }),
        ).rejects.toThrow("is not confirmed");

        const immature = {
            ...input,
            status: { ...input.status, block_time: Math.floor(Date.now() / 1000) },
        };
        await expect(
            recoverBoardingProgram({
                program,
                operatorPubKey: operator,
                boardingTimelock: boardingDelay,
                inputs: [immature],
                recoveryIdentity,
                destination,
                network,
                onchainProvider: provider,
                maxFeeRateSatVb: 10,
                absoluteFeeCapSats: 2_000n,
            }),
        ).rejects.toThrow("is not mature");

        const foreignScript = createBoardingProgramScript(
            {
                ...program,
                cosignerPubKey: await SingleKey.fromPrivateKey(privateKey(6)).xOnlyPublicKey(),
            },
            operator,
            boardingDelay,
        );
        const foreignInput = { ...input, tapTree: foreignScript.encode() };
        expect(script.encode()).not.toEqual(foreignInput.tapTree);
        await expect(
            recoverBoardingProgram({
                program,
                operatorPubKey: operator,
                boardingTimelock: boardingDelay,
                inputs: [foreignInput],
                recoveryIdentity,
                destination,
                network,
                onchainProvider: provider,
                maxFeeRateSatVb: 10,
                absoluteFeeCapSats: 2_000n,
            }),
        ).rejects.toThrow("is not from this program");
        expect(provider.broadcastTransaction).not.toHaveBeenCalled();
    });

    it("refuses a malicious fee estimate before signing or broadcasting", async () => {
        const { program, operator, destination, input, provider } = await fixture();
        vi.mocked(provider.getFeeRate).mockResolvedValue(50_000);
        const sign = vi.spyOn(recoveryIdentity, "sign");

        await expect(
            recoverBoardingProgram({
                program,
                operatorPubKey: operator,
                boardingTimelock: boardingDelay,
                inputs: [input],
                recoveryIdentity,
                destination,
                network,
                onchainProvider: provider,
                maxFeeRateSatVb: 10,
                absoluteFeeCapSats: 2_000n,
            }),
        ).rejects.toThrow("fee rate exceeds");
        expect(sign).not.toHaveBeenCalled();
        expect(provider.broadcastTransaction).not.toHaveBeenCalled();
        sign.mockRestore();
    });

    it("enforces the absolute fee cap even below the approved rate", async () => {
        const { program, operator, destination, input, provider } = await fixture();
        vi.mocked(provider.getFeeRate).mockResolvedValue(5);

        await expect(
            recoverBoardingProgram({
                program,
                operatorPubKey: operator,
                boardingTimelock: boardingDelay,
                inputs: [input],
                recoveryIdentity,
                destination,
                network,
                onchainProvider: provider,
                maxFeeRateSatVb: 10,
                absoluteFeeCapSats: 1n,
            }),
        ).rejects.toThrow("absolute cap");
        expect(provider.broadcastTransaction).not.toHaveBeenCalled();
    });
});
