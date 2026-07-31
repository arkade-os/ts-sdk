import type { DiscoveredMarket } from "@arkade-os/solver-discovery";

// registry-shaped test markets in the 0.1.3 registry schema; asset ids are
// arbitrary 68-hex values, tickers limited to BTC/USD/CHF/XAU
export const USD_ID = "f121ac9b7656797cc68d1e8fecacfbaa2069ec1461edf0bf2f3c37404cb9791a0000";
export const CHF_ID = "47004bf4a5fbdb2221f708030528de68ea28f5980044e546b7bb5a352457d1f30000";

export const btcUsd: DiscoveredMarket = {
    pair: "BTC/USD",
    base_asset: { id: "btc", name: "Bitcoin", ticker: "BTC", decimals: 8 },
    quote_asset: { id: USD_ID, name: "US Dollar", ticker: "USD", decimals: 2 },
    price_feed: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
    price_feed_schema: { type: "json", price_path: "/bitcoin/usd" },
    price_decimals: 6,
    fee_bps: 30,
    min_base_amount: "1000",
    max_base_amount: "5000000",
    min_quote_amount: "50",
    max_quote_amount: "500000",
    solver: "frenchman",
    source: "registry",
    sourceType: "registry",
};

// an asset↔asset market: neither side is BTC
export const XAU_ID = "aad4ace7f70c0f197cafc707fc1026de38b15556e80566ade6354cbc4054fd3a0000";

export const xauUsd: DiscoveredMarket = {
    ...btcUsd,
    pair: "XAU/USD",
    base_asset: { id: XAU_ID, name: "Gold", ticker: "XAU", decimals: 2 },
    quote_asset: { id: USD_ID, name: "US Dollar", ticker: "USD", decimals: 2 },
    price_feed: "https://api.coingecko.com/api/v3/simple/price?ids=gold&vs_currencies=usd",
    price_feed_schema: { type: "json", price_path: "/gold/usd" },
    price_decimals: 0,
    min_base_amount: "1",
    max_base_amount: "10000000",
    min_quote_amount: "1",
    max_quote_amount: "10000000",
    solver: "goldsmith",
};

export const btcChf: DiscoveredMarket = {
    ...btcUsd,
    pair: "BTC/CHF",
    quote_asset: { id: CHF_ID, name: "Swiss Franc", ticker: "CHF", decimals: 8 },
    price_feed: "https://api.binance.com/api/v3/ticker/price?symbol=BTCCHF",
    price_feed_schema: { type: "json", price_path: "/price" },
    price_decimals: 0,
    min_quote_amount: "1000000",
    max_quote_amount: "100000000000",
    solver: "helvetia",
};
