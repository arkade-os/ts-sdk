import { hex } from "@scure/base";
import { Bytes } from "@scure/btc-signer/utils.js";
import { ArkadeScript, type ArkadeScriptType } from "../arkade/script";
import { computeArkadeScriptPublicKey } from "../arkade/tweak";
import { toXOnly } from "../utils/keys";
import { MultisigTapscript, type RelativeTimelock } from "./tapscript";

/** The defaults used by delegatee when a wallet does not choose its own limits. */
export const DEFAULT_DELEGATEE_RENEWAL_WINDOW = 1024;
export const DEFAULT_DELEGATEE_MAX_FEE = 0;

/** Keep these bounds in sync with delegatee's covenant parameter validation. */
export const MAX_DELEGATEE_RENEWAL_WINDOW = 366 * 24 * 60 * 60;
export const MAX_DELEGATEE_FEE = 1_000_000;

export interface DelegateeCovenantParams {
    /** The compressed public key of delegatee's vtxo-tree signer. */
    delegatePubKey: Bytes;
    renewalWindow: number;
    maxFee: number;
}

/** Parameters specific to the delegatee variant of the delegate contract. */
export interface DelegateeVtxoOptions extends DelegateeCovenantParams {
    pubKey: Bytes;
    serverPubKey: Bytes;
    emulatorPubKey: Bytes;
    csvTimelock: RelativeTimelock;
}

const encoder = new TextEncoder();

function data(value: string): Uint8Array {
    return encoder.encode(value);
}

function validateParams({ delegatePubKey, renewalWindow, maxFee }: DelegateeCovenantParams): void {
    if (
        delegatePubKey.length !== 33 ||
        (delegatePubKey[0] !== 0x02 && delegatePubKey[0] !== 0x03)
    ) {
        throw new Error("delegatee key must be a 33-byte compressed public key");
    }
    if (!Number.isSafeInteger(renewalWindow) || renewalWindow <= 0) {
        throw new Error("delegatee renewalWindow must be a positive integer");
    }
    if (renewalWindow > MAX_DELEGATEE_RENEWAL_WINDOW) {
        throw new Error(
            `delegatee renewalWindow must be at most ${MAX_DELEGATEE_RENEWAL_WINDOW} seconds`,
        );
    }
    if (!Number.isSafeInteger(maxFee) || maxFee < 0) {
        throw new Error("delegatee maxFee must be a non-negative integer");
    }
    if (maxFee > MAX_DELEGATEE_FEE) {
        throw new Error(`delegatee maxFee must be at most ${MAX_DELEGATEE_FEE} sats`);
    }
}

/**
 * Build the byte-exact Arkade covenant used by delegatee.
 *
 * The strings in the cosigner clause are intentionally pushed as ASCII hex,
 * matching delegatee's Go implementation (`AddData([]byte(delegatePubKey))`).
 *
 * Requires emulator v0.0.8-rc.1: CHECKTIME pushes a boolean consumed by VERIFY.
 */
export function buildDelegateeArkadeScript(params: DelegateeCovenantParams): Uint8Array {
    validateParams(params);

    const delegatePubKeyHex = hex.encode(params.delegatePubKey);
    const script: ArkadeScriptType = [
        "PUSHEXPIRY",
        params.renewalWindow,
        "SUB",
        "CHECKTIME",
        "VERIFY",
        data("type"),
        "INSPECTINTENTMESSAGE",
        "VERIFY",
        data("register"),
        "EQUALVERIFY",
        data("onchain_output_indexes"),
        "INSPECTINTENTMESSAGE",
        "VERIFY",
        data("[]"),
        "EQUALVERIFY",
        data("cosigners_public_keys.0"),
        "INSPECTINTENTMESSAGE",
        "VERIFY",
        data(delegatePubKeyHex),
        "EQUALVERIFY",
        data("cosigners_public_keys.1"),
        "INSPECTINTENTMESSAGE",
        "NOT",
        "VERIFY",
        "DROP",
        "PUSHCURRENTINPUTINDEX",
        "1SUB",
    ];

    if (params.maxFee === 0) {
        script.push(7, 0, "TUNNEL");
    } else {
        script.push(
            "INSPECTOUTPUTVALUE",
            params.maxFee,
            "ADD",
            "PUSHCURRENTINPUTINDEX",
            "INSPECTINPUTVALUE",
            "GREATERTHANOREQUAL",
            "VERIFY",
            "PUSHCURRENTINPUTINDEX",
            "1SUB",
            5,
            0,
            "TUNNEL",
        );
    }

    return ArkadeScript.encode(script);
}

/** Compatibility name for callers that mirror delegatee's Go code. */
export const buildArkadeScript = buildDelegateeArkadeScript;

/** Return whether a delegate script carries the new delegatee parameters. */
export function isDelegateeVtxoOptions(options: unknown): options is DelegateeVtxoOptions {
    return (
        typeof options === "object" &&
        options !== null &&
        "emulatorPubKey" in options &&
        (options as { emulatorPubKey?: unknown }).emulatorPubKey !== undefined
    );
}

/** Derive the two-key delegate leaf from a delegatee covenant. */
export function buildDelegateeTapLeaf(
    serverPubKey: Bytes,
    emulatorPubKey: Bytes,
    arkadeScript: Uint8Array,
): { emulatorTweakedPubKey: Uint8Array; script: Uint8Array } {
    const emulatorTweakedPubKey = computeArkadeScriptPublicKey(emulatorPubKey, arkadeScript);
    return {
        emulatorTweakedPubKey,
        script: MultisigTapscript.encode({
            pubkeys: [toXOnly(serverPubKey, "server key"), emulatorTweakedPubKey],
        }).script,
    };
}
