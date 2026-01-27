import { Bytes } from "@scure/btc-signer/utils";
import { DefaultVtxo } from "./default";
import { MultisigTapscript } from "./tapscript";
import { TapLeafScript, VtxoScript } from "./base";
import { hex } from "@scure/base";

/**
 * DelegateVtxo extends DefaultVtxo with an extra delegator path
 */
export namespace DelegateVtxo {
    /**
     * Options extends DefaultVtxo.Options and adds a delegatePubKey
     */
    export interface Options extends DefaultVtxo.Options {
        delegatePubKey: Bytes;
    }

    /**
     * DelegateVtxo.Script extends DefaultVtxo.Script and adds a delegate path.
     * @example
     * ```typescript
     * const vtxoScript = new DelegateVtxo.Script({
     *     pubKey: new Uint8Array(32),
     *     serverPubKey: new Uint8Array(32),
     *     delegatePubKey: new Uint8Array(32),
     * });
     *
     * console.log("script pub key:", vtxoScript.pkScript)
     * ```
     */
    export class Script extends VtxoScript {
        readonly defaultVtxo: DefaultVtxo.Script;
        readonly delegateScript: string;

        constructor(readonly options: Options) {
            const defaultVtxo = new DefaultVtxo.Script(options);
            const { delegatePubKey, pubKey, serverPubKey } = options;
            const delegateScript = MultisigTapscript.encode({
                pubkeys: [pubKey, delegatePubKey, serverPubKey],
            }).script;

            super([...defaultVtxo.scripts, delegateScript]);

            this.defaultVtxo = defaultVtxo;
            this.delegateScript = hex.encode(delegateScript);
        }

        forfeit(): TapLeafScript {
            return this.findLeaf(this.defaultVtxo.forfeitScript);
        }

        exit(): TapLeafScript {
            return this.findLeaf(this.defaultVtxo.exitScript);
        }

        delegate(): TapLeafScript {
            return this.findLeaf(this.delegateScript);
        }
    }
}
