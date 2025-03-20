import * as bip68 from "bip68";
import { Bytes } from "@scure/btc-signer/utils";
import { Script, ScriptNum, ScriptType } from "@scure/btc-signer/script";
import { p2tr_ms } from "@scure/btc-signer/payment";

export type RelativeTimelock = {
    value: bigint;
    type: "seconds" | "blocks";
};

export function exitClosure(
    timelock: RelativeTimelock,
    pubkeys: Bytes[]
): Uint8Array {
    for (const pubkey of pubkeys) {
        if (pubkey.length !== 32) {
            throw new Error("Invalid pubkey length");
        }
    }

    const sequence = ScriptNum().encode(
        BigInt(
            bip68.encode(
                timelock.type === "blocks"
                    ? { blocks: Number(timelock.value) }
                    : { seconds: Number(timelock.value) }
            )
        )
    );

    const asm: ScriptType = [sequence, "CHECKSEQUENCEVERIFY", "DROP"];

    for (const [i, pubkey] of pubkeys.entries()) {
        const isLast = i === pubkeys.length - 1;
        asm.push(pubkey, isLast ? "CHECKSIG" : "CHECKSIGVERIFY");
    }

    return Script.encode(asm);
}

export function forfeitClosure(pubkeys: Bytes[]): Uint8Array {
    if (pubkeys.length < 2) {
        throw new Error("At least 2 pubkeys are required");
    }

    for (const pubkey of pubkeys) {
        if (pubkey.length !== 32) {
            throw new Error("Invalid pubkey length");
        }
    }

    return p2tr_ms(pubkeys.length, pubkeys).script;
}
