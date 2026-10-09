/**
 * `arkade:BTC->ethereum:<token>` execution: the client funds a locally derived Arkade covenant,
 * waits for the solver's ERC20Swap lock to be buried, then claims it with `P`, which settles the
 * solver's side. No EVM library: chain access is the caller's, through {@link EvmChain}.
 */
import { hex } from "@scure/base";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
    ArkAddress,
    provisionClaimSecret,
    toXOnly,
    type IWallet,
    type ProvisionedClaimSecret,
    type VHTLC,
} from "@arkade-os/sdk";

import {
    MIN_HEADROOM_SECONDS,
    lightningSendContract,
    newRfqId,
    serverTerms,
    verifyLockupAddress,
    type LightningSendContractParams,
    type RfqQuote,
    type RfqTransport,
} from "./rfq";
import {
    evmAmountFromWire,
    evmSendRequest,
    evmTokenOf,
    readEvmSendQuote,
    type EvmSendQuote,
} from "./evmRfq";
import { registerLockupContract } from "./lockupContract";
import { gateError } from "./onchainHtlc";

/** The six fields ERC20Swap keys a lock by, hex addresses and a 32-byte hash. */
export interface EvmLock {
    preimageHash: string;
    amount: bigint;
    tokenAddress: string;
    claimAddress: string;
    refundAddress: string;
    timelock: bigint;
}

/** The reads the claim gate needs, against the quote's chain. */
export interface EvmChain {
    chainId(): Promise<number>;
    blockNumber(): Promise<number>;
    /** Unix seconds. */
    blockTimestamp(block: number): Promise<number>;
    /** `eth_call` at `block`; resolves to the 0x-prefixed return data. */
    call(tx: { to: string; data: string }, block: number): Promise<string>;
}

/** Any account may send it: the claim names `claimAddress`, and the tokens go there. */
export type EvmSendClaim = (tx: { to: string; data: string }) => Promise<string>;

export interface EvmClaimPolicy {
    /** Blocks the claim needs to land; the solver can refund at `evm_timeout_block`. */
    claimMarginBlocks: number;
    /** Floors over the quote's own: a reorged lock after the reveal loses the sats. */
    minConfirmations?: number;
    minAgeSeconds?: number;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const selector = (signature: string): Uint8Array =>
    keccak_256(new TextEncoder().encode(signature)).subarray(0, 4);

const SWAPS = selector("swaps(bytes32)");
const CLAIM = selector("claim(bytes32,uint256,address,address,address,uint256)");

const uintWord = (value: bigint): Uint8Array => {
    if (value < 0n || value >= 1n << 256n) throw new Error(`${value} does not fit uint256`);
    return hex.decode(value.toString(16).padStart(64, "0"));
};

const addressWord = (address: string): Uint8Array => {
    if (!EVM_ADDRESS.test(address)) throw new Error(`not an EVM address: ${address}`);
    return hex.decode(address.slice(2).toLowerCase().padStart(64, "0"));
};

const bytes32 = (value: string | Uint8Array): Uint8Array => {
    const bytes = typeof value === "string" ? hex.decode(value) : value;
    if (bytes.length !== 32) throw new Error(`expected 32 bytes, got ${bytes.length}`);
    return bytes;
};

const concat = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
};

const calldata = (...parts: Uint8Array[]): string => `0x${hex.encode(concat(...parts))}`;

/** The lock the solver must create: the quote's terms, the client's own token and claim address. */
export const evmSendLock = (quote: EvmSendQuote, evmClaimAddress: string): EvmLock => {
    const tokenAddress = evmTokenOf(quote.pair);
    if (tokenAddress === null) throw new Error(`not an EVM send pair: ${quote.pair}`);
    return {
        preimageHash: quote.profile.payment_hash,
        amount: evmAmountFromWire(quote.to_amount, "to_amount"),
        tokenAddress,
        claimAddress: evmClaimAddress,
        refundAddress: quote.profile.evm_refund_address,
        timelock: BigInt(quote.profile.evm_timeout_block),
    };
};

/** ERC20Swap's `hashValues`: `keccak256(abi.encode(...))`, never `encodePacked`. */
export const evmSwapKey = (lock: EvmLock): Uint8Array =>
    keccak_256(
        concat(
            bytes32(lock.preimageHash),
            uintWord(lock.amount),
            addressWord(lock.tokenAddress),
            addressWord(lock.claimAddress),
            addressWord(lock.refundAddress),
            uintWord(lock.timelock),
        ),
    );

export const evmClaimCalldata = (lock: EvmLock, preimage: Uint8Array): string => {
    if (hex.encode(sha256(bytes32(preimage))) !== lock.preimageHash) {
        throw new Error("preimage does not hash to the lock's payment hash");
    }
    return calldata(
        CLAIM,
        preimage,
        uintWord(lock.amount),
        addressWord(lock.tokenAddress),
        addressWord(lock.claimAddress),
        addressWord(lock.refundAddress),
        uintWord(lock.timelock),
    );
};

/**
 * The pure core of {@link requestEvmSend}: the Arkade covenant, built as the solver builds it for
 * this leg (the solver is the receiver, the base delay ladder, the full non-interactive suite).
 */
export function deriveEvmSend(input: {
    quote: EvmSendQuote;
    paymentHash: string;
    senderPubkey: Uint8Array;
    refundPkScript: Uint8Array;
    operatorPubkey: Uint8Array;
    emulatorPubkey: Uint8Array;
    claimDelay: number;
    hrp: string;
}): {
    address: string;
    script: InstanceType<typeof VHTLC.ScriptV2>;
    contractParams: LightningSendContractParams;
} {
    const contractParams: LightningSendContractParams = {
        solverPubkey: toXOnly(hex.decode(input.quote.solver_pubkey), "solver key"),
        refundLocktime: input.quote.refund_locktime,
        operatorPubkey: input.operatorPubkey,
        paymentHash: input.paymentHash,
        claimDelay: input.claimDelay,
        emulatorPubkey: input.emulatorPubkey,
        senderPubkey: input.senderPubkey,
        receiverPkScript: hex.decode(input.quote.profile.receiver_pk_script),
        refundPkScript: input.refundPkScript,
    };
    const script = lightningSendContract(contractParams);
    const address = script.address(input.hrp, input.operatorPubkey).encode();
    verifyLockupAddress(input.quote as unknown as RfqQuote, address);
    return { address, script, contractParams };
}

/** The funding gate, immediately before funding. The fee is the caller's to judge: the legs are
 * different assets, so only a rate of its own can price it. */
export const assertEvmSendFundable = (input: {
    quote: EvmSendQuote;
    /** The ERC20Swap deployment the caller trusts on this chain. */
    contractAddress: string;
    now: number;
}): void => {
    const { quote, now } = input;
    // A contract the solver names could report any lock and pay nothing for the revealed `P`.
    if (quote.profile.evm_contract_address.toLowerCase() !== input.contractAddress.toLowerCase()) {
        throw gateError(
            "evm_contract_untrusted",
            "quote names an ERC20Swap this client does not trust",
        );
    }
    if (now >= quote.valid_until) throw gateError("quote_expired", "quote expired");
    if (quote.refund_locktime - now < MIN_HEADROOM_SECONDS) {
        throw gateError("insufficient_headroom", "refund deadline headroom below 90 minutes");
    }
};

/**
 * Quote, derive and verify the covenant, gate, and register it. Funds nothing: the caller funds
 * `address` with `fundAmount` before `quote.valid_until`, then drives {@link claimEvmSend}.
 * Persist `secrets` before funding; `P` is what claims the tokens.
 */
export async function requestEvmSend(
    wallet: IWallet,
    transport: RfqTransport,
    params: {
        tokenAddress: string;
        amountSats: number;
        chainId: number;
        contractAddress: string;
        /** Where the tokens go; it need not send the claim, or hold gas. */
        evmClaimAddress: string;
        rfqId?: string;
        emulatorPubkey?: string;
    },
): Promise<{
    rfqId: string;
    quote: EvmSendQuote;
    address: string;
    fundAmount: number;
    script: InstanceType<typeof VHTLC.ScriptV2>;
    contractParams: LightningSendContractParams;
    refundAddress: string;
    lock: EvmLock;
    secrets: ProvisionedClaimSecret;
}> {
    const rfqId = params.rfqId ?? newRfqId();
    const secrets = await provisionClaimSecret(wallet);
    const paymentHash = hex.encode(secrets.paymentHash);
    const [info, refundAddress] = await Promise.all([
        wallet.getArkadeInfo({ requireLive: true }),
        wallet.getAddress(),
    ]);
    const payload = await transport.requestQuote(
        evmSendRequest({
            rfqId,
            tokenAddress: params.tokenAddress,
            paymentHash,
            evmClaimAddress: params.evmClaimAddress,
            refundAddress,
            senderPubkey: secrets.pubkey,
            amountSats: params.amountSats,
        }),
    );
    const quote = readEvmSendQuote(payload, { ...params, rfqId, paymentHash });
    const { address, script, contractParams } = deriveEvmSend({
        quote,
        paymentHash,
        senderPubkey: secrets.pubkey,
        refundPkScript: ArkAddress.decode(refundAddress).pkScript,
        ...serverTerms(info, params.emulatorPubkey),
    });
    assertEvmSendFundable({
        quote,
        contractAddress: params.contractAddress,
        now: Math.floor(Date.now() / 1000),
    });
    await registerLockupContract(await wallet.getContractManager(), script, address);
    return {
        rfqId,
        quote,
        address,
        fundAmount: quote.from_amount,
        script,
        contractParams,
        refundAddress,
        lock: evmSendLock(quote, params.evmClaimAddress),
        secrets,
    };
}

export type EvmClaimWait = "lock_absent" | "lock_shallow" | "lock_young";

/**
 * Whether revealing `P` now is safe: the lock is live at the tip, was already there
 * `minConfirmations` blocks ago, is old enough, and the claim can land before the solver's refund
 * opens. Throws once that window has closed: from then on only the Arkade refund is safe.
 */
export async function evmClaimReadiness(
    chain: EvmChain,
    input: { quote: EvmSendQuote; lock: EvmLock; policy: EvmClaimPolicy },
): Promise<{ ready: true } | { ready: false; wait: EvmClaimWait }> {
    const { quote, lock, policy } = input;
    if ((await chain.chainId()) !== quote.profile.evm_chain_id) {
        throw gateError("evm_chain_mismatch", "EVM reader is not on the quote's chain");
    }
    const tip = await chain.blockNumber();
    if (BigInt(tip + policy.claimMarginBlocks) >= lock.timelock) {
        throw gateError(
            "claim_window_closed",
            "the solver's EVM refund opens before a claim lands",
        );
    }
    const contract = quote.profile.evm_contract_address;
    const locked = async (block: number): Promise<boolean> =>
        BigInt(
            await chain.call({ to: contract, data: calldata(SWAPS, evmSwapKey(lock)) }, block),
        ) === 1n;
    if (!(await locked(tip))) return { ready: false, wait: "lock_absent" };
    const depth = Math.max(quote.profile.min_confirmations, policy.minConfirmations ?? 1);
    const probe = tip - depth + 1;
    if (probe < 1 || !(await locked(probe))) return { ready: false, wait: "lock_shallow" };
    const age = (await chain.blockTimestamp(tip)) - (await chain.blockTimestamp(probe));
    if (age < Math.max(quote.profile.min_age_seconds, policy.minAgeSeconds ?? 0)) {
        return { ready: false, wait: "lock_young" };
    }
    return { ready: true };
}

/** One pass: claims if {@link evmClaimReadiness} allows, else says what it is waiting for. */
export async function claimEvmSend(
    chain: EvmChain,
    sendClaim: EvmSendClaim,
    input: { quote: EvmSendQuote; lock: EvmLock; preimage: Uint8Array; policy: EvmClaimPolicy },
): Promise<{ claimed: true; txHash: string } | { claimed: false; wait: EvmClaimWait }> {
    const data = evmClaimCalldata(input.lock, input.preimage);
    const readiness = await evmClaimReadiness(chain, input);
    if (!readiness.ready) return { claimed: false, wait: readiness.wait };
    return {
        claimed: true,
        txHash: await sendClaim({ to: input.quote.profile.evm_contract_address, data }),
    };
}
