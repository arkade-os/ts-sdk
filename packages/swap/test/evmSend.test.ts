import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ArkAddress, SingleKey, type IWallet } from "@arkade-os/sdk";

import {
    assertEvmSendFundable,
    claimEvmSend,
    deriveEvmSend,
    evmClaimCalldata,
    evmSendLock,
    evmSwapKey,
    requestEvmSend,
    type EvmChain,
    type EvmLock,
} from "../src/evmSend";
import { evmSendPair, type EvmSendQuote } from "../src/evmRfq";
import { AddressMismatch, lightningSendContract, type RfqTransport } from "../src/rfq";

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill));
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program]);

const SERVER = key(3);
const SOLVER = key(1);
const EMULATOR = key(9);
const RECEIVER_PK_SCRIPT = p2tr(key(1));
const REFUND_ADDRESS = new ArkAddress(SERVER, key(21), "tark").encode();
const PREIMAGE = new Uint8Array(32).fill(7);
const PAYMENT_HASH = hex.encode(sha256(PREIMAGE));
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const ERC20_SWAP = "0x1111111111111111111111111111111111111111";
const CLAIM_ADDRESS = "0x2222222222222222222222222222222222222222";
const SOLVER_EVM_ADDRESS = "0x4444444444444444444444444444444444444444";
const TIMEOUT_BLOCK = 21_000_000;
const NOW = Math.floor(Date.now() / 1000);

const lockupFor = (paymentHash: string, senderPubkey: Uint8Array): string =>
    lightningSendContract({
        solverPubkey: SOLVER,
        refundLocktime: NOW + 200 * 3600,
        operatorPubkey: SERVER,
        paymentHash,
        claimDelay: 4096,
        emulatorPubkey: EMULATOR,
        senderPubkey,
        receiverPkScript: RECEIVER_PK_SCRIPT,
        refundPkScript: ArkAddress.decode(REFUND_ADDRESS).pkScript,
    })
        .address("tark", SERVER)
        .encode();

const quoteFor = (
    paymentHash: string,
    senderPubkey: Uint8Array,
    over: Record<string, unknown> = {},
): EvmSendQuote => ({
    v: 1,
    type: "rfq_quote",
    rfq_id: "a1".repeat(32),
    pair: evmSendPair(USDC),
    from_amount: 250_000,
    to_amount: "249750000000000000000",
    solver_pubkey: hex.encode(SOLVER),
    valid_until: NOW + 60,
    refund_locktime: NOW + 200 * 3600,
    profile: {
        payment_hash: paymentHash,
        lockup_address: lockupFor(paymentHash, senderPubkey),
        receiver_pk_script: hex.encode(RECEIVER_PK_SCRIPT),
        evm_refund_address: SOLVER_EVM_ADDRESS,
        evm_timeout_block: TIMEOUT_BLOCK,
        evm_contract_address: ERC20_SWAP,
        evm_chain_id: 42161,
        min_confirmations: 3,
        min_age_seconds: 60,
        ...over,
    },
});

const QUOTE = quoteFor(PAYMENT_HASH, key(13));
const LOCK: EvmLock = evmSendLock(QUOTE, CLAIM_ADDRESS);

describe("ERC20Swap encodings", () => {
    // Vectors from the solver's own `erc20Swap.ts` over the same lock.
    it("keys the lock as the contract's hashValues", () => {
        expect(hex.encode(evmSwapKey(LOCK))).toBe(
            "a0ded6d021310885bb5b4bb375a3fdb7b3bd504d6887c2daa2ea89433d59cde6",
        );
    });

    it("encodes the five-argument claim", () => {
        expect(evmClaimCalldata(LOCK, PREIMAGE)).toBe(
            "0xcd413efa" +
                "07".repeat(32) +
                "00000000000000000000000000000000000000000000000d89fa3dc48dcf0000" +
                "000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" +
                "0000000000000000000000004444444444444444444444444444444444444444" +
                "0000000000000000000000000000000000000000000000000000000001406f40",
        );
    });

    it("refuses a preimage that would not open the lock", () => {
        expect(() => evmClaimCalldata(LOCK, new Uint8Array(32).fill(8))).toThrow(/does not hash/);
    });

    it("keys a checksummed address like its lowercase form", () => {
        const checksummed = { ...LOCK, tokenAddress: "0xA0b86991c6218b36c1D19D4a2e9Eb0cE3606eB48" };
        expect(evmSwapKey(checksummed)).toEqual(evmSwapKey(LOCK));
    });
});

describe("deriveEvmSend", () => {
    const derive = (quote: EvmSendQuote) =>
        deriveEvmSend({
            quote,
            paymentHash: PAYMENT_HASH,
            senderPubkey: key(13),
            refundPkScript: ArkAddress.decode(REFUND_ADDRESS).pkScript,
            operatorPubkey: SERVER,
            emulatorPubkey: EMULATOR,
            claimDelay: 4096,
            hrp: "tark",
        });

    it("rebuilds the solver's lockup", () => {
        expect(derive(QUOTE).address).toBe(QUOTE.profile.lockup_address);
    });

    it("refuses a lockup it cannot rebuild", () => {
        const other = quoteFor(PAYMENT_HASH, key(14));
        expect(() => derive(other)).toThrow(AddressMismatch);
    });
});

describe("assertEvmSendFundable", () => {
    it("passes a fresh quote on the trusted contract", () => {
        expect(() =>
            assertEvmSendFundable({
                quote: QUOTE,
                contractAddress: ERC20_SWAP.toUpperCase().replace("0X", "0x"),
                now: NOW,
            }),
        ).not.toThrow();
    });

    it.each([
        ["evm_contract_untrusted", { contractAddress: CLAIM_ADDRESS }],
        ["quote_expired", { now: NOW + 60 }],
        ["insufficient_headroom", { quote: { ...QUOTE, refund_locktime: NOW + 90 * 60 - 1 } }],
    ])("refuses with %s", (reason, over) => {
        expect(() =>
            assertEvmSendFundable({ quote: QUOTE, contractAddress: ERC20_SWAP, now: NOW, ...over }),
        ).toThrow(expect.objectContaining({ reason }));
    });
});

describe("requestEvmSend", () => {
    const wallet = (): IWallet =>
        ({
            identity: SingleKey.fromHex(
                "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2",
            ),
            getAddress: async () => REFUND_ADDRESS,
            getArkadeInfo: async () => ({
                signerPubkey: hex.encode(SERVER),
                unilateralExitDelay: 4096,
                network: "regtest",
            }),
            getContractManager: async () => ({ createContract: async () => ({}) }),
        }) as unknown as IWallet;

    const transport: RfqTransport = {
        async requestQuote(payload) {
            const profile = payload.profile as Record<string, string>;
            return {
                ...quoteFor(profile.payment_hash!, hex.decode(profile.client_refund_pubkey!)),
                rfq_id: payload.rfq_id as string,
            };
        },
        async status() {
            return null;
        },
        async close() {},
    };

    const request = (contractAddress: string) =>
        requestEvmSend(wallet(), transport, {
            tokenAddress: USDC,
            amountSats: 250_000,
            chainId: 42161,
            contractAddress,
            evmClaimAddress: CLAIM_ADDRESS,
            emulatorPubkey: "02" + hex.encode(EMULATOR),
        });

    it("returns the verified lockup and the lock to wait for", async () => {
        const result = await request(ERC20_SWAP);
        expect(result.address).toBe(result.quote.profile.lockup_address);
        expect(result.fundAmount).toBe(250_000);
        expect(result.lock).toEqual({
            preimageHash: hex.encode(result.secrets.paymentHash),
            amount: 249_750_000_000_000_000_000n,
            tokenAddress: USDC,
            claimAddress: CLAIM_ADDRESS,
            refundAddress: SOLVER_EVM_ADDRESS,
            timelock: BigInt(TIMEOUT_BLOCK),
        });
    });

    it("refuses a quote on a contract the caller does not trust", async () => {
        await expect(request(CLAIM_ADDRESS)).rejects.toMatchObject({
            reason: "evm_contract_untrusted",
        });
    });
});

describe("claimEvmSend", () => {
    const TIP = TIMEOUT_BLOCK - 1_000;
    /** `lockedFrom`: the first block `swaps(key)` reads true; `null` never. */
    const chain = (lockedFrom: number | null, over: Partial<EvmChain> = {}): EvmChain => ({
        chainId: async () => 42161,
        blockNumber: async () => TIP,
        blockTimestamp: async (block) => 1_800_000_000 + block * 30,
        call: async (tx, block) => {
            expect(tx.to).toBe(ERC20_SWAP);
            expect(tx.data).toBe(`0xeb84e7f2${hex.encode(evmSwapKey(LOCK))}`);
            return `0x${(lockedFrom !== null && block >= lockedFrom ? 1 : 0).toString(16).padStart(64, "0")}`;
        },
        ...over,
    });
    const POLICY = { claimMarginBlocks: 100 };
    const claim = (
        evm: EvmChain,
        policy: Parameters<typeof claimEvmSend>[2]["policy"] = POLICY,
    ) => {
        const send = vi.fn(async () => "0xtx");
        return {
            send,
            result: claimEvmSend(evm, send, {
                quote: QUOTE,
                lock: LOCK,
                preimage: PREIMAGE,
                policy,
            }),
        };
    };

    it("claims a buried, aged lock", async () => {
        const { send, result } = claim(chain(TIP - 10));
        expect(await result).toEqual({ claimed: true, txHash: "0xtx" });
        expect(send).toHaveBeenCalledWith({
            to: ERC20_SWAP,
            data: evmClaimCalldata(LOCK, PREIMAGE),
        });
    });

    it.each([
        ["lock_absent", chain(null), POLICY],
        ["lock_shallow", chain(TIP - 1), POLICY],
        ["lock_shallow", chain(TIP - 3), { ...POLICY, minConfirmations: 10 }],
        ["lock_young", chain(TIP - 10), { ...POLICY, minAgeSeconds: 61 }],
    ])("waits with %s and reveals nothing", async (wait, evm, policy) => {
        const { send, result } = claim(evm, policy);
        expect(await result).toEqual({ claimed: false, wait });
        expect(send).not.toHaveBeenCalled();
    });

    it("refuses once the claim cannot land before the solver's refund", async () => {
        const closing = chain(0, { blockNumber: async () => TIMEOUT_BLOCK - 100 });
        await expect(claim(closing).result).rejects.toMatchObject({
            reason: "claim_window_closed",
        });
        expect(
            await claim(chain(0, { blockNumber: async () => TIMEOUT_BLOCK - 101 })).result,
        ).toEqual({
            claimed: true,
            txHash: "0xtx",
        });
    });

    it("refuses a reader on another chain", async () => {
        await expect(claim(chain(0, { chainId: async () => 1 })).result).rejects.toMatchObject({
            reason: "evm_chain_mismatch",
        });
    });
});
