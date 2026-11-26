import { type ContractArtifact, programFromArtifact } from "../../arkade/artifact";
import { ArkadeProgramScript, type ArkadeParamValue, type Program } from "../../arkade/program";
import { timelockToSequence } from "../../utils/timelock";
import type { RelativeTimelock } from "../tapscript";
import artifact from "./onchain-htlc.json";

/** The Bitcoin HTLC of `onchain-htlc.ark`, whose collaborative spends arkd co-signs onchain. */
export namespace OnchainHTLC {
    export interface Options {
        sender: Uint8Array;
        receiver: Uint8Array;
        server: Uint8Array;
        preimageHash: Uint8Array;
        refundLocktime: bigint;
        /** Opens the sender's solo refund, which must come before `claimDelay`, in the same unit. */
        refundDelay: RelativeTimelock;
        claimDelay: RelativeTimelock;
        /** This and `senderScript` are 32-byte witness programs, not pkScripts. */
        receiverScript: Uint8Array;
        senderScript: Uint8Array;
        amount: bigint;
        /** The most the claim covenant leaves to fees; the refund covenant leaves none. */
        fee: bigint;
        /** As `ArkadeHTLC.Options.asset`; onchain it depends on arkd tracking assets, arkd#202. */
        asset?: { txid: Uint8Array; groupIndex: number; amount: bigint };
        /** arkd's `boardingExitDelay`, never bound: arkd co-signs no spend if `refundDelay` is shorter. */
        minExitDelay?: RelativeTimelock;
    }

    export const program: Program = programFromArtifact(artifact as ContractArtifact, {
        singleOperatorKey: true,
    });

    export function args(options: Options): Record<string, ArkadeParamValue> {
        const { asset, refundDelay, claimDelay, minExitDelay } = options;
        if (options.refundLocktime <= 0n) {
            throw new Error("OnchainHTLC: refundLocktime must be greater than 0");
        }
        if (options.amount <= 0n) throw new Error("OnchainHTLC: amount must be greater than 0");
        if (options.fee < 0n) throw new Error("OnchainHTLC: fee must not be negative");
        if (asset && asset.amount <= 0n) {
            throw new Error("OnchainHTLC: asset amount must be greater than 0");
        }
        const sequence = (name: string, delay: RelativeTimelock) => {
            if (delay.value <= 0n) throw new Error(`OnchainHTLC: ${name} must be greater than 0`);
            return BigInt(timelockToSequence(delay));
        };
        const refundSequence = sequence("refundDelay", refundDelay);
        const claimSequence = sequence("claimDelay", claimDelay);
        // ArkadeHTLC's order reversed, else with arkd down the receiver refunds there and claims here.
        if (refundDelay.type !== claimDelay.type || refundDelay.value >= claimDelay.value) {
            throw new Error(
                "OnchainHTLC: refundDelay must open before claimDelay, in the same unit",
            );
        }
        if (
            minExitDelay &&
            (minExitDelay.type !== refundDelay.type || refundDelay.value < minExitDelay.value)
        ) {
            throw new Error("OnchainHTLC: refundDelay must reach minExitDelay, in the same unit");
        }
        return {
            sender: options.sender,
            receiver: options.receiver,
            server: options.server,
            preimageHash: options.preimageHash,
            refundLocktime: options.refundLocktime,
            refundDelay: refundSequence,
            claimDelay: claimSequence,
            receiverScript: options.receiverScript,
            senderScript: options.senderScript,
            amount: options.amount,
            "asset.txid": asset ? Uint8Array.from(asset.txid).reverse() : new Uint8Array(32),
            "asset.gidx": asset?.groupIndex ?? 0,
            assetAmount: asset?.amount ?? 0n,
            fee: options.fee,
        };
    }

    export function script(options: Options): ArkadeProgramScript {
        return new ArkadeProgramScript(program, args(options), { serverKey: options.server });
    }
}
