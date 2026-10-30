/**
 * Partial-fill limit orders: a maker funds a standing sell or buy order as a covenant VTXO and goes
 * offline; any taker fills it, anyone returns it after expiry, the maker cancels with the operator.
 */
import { arkade, asset, type IWallet, type VirtualCoin } from "@arkade-os/sdk";
import type { FillFunding } from "../offer";
import sellOrderArtifact from "./contracts/sell_order.json";
import buyOrderArtifact from "./contracts/buy_order.json";

const PROGRAMS = {
    sell: arkade.programFromArtifact(sellOrderArtifact),
    buy: arkade.programFromArtifact(buyOrderArtifact),
};

/** Everything a fill is checked against. Funding the order's address is the maker's authorization. */
export interface OrderTerms {
    side: "sell" | "buy";
    /** x-only key: signs `cancel` with the operator, or `unilateral` alone after the exit delay. */
    maker: Uint8Array;
    /** P2TR pkScript (34 bytes) paid when the order closes, expires or is cancelled. */
    makerScript: Uint8Array;
    assetId: string;
    priceSats: bigint;
    /** Smallest fill in units, except one that empties a sell order or closes a buy order. */
    minFill: bigint;
    /** Unix seconds on the emulator's clock; 0 = never. */
    expiresAt: bigint;
    /** Buy orders: sats kept in the order to carry the bought units. */
    reserveSats: bigint;
}

export interface Order {
    terms: OrderTerms;
    coin: Pick<VirtualCoin, "txid" | "vout" | "value" | "assets">;
}

/** The covenant of `terms`; `client` must be connected with an emulator. */
export function orderContract(client: arkade.Arkade, terms: OrderTerms): arkade.ArkadeContract {
    const script = terms.makerScript;
    if (script.length !== 34 || script[0] !== 0x51 || script[1] !== 0x20) {
        throw new Error("makerScript must be a P2TR output script");
    }
    if (terms.priceSats <= 0n || terms.minFill <= 0n) {
        throw new Error("price and min fill must be positive");
    }
    if (terms.expiresAt < 0n || terms.reserveSats < 0n) {
        throw new Error("expiry and reserve must not be negative");
    }
    const id = asset.AssetId.fromString(terms.assetId);
    const args = {
        maker: terms.maker,
        makerProgram: script.slice(2),
        // the asset opcodes read the txid in internal byte order
        assetTxid: id.txid.slice().reverse(),
        assetGidx: BigInt(id.groupIndex),
        price: terms.priceSats,
        minFill: terms.minFill,
        expiresAt: terms.expiresAt,
    };
    return terms.side === "sell"
        ? client.contract(PROGRAMS.sell, args)
        : client.contract(PROGRAMS.buy, { ...args, reserve: terms.reserveSats });
}

/** The covenants' floor for a fill, a sell remainder and a buy order's leftover budget: dust. */
export const MIN_FILL_SATS = 330n;

/** Smallest min fill at `priceSats` that keeps every partial fill at or above {@link MIN_FILL_SATS}. */
export const minFillFor = (priceSats: bigint): bigint =>
    (MIN_FILL_SATS + priceSats - 1n) / priceSats;

/** Why an order of `size` units on `terms` is too small to fund, or undefined. */
export function orderTooSmall(terms: OrderTerms, size: bigint): string | undefined {
    if (size * terms.priceSats < MIN_FILL_SATS) {
        return `an order must be worth at least ${MIN_FILL_SATS} sats`;
    }
    if (terms.minFill * terms.priceSats < MIN_FILL_SATS) {
        return `min fill must be worth at least ${MIN_FILL_SATS} sats (${minFillFor(terms.priceSats)} units at this price)`;
    }
    if (terms.side === "buy" && terms.reserveSats < MIN_FILL_SATS) {
        return `a buy order must reserve at least ${MIN_FILL_SATS} sats to carry the units it buys`;
    }
    return undefined;
}

/** A buy order left with `left` sats of budget closes to its maker: no further legal fill fits. */
export const buyCloses = (terms: OrderTerms, left: bigint): boolean =>
    left < terms.minFill * terms.priceSats || left < MIN_FILL_SATS;

/** `fill` in sell_order.ark / buy_order.ark, for an order coin holding `held` (expiry aside). */
export function fillAllowed(
    terms: OrderTerms,
    held: { units: bigint; value: bigint },
    qty: bigint,
): boolean {
    if (qty <= 0n || qty * terms.priceSats < MIN_FILL_SATS) return false;
    if (terms.side === "sell") {
        const rest = held.units - qty;
        return (
            rest >= 0n &&
            (qty >= terms.minFill || rest === 0n) &&
            (rest === 0n || rest * terms.priceSats >= MIN_FILL_SATS)
        );
    }
    const left = held.value - qty * terms.priceSats - terms.reserveSats;
    return left >= 0n && (qty >= terms.minFill || buyCloses(terms, left));
}

export interface FillPlan {
    legs: { order: Order; qty: bigint }[];
    qty: bigint;
    notional: bigint;
    /** The last leg's price: the worst the plan reaches. */
    worst: bigint | null;
    /** Units resting on the side being taken, whether or not a legal fill reaches them. */
    depth: bigint;
}

/**
 * Buying walks sell orders cheapest first, selling walks buy orders richest first, equal prices in
 * book order. Never overfills; skips orders expiring within 30 s (emulator clock skew). Each leg is
 * its own {@link fillOrder}.
 */
export function planFill(
    book: readonly Order[],
    side: "buy" | "sell",
    qty: bigint,
    nowUnix: number,
): FillPlan {
    const resting = side === "buy" ? "sell" : "buy";
    const live = book.filter(
        (o) =>
            o.terms.side === resting &&
            (o.terms.expiresAt === 0n || o.terms.expiresAt > BigInt(nowUnix + 30)),
    );
    live.sort((a, b) => {
        const d = a.terms.priceSats - b.terms.priceSats;
        if (d === 0n) return 0;
        return d < 0n === (side === "buy") ? -1 : 1;
    });
    const legs: FillPlan["legs"] = [];
    let need = qty;
    let depth = 0n;
    for (const order of live) {
        depth += remainingUnits(order);
        const take = legalTake(order, need);
        if (take === 0n) continue;
        legs.push({ order, qty: take });
        need -= take;
    }
    return {
        legs,
        qty: qty - need,
        notional: legs.reduce((s, l) => s + l.qty * l.order.terms.priceSats, 0n),
        worst: legs.at(-1)?.order.terms.priceSats ?? null,
        depth,
    };
}

const unitsOf = (assets: readonly { assetId: string; amount: bigint }[] | undefined, id: string) =>
    (assets ?? []).reduce((s, a) => (a.assetId === id ? s + a.amount : s), 0n);

function remainingUnits({ terms, coin }: Order): bigint {
    if (terms.side === "sell") return unitsOf(coin.assets, terms.assetId);
    const budget = BigInt(coin.value) - terms.reserveSats;
    return budget > 0n ? budget / terms.priceSats : 0n;
}

/** The largest fill up to `want` the covenant accepts, else 0n. */
function legalTake(order: Order, want: bigint): bigint {
    const { terms, coin } = order;
    const remaining = remainingUnits(order);
    const held = { units: unitsOf(coin.assets, terms.assetId), value: BigInt(coin.value) };
    const q = want < remaining ? want : remaining;
    if (q <= 0n) return 0n;
    if (fillAllowed(terms, held, q)) return q;
    // a sell fill that would leave under 330 sats behind can shrink to leave exactly enough
    const shrunk = remaining - minFillFor(terms.priceSats);
    return terms.side === "sell" && shrunk < q && fillAllowed(terms, held, shrunk) ? shrunk : 0n;
}

const nowUnix = () => BigInt(Math.floor(Date.now() / 1000));

/** Funds an order from `wallet`: a sell order locks `size` units, a buy order their price plus its reserve. */
export async function createOrder(
    wallet: IWallet,
    client: arkade.Arkade,
    terms: OrderTerms,
    size: bigint,
): Promise<{ txid: string; contract: arkade.ArkadeContract }> {
    const tooSmall = orderTooSmall(terms, size);
    if (tooSmall) throw new Error(tooSmall);
    const budget = size * terms.priceSats + terms.reserveSats;
    if (terms.side === "buy" && budget > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`a buy order of ${budget} sats exceeds what wallet.send can carry`);
    }
    const contract = orderContract(client, terms);
    const txid = await wallet.send(
        terms.side === "sell"
            ? { address: contract.address, assets: [{ assetId: terms.assetId, amount: size }] }
            : { address: contract.address, amount: Number(budget) },
    );
    return { txid, contract };
}

/**
 * Takes `qty` units from (sell) or into (buy) `order`, signing `taker.fund` with `client`'s
 * identity. Output 0 is the order's continuation, or the maker's script on the fill that closes
 * it; output 1 is `taker.change`, carrying the taker's sats and every asset not left in the order.
 */
export async function fillOrder(
    client: arkade.Arkade,
    order: Order,
    qty: bigint,
    taker: { fund: FillFunding[]; change: Uint8Array },
): Promise<arkade.ArkadeSpendResult> {
    const { terms, coin } = order;
    const value = BigInt(coin.value);
    const held = unitsOf(coin.assets, terms.assetId);
    if (terms.expiresAt > 0n && nowUnix() >= terms.expiresAt) throw new Error("order has expired");
    if (!fillAllowed(terms, { units: held, value }, qty)) {
        throw new Error(`order refuses a fill of ${qty}`);
    }
    const contract = orderContract(client, terms);
    const notional = qty * terms.priceSats;
    const sell = terms.side === "sell";
    const closes = sell ? qty === held : buyCloses(terms, value - notional - terms.reserveSats);
    const orderSats = sell ? value + notional : value - notional;
    const takerSats = taker.fund.reduce((s, c) => s + BigInt(c.value), 0n) + value - orderSats;
    if (takerSats < MIN_FILL_SATS) {
        throw new Error(`taker output of ${takerSats} sats is below ${MIN_FILL_SATS}`);
    }
    const fill = contract.functions
        .fill(qty)
        .from(coin)
        .fund(taker.fund)
        .to(closes ? terms.makerScript : contract.pkScript, orderSats)
        .to(taker.change, takerSats);

    const kept = sell ? held - qty : held + qty;
    const inputs = new Map<string, { vin: number; amount: bigint }[]>([[terms.assetId, []]]);
    [coin, ...taker.fund].forEach((c, vin) => {
        for (const a of c.assets ?? []) {
            inputs.set(a.assetId, [
                ...(inputs.get(a.assetId) ?? []),
                { vin, amount: BigInt(a.amount) },
            ]);
        }
    });
    for (const [assetId, ins] of inputs) {
        const total = ins.reduce((s, i) => s + i.amount, 0n);
        const toOrder = assetId === terms.assetId ? kept : 0n;
        if (total < toOrder) {
            throw new Error(
                `the fill needs ${toOrder} of ${assetId} but its inputs carry ${total}`,
            );
        }
        const outputs = [];
        if (toOrder > 0n) outputs.push({ vout: 0, amount: toOrder });
        if (total > toOrder) outputs.push({ vout: 1, amount: total - toOrder });
        fill.withAsset({ assetId, inputs: ins, outputs });
    }
    return fill.send();
}

/** Permissionless: returns an expired order, value and assets, to its maker's script. */
export async function settleExpiredOrder(
    client: arkade.Arkade,
    order: Order,
): Promise<arkade.ArkadeSpendResult> {
    const { expiresAt } = order.terms;
    if (expiresAt === 0n || nowUnix() < expiresAt) throw new Error("order has not expired");
    return returnToMaker(orderContract(client, order.terms).functions.settle(), order);
}

/** The maker's cancel, co-signed by the operator: `client`'s identity must be `terms.maker`. */
export async function cancelOrder(
    client: arkade.Arkade,
    order: Order,
): Promise<arkade.ArkadeSpendResult> {
    return returnToMaker(orderContract(client, order.terms).functions.cancel(), order);
}

function returnToMaker(
    spend: arkade.ArkadeTransactionBuilder,
    { terms, coin }: Order,
): Promise<arkade.ArkadeSpendResult> {
    spend.from(coin).to(terms.makerScript, BigInt(coin.value));
    // The maker's output is the only one, so every asset goes to vout 0.
    for (const a of coin.assets ?? []) {
        spend.withAsset({
            assetId: a.assetId,
            inputs: [{ vin: 0, amount: a.amount }],
            outputs: [{ vout: 0, amount: a.amount }],
        });
    }
    return spend.send();
}
