import { type ContractArtifact, programFromArtifact } from "../../arkade/artifact";
import { ArkadeProgramScript, type ArkadeParamValue, type Program } from "../../arkade/program";
import { timelockToSequence } from "../../utils/timelock";
import type { RelativeTimelock } from "../tapscript";
import artifact from "./arkade-htlc.json";

/** The offchain HTLC of `arkade-htlc.ark`, whose covenant leaves no emulator key co-signs. */
export namespace ArkadeHTLC {
    export interface Options {
        sender: Uint8Array;
        receiver: Uint8Array;
        server: Uint8Array;
        preimageHash: Uint8Array;
        refundLocktime: bigint;
        unilateralClaimDelay: RelativeTimelock;
        unilateralRefundDelay: RelativeTimelock;
        unilateralRefundWithoutReceiverDelay: RelativeTimelock;
        /** This and `senderScript` are 32-byte witness programs, not pkScripts. */
        receiverScript: Uint8Array;
        senderScript: Uint8Array;
        amount: bigint;
        /** The txid in canonical order, as `VHTLC.Options.asset` takes it. */
        asset?: { txid: Uint8Array; groupIndex: number; amount: bigint };
    }

    export const program: Program = programFromArtifact(artifact as ContractArtifact, {
        singleOperatorKey: true,
    });

    /** The arguments `Arkade.contract(ArkadeHTLC.program, args(options))` compiles. */
    export function args(options: Options): Record<string, ArkadeParamValue> {
        const { asset } = options;
        if (options.refundLocktime <= 0n) {
            throw new Error("ArkadeHTLC: refundLocktime must be greater than 0");
        }
        if (asset && asset.amount <= 0n) {
            throw new Error("ArkadeHTLC: asset amount must be greater than 0");
        }
        const sequence = (name: string, delay: RelativeTimelock) => {
            if (delay.value <= 0n) throw new Error(`ArkadeHTLC: ${name} must be greater than 0`);
            return BigInt(timelockToSequence(delay));
        };
        return {
            sender: options.sender,
            receiver: options.receiver,
            server: options.server,
            preimageHash: options.preimageHash,
            refundLocktime: options.refundLocktime,
            unilateralClaimDelay: sequence("unilateralClaimDelay", options.unilateralClaimDelay),
            unilateralRefundDelay: sequence("unilateralRefundDelay", options.unilateralRefundDelay),
            unilateralRefundWithoutReceiverDelay: sequence(
                "unilateralRefundWithoutReceiverDelay",
                options.unilateralRefundWithoutReceiverDelay,
            ),
            receiverScript: options.receiverScript,
            senderScript: options.senderScript,
            amount: options.amount,
            // The lookup reads the txid reversed; without an asset the zero one binds, unchecked.
            "asset.txid": asset ? Uint8Array.from(asset.txid).reverse() : new Uint8Array(32),
            "asset.gidx": asset?.groupIndex ?? 0,
            assetAmount: asset?.amount ?? 0n,
        };
    }

    /** The lockup from `options` alone, with no client and no emulator key. */
    export function script(options: Options): ArkadeProgramScript {
        return new ArkadeProgramScript(program, args(options), { serverKey: options.server });
    }
}
