import { hex } from "@scure/base";
import { randomBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ArkAddress } from "@arkade-os/sdk";
import type {
    BoltzSwapProvider,
    CreateReverseSwapRequest,
    CreateReverseSwapResponse,
} from "./boltz-swap-provider";
import type { CovclaimdProvider } from "./covclaimd-provider";
import { eciesEncrypt } from "./utils/covclaimd-ecies";
import { enforcePayTo } from "./utils/vhtlc";
import { decodeInvoice } from "./utils/decoding";
import { SwapError } from "./errors";

/** Inputs for a server-orchestrated non-interactive reverse swap. */
export interface CreateNonInteractiveReverseSwapArgs {
    /** Boltz provider (`new BoltzSwapProvider(...)`). */
    swapProvider: BoltzSwapProvider;
    /** covclaimd client (`new CovclaimdProvider(url)`). */
    covclaimd: CovclaimdProvider;
    /** Invoice amount in satoshis. */
    amount: number;
    /** Receiver's compressed claim public key (33 bytes / 66 hex chars). */
    claimPublicKey: string;
    /** Receiver's Arkade address — the covenant claim is constrained to pay it. */
    claimAddress: string;
    /** Optional invoice description. */
    description?: string;
    /** Optional invoice description hash (mutually exclusive with `description`). */
    descriptionHash?: string;
}

/** Result of a non-interactive reverse swap. `preimage` is returned for record-keeping;
 *  the caller never needs it to claim (covclaimd does that), but may keep it to prove
 *  settlement (e.g. LUD-21 verify). */
export interface NonInteractiveReverseSwap {
    id: string;
    invoice: string;
    preimage: string;
    preimageHash: string;
    lockupAddress: string;
    response: CreateReverseSwapResponse;
}

/**
 * Create a non-interactive reverse swap (Lightning → Arkade) for an **arbitrary
 * receiver**, with no wallet. This is {@link ArkadeSwaps.createReverseSwap} in
 * `nonInteractive` mode, minus the wallet: instead of reading the receiver's
 * identity from `this.wallet`, the caller supplies the receiver's public
 * `claimPublicKey` + `claimAddress`. A fresh preimage is generated internally,
 * encrypted to covclaimd, and the VHTLC claim is covenant-constrained (via
 * `enforcePayTo`) to pay the receiver — so covclaimd learns the preimage but
 * cannot redirect the funds, and the receiver never needs to be online or
 * expose a signing key.
 *
 * Intended for services (e.g. an LNURL server) that mint invoices on behalf of
 * offline users.
 */
export async function createNonInteractiveReverseSwap(
    args: CreateNonInteractiveReverseSwapArgs,
): Promise<NonInteractiveReverseSwap> {
    const { swapProvider, covclaimd, amount, claimPublicKey, claimAddress } = args;
    if (amount <= 0) throw new SwapError({ message: "Amount must be greater than 0" });

    // covclaimd's keys must be available before we commit to a swap.
    const covPubKeys = await covclaimd.getPubKeys();

    const preimage = randomBytes(32);
    const preimageHash = hex.encode(sha256(preimage));

    const swapRequest: CreateReverseSwapRequest = {
        invoiceAmount: amount,
        claimPublicKey,
        preimageHash,
        ...(args.descriptionHash !== undefined
            ? { descriptionHash: args.descriptionHash }
            : args.description?.trim()
              ? { description: args.description.trim() }
              : {}),
        nonInteractiveClaim: { claimAddress },
    };

    const response = await swapProvider.createReverseSwap(swapRequest);

    const decoded = decodeInvoice(response.invoice);
    if (decoded.paymentHash !== preimageHash) {
        throw new SwapError({ message: "Preimage hash does not match invoice payment hash" });
    }
    if (!response.lockupAddress) {
        throw new SwapError({ message: "reverse swap response missing lockupAddress" });
    }

    // Hand covclaimd the encrypted preimage + the pay-to-receiver covenant so it
    // can claim the VHTLC on the offline receiver's behalf.
    const receiverTapKey = ArkAddress.decode(claimAddress).vtxoTaprootKey;
    await covclaimd.reveal({
        swapAddress: response.lockupAddress,
        ciphertext: eciesEncrypt(covPubKeys.covclaimdPubKey, preimage),
        arkadeScript: enforcePayTo(receiverTapKey),
    });

    return {
        id: response.id,
        invoice: response.invoice,
        preimage: hex.encode(preimage),
        preimageHash,
        lockupAddress: response.lockupAddress,
        response,
    };
}
