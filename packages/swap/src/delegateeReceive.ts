import {
    ArkAddress,
    sealDelegateeSecrets,
    toXOnly,
    type ArkadeInfo,
    type DelegateeProvider,
    type VHTLC,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { ScriptNum } from "@scure/btc-signer";

export interface DelegateeReceiveOptions {
    provider: DelegateeProvider;
    /** The operator-trusted offline_receive template's content id. */
    templateId: string;
}

export async function registerDelegateeReceive(input: {
    delegatee: DelegateeReceiveOptions | undefined;
    info: ArkadeInfo;
    emulatorPubkey: Uint8Array;
    preimage: Uint8Array;
    script: InstanceType<typeof VHTLC.ScriptV2>;
    address: string;
    payoutAddress: string;
    expectedAmount: number;
    refundLocktime: number;
}): Promise<void> {
    if (!input.delegatee) return;
    if (
        !Number.isSafeInteger(input.expectedAmount) ||
        input.expectedAmount <= 0 ||
        input.expectedAmount > 2_100_000_000_000_000
    ) {
        throw new Error("invalid offline receive amount");
    }
    const claimUntil = input.refundLocktime - 60;
    if (!Number.isSafeInteger(claimUntil) || claimUntil <= Math.floor(Date.now() / 1000)) {
        throw new Error("offline receive claim deadline has passed");
    }
    const { provider, templateId } = input.delegatee;
    const info = await provider.getInfo();
    if (
        info.network !== input.info.network ||
        hex.encode(toXOnly(hex.decode(info.serverPubkey), "delegatee operator")) !==
            hex.encode(toXOnly(hex.decode(input.info.signerPubkey), "operator")) ||
        hex.encode(toXOnly(hex.decode(info.emulatorPubkey), "delegatee emulator")) !==
            hex.encode(toXOnly(input.emulatorPubkey, "emulator"))
    ) {
        throw new Error("delegatee is on a different network or signer set");
    }
    const ciphertext = sealDelegateeSecrets({
        templateId,
        encryptionPubkey: hex.decode(info.encryptionPubkey),
        values: {
            preimage: input.preimage,
            minimum_value: ScriptNum(8).encode(BigInt(input.expectedAmount)),
            claim_until: ScriptNum(8).encode(BigInt(claimUntil)),
            lockup_program: input.script.pkScript.subarray(2),
        },
    });
    const watch = await provider.registerDelegation({
        templateId,
        variables: {
            taptree: hex.encode(input.script.encode()),
            receiver_program: hex.encode(
                ArkAddress.decode(input.payoutAddress).pkScript.subarray(2),
            ),
            ciphertext: hex.encode(ciphertext),
        },
        expiresAt: claimUntil,
    });
    if (
        watch.address !== input.address ||
        watch.status !== "active" ||
        watch.templateId !== templateId ||
        watch.expiresAt !== claimUntil ||
        watch.expiresAt <= Math.floor(Date.now() / 1000)
    ) {
        throw new Error("delegatee did not register the expected active claim watch");
    }
}
