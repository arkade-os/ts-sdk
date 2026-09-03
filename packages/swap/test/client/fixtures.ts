/**
 * What a quote path needs standing behind it: a wallet, an operator, cards, and
 * a solver that answers.
 *
 * The solver doubles here derive the same covenants the trader will, from the
 * request the trader actually sent — which is the only way a verification test
 * means anything. A double that echoed a fixed address would pass the
 * `lockup_address` check by accident on a client that derived nothing.
 */
import { hex } from "@scure/base";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
    ArkAddress,
    CSVMultisigTapscript,
    DescriptorIdentity,
    HDDescriptorProvider,
    InMemoryWalletRepository,
    MnemonicIdentity,
    getNetwork,
    type IWallet,
} from "@arkade-os/sdk";
import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import {
    LIGHTNING_RECEIVE_PAIR,
    LIGHTNING_SEND_PAIR,
    ONCHAIN_SEND_PAIR,
    lightningReceiveContract,
    lightningSendContract,
    unilateralClaimDelay,
    type RfqQuote,
    type RfqStatus,
} from "../../src/rfq";
import { onchainHtlcScript } from "../../src/onchainHtlc";
import type { AttestingRfqTransport } from "../../src/client/transport";
import { encodeInvoice } from "../helpers/bolt11";

export const key = (fill: number): Uint8Array =>
    schnorr.getPublicKey(new Uint8Array(32).fill(fill));
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program]);

export const OPERATOR_PUBKEY = key(3);
export const SOLVER_PUBKEY = key(1);
export const EMULATOR_PUBKEY = key(9);
/** The 33-byte compressed form the co-signer override takes. */
export const EMULATOR_PUBKEY_HEX = `02${hex.encode(EMULATOR_PUBKEY)}`;
export const SOLVER_DISCOVERY_KEY = hex.encode(key(4));
export const RECEIVER_PK_SCRIPT = p2tr(key(6));
export const SOLVER_REFUND_PK_SCRIPT = p2tr(key(8));
export const HTLC_REFUND_PUBKEY = key(7);

export const NETWORK = getNetwork("regtest");
export const CLAIM_DELAY = unilateralClaimDelay(4096);

/**
 * The checkpoint closure, derived from the signer key rather than pinned — the
 * way arkd advertises it, so a checkpoint committing to another key would
 * describe a different server.
 *
 * Needed by the offer route's registration, which builds an `Arkade` client to
 * derive the contract row; the quote path never reads it.
 */
export const CHECKPOINT_TAPSCRIPT = hex.encode(
    CSVMultisigTapscript.encode({
        timelock: { type: "blocks", value: 10n },
        pubkeys: [OPERATOR_PUBKEY],
    }).script,
);

/** What the wallet answers `getArkadeInfo()` with. */
export const ARK_INFO = {
    signerPubkey: hex.encode(OPERATOR_PUBKEY),
    unilateralExitDelay: 4096,
    network: "regtest",
    deprecatedSigners: [],
    checkpointTapscript: CHECKPOINT_TAPSCRIPT,
};

export const WALLET_ADDRESS = new ArkAddress(OPERATOR_PUBKEY, key(21), NETWORK.hrp).encode();

/** A wallet backed by the real allocator and the real deterministic signer. */
export const hdWallet = async (
    over: { getContractManager?: () => Promise<unknown>; info?: unknown } = {},
): Promise<IWallet> => {
    const identity = MnemonicIdentity.fromMnemonic(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        { isMainnet: false },
    );
    const provider = await HDDescriptorProvider.create(identity, new InMemoryWalletRepository());
    return {
        identity,
        getAddress: async () => WALLET_ADDRESS,
        getArkadeInfo: async () => over.info ?? ARK_INFO,
        getContractManager:
            over.getContractManager ??
            (async () => {
                throw new Error("the quote path must not reach the contract manager");
            }),
        getCurrentSigningDescriptor: () => provider.getCurrentSigningDescriptor(),
        getNextSigningDescriptor: () => provider.getNextSigningDescriptor(),
        getUsedSigningDescriptors: async () => [],
        advanceSigningDescriptorWatermark: async () => {},
        signerForDescriptor: async (descriptor: string) =>
            new DescriptorIdentity({ descriptor, signer: provider, base: identity }),
    } as unknown as IWallet;
};

const CORRIDOR_CARD: Omit<DiscoveredMarket, "pair" | "quote_corridor"> = {
    base_asset: { id: "btc", name: "Bitcoin", ticker: "BTC", decimals: 8 },
    quote_asset: { id: "btc", name: "Bitcoin", ticker: "BTC", decimals: 8 },
    base_corridor: "arkade",
    fee_bps: 30,
    min_base_amount: "1000",
    max_base_amount: "50000000",
    min_quote_amount: "1000",
    max_quote_amount: "50000000",
    solver: "frenchman",
    source: "https://registry.example/regtest.json",
    sourceType: "registry",
    discovery_pubkey: SOLVER_DISCOVERY_KEY,
    transports: { nostr: { relays: ["wss://relay.example"] } },
};

/** `arkade:BTC <-> lightning:BTC`, both directions off one card. */
export const lightningCard: DiscoveredMarket = {
    ...CORRIDOR_CARD,
    pair: "BTC/lightning:BTC",
    quote_corridor: "lightning",
};

/** `arkade:BTC -> onchain:BTC`. */
export const onchainCard: DiscoveredMarket = {
    ...CORRIDOR_CARD,
    pair: "BTC/onchain:BTC",
    quote_corridor: "onchain",
};

/** A second lightning card, for the candidate-ranking and allowlist tests. */
export const rivalLightningCard: DiscoveredMarket = {
    ...lightningCard,
    fee_bps: 90,
    solver: "rival",
    source: "https://other-registry.example/regtest.json",
    discovery_pubkey: hex.encode(key(5)),
};

export const USD_ASSET_ID = "f121ac9b7656797cc68d1e8fecacfbaa2069ec1461edf0bf2f3c37404cb9791a0000";

/** An arkade-to-arkade market: feed-priced, no rendezvous, no corridor. */
export const spotCard: DiscoveredMarket = {
    pair: "BTC/USD",
    base_asset: { id: "btc", name: "Bitcoin", ticker: "BTC", decimals: 8 },
    quote_asset: { id: USD_ASSET_ID, name: "US Dollar", ticker: "USD", decimals: 2 },
    price_feed: "https://feed.example/btc-usd",
    price_feed_schema: { type: "json", price_path: "/price" },
    price_decimals: 6,
    fee_bps: 30,
    min_base_amount: "1000",
    max_base_amount: "5000000",
    min_quote_amount: "50",
    max_quote_amount: "500000",
    solver: "frenchman",
    source: "https://registry.example/regtest.json",
    sourceType: "registry",
};

/** A feed answering a fixed price, and a count of how often it was asked. */
export const feedServing = (price = 100_000): { fetch: typeof fetch; calls: () => number } => {
    let calls = 0;
    return {
        fetch: (async () => {
            calls += 1;
            return new Response(JSON.stringify({ price }));
        }) as unknown as typeof fetch,
        calls: () => calls,
    };
};

export interface SolverClock {
    readonly now: number;
    readonly validUntil: number;
    readonly refundLocktime: number;
    readonly htlcLocktime: number;
}

export const clockAt = (now: number): SolverClock => ({
    now,
    validUntil: now + 3600,
    // Past MIN_HEADROOM_SECONDS on the send legs, and past the receive leg's
    // claim window measured from the pay deadline.
    refundLocktime: now + 200 * 3600,
    htlcLocktime: now + 24 * 3600,
});

/** A BOLT11 the built-in decoder reads: 5_000 sats, an hour of validity. */
export const invoiceFor = (paymentHash: string, clock: SolverClock, amount = "50u"): string =>
    encodeInvoice({
        prefix: "lnbcrt",
        amount,
        timestamp: clock.now - 60,
        expiry: 3_600,
        paymentHash,
    });

export const PREIMAGE = new Uint8Array(32).fill(7);
export const PAYMENT_HASH = hex.encode(sha256(PREIMAGE));

type Payload = Record<string, unknown>;
type Profile = Record<string, unknown>;

const profileOf = (payload: Payload): Profile => payload.profile as Profile;

const baseQuote = (payload: Payload, clock: SolverClock): Omit<RfqQuote, "profile"> => ({
    v: 1,
    type: "rfq_quote",
    rfq_id: payload.rfq_id as string,
    pair: payload.pair as string,
    from_amount: 0,
    to_amount: 0,
    solver_pubkey: hex.encode(SOLVER_PUBKEY),
    valid_until: clock.validUntil,
    refund_locktime: clock.refundLocktime,
});

/** The solver's answer to `arkade:BTC->lightning:BTC`. */
export const lightningSendAnswer = (
    payload: Payload,
    clock: SolverClock,
    over: { quote?: Partial<RfqQuote>; profile?: Profile; invoiceAmount?: number } = {},
): RfqQuote => {
    const profile = profileOf(payload);
    const script = lightningSendContract({
        solverPubkey: SOLVER_PUBKEY,
        refundLocktime: clock.refundLocktime,
        operatorPubkey: OPERATOR_PUBKEY,
        paymentHash: PAYMENT_HASH,
        claimDelay: CLAIM_DELAY,
        emulatorPubkey: EMULATOR_PUBKEY,
        senderPubkey: hex.decode(profile.client_refund_pubkey as string),
        receiverPkScript: RECEIVER_PK_SCRIPT,
        refundPkScript: ArkAddress.decode(profile.refund_address as string).pkScript,
    });
    const take = over.invoiceAmount ?? 5_000;
    return {
        ...baseQuote(payload, clock),
        from_amount: take + 50,
        to_amount: take,
        profile: {
            lockup_address: script.address(NETWORK.hrp, OPERATOR_PUBKEY).encode(),
            receiver_pk_script: hex.encode(RECEIVER_PK_SCRIPT),
            ...over.profile,
        },
        ...over.quote,
    } as RfqQuote;
};

/** The solver's answer to `lightning:BTC->arkade:BTC`, hold invoice included. */
export const lightningReceiveAnswer = (
    payload: Payload,
    clock: SolverClock,
    over: { quote?: Partial<RfqQuote>; profile?: Profile; invoice?: string } = {},
): RfqQuote => {
    const profile = profileOf(payload);
    const paymentHash = profile.payment_hash as string;
    const script = lightningReceiveContract({
        solverPubkey: SOLVER_PUBKEY,
        refundLocktime: clock.refundLocktime,
        operatorPubkey: OPERATOR_PUBKEY,
        paymentHash,
        claimDelay: CLAIM_DELAY,
        emulatorPubkey: EMULATOR_PUBKEY,
        solverRefundPkScript: SOLVER_REFUND_PK_SCRIPT,
        payoutPubkey: hex.decode(profile.payout_pubkey as string),
        payoutPkScript: ArkAddress.decode(profile.payout_address as string).pkScript,
    });
    return {
        ...baseQuote(payload, clock),
        from_amount: 5_000,
        to_amount: 4_950,
        profile: {
            payment_hash: paymentHash,
            invoice: over.invoice ?? invoiceFor(paymentHash, clock),
            lockup_address: script.address(NETWORK.hrp, OPERATOR_PUBKEY).encode(),
            solver_refund_pk_script: hex.encode(SOLVER_REFUND_PK_SCRIPT),
            ...over.profile,
        },
        ...over.quote,
    } as RfqQuote;
};

/** The solver's answer to `arkade:BTC->onchain:BTC`, both contracts included. */
export const onchainSendAnswer = (
    payload: Payload,
    clock: SolverClock,
    over: { quote?: Partial<RfqQuote>; profile?: Profile } = {},
): RfqQuote => {
    const profile = profileOf(payload);
    const paymentHash = profile.payment_hash as string;
    const script = lightningSendContract({
        solverPubkey: SOLVER_PUBKEY,
        refundLocktime: clock.refundLocktime,
        operatorPubkey: OPERATOR_PUBKEY,
        paymentHash,
        claimDelay: CLAIM_DELAY,
        emulatorPubkey: EMULATOR_PUBKEY,
        senderPubkey: hex.decode(profile.client_refund_pubkey as string),
        receiverPkScript: RECEIVER_PK_SCRIPT,
        refundPkScript: ArkAddress.decode(profile.refund_address as string).pkScript,
    });
    const htlc = onchainHtlcScript(
        {
            paymentHash,
            claimKey: hex.decode(profile.payout_pubkey as string),
            refundKey: HTLC_REFUND_PUBKEY,
            refundLocktime: clock.htlcLocktime,
        },
        "regtest",
    );
    return {
        ...baseQuote(payload, clock),
        from_amount: 100_000,
        to_amount: 99_000,
        profile: {
            lockup_address: script.address(NETWORK.hrp, OPERATOR_PUBKEY).encode(),
            receiver_pk_script: hex.encode(RECEIVER_PK_SCRIPT),
            htlc_pubkey: hex.encode(HTLC_REFUND_PUBKEY),
            htlc_locktime: clock.htlcLocktime,
            htlc_address: htlc.address,
            min_confirmations: 2,
            ...over.profile,
        },
        ...over.quote,
    } as RfqQuote;
};

export type SolverAnswer = (payload: Payload) => RfqQuote | Promise<RfqQuote>;

export interface SolverTransport extends AttestingRfqTransport {
    /** Every request the client sent, in order. */
    readonly sent: Payload[];
    readonly closed: () => boolean;
}

/** A transport that answers with `answer`, and records what it was asked. */
export const solverTransport = (
    answer: SolverAnswer,
    over: { attestedResponder?: string | undefined } = {},
): SolverTransport => {
    const sent: Payload[] = [];
    let closed = false;
    return {
        sent,
        closed: () => closed,
        ...("attestedResponder" in over
            ? { attestedResponder: over.attestedResponder }
            : { attestedResponder: SOLVER_DISCOVERY_KEY }),
        async requestQuote(payload) {
            sent.push(payload);
            return answer(payload);
        },
        async status(): Promise<RfqStatus | null> {
            return null;
        },
        async close() {
            closed = true;
        },
    };
};

/** The quote a payload asks for, routed to the right solver double. */
export const solverFor = (clock: SolverClock): SolverAnswer => {
    return (payload) => {
        switch (payload.pair) {
            case LIGHTNING_SEND_PAIR:
                return lightningSendAnswer(payload, clock);
            case LIGHTNING_RECEIVE_PAIR:
                return lightningReceiveAnswer(payload, clock);
            case ONCHAIN_SEND_PAIR:
                return onchainSendAnswer(payload, clock);
            default:
                throw new Error(`no solver double for ${String(payload.pair)}`);
        }
    };
};

export const compressed = (fill: number): string =>
    hex.encode(secp256k1.getPublicKey(new Uint8Array(32).fill(fill), true));

// ── What `accept()` needs behind it, and nothing the quote path had ─────────

/** One `wallet.send` call, exactly as the accept path issued it. */
export interface SentPayment {
    address: string;
    amount?: number;
    assets?: { assetId: string; amount: bigint }[];
    extensions?: { type: number; payload: Uint8Array }[];
}

/** A contract row, as `createContract` was asked to write it. */
export interface WrittenContract {
    type: string;
    script: string;
    address: string;
    params: Record<string, string>;
}

/** One `setContractWatchState` call: the script, and the state asked for. */
export type WatchStateCall = [script: string, state: string];

export interface AcceptWallet {
    readonly wallet: IWallet;
    /** Every funding call, in order. */
    readonly sent: SentPayment[];
    /** Every contract row written, in order — first-writer-wins is modelled. */
    readonly contracts: WrittenContract[];
    /** Every watch-state change, in order. The offer route promotes its row. */
    readonly watched: WatchStateCall[];
    /** VTXOs the reader will answer with, keyed by script hex. */
    readonly deposits: Map<
        string,
        { txid: string; value: number; assets?: { assetId: string; amount: bigint }[] }[]
    >;
}

/**
 * The quote path's wallet, plus the four seams `accept()` reaches.
 *
 * `getContractManager` no longer throws — it records instead — because
 * registration is part of the accept ordering. The quote path's assertion that
 * *it* never reaches the manager is unaffected: that test builds its wallet
 * with {@link hdWallet}, whose thrower is untouched.
 *
 * `send` records and returns a txid rather than deriving one, and `failSend`
 * makes it throw, which is how the after-persist-before-funding window is
 * reached without killing a process.
 */
export const acceptWallet = async (
    over: {
        balance?: { available?: number; availableAssets?: { assetId: string; amount: bigint }[] };
        txid?: string;
        failSend?: () => Error;
        failRegistration?: () => Error;
    } = {},
): Promise<AcceptWallet> => {
    const base = await hdWallet();
    const sent: SentPayment[] = [];
    const contracts: WrittenContract[] = [];
    const watched: WatchStateCall[] = [];
    const deposits = new Map<
        string,
        { txid: string; value: number; assets?: { assetId: string; amount: bigint }[] }[]
    >();
    const wallet = {
        ...base,
        getBalance: async () => ({
            available: over.balance?.available ?? 100_000_000,
            availableAssets: over.balance?.availableAssets ?? [
                { assetId: USD_ASSET_ID, amount: 1_000_000n },
            ],
            assets: [],
        }),
        // The whole seam the accept path reaches, not just `createContract`:
        // the offer route registers through `Arkade.connect` and then promotes
        // the row, so `setContractWatchState` and `getContracts` are part of
        // registration rather than extras.
        getContractManager: async () => ({
            createContract: async (row: WrittenContract) => {
                const failure = over.failRegistration?.();
                if (failure) throw failure;
                // First-writer-wins, as the real one is: identical offers derive
                // one address, so a second write for a script already present is
                // a no-op rather than a conflict.
                if (!contracts.some((c) => c.script === row.script)) contracts.push(row);
                return { ...row, state: "active", createdAt: 0 };
            },
            getContracts: async (filter?: { script?: string }) =>
                contracts.filter((c) => filter?.script === undefined || c.script === filter.script),
            setContractWatchState: async (script: string, state: string) => {
                watched.push([script, state]);
            },
            onContractEvent: () => () => {},
        }),
        getArkadeReader: async () => ({
            getVtxos: async ({ scripts }: { scripts?: string[] }) => ({
                vtxos: (scripts ?? []).flatMap((s) =>
                    (deposits.get(s) ?? []).map((d) => ({
                        txid: d.txid,
                        vout: 0,
                        value: d.value,
                        ...(d.assets ? { assets: d.assets } : {}),
                    })),
                ),
            }),
        }),
        send: async (recipient: SentPayment) => {
            const failure = over.failSend?.();
            if (failure) throw failure;
            sent.push(recipient);
            return over.txid ?? FUNDING_TXID;
        },
    } as unknown as IWallet;
    return { wallet, sent, contracts, watched, deposits };
};

/** The txid `acceptWallet`'s `send` returns unless told otherwise. */
export const FUNDING_TXID = "b".repeat(64);
