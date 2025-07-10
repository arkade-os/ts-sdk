import { Bytes } from "@scure/btc-signer/utils";
import { TapLeafScript, VtxoScript } from "./base";
import {
    CSVMultisigTapscript,
    MultisigTapscript,
    RelativeTimelock,
} from "./tapscript";
import { hex } from "@scure/base";

/**
 * DefaultVtxo is the default implementation of a VtxoScript.
 * It contains 1 forfeit path and 1 exit path.
 * - forfeit = (Alice + Server)
 * - exit = (Alice) after csvTimelock
 */
export namespace DefaultVtxo {
    /**
     * Options is the options for the DefaultVtxo.Script class.
     * csvTimelock is the exit path timelock, default is 144 blocks (1 day).
     */
    export interface Options {
        pubKey: Bytes;
        serverPubKey: Bytes;
        csvTimelock?: RelativeTimelock;
    }

    /**
     * DefaultVtxo.Script is the class letting to create the vtxo script.
     * @example
     * ```typescript
     * const vtxoScript = new DefaultVtxo.Script({
     *     pubKey: new Uint8Array(32),
     *     serverPubKey: new Uint8Array(32),
     * });
     *
     * console.log("script pub key:", vtxoScript.pkScript)
     * ```
     */
    export class Script extends VtxoScript {
        static readonly DEFAULT_TIMELOCK: RelativeTimelock = {
            value: 144n,
            type: "blocks",
        }; // 1 day in blocks

        readonly forfeitScript: string;
        readonly exitScript: string;

        constructor(readonly options: Options) {
            const {
                pubKey,
                serverPubKey,
                csvTimelock = Script.DEFAULT_TIMELOCK,
            } = options;

            const forfeitScript = MultisigTapscript.encode({
                pubkeys: [pubKey, serverPubKey],
            }).script;

            const exitScript = CSVMultisigTapscript.encode({
                timelock: csvTimelock,
                pubkeys: [pubKey],
            }).script;

            super([forfeitScript, exitScript]);

            this.forfeitScript = hex.encode(forfeitScript);
            this.exitScript = hex.encode(exitScript);
        }

        forfeit(): TapLeafScript {
            return this.findLeaf(this.forfeitScript);
        }

        exit(): TapLeafScript {
            return this.findLeaf(this.exitScript);
        }
    }
}
