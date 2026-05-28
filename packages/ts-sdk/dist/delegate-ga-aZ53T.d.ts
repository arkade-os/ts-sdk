import { Bytes } from '@scure/btc-signer/utils.js';
import { o as RelativeTimelock, V as VtxoScript, p as TapLeafScript } from './ark-loKbOrJY.js';

/**
 * DefaultVtxo is the default implementation of a VtxoScript.
 * It contains 1 forfeit path and 1 exit path.
 * - forfeit = (Alice + Server)
 * - exit = (Alice) after csvTimelock
 */
declare namespace DefaultVtxo {
    /**
     * Options is the options for the DefaultVtxo.Script class.
     * csvTimelock is the exit path timelock, default is 144 blocks (1 day).
     */
    interface Options {
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
    class Script extends VtxoScript {
        readonly options: Options;
        static readonly DEFAULT_TIMELOCK: RelativeTimelock;
        readonly forfeitScript: string;
        readonly exitScript: string;
        /** Create the default virtual output script with one forfeit path and one exit path. */
        constructor(options: Options);
        /** Return the forfeit tapleaf script. */
        forfeit(): TapLeafScript;
        /** Return the unilateral exit tapleaf script. */
        exit(): TapLeafScript;
    }
}

/**
 * DelegateVtxo extends DefaultVtxo with an extra delegate path
 */
declare namespace DelegateVtxo {
    /**
     * Options extends DefaultVtxo.Options and adds a delegatePubKey
     */
    interface Options extends DefaultVtxo.Options {
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
    class Script extends VtxoScript {
        readonly options: Options;
        readonly defaultVtxo: DefaultVtxo.Script;
        readonly delegateScript: string;
        /** Create a delegated virtual output script with forfeit, exit, and delegate paths. */
        constructor(options: Options);
        /** Return the forfeit tapleaf script. */
        forfeit(): TapLeafScript;
        /** Return the unilateral exit tapleaf script. */
        exit(): TapLeafScript;
        /** Return the delegate tapleaf script. */
        delegate(): TapLeafScript;
    }
}

export { DefaultVtxo as D, DelegateVtxo as a };
