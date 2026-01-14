import { Bytes } from "@scure/btc-signer/utils.js";
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
        delegatePubKey?: Bytes;
    }

    /**
     * DefaultVtxo.Script is the class letting to create the vtxo script.
     * If delegatePubKey is provided, the script will contain a delegate path.
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
        readonly delegateScript?: string;

        constructor(readonly options: Options) {
            const {
                pubKey,
                serverPubKey,
                csvTimelock = Script.DEFAULT_TIMELOCK,
                delegatePubKey,
            } = options;

            const forfeitScript = MultisigTapscript.encode({
                pubkeys: [pubKey, serverPubKey],
            }).script;

            const exitScript = CSVMultisigTapscript.encode({
                timelock: csvTimelock,
                pubkeys: [pubKey],
            }).script;

            const tapscripts = [forfeitScript, exitScript];

            let delegateScript: Bytes | undefined;
            if (delegatePubKey) {
                delegateScript = MultisigTapscript.encode({
                    pubkeys: [pubKey, delegatePubKey, serverPubKey],
                }).script;

                tapscripts.push(delegateScript);
            }

            super(tapscripts);

            this.forfeitScript = hex.encode(forfeitScript);
            this.exitScript = hex.encode(exitScript);
            this.delegateScript = delegateScript
                ? hex.encode(delegateScript)
                : undefined;
        }

        forfeit(): TapLeafScript {
            return this.findLeaf(this.forfeitScript);
        }

        exit(): TapLeafScript {
            return this.findLeaf(this.exitScript);
        }

        hasDelegate(): boolean {
            return this.delegateScript !== undefined;
        }

        delegate(): TapLeafScript {
            if (!this.delegateScript) {
                throw new Error("Delegator not configured");
            }
            return this.findLeaf(this.delegateScript);
        }
    }
}
