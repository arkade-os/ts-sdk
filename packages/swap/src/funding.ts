import { hex } from "@scure/base";
import {
    ArkAddress,
    RestArkProvider,
    RestIndexerProvider,
    SendDeadlineExceededError,
    asset,
    getNetwork,
    selectCoinsWithAsset,
    selectVirtualCoins,
    toXOnlySignerHex,
    type IWallet,
    type NetworkName,
    type NormalizedExtendedVirtualCoin,
} from "@arkade-os/sdk";
import { hasBoundFunding } from "./fundingPersistence";
import { checkFundingOutput, type FundingOutputCheck } from "./fundingRecovery";
import { decodeOffer, OFFER_PACKET_TYPE, offerVtxoScript, registerOfferContract } from "./offer";
import type { AssetSwapRepository } from "./repository";
import { canonicalAssetAmount } from "./rfq";
import { BTC_ASSET_ID, type AssetSwap } from "./store";

export interface FundingExpiryFloor {
    kind: "height" | "time";
    value: bigint;
}

export interface FundOfferParams {
    repository: AssetSwapRepository;
    offerHex: string;
    deposit: {
        amount: bigint | number | string;
        assetId?: string;
        carrierSats?: bigint | number | string;
    };
    id?: string;
    validUntil?: number;
    inputExpiryFloor?: FundingExpiryFloor;
    prepareNew?: (swap: AssetSwap) => AssetSwap | Promise<AssetSwap>;
}

/**
 * The outcome is unknown and **the reservation is still held**: never abandon
 * on this error, only let `restoreAssetSwapRepository` resolve it from chain
 * evidence. The provably-unsent case raises `SendDeadlineExceededError`.
 */
export class FundingOutcomeUnknownError extends Error {
    override readonly name = "FundingOutcomeUnknownError";

    constructor(
        readonly operationId: string,
        readonly fundingTxid: string | undefined,
        cause: unknown,
    ) {
        super(
            fundingTxid
                ? `funding ${operationId} returned ${fundingTxid} but could not be bound durably`
                : `funding ${operationId} entered send but its outcome is unknown`,
            { cause },
        );
    }
}

/**
 * An unfunded operation: `prepared` is a reservation still owned by whoever
 * made it, `abandoned` is terminal and needs a new id.
 */
export class FundingNotCompletedError extends Error {
    override readonly name = "FundingNotCompletedError";

    constructor(
        readonly operationId: string,
        readonly state: "prepared" | "abandoned",
    ) {
        super(
            state === "prepared"
                ? `funding operation ${operationId} is still preparing under its own caller`
                : `funding operation ${operationId} was abandoned before send`,
        );
    }
}

export class FundingOutputMismatchError extends Error {
    override readonly name = "FundingOutputMismatchError";

    constructor(
        readonly operationId: string,
        readonly fundingTxid: string,
    ) {
        super(
            `funding ${operationId} sent ${fundingTxid}, which does not carry the intended covenant output`,
        );
    }
}

// The SDK's own `getDustAmount` probe minus its 330-sat fallback: a guess cannot
// found a floor whose whole job is to be sound.
const walletDustAmount = (wallet: IWallet): bigint | undefined => {
    if (!("dustAmount" in wallet)) return undefined;
    const value = (wallet as { dustAmount?: unknown }).dustAmount;
    return typeof value === "bigint" && value > 0n ? value : undefined;
};

const assertFundingRepository = (repository: AssetSwapRepository): void => {
    if (
        repository?.version !== 5 ||
        typeof repository.getSwap !== "function" ||
        typeof repository.getAllSwaps !== "function" ||
        typeof repository.insertPreparedSwap !== "function" ||
        typeof repository.advanceFundingState !== "function"
    ) {
        throw new Error(
            "fundOffer requires AssetSwapRepository version 5 with all atomic funding methods",
        );
    }
};

const canonicalUrl = (value: string): string => {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error("arkServerUrl must be an HTTP(S) URL");
    }
    if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.username ||
        parsed.password ||
        parsed.hash
    ) {
        throw new Error("arkServerUrl must be an HTTP(S) URL without credentials or a fragment");
    }
    return parsed.toString();
};

const captureDeadline = (value: unknown): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError("validUntil must be a positive safe integer UNIX timestamp in seconds");
    }
    return value;
};

const assertDeadline = (validUntil?: number): void => {
    if (validUntil !== undefined && Date.now() / 1000 >= validUntil) {
        throw new SendDeadlineExceededError(validUntil);
    }
};

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => hex.encode(a) === hex.encode(b);

const canonicalAssetId = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const parsed = asset.AssetId.fromString(value);
    if (parsed.toString() !== value) throw new Error("deposit.assetId must be canonical");
    return value;
};

const satsNumber = (value: bigint, field: string): number => {
    if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`${field} must be a positive safe integer`);
    }
    return Number(value);
};

const expiryMatches = (coin: NormalizedExtendedVirtualCoin, floor: FundingExpiryFloor): boolean => {
    const hasTime = coin.expiresAt !== undefined;
    const hasHeight = coin.expiresAtHeight !== undefined;
    if (hasTime === hasHeight) return false;
    if (floor.kind === "time") {
        const time = coin.expiresAt instanceof Date ? coin.expiresAt.getTime() : Number.NaN;
        return Number.isFinite(time) && BigInt(Math.floor(time / 1000)) >= floor.value;
    }
    return (
        typeof coin.expiresAtHeight === "number" &&
        Number.isSafeInteger(coin.expiresAtHeight) &&
        BigInt(coin.expiresAtHeight) >= floor.value
    );
};

const reservedInputs = (swaps: AssetSwap[]): Set<string> => {
    const reserved = new Set<string>();
    for (const swap of swaps) {
        const intent = swap.fundingIntent;
        if (!intent || (intent.state !== "prepared" && intent.state !== "submitted")) continue;
        for (const input of intent.inputs) reserved.add(`${input.txid}:${input.vout}`);
    }
    return reserved;
};

const selectFundingInputs = (
    available: NormalizedExtendedVirtualCoin[],
    outputSats: number,
    depositAssetId: string | undefined,
    depositAmount: bigint,
    dust: number,
): NormalizedExtendedVirtualCoin[] => {
    let selected: NormalizedExtendedVirtualCoin[];
    if (depositAssetId) {
        selected = selectCoinsWithAsset(available, depositAssetId, depositAmount)
            .selected as NormalizedExtendedVirtualCoin[];
    } else {
        selected = selectVirtualCoins(available, outputSats)
            .inputs as NormalizedExtendedVirtualCoin[];
    }

    const assetChange = (coins: NormalizedExtendedVirtualCoin[]): Map<string, bigint> => {
        const change = new Map<string, bigint>();
        for (const coin of coins) {
            for (const held of coin.assets ?? []) {
                change.set(held.assetId, (change.get(held.assetId) ?? 0n) + held.amount);
            }
        }
        if (depositAssetId) {
            const left = (change.get(depositAssetId) ?? 0n) - depositAmount;
            if (left < 0n) throw new Error(`selected inputs are short asset ${depositAssetId}`);
            if (left === 0n) change.delete(depositAssetId);
            else change.set(depositAssetId, left);
        }
        return change;
    };

    let selectedSats = selected.reduce((sum, coin) => sum + coin.value, 0);
    // A top-up coin carries its own assets, so the carrier reserve is re-derived over
    // the whole selection: `send({selectedVtxos})` may not reach for an unnamed input.
    for (;;) {
        const neededSats = outputSats + (assetChange(selected).size > 0 ? dust : 0);
        if (selectedSats >= neededSats) return selected;
        const selectedKeys = new Set(selected.map((coin) => `${coin.txid}:${coin.vout}`));
        const remaining = available.filter(
            (coin) => !selectedKeys.has(`${coin.txid}:${coin.vout}`),
        );
        const extra = selectVirtualCoins(remaining, neededSats - selectedSats)
            .inputs as NormalizedExtendedVirtualCoin[];
        selected = [...selected, ...extra];
        selectedSats += extra.reduce((sum, coin) => sum + coin.value, 0);
    }
};

const authorityFields = [
    "id",
    "fromAsset",
    "toAsset",
    "fromAmount",
    "toAmount",
    "swapAddress",
    "swapPkScript",
    "offerHex",
    "fundingTxid",
    "status",
    "createdAt",
    "signingDescriptor",
    "preimageHex",
    "preimageSaltHex",
    "spentTxid",
    "completedAt",
    "pair",
    "paymentHash",
    "htlcPkScriptHex",
    "htlcLocktime",
    "l1Txid",
] as const;

const decorate = async (
    base: AssetSwap,
    prepareNew: FundOfferParams["prepareNew"],
): Promise<AssetSwap> => {
    if (!prepareNew) return base;
    const decorated = await prepareNew(structuredClone(base));
    if (!decorated || typeof decorated !== "object") {
        throw new Error("prepareNew must return an asset swap");
    }
    for (const field of authorityFields) {
        if (decorated[field] !== base[field]) {
            throw new Error(`prepareNew must not change ${field}`);
        }
    }
    if (JSON.stringify(decorated.fundingIntent) !== JSON.stringify(base.fundingIntent)) {
        throw new Error("prepareNew must not change fundingIntent");
    }
    JSON.stringify(decorated);
    return decorated;
};

const assertExistingRequest = (
    existing: AssetSwap,
    request: {
        offerHex: string;
        fromAsset: string;
        fromAmount: string;
        toAsset: string;
        toAmount: string;
        arkServerUrl: string;
        explicitCarrier?: string;
    },
): void => {
    const matches =
        existing.offerHex === request.offerHex &&
        existing.fromAsset === request.fromAsset &&
        existing.fromAmount === request.fromAmount &&
        existing.toAsset === request.toAsset &&
        existing.toAmount === request.toAmount &&
        existing.fundingIntent?.arkServerUrl === request.arkServerUrl &&
        (request.explicitCarrier === undefined ||
            existing.fundingIntent.output.value === request.explicitCarrier);
    if (!matches)
        throw new Error(`funding operation ${existing.id} conflicts with its stored intent`);
};

/**
 * Only a funded row is a result: `submitted` has no `fundingTxid`, `abandoned`
 * is `cancelled`. A `prepared` row is left as found — this caller never made
 * that reservation, and taking its CAS would make its owner skip `wallet.send`.
 */
const resolveExistingFunding = (existing: AssetSwap): AssetSwap => {
    // also true for legacy pre-v5 rows, which are funded on a txid alone
    if (hasBoundFunding(existing)) return existing;
    const state = existing.fundingIntent?.state;
    if (state === "submitted") {
        throw new FundingOutcomeUnknownError(
            existing.id,
            undefined,
            new Error("send outcome is still unverified"),
        );
    }
    if (state === "prepared" || state === "abandoned") {
        throw new FundingNotCompletedError(existing.id, state);
    }
    throw new Error(`funding operation ${existing.id} is not funded`);
};

export async function fundOffer(
    wallet: IWallet,
    arkServerUrl: string,
    params: FundOfferParams,
): Promise<AssetSwap> {
    assertFundingRepository(params.repository);
    const repository = params.repository;
    const prepareNew = params.prepareNew;
    const offerHex = params.offerHex;
    const offerPayload = hex.decode(offerHex);
    if (offerPayload.length === 0 || hex.encode(offerPayload) !== offerHex) {
        throw new Error("offerHex must be canonical non-empty lowercase hex");
    }
    const offer = decodeOffer(offerPayload);
    const depositAssetId = canonicalAssetId(params.deposit.assetId);
    const depositAmount = BigInt(canonicalAssetAmount(params.deposit.amount));
    const explicitCarrier =
        params.deposit.carrierSats === undefined
            ? undefined
            : BigInt(canonicalAssetAmount(params.deposit.carrierSats));
    if (depositAssetId === undefined && explicitCarrier !== undefined) {
        throw new Error("deposit.carrierSats is only valid for an asset deposit");
    }
    const url = canonicalUrl(arkServerUrl);
    const validUntil = captureDeadline(params.validUntil);
    const floor = params.inputExpiryFloor
        ? { kind: params.inputExpiryFloor.kind, value: params.inputExpiryFloor.value }
        : undefined;
    if (floor && floor.kind !== "height" && floor.kind !== "time") {
        throw new Error("inputExpiryFloor.kind must be height or time");
    }
    if (floor && floor.value <= 0n) throw new Error("inputExpiryFloor.value must be positive");
    const id = params.id ?? globalThis.crypto.randomUUID();
    const fromAsset = depositAssetId ?? BTC_ASSET_ID;
    const toAsset = offer.wantAsset?.toString() ?? BTC_ASSET_ID;
    const requestFacts = {
        offerHex,
        fromAsset,
        fromAmount: depositAmount.toString(),
        toAsset,
        toAmount: offer.wantAmount.toString(),
        arkServerUrl: url,
        ...(explicitCarrier === undefined ? {} : { explicitCarrier: explicitCarrier.toString() }),
    };

    if (params.id !== undefined) {
        const existing = await repository.getSwap(id);
        if (existing) {
            assertExistingRequest(existing, requestFacts);
            return resolveExistingFunding(existing);
        }
    }

    assertDeadline(validUntil);
    const provider = new RestArkProvider(url);
    const [info, makerPublicKey, walletAddress] = await Promise.all([
        provider.getInfo(),
        wallet.identity.xOnlyPublicKey(),
        wallet.getAddress(),
    ]);
    const serverPubkey = hex.decode(toXOnlySignerHex(info.signerPubkey));
    const network = getNetwork(info.network as NetworkName);
    if (!sameBytes(makerPublicKey, offer.makerPublicKey)) {
        throw new Error("offer maker key is not owned by this wallet");
    }
    let decodedWalletAddress: ArkAddress;
    try {
        decodedWalletAddress = ArkAddress.decode(walletAddress);
    } catch (cause) {
        throw new Error("wallet address does not match the operator network", { cause });
    }
    if (
        decodedWalletAddress.hrp !== network.hrp ||
        !sameBytes(decodedWalletAddress.serverPubKey, serverPubkey)
    ) {
        throw new Error("wallet address does not match the operator network or signing key");
    }
    const { swapPkScript: encodedScript, ...binding } = offer;
    const script = offerVtxoScript(binding, serverPubkey);
    if (!sameBytes(script.pkScript, encodedScript)) {
        throw new Error("offer covenant commitment does not match the connected operator");
    }

    // Under dust the wallet pays the address's OP_RETURN sub-dust script, and decides
    // that against its OWN dust — frozen at construction, so it can outlive a lowered
    // operator value. Topping up instead would spend sats the caller never authorized.
    const walletDust = walletDustAmount(wallet);
    const dust = Math.max(
        satsNumber(BigInt(info.dust), "operator dust"),
        walletDust === undefined ? 0 : satsNumber(walletDust, "wallet dust"),
    );
    const depositField = depositAssetId ? "deposit.carrierSats" : "deposit.amount";
    const outputSats = depositAssetId
        ? satsNumber(explicitCarrier ?? BigInt(dust), depositField)
        : satsNumber(depositAmount, depositField);
    if (outputSats < dust) {
        throw new Error(`${depositField} must be at least the ${dust} sat dust floor`);
    }
    const [spendable, swaps] = await Promise.all([
        wallet.getSpendableVtxos({ withRecoverable: false }),
        repository.getAllSwaps(),
    ]);
    const reserved = reservedInputs(swaps);
    const unreserved = spendable.filter((coin) => !reserved.has(`${coin.txid}:${coin.vout}`));
    const eligible = floor ? unreserved.filter((coin) => expiryMatches(coin, floor)) : unreserved;
    let selected: NormalizedExtendedVirtualCoin[];
    try {
        selected = selectFundingInputs(eligible, outputSats, depositAssetId, depositAmount, dust);
    } catch (cause) {
        if (floor)
            throw new Error("input expiry floor leaves insufficient eligible funds", { cause });
        throw cause;
    }

    const address = script.address(network.hrp, serverPubkey).encode();
    const base: AssetSwap = {
        id,
        fromAsset,
        toAsset,
        fromAmount: depositAmount.toString(),
        toAmount: offer.wantAmount.toString(),
        swapAddress: address,
        swapPkScript: hex.encode(script.pkScript),
        offerHex,
        fundingTxid: "",
        status: "pending",
        createdAt: Date.now(),
        fundingIntent: {
            version: 1,
            state: "prepared",
            inputs: selected.map((coin) => ({ txid: coin.txid, vout: coin.vout })),
            serverPubkey: hex.encode(serverPubkey),
            arkServerUrl: url,
            output: {
                script: hex.encode(script.pkScript),
                value: outputSats.toString(),
                ...(depositAssetId
                    ? { assetId: depositAssetId, assetAmount: depositAmount.toString() }
                    : {}),
            },
        },
    };

    const prepared = await decorate(base, prepareNew);
    assertDeadline(validUntil);
    await registerOfferContract(
        wallet,
        url,
        info.network as NetworkName,
        binding,
        serverPubkey,
        script.pkScript,
        // a mark postdating `createdAt` is one no record can ever clear
        { issued: prepared.createdAt },
    );
    assertDeadline(validUntil);
    if (!(await repository.insertPreparedSwap(prepared))) {
        const existing = await repository.getSwap(id);
        if (existing) {
            assertExistingRequest(existing, requestFacts);
            return resolveExistingFunding(existing);
        }
        throw new Error(`funding reservation conflict for operation ${id}`);
    }

    try {
        assertDeadline(validUntil);
    } catch (expired) {
        // Provably unsent, so the inputs are released here. A submitted row never
        // takes this path: its send may have gone out, and that liability stands.
        await repository.advanceFundingState(id, "prepared", { state: "abandoned" });
        throw expired;
    }
    if (!(await repository.advanceFundingState(id, "prepared", { state: "submitted" }))) {
        throw new Error(`funding state for operation ${id} did not advance to submitted`);
    }
    const recipient = {
        address,
        amount: outputSats,
        ...(depositAssetId ? { assets: [{ assetId: depositAssetId, amount: depositAmount }] } : {}),
        extensions: [{ type: OFFER_PACKET_TYPE, payload: offerPayload }],
    };
    let fundingTxid: string;
    try {
        fundingTxid = await wallet.send({
            recipients: [recipient],
            selectedVtxos: selected,
            ...(validUntil === undefined ? {} : { validUntil }),
        });
    } catch (cause) {
        if (cause instanceof SendDeadlineExceededError) {
            // Raised only from the wallet's pre-submit hook, the last step
            // before `submitTx`: proof the send never went out.
            await repository.advanceFundingState(id, "submitted", { state: "abandoned" });
            throw cause;
        }
        throw new FundingOutcomeUnknownError(id, undefined, cause);
    }
    if (!/^[0-9a-f]{64}$/.test(fundingTxid)) {
        throw new FundingOutcomeUnknownError(
            id,
            undefined,
            new Error("wallet returned invalid txid"),
        );
    }
    if (walletDust === undefined) {
        // Nothing above proves which dust this shape applied, so the covenant output is
        // read back before anything is funded. The row stays submitted: the send went out.
        let observed: FundingOutputCheck;
        try {
            observed = await checkFundingOutput(
                new RestIndexerProvider(url),
                fundingTxid,
                prepared,
            );
        } catch (cause) {
            throw new FundingOutcomeUnknownError(id, fundingTxid, cause);
        }
        if (observed === "mismatch") throw new FundingOutputMismatchError(id, fundingTxid);
        if (observed === "unavailable") {
            throw new FundingOutcomeUnknownError(
                id,
                fundingTxid,
                new Error("funding output is not observable yet"),
            );
        }
    }
    try {
        const bound = await repository.advanceFundingState(id, "submitted", {
            state: "bound",
            fundingTxid,
        });
        if (!bound) throw new Error("submitted-to-bound compare-and-swap failed");
    } catch (cause) {
        throw new FundingOutcomeUnknownError(id, fundingTxid, cause);
    }
    const result = await repository.getSwap(id);
    if (!result)
        throw new FundingOutcomeUnknownError(id, fundingTxid, new Error("bound row missing"));
    return result;
}
