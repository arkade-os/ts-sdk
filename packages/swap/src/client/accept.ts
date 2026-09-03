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
 * **Persist-first is a mechanism here, not an instruction.** v1 wrote the rule
 * down in a README and could not keep it: `AssetSwap.id` *is* the funding txid,
 * so on the spot route the record could not exist before the money did, and the
 * e2e ran the opposite order because it had to. Keying on the client-minted
 * quote id is what makes the record precede the funding on every route, with
 * `fundingTxid` a later best-effort write.
 *
 * **Registration is part of the ordering, before the persist.** The quote path
 * deliberately registers nothing — it derives a covenant and discloses nothing
 * durable — but a lockup's contract row is the only place its tree parameters
 * live, and a rebuild reads them from there. So a record persisted without one
 * is unrebuildable. Registering first buys the invariant that *a persisted
 * record always has its covenant row*; the row is local, idempotent
 * (first-writer-wins) and inert until funded, so a crash between the two leaves
 * nothing at stake — which is the same argument `createOffer` already makes for
 * registering before funding rather than after.
 *
 * **A funding route is one whose give instrument is the wallet's.** On
 * `lightning -> arkade` the give leg is the hold invoice a third party pays, so
 * the pipeline ends at the persist: nothing is pre-flighted and nothing is sent.
 * The discriminant is the instrument and never the asset — a receive gives BTC
 * too, and branching on the asset would refuse the canonical empty-wallet
 * receive for want of a balance it never spends.
 *
 * What does NOT happen here: arming. The drive loop, the watcher and the
 * outcome vocabulary are the next milestone's, and this one stops once the
 * record is durable. A receive route therefore hands back a durable invoice
 * that nothing is yet watching.
 */
import { hex } from "@scure/base";
import { asset, getAllNormalizedVtxos, type IWallet } from "@arkade-os/sdk";
import { createOffer, OFFER_PACKET_TYPE } from "../offer";
import { registerLockupContract } from "../lockupContract";
import { onchainSendProfile } from "../rfqCorridors";
import { rfqSecretsProfile } from "../rfqProfileParts";
import { BTC_ASSET_ID } from "../store";
import type { AssetSwapRepository } from "../repository";
import { assetPartOf, BTC_ASSET_PART } from "./assetId";
import type { CorridorSet } from "./corridors/registry";
import { AcceptConflict, InsufficientFunds, MissingCorridorDep, QuoteExpired } from "./errors";
import { fromAtomicDecimal } from "./amount";
import { toSafeNumber } from "./rfqAmount";
import type { Quote, QuoteId } from "./quote";
import type { OfferPreparation } from "./quoteOffer";
import type { RfqPreparation } from "./quoteRfq";
import {
    fundsFromWallet,
    recordArtifact,
    recordEndpoint,
    recordLeg,
    swapOf,
    type CorridorSwapRecord,
    type OfferSwapRecord,
    type Swap,
    type SwapRecord,
} from "./record";

/** What a quote derived, kept in memory for the accept that may follow. */
export type QuotePreparation = RfqPreparation | OfferPreparation;

export interface AcceptInput {
    readonly quote: Quote;
    readonly preparation: QuotePreparation;
    readonly wallet: IWallet;
    readonly repository: AssetSwapRepository | undefined;
    readonly corridors: CorridorSet;
    /** Unix seconds. */
    readonly now: number;
}

/**
 * The repository, or the refusal that names it.
 *
 * `MissingCorridorDep("arkade", "repository")` rather than a bare `Error`: the
 * arkade corridor declares the repository as its one overridable dep, described
 * in the override matrix as "where persist-first lands", and this is the call
 * that lands it. Refused here rather than at dep resolution because the arkade
 * module is a leg of every route, so a required dep would mean a client with no
 * storage could not even `quote()` — and quoting persists nothing.
 */
const storageOf = (repository: AssetSwapRepository | undefined): AssetSwapRepository => {
    if (repository === undefined) {
        throw new MissingCorridorDep("arkade", "repository");
    }
    return repository;
};

/**
 * The fields on which a stored record and an incoming quote disagree.
 *
 * §3.2's list, spelled as dotted paths so the message names a field rather than
 * a concept: route pair, both assets and amounts, both instruments, the lock
 * hash, `refundLocktime`, the solver and the registry.
 *
 * Two rules from the spec, both load-bearing. Only **material** differences
 * count, so a field absent on both sides never conflicts — which is what keeps
 * a feed-priced quote, whose `solver` and `lock` are absent by construction,
 * from conflicting with its own record. And `fundingTxid` is not compared at
 * all: it appearing where there was none is the benign resume, named as such.
 *
 * The comparison runs over the record's *stored* form rather than over a
 * rehydrated `Swap`, so an amount is compared as the canonical decimal string
 * both sides encode to. That is one comparison of one representation, instead
 * of a `bigint` round trip that could differ only by how it was parsed.
 */
export const conflictingFields = (record: SwapRecord, quote: Quote): string[] => {
    const incoming = recordedFacts(quote);
    const stored = {
        "route.pair": `${record.route.give.corridor}->${record.route.take.corridor}`,
        "give.asset": record.route.give.asset,
        "take.asset": record.route.take.asset,
        "give.amount": record.give.amount,
        "take.amount": record.take.amount,
        "give.instrument": JSON.stringify(record.route.give.instrument),
        "take.instrument": JSON.stringify(record.route.take.instrument),
        "lock.hash": record.family === "rfq" ? record.lock.hash : undefined,
        refundLocktime: record.family === "rfq" ? String(record.refundLocktime) : undefined,
        solver: record.solver,
        "market.source": marketSourceOf(record.market),
    };
    return Object.keys(incoming).filter((field) => {
        const a = stored[field as keyof typeof stored];
        const b = incoming[field as keyof typeof incoming];
        // Absent on both sides is agreement, not a difference: it is how a
        // feed-priced quote's missing solver and lock hash read.
        if (a === undefined && b === undefined) return false;
        return a !== b;
    });
};

/** The same facts off a `Quote`, in the record's own encoding. */
const recordedFacts = (quote: Quote) => ({
    "route.pair": `${quote.route.give.corridor}->${quote.route.take.corridor}`,
    "give.asset": quote.route.give.asset as string,
    "take.asset": quote.route.take.asset as string,
    "give.amount": recordLeg(quote.give).amount as string,
    "take.amount": recordLeg(quote.take).amount as string,
    "give.instrument": JSON.stringify(recordEndpoint(quote.route.give).instrument),
    "take.instrument": JSON.stringify(recordEndpoint(quote.route.take).instrument),
    "lock.hash": quote.lock?.hash,
    refundLocktime: quote.refundLocktime === undefined ? undefined : String(quote.refundLocktime),
    solver: quote.solver,
    "market.source": marketSourceOf(quote.market),
});

/**
 * The registry a market came from.
 *
 * `CardMarketRef.source` and not `snapshot.registry`: `source` is the field the
 * policy allowlist already matches on and the one a locally pinned card carries
 * a label in, while `snapshot.registry` is absent on an injected snapshot. The
 * auction arm has no source at all, which reads as "absent on both sides" and
 * therefore never conflicts.
 */
const marketSourceOf = (market: Quote["market"]): string | undefined =>
    market.kind === "card" ? market.source : undefined;

/**
 * The wallet can fund the give leg, or it cannot and nothing is written.
 *
 * Runs only on a funding route, and deliberately coarse: `balance.available` is
 * documented as what generic selection would pick, "so nothing counted here can
 * be refused by `send`", which makes a shortfall it reports real. What it does
 * NOT model is the other direction — `send`'s dust carrier, and the sats it
 * credits back off selected asset coins — because a false refusal is the one
 * failure that matters here. A shortfall this misses surfaces as `send`'s own
 * throw, after the persist, and the record survives that.
 */
const assertFundable = async (wallet: IWallet, quote: Quote): Promise<void> => {
    const give = quote.give;
    const balance = await wallet.getBalance();
    // On the asset part, not the whole id: the rail differs per corridor —
    // `arkade:…/slip44:0` and `bitcoin:…/slip44:0` are one coin — and it is the
    // part that says *which asset* rather than *on which rail*.
    if (assetPartOf(give.asset) === BTC_ASSET_PART) {
        const available = BigInt(balance.available);
        if (available < give.amount) {
            throw new InsufficientFunds(give.asset, give.amount, available);
        }
        return;
    }
    const held = balance.availableAssets.find((a) => give.asset.endsWith(a.assetId));
    const available = held?.amount ?? 0n;
    if (available < give.amount) {
        throw new InsufficientFunds(give.asset, give.amount, available);
    }
};

/**
 * The v2 record for an accepted quote, before anything is funded.
 *
 * One builder for both families so the common half cannot drift between them —
 * every field §3.2 compares is written in one place, which is what makes "the
 * compared field is durable" a property of the type rather than a review note.
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
    preparation: RfqPreparation,
    now: number,
): CorridorSwapRecord => {
    if (quote.lock === undefined || quote.refundLocktime === undefined) {
        // Unreachable from `quote()`: every corridor route refuses a reply
        // without both, in verification. Stated so the record's non-optional
        // fields are not an unchecked cast.
        throw new Error(`corridor quote ${quote.id} carries no lock hash or refund locktime`);
    }
    return {
        ...commonOf(quote, now),
        family: "rfq",
        state: "pending",
        kind: kindOf(preparation),
        rfqId: preparation.rfqId,
        lockupAddress: preparation.lockup.address,
        lockupPkScript: hex.encode(preparation.lockup.pkScript),
        lock: { hash: quote.lock.hash },
        refundLocktime: quote.refundLocktime,
        profile: profileOf(preparation, quote.lock.hash),
    };
};

/** The manager's own vocabulary for this route — a route pair, not a corridor. */
const kindOf = (preparation: RfqPreparation): CorridorSwapRecord["kind"] => {
    switch (preparation.route) {
        case "arkade->lightning":
            return "lightning_send";
        case "lightning->arkade":
            return "lightning_receive";
        case "arkade->onchain":
            return "onchain_send";
    }
};

/**
 * The corridor's opaque half, written through the corridor-owned builders.
 *
 * `rfqSecretsProfile` rather than hand-listed fields: it splits the provisioned
 * secret so `preimageSaltHex` rides into `hashlock` with the rest of the
 * preimage material, and hand-listing is exactly how that field was lost
 * before. The at-most-one-of `preimageHex`/`preimageSaltHex` rule comes with
 * it, since the provisioning result is what decides which arm exists.
 */
const profileOf = (preparation: RfqPreparation, paymentHash: string): Record<string, unknown> => {
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
export const acceptQuote = async (input: AcceptInput): Promise<Swap> => {
    const { quote, preparation, wallet, now } = input;
    const repository = storageOf(input.repository);

    // Strictly past its own deadline, and not against `policy.quoteTtlFloor`:
    // the floor is the quote path's question — "is there enough life left in
    // these terms to be worth showing" — and inheriting it here would refuse a
    // quote §3.2 still considers acceptable.
    if (now > quote.expiresAt) {
        throw new QuoteExpired(quote.id, quote.expiresAt, now);
    }

    const stored = await repository.getSwapRecord(quote.id);
    if (stored !== undefined) {
        const fields = conflictingFields(stored, quote);
        if (fields.length > 0) {
            throw new AcceptConflict(quote.id, stored.id, fields);
        }
        // The record is this quote's, and its funding already happened: the
        // whole call is a no-op and the answer comes off the record, artifact
        // included. A duplicate receive accept therefore returns the invoice
        // that was stored rather than the one on whatever quote object the
        // caller still holds.
        if (stored.fundingTxid !== undefined) return swapOf(stored);
        if (!fundsFromWallet(stored.route)) return swapOf(stored);
        // Persisted but unfunded. Before a second `wallet.send`, look for the
        // deposit a crashed first attempt may already have made.
        const found = await reconcileFunding(input, stored);
        if (found !== undefined) {
            return swapOf(await stampFunding(repository, stored, found, now));
        }
        return swapOf(await fundAndStamp(input, stored, repository));
    }

    const funds = fundsFromWallet(quote.route);
    if (funds) await assertFundable(wallet, quote);

    // Derive-and-register, then persist. Both families register before the
    // record exists, which is what makes a stored record always rebuildable.
    const record =
        preparation.backend === "feed"
            ? await registeredOfferRecord(input, preparation)
            : await registeredCorridorRecord(input, preparation);

    // Throwing, deliberately: nothing past this line may happen if the record
    // is not durable, and that is the whole invariant.
    await repository.saveSwapRecord(record);

    if (!funds) return swapOf(record);
    return swapOf(await fundAndStamp(input, record, repository));
};

/**
 * The offer covenant, registered, and the record that describes it.
 *
 * `createOffer` derives and registers in one call — the contract row and the
 * process-local issuance mark are both written inside it — so on this route
 * "derive and register" is one step and the offer TLV is what the record keeps.
 */
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

/** The lockup's contract row, then the record that names it. */
const registeredCorridorRecord = async (
    input: AcceptInput,
    preparation: RfqPreparation,
): Promise<CorridorSwapRecord> => {
    const contracts = await input.wallet.getContractManager();
    await registerLockupContract(contracts, preparation.lockup.script, preparation.lockup.address);
    return corridorRecord(input.quote, preparation, input.now);
};

/**
 * Fund the give leg, then stamp the txid.
 *
 * The stamp is best effort by design: the money has moved, and failing the
 * caller here would report as failed a swap whose funding is already broadcast.
 * What recovers a lost stamp is the reconcile above, which finds the deposit
 * from chain evidence on the next accept.
 */
const fundAndStamp = async (
    input: AcceptInput,
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
 * The `wallet.send` each funding route makes.
 *
 * The recipient object is passed **straight** to `send`, never rebuilt or
 * normalised on the way: `send` re-reads `extensions` off its own raw arguments
 * rather than off the validated recipients, so a helper that reassembled the
 * list would drop the offer packet — silently, since omitting it throws
 * nowhere and merely lands the deposit at a covenant no solver can see. That
 * silent loss is the failure this route's packet handling exists to delete.
 */
const fund = async (input: AcceptInput, record: SwapRecord): Promise<string> => {
    const { wallet, preparation } = input;
    if (record.family === "offer") {
        if (preparation.backend !== "feed") {
            throw new Error(
                `offer record ${record.id} accepted with an ${preparation.backend} quote`,
            );
        }
        const { plan } = preparation;
        const depositIsBtc = plan.deposit.asset.id === BTC_ASSET_ID;
        // The amount comes off the RECORD, not the plan: v1 made a caller read
        // a `fundAmount` field beside the amount they quoted, and v2 has no
        // such field because the quote's own give amount is what accept funds.
        // The plan is still what spells the asset id, which only it carries.
        const amount = fromAtomicDecimal(record.give.amount);
        return wallet.send({
            address: record.swapAddress,
            // An asset deposit rides the SDK's dust-sat carrier, so the sats
            // amount is left to the default rather than set here.
            ...(depositIsBtc
                ? { amount: toSafeNumber(amount, "give.amount") }
                : { assets: [{ assetId: plan.deposit.asset.id, amount }] }),
            extensions: [offerExtensionOf(record)],
        });
    }
    if (preparation.backend !== "rfq") {
        throw new Error(
            `corridor record ${record.id} accepted with an ${preparation.backend} quote`,
        );
    }
    if (preparation.route === "lightning->arkade") {
        // Unreachable: the caller gates on `fundsFromWallet`, and a receive's
        // give instrument is the invoice. Stated so the union is exhaustive
        // rather than narrowed by an assumption.
        throw new Error(`receive swap ${record.id} funds nothing from this wallet`);
    }
    // Again the record's own give amount, which `verifyQuotedAmount` already
    // proved equal to the preparation's `fundAmount` at quote time. One source
    // means the resume path funds the same number the first attempt would have.
    return wallet.send({
        address: record.lockupAddress,
        amount: toSafeNumber(fromAtomicDecimal(record.give.amount), "give.amount"),
    });
};

/**
 * The offer packet, rebuilt from the record's own TLV.
 *
 * Rebuilt from the record rather than carried through from `createOffer`'s
 * return, so the packet a resumed funding attaches is the one the *stored*
 * covenant commits to rather than a second value that could drift from it. The
 * TLV is the covenant, so re-encoding it is not a second derivation.
 */
const offerExtensionOf = (record: OfferSwapRecord): { type: number; payload: Uint8Array } => ({
    type: OFFER_PACKET_TYPE,
    payload: hex.decode(record.offerHex),
});

/**
 * The deposit a crashed accept may already have made, found from evidence.
 *
 * The window this closes: the record is durable, `wallet.send` was called, and
 * the process died before the txid was written. A blind retry would fund the
 * same covenant twice.
 *
 * Matching is by script, then by amount, because the script alone is not unique
 * — identical offers derive one address, and `createContract` is
 * first-writer-wins precisely so nothing per-swap is written against it. What
 * disambiguates is the deposited amount, which only the record carries: the
 * covenant binds what the fill must *deliver*, never what was deposited.
 *
 * A VTXO at the script that matches no record's amount is left alone rather
 * than adopted into a guess: adopting it would attach a deposit to the wrong
 * swap, and the swap it really belongs to would then be funded twice.
 */
const reconcileFunding = async (
    input: AcceptInput,
    record: SwapRecord,
): Promise<string | undefined> => {
    const script = record.family === "offer" ? record.swapPkScript : record.lockupPkScript;
    const expected = BigInt(record.give.amount);
    const reader = await input.wallet.getArkadeReader();
    // `getAllNormalizedVtxos` rather than the reader's own `getVtxos`: that one
    // is a single logical query whose paging is the caller's to follow, and a
    // missed page here would read as "no deposit" and fund the covenant twice.
    const vtxos = await getAllNormalizedVtxos(reader, [script]);
    const deposit = vtxos.find((vtxo) => depositMatches(vtxo, record, expected));
    return deposit?.txid;
};

/**
 * Whether this VTXO is the deposit the record describes.
 *
 * The give leg decides which figure to compare: a BTC give leg is the VTXO's
 * own value, while an asset give leg rides the dust-sat carrier and the amount
 * lives on the asset entry, so comparing `value` there would test the carrier
 * rather than the deposit.
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
