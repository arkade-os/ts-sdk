import { hex } from "@scure/base";
import {
    Contract,
    ContractHandler,
    DerivedContractTapscripts,
    PathContext,
    PathSelection,
    TapscriptDeriving,
} from "../types";
import { isCltvSatisfied, isCsvSpendable } from "./helpers";
import { timelockToSequence } from "../../utils/timelock";
import { extractPubKey, isDescriptor } from "../../identity/descriptor";
import {
    ArkadeProgramScript,
    deserializeArkadeContractParams,
    serializeArkadeContractParams,
    witnessRefToBytes,
    type ArkadeContractParams,
    type CompiledProgramFunction,
} from "../../arkade/program";

/**
 * Extract the raw x-only pubkey hex the wallet signs with from the path
 * context, best-effort (mirrors the VHTLC handler's role resolution).
 */
function walletKeyFrom(context: PathContext): string | undefined {
    const extract = (value: string): string | undefined => {
        if (!isDescriptor(value)) return value.toLowerCase();
        try {
            return extractPubKey(value).toLowerCase();
        } catch {
            return undefined;
        }
    };
    if (context.walletDescriptor) {
        const key = extract(context.walletDescriptor);
        if (key) return key;
    }
    if (context.walletPubKey) {
        return extract(context.walletPubKey);
    }
    return undefined;
}

/**
 * Resolve a pure-tapscript function's condition witness without call
 * arguments: literals and `$param` references resolve, function-input
 * references cannot (they only exist at call time) — those paths are not
 * generically spendable.
 */
function staticWitness(
    fn: CompiledProgramFunction,
    script: ArkadeProgramScript,
): Uint8Array[] | null {
    const refs = fn.def.tapscript.witness ?? [];
    try {
        return refs.map((w) => witnessRefToBytes(w, {}, script.args));
    } catch {
        return null;
    }
}

/**
 * Enumerate the spending paths of a compiled program for the given context.
 *
 * Covenant (`arkadeScript`) functions are excluded: they require the
 * co-signing service round-trip and call arguments, so they are spent through
 * `ArkadeContract.functions.<name>(...)`, never through generic wallet path
 * selection. Pure-tapscript functions follow the same conventions as the
 * built-in handlers:
 *
 * - collaborative context → non-timelocked paths (CLTV paths once satisfied);
 * - unilateral context → only paths that do not require the Arkade Service
 *   signer, with CSV/CLTV gates applied (`checkTimelocks: false` skips the
 *   gates, for `getAllSpendingPaths`).
 * - when the context identifies the wallet key and a path has non-server
 *   signers, the wallet must be one of them.
 */
function pathsFor(
    script: ArkadeProgramScript,
    context: PathContext,
    opts: { checkTimelocks: boolean },
): PathSelection[] {
    const walletKey = walletKeyFrom(context);
    const serverHex = hex.encode(script.keys.serverKey);
    const paths: PathSelection[] = [];

    for (const fn of script.compiled) {
        if (fn.arkadeScript) continue;

        const witness = staticWitness(fn, script);
        if (witness === null) continue;

        const signerHexes = fn.signerKeys.map((s) => hex.encode(s));
        const requiresServer = signerHexes.includes(serverHex);
        const nonServer = signerHexes.filter((s) => s !== serverHex);

        // If we know who the wallet is and the path needs non-server
        // signatures, the wallet must be one of those signers.
        if (walletKey && nonServer.length > 0 && !nonServer.includes(walletKey)) {
            continue;
        }

        const csv = fn.def.tapscript.csv;
        const cltv = fn.def.tapscript.cltv;

        if (context.collaborative) {
            // CSV leaves are unilateral-exit paths by convention.
            if (csv) continue;
            if (opts.checkTimelocks && cltv !== undefined && !isCltvSatisfied(context, cltv)) {
                continue;
            }
            paths.push({
                leaf: fn.tapLeafScript,
                ...(witness.length > 0 ? { extraWitness: witness } : {}),
            });
            continue;
        }

        // Unilateral: the Arkade Service will not co-sign.
        if (requiresServer) continue;
        const sequence = csv ? Number(timelockToSequence(csv)) : undefined;
        if (opts.checkTimelocks && csv && !isCsvSpendable(context, sequence)) continue;
        if (opts.checkTimelocks && cltv !== undefined && !isCltvSatisfied(context, cltv)) {
            continue;
        }
        paths.push({
            leaf: fn.tapLeafScript,
            ...(sequence !== undefined ? { sequence } : {}),
            ...(witness.length > 0 ? { extraWitness: witness } : {}),
        });
    }

    return paths;
}

/**
 * Generic handler for artifact/program-based Arkade contracts.
 *
 * Persists the full {@link ArkadeContractParams} (program artifact JSON, args,
 * signer keys) as string params, so any contract created via
 * `arkade.contract(program, args)` participates in the standard contract
 * pipeline: ContractManager persistence and validation, watcher events,
 * repository-backed balances, and offline script re-derivation. Rebuild a
 * callable contract from a stored row with `ArkadeContract.fromContract`.
 */
export const ArkadeContractHandler: ContractHandler<ArkadeContractParams, ArkadeProgramScript> &
    TapscriptDeriving<ArkadeProgramScript> = {
    type: "arkade",

    createScript(params: Record<string, string>): ArkadeProgramScript {
        const typed = this.deserializeParams(params);
        return new ArkadeProgramScript(typed.program, typed.args, {
            serverKey: typed.serverKey,
            userKey: typed.userKey,
            emulatorKey: typed.emulatorKey,
        });
    },

    serializeParams(params: ArkadeContractParams): Record<string, string> {
        return serializeArkadeContractParams(params);
    },

    deserializeParams(params: Record<string, string>): ArkadeContractParams {
        return deserializeArkadeContractParams(params);
    },

    selectPath(
        script: ArkadeProgramScript,
        _contract: Contract,
        context: PathContext,
    ): PathSelection | null {
        const paths = pathsFor(script, context, { checkTimelocks: true });
        return paths.length > 0 ? paths[0] : null;
    },

    getAllSpendingPaths(
        script: ArkadeProgramScript,
        _contract: Contract,
        context: PathContext,
    ): PathSelection[] {
        return pathsFor(script, context, { checkTimelocks: false });
    },

    getSpendablePaths(
        script: ArkadeProgramScript,
        _contract: Contract,
        context: PathContext,
    ): PathSelection[] {
        return pathsFor(script, context, { checkTimelocks: true });
    },

    /**
     * Annotation tapscripts for VTXOs locked to this contract: prefer the
     * collaborative tapscript path (the multisig the Arkade Service co-signs,
     * mirroring `forfeit()` on the built-in script shapes); covenant-only
     * programs fall back to their first covenant leaf (its forfeit is
     * co-signed by the emulator during batch settlement); otherwise the first
     * declared leaf.
     */
    deriveTapscripts(script: ArkadeProgramScript, _contract: Contract): DerivedContractTapscripts {
        const collaborative = pathsFor(
            script,
            { collaborative: true, currentTime: 0 },
            { checkTimelocks: false },
        );
        const leaf =
            collaborative[0]?.leaf ??
            script.compiled.find((f) => f.arkadeScript)?.tapLeafScript ??
            script.compiled[0].tapLeafScript;
        return {
            forfeitTapLeafScript: leaf,
            intentTapLeafScript: leaf,
            tapTree: script.encode(),
        };
    },
};
