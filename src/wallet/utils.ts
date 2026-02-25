import { Recipient } from ".";
import {
    ArkAddress,
    type Coin,
    type ExtendedCoin,
    type ExtendedVirtualCoin,
    type VirtualCoin,
} from "..";
import { ReadonlyWallet } from "./wallet";
import { hex } from "@scure/base";
import { Bytes } from "@scure/btc-signer/utils";

export const DUST_AMOUNT = 546; // sats

export function extendVirtualCoin(
    wallet: { offchainTapscript: ReadonlyWallet["offchainTapscript"] },
    vtxo: VirtualCoin
): ExtendedVirtualCoin {
    return {
        ...vtxo,
        forfeitTapLeafScript: wallet.offchainTapscript.forfeit(),
        intentTapLeafScript: wallet.offchainTapscript.forfeit(),
        tapTree: wallet.offchainTapscript.encode(),
    };
}

export function extendCoin(
    wallet: { boardingTapscript: ReadonlyWallet["boardingTapscript"] },
    utxo: Coin
): ExtendedCoin {
    return {
        ...utxo,
        forfeitTapLeafScript: wallet.boardingTapscript.forfeit(),
        intentTapLeafScript: wallet.boardingTapscript.forfeit(),
        tapTree: wallet.boardingTapscript.encode(),
    };
}

export function getRandomId(): string {
    const randomValue = crypto.getRandomValues(new Uint8Array(16));
    return hex.encode(randomValue);
}

export function isValidArkAddress(address: string): boolean {
    try {
        ArkAddress.decode(address);
        return true;
    } catch (e) {
        return false;
    }
}

type ValidatedRecipient = Required<Recipient> & { script: Bytes };

export function validateRecipients(
    recipients: Recipient[],
    dustAmount: number
): ValidatedRecipient[] {
    const validatedRecipients: ValidatedRecipient[] = [];

    for (const recipient of recipients) {
        let address: ArkAddress;
        try {
            address = ArkAddress.decode(recipient.address);
        } catch (e) {
            throw new Error(`Invalid Ark address: ${recipient.address}`);
        }

        const amount = recipient.amount || dustAmount;
        if (amount <= 0) {
            throw new Error("Amount must be positive");
        }

        validatedRecipients.push({
            address: recipient.address,
            assets: recipient.assets ?? [],
            amount,
            script:
                amount < dustAmount
                    ? address.subdustPkScript
                    : address.pkScript,
        });
    }

    return validatedRecipients;
}
