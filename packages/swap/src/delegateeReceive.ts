import { ArkAddress, sealDelegateeSecrets } from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { ScriptNum } from "@scure/btc-signer";
import { concatBytes } from "@scure/btc-signer/utils.js";
import { DELEGATEE_CLAIM_PACKET_PREFIX } from "./claimPacket";

export interface DelegateeReceiveOptions {
    /** The operator can decrypt the preimage and must be trusted with it. */
    encryptionPubkey: string;
    templateId: string;
}

export function sealDelegateeReceive(input: {
    delegatee: DelegateeReceiveOptions | undefined;
    preimage: Uint8Array;
    payoutAddress: string;
    amount: { on: "give" | "take"; value: bigint };
}): string | undefined {
    if (!input.delegatee) return undefined;
    if (input.amount.on !== "take") {
        throw new Error("packet-only offline receive requires amountOn: take");
    }
    if (input.amount.value <= 0n || input.amount.value > 2_100_000_000_000_000n) {
        throw new Error("invalid offline receive amount");
    }
    if (input.preimage.length !== 32) throw new Error("preimage must be 32 bytes");
    const encryptionPubkey = hex.decode(input.delegatee.encryptionPubkey);
    const ciphertext = sealDelegateeSecrets({
        templateId: input.delegatee.templateId,
        encryptionPubkey,
        values: {
            preimage: input.preimage,
            minimum_value: ScriptNum(8).encode(input.amount.value),
            receiver_program: ArkAddress.decode(input.payoutAddress).pkScript.subarray(2),
        },
    });
    const tlv = (tag: number, value: Uint8Array) =>
        concatBytes(new Uint8Array([tag, value.length >> 8, value.length & 0xff]), value);
    return base64.encode(
        concatBytes(DELEGATEE_CLAIM_PACKET_PREFIX, tlv(1, ciphertext), tlv(3, encryptionPubkey)),
    );
}
