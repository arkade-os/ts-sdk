/**
 * What a drive test needs standing behind it: real covenants, a real record
 * store, and doubles for the four seams a pass reads.
 *
 * The covenants are the production builders' own — a drive test that watched a
 * hand-made script would prove nothing about whether the restore rebuilds the
 * covenant that was actually funded, which is the check `rebuildRfqSwap` exists
 * to make. The repository is the shipped `InMemoryAssetSwapRepository`, so the
 * bridge is exercised against the same store `accept()` writes.
 */
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
    ArkAddress,
    Extension,
    Transaction,
    UnknownPacket,
    VHTLCV2ContractHandler,
    asset,
    type ContractEvent,
    type CreateContractParams,
    type IWallet,
    type VHTLC,
} from "@arkade-os/sdk";
import { lightningReceiveContract, lightningSendContract } from "../../src/rfq";
import { encodeOffer, offerContract, OFFER_PACKET_TYPE, type Offer } from "../../src/offer";
import type { LockupSpendIndexer } from "../../src/refund";
import { InMemoryAssetSwapRepository } from "../../src/repository";
import { SWAP_LOCKUP_CONTRACT_KIND, SWAP_LOCKUP_CONTRACT_TYPE } from "../../src/lockupContract";
import type { SwapContractRegistry } from "../../src/swapManager";
import type { CorridorSet } from "../../src/client/corridors/registry";
import type { CorridorSwapRecord, OfferSwapRecord } from "../../src/client/record";
import type { CardMarketRef } from "../../src/client/quote";

export const priv = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
export const key = (fill: number): Uint8Array => schnorr.getPublicKey(priv(fill));
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program]);

export const HRP = "tark";
export const OPERATOR = key(3);
export const SOLVER = key(1);
export const PREIMAGE = new Uint8Array(32).fill(7);
export const PAYMENT_HASH = hex.encode(sha256(PREIMAGE));
export const PAYOUT = p2tr(key(5));

export const REFUND_LOCKTIME = 1_800_000_000;
/** Comfortably inside every window. */
export const BEFORE = REFUND_LOCKTIME - 3600;
/** Past the refund window, and past the MTP lag the manager gives up at. */
export const AFTER = REFUND_LOCKTIME + 60;

/** `arkade -> lightning`: the trader funds it, so `refundLocktime` is theirs. */
export const SEND_LOCKUP = lightningSendContract({
    solverPubkey: SOLVER,
    operatorPubkey: OPERATOR,
    paymentHash: PAYMENT_HASH,
    refundLocktime: REFUND_LOCKTIME,
    claimDelay: 4096,
    emulatorPubkey: key(9),
    refundPkScript: PAYOUT,
    senderPubkey: key(13),
    receiverPkScript: p2tr(key(1)),
});

/** `lightning -> arkade`: the SAME covenant with the roles inverted — the
 * solver funds and the trader claims, so every non-claim leaf is the solver's. */
export const RECEIVE_LOCKUP = lightningReceiveContract({
    solverPubkey: SOLVER,
    refundLocktime: REFUND_LOCKTIME,
    operatorPubkey: OPERATOR,
    paymentHash: PAYMENT_HASH,
    claimDelay: 4096,
    emulatorPubkey: key(9),
    solverRefundPkScript: p2tr(key(1)),
    payoutPubkey: key(13),
    payoutPkScript: PAYOUT,
});

export const addressOf = (script: InstanceType<typeof VHTLC.ScriptV2>): string =>
    script.address(HRP, OPERATOR).encode();

export const WALLET_ADDRESS = new ArkAddress(OPERATOR, key(21), HRP).encode();

const MARKET: CardMarketRef = {
    kind: "card",
    key: "arkade:btc/lightning:btc",
    backend: "rfq",
    source: "https://registry.example/regtest.json",
    sourceType: "registry",
    solver: "frenchman",
    pair: "BTC/lightning:BTC",
    snapshot: { fetchedAt: 1_700_000_000_000, live: true, source: "live" },
};

/** A v2 corridor record, as `accept()` writes one. */
export const corridorRecord = (over: Partial<CorridorSwapRecord> = {}): CorridorSwapRecord => {
    const script = over.kind === "lightning_receive" ? RECEIVE_LOCKUP : SEND_LOCKUP;
    const receive = over.kind === "lightning_receive";
    return {
        id: "q1",
        family: "rfq",
        route: {
            give: receive
                ? {
                      corridor: "lightning",
                      asset: "lightning:btc",
                      instrument: {
                          kind: "invoice",
                          bolt11: "lnbcrt1",
                          paymentHash: PAYMENT_HASH,
                          expiresAt: REFUND_LOCKTIME,
                      },
                  }
                : { corridor: "arkade", asset: "arkade:btc", instrument: { kind: "wallet" } },
            take: receive
                ? { corridor: "arkade", asset: "arkade:btc", instrument: { kind: "wallet" } }
                : {
                      corridor: "lightning",
                      asset: "lightning:btc",
                      instrument: {
                          kind: "invoice",
                          bolt11: "lnbcrt1",
                          paymentHash: PAYMENT_HASH,
                          expiresAt: REFUND_LOCKTIME,
                      },
                  },
        },
        give: { asset: "arkade:btc", amount: "100000" },
        take: { asset: "lightning:btc", amount: "99000" },
        fee: { asset: "arkade:btc", amount: "1000" },
        market: MARKET,
        solver: hex.encode(SOLVER),
        expiresAt: REFUND_LOCKTIME,
        state: "pending",
        kind: "lightning_send",
        rfqId: "rfq-1",
        lockupAddress: addressOf(script),
        lockupPkScript: hex.encode(script.pkScript),
        lock: { hash: PAYMENT_HASH },
        refundLocktime: REFUND_LOCKTIME,
        profile: {
            signer: { signingDescriptor: "tr(deadbeef)" },
            hashlock: { preimageHex: hex.encode(PREIMAGE), paymentHash: PAYMENT_HASH },
            ...(receive ? { expectedAmount: 99_000, payoutAddress: WALLET_ADDRESS } : {}),
        },
        createdAt: 1_000,
        updatedAt: 1_000,
        ...over,
    } as CorridorSwapRecord;
};

/**
 * A real offer covenant and the funding transaction that carries its packet.
 *
 * Real, not a stub, because the offer half of the construction restore runs the
 * production scan: it reads the packet off the funding transaction's extension
 * and binds it to the deposit at the covenant's own script. A fixture that
 * short-circuited either would prove the wiring exists and nothing about
 * whether it can answer.
 */
const OFFER_BINDING: Omit<Offer, "swapPkScript"> = {
    wantAmount: 5_000n,
    wantAsset: asset.AssetId.fromString("f1".repeat(34)),
    makerPkScript: PAYOUT,
    makerPublicKey: key(22),
    emulatorPubkey: key(9),
};

export const OFFER: Offer = {
    ...OFFER_BINDING,
    swapPkScript: offerContract(OFFER_BINDING, OPERATOR).pkScript,
};

export const OFFER_SCRIPT = hex.encode(OFFER.swapPkScript);

/** The funding transaction: the covenant output plus the offer packet. */
export const offerFunding = (): { psbt: string; txid: string } => {
    const tx = new Transaction({ allowUnknownOutputs: true });
    tx.addInput({ txid: new Uint8Array(32), index: 0 });
    tx.addOutput({ script: OFFER.swapPkScript, amount: 100_000n });
    const ext = Extension.create([
        new UnknownPacket(OFFER_PACKET_TYPE, encodeOffer(OFFER)),
    ]).txOut();
    tx.addOutput({ script: ext.script, amount: ext.amount });
    return { psbt: base64.encode(tx.toPSBT()), txid: tx.id };
};

/** The deposit at the offer's script, in whatever state the scan should read. */
export const offerDeposit = (txid: string, state: string): FakeVtxo => ({
    txid,
    vout: 0,
    spentBy: "",
    script: OFFER_SCRIPT,
    value: 100_000,
    createdAt: new Date(1_700_000_000_000),
    virtualStatus: { state },
});

/** A v2 offer record. `offerHex` is never decoded by anything under test here —
 * only the watcher's spend classifier reads it, and these tests drive the
 * restore path instead. */
export const offerRecord = (over: Partial<OfferSwapRecord> = {}): OfferSwapRecord =>
    ({
        id: "o1",
        family: "offer",
        route: {
            give: { corridor: "arkade", asset: "arkade:btc", instrument: { kind: "wallet" } },
            take: { corridor: "arkade", asset: "arkade:usd", instrument: { kind: "wallet" } },
        },
        give: { asset: "arkade:btc", amount: "100000" },
        take: { asset: "arkade:usd", amount: "5000" },
        fee: { asset: "arkade:btc", amount: "1000" },
        market: { ...MARKET, backend: "feed" },
        expiresAt: REFUND_LOCKTIME,
        status: "pending",
        offerHex: "00",
        swapAddress: WALLET_ADDRESS,
        swapPkScript: OFFER_SCRIPT,
        createdAt: 1_000,
        updatedAt: 1_000,
        ...over,
    }) as OfferSwapRecord;

/** A contract registry that already holds the rows `accept()` would have
 * written, so a restore can read each lockup's covenant parameters back. */
export interface FakeContracts extends SwapContractRegistry {
    readonly rows: CreateContractParams[];
    readonly watchStates: [script: string, state: string][];
    emit(event: ContractEvent): void;
}

export const fakeContracts = (
    scripts: InstanceType<typeof VHTLC.ScriptV2>[] = [SEND_LOCKUP],
): FakeContracts => {
    const rows: CreateContractParams[] = scripts.map((script) => ({
        type: SWAP_LOCKUP_CONTRACT_TYPE,
        params: VHTLCV2ContractHandler.serializeParams(script.options),
        script: hex.encode(script.pkScript),
        address: addressOf(script),
        label: "Arkade RFQ swap lockup",
        metadata: { genericallySpendable: false, kind: SWAP_LOCKUP_CONTRACT_KIND },
    }));
    const watchStates: [string, string][] = [];
    const handlers = new Set<(event: ContractEvent) => void>();
    return {
        rows,
        watchStates,
        emit: (event: ContractEvent) => {
            for (const handler of handlers) handler(event);
        },
        createContract: async (row: CreateContractParams) => {
            if (!rows.some((r) => r.script === row.script)) rows.push(row);
            return { ...row, state: "active", createdAt: 0 } as never;
        },
        getContracts: async (filter?: { script?: string }) =>
            rows.filter((r) => filter?.script === undefined || r.script === filter.script) as never,
        setContractWatchState: async (script: string, state: string) => {
            watchStates.push([script, state]);
        },
        onContractEvent: (handler: (event: ContractEvent) => void) => {
            handlers.add(handler);
            return () => handlers.delete(handler);
        },
    } as unknown as FakeContracts;
};

/** An output at a lockup, as `findLockupVtxos` reads one. */
export interface FakeFunded {
    txid: string;
    vout: number;
    value: number;
    recoverable?: boolean;
}

/** An output as the fate read shapes one. */
export interface FakeVtxo {
    txid: string;
    vout: number;
    spentBy: string;
    arkTxId?: string;
    isSpent?: boolean;
    isUnrolled?: boolean;
    script?: string;
    value?: number;
    assets?: { assetId: string; amount: bigint }[];
    virtualStatus?: { state: string };
    createdAt?: Date;
}

export type FakeIndexer = LockupSpendIndexer & { vtxoCalls: number };

/**
 * A scripted indexer, typed against the production seam so a change to
 * `LockupSpendIndexer` breaks this at compile time.
 *
 * The filters are honoured rather than ignored: `findLockupVtxos` makes the
 * spendable and recoverable reads separately and merges them, so a fake that
 * answered the same set twice would report every output as both and hide the
 * dedup entirely.
 */
export const fakeIndexer = (
    state: {
        vtxos?: FakeVtxo[];
        funded?: FakeFunded[];
        txs?: { txid: string; psbt: string }[];
        fail?: boolean;
    } = {},
): FakeIndexer => {
    const indexer = {
        vtxoCalls: 0,
        async getVtxos(filter?: { spendableOnly?: boolean; recoverableOnly?: boolean }) {
            indexer.vtxoCalls += 1;
            if (state.fail) throw new Error("indexer unreachable");
            const funded = state.funded ?? [];
            if (filter?.spendableOnly) return { vtxos: funded.filter((v) => !v.recoverable) };
            if (filter?.recoverableOnly) return { vtxos: funded.filter((v) => v.recoverable) };
            return { vtxos: state.vtxos ?? [] };
        },
        async getVirtualTxs(txids: string[]) {
            const known = new Map((state.txs ?? []).map((tx) => [tx.txid, tx.psbt]));
            return { txs: txids.map((id) => known.get(id)).filter((psbt) => psbt !== undefined) };
        },
    };
    return indexer as unknown as FakeIndexer;
};

export interface FakeWallet {
    readonly wallet: IWallet;
    readonly contracts: FakeContracts;
    /** Every `recoverVtxos()` call. */
    readonly recoveries: number[];
}

export const fakeWallet = (
    over: {
        contracts?: FakeContracts;
        /** The signer `contractSigner` resolves a `tr(pubkey)` descriptor to.
         * Absent leaves the wallet unable to sign, which is what the refusal
         * paths need. */
        identity?: unknown;
        history?: { type: string; arkTxid: string; createdAt: number }[];
        recover?: () => Promise<string>;
        /** Omit the VTXO manager entirely, as a watch-only wallet would. */
        noVtxoManager?: boolean;
    } = {},
): FakeWallet => {
    const contracts = over.contracts ?? fakeContracts();
    const recoveries: number[] = [];
    const wallet = {
        ...(over.identity === undefined ? {} : { identity: over.identity }),
        getAddress: async () => WALLET_ADDRESS,
        getContractManager: async () => contracts,
        getArkadeReader: async () => ({ getVtxos: async () => ({ vtxos: [] }) }),
        getTransactionHistory: async () =>
            (over.history ?? []).map((tx) => ({
                type: tx.type,
                key: { arkTxid: tx.arkTxid, boardingTxid: "", commitmentTxid: "" },
                createdAt: tx.createdAt,
                amount: 0,
                settled: true,
            })),
        ...(over.noVtxoManager
            ? {}
            : {
                  getVtxoManager: async () => ({
                      recoverVtxos: async () => {
                          recoveries.push(recoveries.length);
                          return over.recover ? over.recover() : "ee".repeat(32);
                      },
                  }),
              }),
    } as unknown as IWallet;
    return { wallet, contracts, recoveries };
};

/**
 * A corridor set that answers only for `onchain`, which is the only corridor a
 * drive pass resolves. `chain: null` models the deliberate refusal — the case
 * whose whole point is that it must not become a construction failure.
 */
export const fakeCorridors = (
    over: { chain?: unknown | null; claim?: unknown } = {},
): (() => Promise<CorridorSet>) & { readonly resolved: string[] } => {
    const resolved: string[] = [];
    const set = {
        get: (corridor: string) => {
            resolved.push(corridor);
            if (corridor !== "onchain") return { deps: {} };
            if (over.chain === null) throw new Error("the onchain corridor has no chain source");
            return {
                deps: { chain: over.chain ?? {}, ...(over.claim ? { claim: over.claim } : {}) },
            };
        },
        claim: () => undefined,
    } as unknown as CorridorSet;
    return Object.assign(async () => set, { resolved });
};

/** The shipped in-memory store, so the bridge is exercised against the same
 * object `accept()` writes. */
export const memoryRepository = (): InMemoryAssetSwapRepository =>
    new InMemoryAssetSwapRepository();

/**
 * A `SwapOperator` double. `gate` holds `getInfo` open, which is what a refund
 * push awaits first — the only way to observe a pass while its money action is
 * still in flight.
 */
export const fakeOperator = (gate?: Promise<void>) =>
    ({
        getInfo: async () => {
            if (gate) await gate;
            return {};
        },
        submitTx: async () => ({}),
        finalizeTx: async () => {},
    }) as never;
