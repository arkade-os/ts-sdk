import { describe, it, expect, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { Address, OutScript, TaprootControlBlock } from "@scure/btc-signer";

import { Wallet } from "../src";
import {
    validateBatchRecipientsWithoutTree,
    ErrOnchainOutputNotFound,
    ErrUnvalidatedOffchainOutput,
} from "../src/wallet/validation";
import { ServerResponseMismatchError } from "../src/providers/errors";
import { Transaction } from "../src/utils/transaction";
import { networks } from "../src/networks";
import type { TapLeafScript } from "../src/script/base";
import type { ExtendedCoin, Recipient } from "../src/wallet";
import type { BatchFinalizationEvent } from "../src/providers/ark";

const NETWORK = networks.regtest;

const ONCHAIN_ADDRESS = Address(NETWORK).encode({
    type: "tr",
    pubkey: hex.decode("33".repeat(32)),
});
const OTHER_ONCHAIN_ADDRESS = Address(NETWORK).encode({
    type: "tr",
    pubkey: hex.decode("44".repeat(32)),
});
const OFFCHAIN_ADDRESS =
    "tark1qpt0syx7j0jspe69kldtljet0x9jz6ns4xw70m0w0xl30yfhn0mzmxz6yz8rduexx9sv73mqth7ecy8rtzcgm498kad3avmhyhmy097ew6h83g";

const pkScript = (address: string) => OutScript.encode(Address(NETWORK).decode(address));

/** A commitment tx paying `outputs`, plus the shared batch output at index 0. */
function commitmentTx(outputs: { address: string; amount: bigint }[]): Transaction {
    const tx = new Transaction({ allowUnknownOutputs: true });
    tx.addOutput({ script: new Uint8Array([0x51]), amount: 5_000n });
    for (const output of outputs) {
        tx.addOutput({ script: pkScript(output.address), amount: output.amount });
    }
    return tx;
}

describe("validateBatchRecipientsWithoutTree", () => {
    it("accepts a recipient present with the exact script and amount", () => {
        const tx = commitmentTx([{ address: ONCHAIN_ADDRESS, amount: 1_000n }]);

        expect(() =>
            validateBatchRecipientsWithoutTree(
                tx,
                [{ address: ONCHAIN_ADDRESS, amount: 1_000 }],
                NETWORK,
            ),
        ).not.toThrow();
    });

    it("rejects a recipient absent from the commitment tx outputs", () => {
        const tx = commitmentTx([{ address: OTHER_ONCHAIN_ADDRESS, amount: 1_000n }]);

        expect(() =>
            validateBatchRecipientsWithoutTree(
                tx,
                [{ address: ONCHAIN_ADDRESS, amount: 1_000 }],
                NETWORK,
            ),
        ).toThrow(ErrOnchainOutputNotFound(ONCHAIN_ADDRESS).message);
    });

    it("rejects a recipient paid the wrong amount", () => {
        const tx = commitmentTx([{ address: ONCHAIN_ADDRESS, amount: 999n }]);

        expect(() =>
            validateBatchRecipientsWithoutTree(
                tx,
                [{ address: ONCHAIN_ADDRESS, amount: 1_000 }],
                NETWORK,
            ),
        ).toThrow(/onchain output not found/);
    });

    it("does not let one output satisfy two identical recipients", () => {
        const tx = commitmentTx([{ address: ONCHAIN_ADDRESS, amount: 1_000n }]);
        const recipients: Recipient[] = [
            { address: ONCHAIN_ADDRESS, amount: 1_000 },
            { address: ONCHAIN_ADDRESS, amount: 1_000 },
        ];

        expect(() => validateBatchRecipientsWithoutTree(tx, recipients, NETWORK)).toThrow(
            /onchain output not found/,
        );
    });

    it("accepts two identical recipients paid by two outputs", () => {
        const tx = commitmentTx([
            { address: ONCHAIN_ADDRESS, amount: 1_000n },
            { address: ONCHAIN_ADDRESS, amount: 1_000n },
        ]);
        const recipients: Recipient[] = [
            { address: ONCHAIN_ADDRESS, amount: 1_000 },
            { address: ONCHAIN_ADDRESS, amount: 1_000 },
        ];

        expect(() => validateBatchRecipientsWithoutTree(tx, recipients, NETWORK)).not.toThrow();
    });

    it("rejects an offchain recipient: without a validated tree there is nothing to check it against", () => {
        const tx = commitmentTx([{ address: ONCHAIN_ADDRESS, amount: 1_000n }]);

        expect(() =>
            validateBatchRecipientsWithoutTree(
                tx,
                [{ address: OFFCHAIN_ADDRESS, amount: 1_000 }],
                NETWORK,
            ),
        ).toThrow(ErrUnvalidatedOffchainOutput(OFFCHAIN_ADDRESS).message);
    });

    it("raises a terminal ServerResponseMismatchError, not a retryable one", () => {
        const tx = commitmentTx([]);

        try {
            validateBatchRecipientsWithoutTree(
                tx,
                [{ address: ONCHAIN_ADDRESS, amount: 1_000 }],
                NETWORK,
            );
            expect.unreachable("expected a rejection");
        } catch (e) {
            expect(e).toBeInstanceOf(ServerResponseMismatchError);
            expect((e as ServerResponseMismatchError).retryable).toBe(false);
            expect((e as Error).name).toBe("ServerResponseMismatchError");
            // `message` is the only part of the above that survives a
            // structured clone, so it carries the whole signal
            expect((e as Error).message).toMatch(/onchain output not found/);
        }
    });
});

function tapLeaf(): TapLeafScript {
    const controlBlock = TaprootControlBlock.decode(
        new Uint8Array([0xc0, ...new Uint8Array(32).fill(1)]),
    );
    // PSBT stores the leaf version as the script's trailing byte; it must match
    // the control block's or `updateInput` rejects the pair.
    const script = new Uint8Array(20).fill(2);
    script[script.length - 1] = 0xc0;
    return [controlBlock, script];
}

const BOARDING_INPUT = {
    txid: "aa".repeat(32),
    vout: 0,
    value: 10_000,
    status: { confirmed: true },
    forfeitTapLeafScript: tapLeaf(),
    intentTapLeafScript: tapLeaf(),
    tapTree: new Uint8Array([0x00]),
} as unknown as ExtendedCoin;

/** Commitment tx spending the boarding input and paying `outputs`. */
function finalizationEvent(outputs: { address: string; amount: bigint }[]): BatchFinalizationEvent {
    const tx = commitmentTx(outputs);
    tx.addInput({
        txid: hex.decode(BOARDING_INPUT.txid),
        index: BOARDING_INPUT.vout,
        witnessUtxo: {
            script: pkScript(ONCHAIN_ADDRESS),
            amount: BigInt(BOARDING_INPUT.value),
        },
    });
    return { id: "batch-1", commitmentTx: base64.encode(tx.toPSBT()) } as BatchFinalizationEvent;
}

/**
 * An onchain-only settle: `skipVtxoTreeSigning` means `onTreeSigningStarted`
 * never runs, so the handler reaches finalization with no validated commitment
 * txid and recipients that have never been checked.
 */
function onchainOnlyHandler(recipients: Recipient[]) {
    // Signing a boarding input replaces the psbt with the signer's return value;
    // a fake standing in for a signed one keeps the test off real key material.
    const signed = {
        inputsLength: 1,
        getInput: () => ({ tapScriptSig: [{}] }),
        toPSBT: () => new Uint8Array([1]),
    };
    const thisArg: any = {
        network: NETWORK,
        forfeitOutputScript: pkScript(OTHER_ONCHAIN_ADDRESS),
        dustAmount: 1_000,
        arkProvider: {
            confirmRegistration: vi.fn(async () => {}),
            submitSignedForfeitTxs: vi.fn(async () => {}),
        },
        _signerRouter: { sign: vi.fn(async () => signed) },
        handleSettlementFinalizationEvent: (Wallet.prototype as any)
            .handleSettlementFinalizationEvent,
    };

    const handler = (Wallet.prototype as any).createBatchHandler.call(
        thisArg,
        "intent-1",
        [BOARDING_INPUT],
        recipients,
        undefined,
    );

    return { handler, thisArg };
}

describe("Wallet.createBatchHandler onchain-only finalization", () => {
    it("does not sign when the commitment tx omits the requested onchain recipient", async () => {
        const { handler, thisArg } = onchainOnlyHandler([
            { address: ONCHAIN_ADDRESS, amount: 1_000 },
        ]);

        await expect(
            handler.onBatchFinalization(
                finalizationEvent([{ address: OTHER_ONCHAIN_ADDRESS, amount: 1_000n }]),
            ),
        ).rejects.toThrow(/onchain output not found/);

        expect(thisArg._signerRouter.sign).not.toHaveBeenCalled();
        expect(thisArg.arkProvider.submitSignedForfeitTxs).not.toHaveBeenCalled();
    });

    it("does not sign when the requested onchain recipient is paid the wrong amount", async () => {
        const { handler, thisArg } = onchainOnlyHandler([
            { address: ONCHAIN_ADDRESS, amount: 1_000 },
        ]);

        await expect(
            handler.onBatchFinalization(
                finalizationEvent([{ address: ONCHAIN_ADDRESS, amount: 900n }]),
            ),
        ).rejects.toThrow(/onchain output not found/);

        expect(thisArg._signerRouter.sign).not.toHaveBeenCalled();
        expect(thisArg.arkProvider.submitSignedForfeitTxs).not.toHaveBeenCalled();
    });

    it("signs the boarding input when the recipient is paid exactly as requested", async () => {
        const { handler, thisArg } = onchainOnlyHandler([
            { address: ONCHAIN_ADDRESS, amount: 1_000 },
        ]);

        await handler.onBatchFinalization(
            finalizationEvent([{ address: ONCHAIN_ADDRESS, amount: 1_000n }]),
        );

        expect(thisArg._signerRouter.sign).toHaveBeenCalledTimes(1);
        expect(thisArg.arkProvider.submitSignedForfeitTxs).toHaveBeenCalledTimes(1);
    });

    it("keeps signing when no recipients were declared (compat)", async () => {
        const { handler, thisArg } = onchainOnlyHandler([]);

        await handler.onBatchFinalization(
            finalizationEvent([{ address: OTHER_ONCHAIN_ADDRESS, amount: 1_000n }]),
        );

        expect(thisArg._signerRouter.sign).toHaveBeenCalledTimes(1);
    });
});
