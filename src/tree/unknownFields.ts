import * as bip68 from "bip68";
import { RawTx, ScriptNum, Transaction } from "@scure/btc-signer";
import { base64, hex } from "@scure/base";
import { RelativeTimelock } from "../script/tapscript";

const COSIGNER_KEY_PREFIX = new Uint8Array(
    "cosigner".split("").map((c) => c.charCodeAt(0))
);

const VTXO_TREE_EXPIRY_PSBT_KEY = new Uint8Array(
    "expiry".split("").map((c) => c.charCodeAt(0))
);

export function getVtxoTreeExpiry(input: {
    unknown?: { key: Uint8Array; value: Uint8Array }[];
}): RelativeTimelock | null {
    if (!input.unknown) return null;

    for (const u of input.unknown) {
        // Check if key contains the VTXO tree expiry key
        if (u.key.length < VTXO_TREE_EXPIRY_PSBT_KEY.length) continue;

        let found = true;
        for (let i = 0; i < VTXO_TREE_EXPIRY_PSBT_KEY.length; i++) {
            if (u.key[i] !== VTXO_TREE_EXPIRY_PSBT_KEY[i]) {
                found = false;
                break;
            }
        }

        if (found) {
            const value = ScriptNum(6, true).decode(u.value);
            const { blocks, seconds } = bip68.decode(Number(value));
            return {
                type: blocks ? "blocks" : "seconds",
                value: BigInt(blocks ?? seconds ?? 0),
            };
        }
    }

    return null;
}

function parsePrefixedCosignerKey(key: Uint8Array): boolean {
    if (key.length < COSIGNER_KEY_PREFIX.length) return false;

    for (let i = 0; i < COSIGNER_KEY_PREFIX.length; i++) {
        if (key[i] !== COSIGNER_KEY_PREFIX[i]) return false;
    }
    return true;
}

export function getCosignerKeys(tx: Transaction): Uint8Array[] {
    const keys: Uint8Array[] = [];

    const input = tx.getInput(0);

    if (!input.unknown) return keys;

    for (const unknown of input.unknown) {
        const ok = parsePrefixedCosignerKey(
            new Uint8Array([unknown[0].type, ...unknown[0].key])
        );

        if (!ok) continue;

        // Assuming the value is already a valid public key in compressed format
        keys.push(unknown[1]);
    }

    return keys;
}
