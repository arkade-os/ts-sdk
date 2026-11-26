import { Engine, newTaprootExecutionCtx, type TapLeaf } from "./engine";
import { KIND, plainError, prefixed } from "./errors";
import type { ArkPrevOutFetcher } from "./fetcher";
import { type ComputeBudget, type ComputeLimits, cloneComputeLimits } from "./limits";
import { computeTxSigHashes, type VmTx, type VmTxOut } from "./tx";
import type { ExtensionCodec } from "./types";

export interface CovenantOptions {
    /** The arkade script, executed in the scriptPubKey slot. */
    readonly script: Uint8Array;
    /** The Bitcoin spending leaf the sighash commits to, not the arkade script. */
    readonly tapLeaf: TapLeaf;
    /** Seeds the stack bottom-first. */
    readonly witness: readonly Uint8Array[];
    readonly tx: VmTx;
    readonly inputIndex: number;
    /** Must resolve fetchPrevOutput for every input, not only the executed one. */
    readonly fetcher: ArkPrevOutFetcher;
    /** The asset and emulator packets are read from `tx` through it, as Go reads them. */
    readonly codec?: ExtensionCodec;
    readonly expiry?: bigint;
    readonly intentMessage?: string;
    /** WithExactComputeLimits: opcodes absent from the map are unlimited. */
    readonly limits?: ComputeLimits;
    /** Shared across the inputs of one request. */
    readonly budget?: ComputeBudget;
    readonly now?: bigint;
}

const parseWith = <T>(kind: string, context: string, read: () => T): T =>
    prefixed(context, read, (message) => plainError(kind, message));

/** Covenant mode: ArkadeScript.Execute (script.go:210-270). No control block, merkle or annex work. */
export function executeCovenant(opts: CovenantOptions): void {
    const { tx, fetcher } = opts;
    // a miss would be signed as a fabricated zero value that introspection also sees
    tx.inputs.forEach((input, i) => {
        if (!fetcher.fetchPrevOutput(input)) {
            throw plainError(KIND.noPrevout, `no prevout found for input ${i}`);
        }
    });
    const spent = tx.inputs[opts.inputIndex];
    if (!spent) throw plainError(KIND.panic, `input index ${opts.inputIndex} out of range`);

    const vm = new Engine({
        script: opts.script,
        tx,
        inputIndex: opts.inputIndex,
        inputAmount: (fetcher.fetchPrevOutput(spent) as VmTxOut).value,
        fetcher,
        sigHashes: computeTxSigHashes(tx, fetcher),
        now: opts.now,
        expiry: opts.expiry,
        intentMessage: opts.intentMessage,
        codec: opts.codec,
    });
    vm.taprootCtx = newTaprootExecutionCtx(opts.tapLeaf);
    if (opts.limits) vm.limits = cloneComputeLimits(opts.limits);
    vm.budget = opts.budget;

    const codec = vm.codecFor(tx);
    const extension = parseWith(KIND.extensionParse, "failed to parse extension", () =>
        codec.readExtension(tx),
    );
    if (extension?.assetPacket) vm.assetPacket = extension.assetPacket;
    const packet = parseWith(KIND.emulatorPacketParse, "failed to parse emulator packet", () =>
        codec.findEmulatorPacket(tx),
    );
    if (packet) vm.emulatorPacket = packet;

    if (opts.witness.length > 0) vm.setStack(opts.witness);
    vm.execute();
}
