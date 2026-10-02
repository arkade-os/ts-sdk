/**
 * `accept()`: where value moves, and the one ordering it moves in.
 *
 * ```
 * QuoteExpired
 *   -> the record by quote id: return | resume | AcceptConflict
 *   -> InsufficientFunds                     [funding routes]
 *   -> derive the covenant and REGISTER its row
 *   -> persist the record and its secrets    <- throwing; nothing past here
 *                                               happens without it
 *   -> fund                                  [funding routes]
 *   -> write the funding txid                [funding routes, best effort]
 * ```
 *
 * **Persist-first is structural**: records are keyed on the client-minted quote id (not the
 * funding txid), so the record precedes funding on every route; `fundingTxid` is a later
 * best-effort write.
 *
 * **Registration precedes the persist**: the contract row is the only place a lockup's tree
 * parameters live, so a record without one is unrebuildable. The row is local, idempotent and
 * inert until funded, so a crash between the two leaves nothing at stake.
 *
 * **A funding route is one whose give instrument is the wallet's** — the instrument, never the
 * asset: a `lightning -> arkade` receive gives BTC via a third party's invoice, and branching on
 * the asset would refuse an empty-wallet receive.
 *
 * **Arming** via {@link AcceptInput.drive} happens after the record is durable and runs BEHIND
 * the return, so this call waits on no pass and no network read.
 */
import { hex } from "@scure/base";
import { asset, getAllNormalizedVtxos, type IWallet } from "@arkade-os/sdk";
import { createOffer, OFFER_PACKET_TYPE, registerDerivedOffer } from "../offer";
import { registerLockupContract } from "../lockupContract";
import { onchainSendProfile } from "../rfqCorridors";
import { rfqSecretsProfile } from "../rfqProfileParts";
import { BTC_ASSET_ID } from "../store";
import type { AssetSwapRepository } from "../repository";
import { assetPartOf, BTC_ASSET_PART } from "./assetId";
import { toDiscoveryLeg } from "./aliases";
import type { CorridorSet } from "./corridors/registry";
import type { SwapDrive } from "./drive";
import { recordOutcome } from "./outcome";
import { AcceptConflict, InsufficientFunds, MissingCorridorDep, QuoteExpired } from "./errors";
import { fromAtomicDecimal } from "./amount";
import { toSafeNumber } from "./rfqAmount";
import type { Quote, QuoteId } from "./quote";
import type { OfferPreparation } from "./quoteOffer";
import type { AssetRfqPreparation, CorridorRfqPreparation, RfqPreparation } from "./quoteRfq";
import {
    fundsFromWallet,
    recordArtifact,
    recordEndpoint,
    recordLeg,
    swapOf,
    type CorridorSwapRecord,
    type OfferSwapRecord,
    type RecordedInstrument,
    type Swap,
    type SwapRecord,
} from "./record";

/** What a quote derived, kept in memory for the accept that may follow. */
export type QuotePreparation = RfqPreparation | OfferPreparation;

/**
 * The per-quote safety lock. `accept` is idempotent only *sequentially*: two concurrent calls
 * would both read "unfunded" and both send. So the whole read/reconcile/register/fund sequence
 * is serialized by quote id, like NArk's `LockKeyAsync($"swap::{swapId}")`.
 *
 * A keyed promise chain: later calls wait rather than refuse, and the entry deletes itself when
 * the chain drains. Process-local; across clients sharing a repository, never-fund-twice rests
 * on reading the record *after* acquiring the lock.
 */
const acceptLocks = new Map<QuoteId, Promise<void>>();

const runSerialized = <T>(id: QuoteId, body: () => Promise<T>): Promise<T> => {
    const tail = acceptLocks.get(id) ?? Promise.resolve();
    const run = tail.then(body);
    // Settle-swallowed, so one accept's rejection never poisons the next one's tail.
    const marker: Promise<void> = run.then(
        () => undefined,
        () => undefined,
    );
    acceptLocks.set(id, marker);
    // Evict only when this run is still the tail: a later accept may already
    // have chained its own marker, and deleting that would reopen the gate.
    void marker.then(() => {
        if (acceptLocks.get(id) === marker) acceptLocks.delete(id);
    });
    return run;
};

export interface AcceptInput {
    readonly quote: Quote;
    readonly preparation?: QuotePreparation;
    readonly wallet: IWallet;
    readonly repository: AssetSwapRepository | undefined;
    readonly corridors: CorridorSet;
    /**
     * The drive, when the caller has one. It turns a record into the public {@link Swap} (only
     * the drive knows the live `outcome`) and ARMS the swap with the manager, behind the return.
     * Without one the answer is the record's projection and nothing is driven.
     */
    readonly drive?: SwapDrive;
    /** Unix seconds. */
    readonly now: number;
}

/**
 * The repository, or `MissingCorridorDep("arkade", "repository")`. Refused here rather than at
 * dep resolution: arkade is a leg of every route, and `quote()` needs no storage.
 */
const storageOf = (repository: AssetSwapRepository | undefined): AssetSwapRepository => {
    if (repository === undefined) {
        throw new MissingCorridorDep("arkade", "repository");
    }
    return repository;
};

/**
 * The fields on which a stored record and an incoming quote disagree (§3.2's list, as dotted
 * paths). Only **material** differences count: absent on both sides is agreement (a feed-priced
 * quote has no `solver`/`lock`). `fundingTxid` is never compared; its appearance is a benign
 * resume. Compared in the stored encoding, so amounts are one canonical decimal string.
 */
type RecordedFacts = {
    readonly "route.pair": string;
    readonly "give.asset": string;
    readonly "take.asset": string;
    readonly "give.amount": string;
    readonly "take.amount": string;
    readonly "give.instrument": RecordedInstrument;
    readonly "take.instrument": RecordedInstrument;
    readonly "lock.hash": string | undefined;
    readonly refundLocktime: string | undefined;
    readonly solver: string | undefined;
    readonly "market.source": string | undefined;
};

const sameRecordedInstrument = (a: RecordedInstrument, b: RecordedInstrument): boolean => {
    switch (a.kind) {
        case "wallet":
            return b.kind === "wallet";
        case "address":
            return b.kind === "address" && a.address === b.address;
        case "invoice":
            return (
                b.kind === "invoice" &&
                a.bolt11 === b.bolt11 &&
                a.paymentHash === b.paymentHash &&
                a.amount === b.amount &&
                a.expiresAt === b.expiresAt
            );
    }
};

export const conflictingFields = (record: SwapRecord, quote: Quote): string[] => {
    const incoming = recordedFacts(quote);
    const stored: RecordedFacts = {
        "route.pair": `${record.route.give.corridor}->${record.route.take.corridor}`,
        "give.asset": record.route.give.asset,
        "take.asset": record.route.take.asset,
        "give.amount": record.give.amount,
        "take.amount": record.take.amount,
        "give.instrument": record.route.give.instrument,
        "take.instrument": record.route.take.instrument,
        "lock.hash": record.family === "rfq" ? record.lock.hash : undefined,
        refundLocktime: record.family === "rfq" ? String(record.refundLocktime) : undefined,
        solver: record.solver,
        "market.source": marketSourceOf(record.market),
    };
    return (Object.keys(incoming) as (keyof RecordedFacts)[]).filter((field) => {
        if (field === "give.instrument" || field === "take.instrument") {
            return !sameRecordedInstrument(stored[field], incoming[field]);
        }

        const a = stored[field];
        const b = incoming[field];
        if (a === undefined && b === undefined) return false;
        return a !== b;
    });
};

/** The same facts off a `Quote`, in the record's own encoding. */
const recordedFacts = (quote: Quote): RecordedFacts => ({
    "route.pair": `${quote.route.give.corridor}->${quote.route.take.corridor}`,
    "give.asset": quote.route.give.asset as string,
    "take.asset": quote.route.take.asset as string,
    "give.amount": recordLeg(quote.give).amount as string,
    "take.amount": recordLeg(quote.take).amount as string,
    "give.instrument": recordEndpoint(quote.route.give).instrument,
    "take.instrument": recordEndpoint(quote.route.take).instrument,
    "lock.hash": quote.lock?.hash,
    refundLocktime: quote.refundLocktime === undefined ? undefined : String(quote.refundLocktime),
    solver: quote.solver,
    "market.source": marketSourceOf(quote.market),
});

/**
 * The registry a market came from: `CardMarketRef.source` (what the allowlist matches), not
 * `snapshot.registry`, which is absent on an injected snapshot.
 */
const marketSourceOf = (market: Quote["market"]): string | undefined =>
    market.kind === "card" ? market.source : undefined;

/**
 * The wallet can fund the give leg, or it cannot and nothing is written. Deliberately coarse:
 * a shortfall reported off `balance.available` is real, while `send`'s dust carrier and asset
 * sat credits are not modelled, since a false refusal is the failure that matters. A missed
 * shortfall surfaces as `send`'s throw after the persist, which the record survives.
 */
const assertFundable = async (wallet: IWallet, quote: Quote): Promise<void> => {
    const give = quote.give;
    const balance = await wallet.getBalance();
    // On the asset part: `arkade:…/slip44:0` and `bitcoin:…/slip44:0` are one coin.
    const available =
        assetPartOf(give.asset) === BTC_ASSET_PART
            ? BigInt(balance.available)
            : (balance.availableAssets.find((a) => give.asset.endsWith(a.assetId))?.amount ?? 0n);
    if (available < give.amount) {
        throw new InsufficientFunds(give.asset, give.amount, available);
    }
};

/**
 * The v2 record for an accepted quote, before anything is funded. One builder for both families,
 * so every field §3.2 compares is written in one place.
 */
const commonOf = (quote: Quote, now: number) => ({
    id: quote.id,
    route: {
        give: recordEndpoint(quote.route.give),
        take: recordEndpoint(quote.route.take),
    },
    give: recordLeg(quote.give),
    take: recordLeg(quote.take),
    fee: recordLeg(quote.fee),
    market: quote.market,
    ...(quote.solver === undefined ? {} : { solver: quote.solver }),
    expiresAt: quote.expiresAt,
    ...(quote.artifact === undefined ? {} : { artifact: recordArtifact(quote.artifact) }),
    createdAt: now,
    updatedAt: now,
});

/** The corridor record: the lockup, its clocks, its secrets and its profile. */
const corridorRecord = (
    quote: Quote,
    preparation: CorridorRfqPreparation,
    now: number,
): CorridorSwapRecord => {
    if (quote.lock === undefined || quote.refundLocktime === undefined) {
        // Unreachable from `quote()` (verification refuses it); keeps the fields below uncast.
        throw new Error(`corridor quote ${quote.id} carries no lock hash or refund locktime`);
    }
    return {
        ...commonOf(quote, now),
        family: "rfq",
        state: "pending",
        kind: KIND_OF[preparation.route],
        rfqId: preparation.rfqId,
        lockupAddress: preparation.lockup.address,
        lockupPkScript: hex.encode(preparation.lockup.pkScript),
        lock: { hash: quote.lock.hash },
        refundLocktime: quote.refundLocktime,
        profile: profileOf(preparation, quote.lock.hash),
    };
};

/** The manager's own vocabulary for this route — a route pair, not a corridor. */
const KIND_OF = {
    "arkade->lightning": "lightning_send",
    "lightning->arkade": "lightning_receive",
    "arkade->onchain": "onchain_send",
} as const satisfies Record<CorridorRfqPreparation["route"], CorridorSwapRecord["kind"]>;

/**
 * The corridor's opaque half, written through the corridor-owned builders. `rfqSecretsProfile`,
 * not hand-listed fields, so `preimageSaltHex` cannot be dropped from `hashlock`.
 */
const profileOf = (
    preparation: CorridorRfqPreparation,
    paymentHash: string,
): Record<string, unknown> => {
    const secrets = rfqSecretsProfile(preparation.secrets, paymentHash);
    switch (preparation.route) {
        case "arkade->lightning":
            return { ...secrets };
        case "lightning->arkade":
            return {
                ...secrets,
                expectedAmount: toSafeNumber(preparation.expectedAmount, "expectedAmount"),
                payoutAddress: preparation.payoutAddress,
            };
        case "arkade->onchain":
            return {
                ...secrets,
                ...onchainSendProfile({
                    htlc: preparation.htlc,
                    htlcParams: preparation.htlcParams,
                    l1Network: preparation.l1Network,
                    minConfirmations: preparation.minConfirmations,
                    expectedAmount: toSafeNumber(preparation.expectedAmount, "expectedAmount"),
                    payoutPkScript: preparation.payoutPkScript,
                }),
            };
    }
};

/**
 * Accept a quote: make it durable, then move the value.
 *
 * Idempotent by quote id and only by quote id. A second call with the same
 * quote returns the stored swap when the funding txid is already known, resumes
 * the record when it is not, and refuses as `AcceptConflict` only when the
 * durable evidence contradicts the quote on a material field.
 */
export const acceptQuote = async (input: AcceptInput): Promise<Swap> =>
    runSerialized(input.quote.id, () => acceptQuoteBody(input));

const acceptQuoteBody = async (input: AcceptInput): Promise<Swap> => {
    const { quote, wallet, now } = input;
    const repository = storageOf(input.repository);
    const answer = (record: SwapRecord): Swap =>
        input.drive ? input.drive.adopt(record) : swapOf(record, recordOutcome(record));

    const expired = now > quote.expiresAt;

    const stored = await repository.getSwapRecord(quote.id);
    if (stored !== undefined) {
        const fields = conflictingFields(stored, quote);
        if (fields.length > 0) {
            throw new AcceptConflict(quote.id, stored.id, fields);
        }
        // Already funded (or nothing to fund): answer off the record, so a duplicate receive
        // returns the stored invoice, not the caller's quote object's.
        if (stored.fundingTxid !== undefined) return answer(stored);
        if (!fundsFromWallet(stored.route)) return answer(stored);
        // Persisted but unfunded: look for a crashed first attempt's deposit before sending
        // again. Uses the stored record only, so it survives a restart.
        const found = await reconcileFunding({ wallet }, stored);
        if (found !== undefined) {
            return answer(await stampFunding(repository, stored, found, now));
        }
        // No funding evidence: retrying moves new value, so the deadline still applies.
        if (expired) throw new QuoteExpired(quote.id, quote.expiresAt, now);
        return answer(await fundAndStamp({ wallet, now }, stored, repository));
    }

    // Its own deadline only, not `policy.quoteTtlFloorSeconds`: that floor is the quote path's
    // question, and would refuse a quote §3.2 still accepts.
    if (expired) throw new QuoteExpired(quote.id, quote.expiresAt, now);

    const preparation = input.preparation;
    if (preparation === undefined) {
        // The verified derivation is gone and no record exists; re-deriving would give one
        // covenant two sources.
        throw new Error(
            `quote ${quote.id} was not derived by this client instance; re-quote before accepting`,
        );
    }

    const funds = fundsFromWallet(quote.route);
    if (funds) await assertFundable(wallet, quote);

    const record =
        preparation.backend === "feed"
            ? await registeredOfferRecord(input, preparation)
            : preparation.route === "arkade->arkade"
              ? await registeredAssetRecord(input, preparation)
              : await registeredCorridorRecord(input, preparation);

    // Throwing, deliberately: nothing past this line may happen unless the record is durable.
    await repository.saveSwapRecord(record);

    if (!funds) return answer(record);
    return answer(await fundAndStamp({ wallet, now }, record, repository));
};

/** The offer covenant, derived and registered by `createOffer`, and the record keeping its TLV. */
const registeredOfferRecord = async (
    input: AcceptInput,
    preparation: OfferPreparation,
): Promise<OfferSwapRecord> => {
    const { quote, wallet, corridors, now } = input;
    const { plan } = preparation;
    const arkade = corridors.get("arkade").deps;
    const receiveIsBtc = plan.receive.asset.id === BTC_ASSET_ID;
    const offer = await createOffer(wallet, {
        // Keyed on the receive side: the covenant binds what the fill delivers.
        wantAmount: plan.receive.atomic,
        ...(receiveIsBtc
            ? { offerAsset: asset.AssetId.fromString(plan.deposit.asset.id) }
            : { wantAsset: asset.AssetId.fromString(plan.receive.asset.id) }),
        emulatorPubkey: arkade.emulatorPubkey,
    });
    return {
        ...commonOf(quote, now),
        family: "offer",
        status: "pending",
        offerHex: offer.offerHex,
        swapAddress: offer.address,
        swapPkScript: hex.encode(offer.swapPkScript),
    };
};

/**
 * A negotiated asset swap's covenant, registered, and the record that describes
 * it.
 *
 * The record is an `offer` record, identical in family to the feed-priced one:
 * what differed was how the terms were reached, and the terms are already on the
 * quote by the time this runs. Everything downstream — cancel, the restore scan,
 * the classifier, the drive — therefore needs no arm of its own for this route.
 *
 * What registers is the derivation the quote was verified against, not a second
 * one built from the same terms: `createOffer` would re-derive, and two
 * derivations that can disagree is the failure the preparation hand-off exists
 * to delete.
 */
const registeredAssetRecord = async (
    input: AcceptInput,
    preparation: AssetRfqPreparation,
): Promise<OfferSwapRecord> => {
    await registerDerivedOffer(input.wallet, preparation.offer);
    return {
        ...commonOf(input.quote, input.now),
        family: "offer",
        status: "pending",
        offerHex: preparation.offer.offerHex,
        swapAddress: preparation.offer.address,
        swapPkScript: hex.encode(preparation.offer.swapPkScript),
        ...(preparation.carrierSats === undefined
            ? {}
            : { carrierSats: preparation.carrierSats.toString() }),
    };
};

/** The lockup's contract row, then the record that names it. */
const registeredCorridorRecord = async (
    input: AcceptInput,
    preparation: CorridorRfqPreparation,
): Promise<CorridorSwapRecord> => {
    const contracts = await input.wallet.getContractManager();
    await registerLockupContract(contracts, preparation.lockup.script, preparation.lockup.address);
    return corridorRecord(input.quote, preparation, input.now);
};

/**
 * Fund the give leg, then stamp the txid. The stamp is best effort: the money has moved, so
 * failing would misreport a broadcast swap. `reconcileFunding` recovers a lost stamp.
 */
type FundingInput = Pick<AcceptInput, "wallet" | "now">;

const fundAndStamp = async (
    input: FundingInput,
    record: SwapRecord,
    repository: AssetSwapRepository,
): Promise<SwapRecord> => {
    const txid = await fund(input, record);
    return stampFunding(repository, record, txid, input.now);
};

const stampFunding = async (
    repository: AssetSwapRepository,
    record: SwapRecord,
    fundingTxid: string,
    now: number,
): Promise<SwapRecord> => {
    const stamped = { ...record, fundingTxid, updatedAt: now } as SwapRecord;
    try {
        await repository.saveSwapRecord(stamped);
    } catch (error) {
        console.warn(`[swap] funded ${record.id} but could not store its txid`, error);
    }
    return stamped;
};

/**
 * The `wallet.send` each funding route makes. The recipient object goes **straight** to `send`:
 * `send` reads `extensions` off its raw arguments, so reassembling it would silently drop the
 * offer packet and land the deposit at a covenant no solver can see.
 */
const fund = async (input: FundingInput, record: SwapRecord): Promise<string> => {
    const { wallet } = input;
    if (record.family === "offer") {
        const amount = fromAtomicDecimal(record.give.amount);
        const depositIsBtc = assetPartOf(record.route.give.asset) === BTC_ASSET_PART;
        return wallet.send({
            address: record.swapAddress,
            // An asset deposit rides a dust-sat carrier: the solver's published one when the record
            // names it (the fill is priced against it), else the SDK default.
            ...(depositIsBtc
                ? { amount: toSafeNumber(amount, "give.amount") }
                : {
                      ...(record.carrierSats === undefined
                          ? {}
                          : { amount: toSafeNumber(BigInt(record.carrierSats), "carrierSats") }),
                      assets: [
                          { assetId: toDiscoveryLeg(record.route.give.asset).assetId, amount },
                      ],
                  }),
            extensions: [offerExtensionOf(record)],
        });
    }
    if (record.kind === "lightning_receive") {
        // Unreachable (callers gate on `fundsFromWallet`); keeps the union exhaustive.
        throw new Error(`receive swap ${record.id} funds nothing from this wallet`);
    }
    // The record's give amount: quote-time verification proved it equals the negotiated funding.
    return wallet.send({
        address: record.lockupAddress,
        amount: toSafeNumber(fromAtomicDecimal(record.give.amount), "give.amount"),
    });
};

/**
 * The offer packet, rebuilt from the record's own TLV, so a resumed funding attaches exactly
 * what the *stored* covenant commits to.
 */
const offerExtensionOf = (record: OfferSwapRecord): { type: number; payload: Uint8Array } => ({
    type: OFFER_PACKET_TYPE,
    payload: hex.decode(record.offerHex),
});

/**
 * The deposit a crashed accept may already have made (sent, then died before stamping the txid);
 * a blind retry would fund the covenant twice.
 *
 * Matched by script, then amount: identical offers share one address, and only the record
 * carries the deposited amount. A VTXO matching no amount is left alone — adopting it would
 * attach a deposit to the wrong swap and double-fund the right one.
 */
const reconcileFunding = async (
    input: Pick<AcceptInput, "wallet">,
    record: SwapRecord,
): Promise<string | undefined> => {
    const script = record.family === "offer" ? record.swapPkScript : record.lockupPkScript;
    const expected = BigInt(record.give.amount);
    const reader = await input.wallet.getArkadeReader();
    // Not the reader's paged `getVtxos`: a missed page would read as "no deposit" and double-fund.
    const vtxos = await getAllNormalizedVtxos(reader, [script]);
    const deposit = vtxos.find((vtxo) => depositMatches(vtxo, record, expected));
    return deposit?.txid;
};

/**
 * Whether this VTXO is the deposit the record describes: BTC compares `value`; an asset compares
 * its asset entry, since `value` there is only the dust carrier.
 */
const depositMatches = (
    vtxo: { value: number; assets?: readonly { assetId: string; amount: bigint }[] },
    record: SwapRecord,
    expected: bigint,
): boolean => {
    const giveAsset = record.route.give.asset;
    if (assetPartOf(giveAsset) === BTC_ASSET_PART) {
        return BigInt(vtxo.value) === expected;
    }
    return (vtxo.assets ?? []).some(
        (entry) => giveAsset.endsWith(entry.assetId) && entry.amount === expected,
    );
};

/** The stored record for a quote id, for a caller that holds only the id. */
export const swapRecordOf = async (
    repository: AssetSwapRepository | undefined,
    id: QuoteId,
): Promise<SwapRecord | undefined> => storageOf(repository).getSwapRecord(id);
