import { Bytes } from "@scure/btc-signer/utils.js";
import { DefaultVtxo } from "./default";
import { MultisigTapscript } from "./tapscript";
import { TapLeafScript, VtxoScript } from "./base";
import { hex } from "@scure/base";
import {
    buildDelegateeArkadeScript,
    buildDelegateeTapLeaf,
    isDelegateeVtxoOptions,
    type DelegateeVtxoOptions,
} from "./delegatee";

/**
 * DelegateVtxo extends DefaultVtxo with an extra delegate path
 */
export namespace DelegateVtxo {
    /**
     * Options extends DefaultVtxo.Options and adds a delegatePubKey
     */
    /** @deprecated Legacy three-party pre-signed delegator script parameters. */
    export interface LegacyOptions extends DefaultVtxo.Options {
        delegatePubKey: Bytes;
    }

    export type Options = LegacyOptions | DelegateeVtxoOptions;

    /**
     * DelegateVtxo.Script extends DefaultVtxo.Script and adds a delegate path.
     * @example
     * ```typescript
     * const vtxoScript = new DelegateVtxo.Script({
     *     pubKey: new Uint8Array(32),
     *     serverPubKey: new Uint8Array(32),
     *     delegatePubKey: new Uint8Array(32),
     *     csvTimelock: {
     *         value: 605184n,
     *         type: "seconds"
     *     }
     * });
     *
     * console.log("script pub key:", vtxoScript.pkScript)
     * ```
     */
    export class Script extends VtxoScript {
        readonly defaultVtxo: DefaultVtxo.Script;
        readonly delegateScript: string;
        readonly isDelegatee: boolean;
        readonly arkadeScript?: Uint8Array;
        readonly emulatorTweakedPubKey?: Uint8Array;

        /**
         * Create a delegated virtual output script with forfeit, exit, and delegate paths.
         * LegacyOptions remains supported for existing contracts; use DelegateeVtxoOptions for new delegation.
         */
        constructor(readonly options: Options) {
            const defaultVtxo = new DefaultVtxo.Script(options);
            const { delegatePubKey, pubKey, serverPubKey } = options;
            let delegateScript: Uint8Array;
            let arkadeScript: Uint8Array | undefined;
            let emulatorTweakedPubKey: Uint8Array | undefined;

            if (isDelegateeVtxoOptions(options)) {
                arkadeScript = buildDelegateeArkadeScript(options);
                const delegateLeaf = buildDelegateeTapLeaf(
                    serverPubKey,
                    options.emulatorPubKey,
                    arkadeScript,
                );
                delegateScript = delegateLeaf.script;
                emulatorTweakedPubKey = delegateLeaf.emulatorTweakedPubKey;
            } else {
                delegateScript = MultisigTapscript.encode({
                    pubkeys: [pubKey, delegatePubKey, serverPubKey],
                }).script;
            }

            super([...defaultVtxo.scripts, delegateScript]);

            this.defaultVtxo = defaultVtxo;
            this.delegateScript = hex.encode(delegateScript);
            this.isDelegatee = isDelegateeVtxoOptions(options);
            this.arkadeScript = arkadeScript;
            this.emulatorTweakedPubKey = emulatorTweakedPubKey;
        }

        /** Return the forfeit tapleaf script. */
        forfeit(): TapLeafScript {
            return this.findLeaf(this.defaultVtxo.forfeitScript);
        }

        /** Return the unilateral exit tapleaf script. */
        exit(): TapLeafScript {
            return this.findLeaf(this.defaultVtxo.exitScript);
        }

        /** Return the delegate tapleaf script. */
        delegate(): TapLeafScript {
            return this.findLeaf(this.delegateScript);
        }
    }
}
