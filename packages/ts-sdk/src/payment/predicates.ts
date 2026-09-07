/**
 * Target classification for the payment rails — format only. No bech32
 * checksum, no bolt11 decode (core carries no bolt11 dependency), no network
 * match against the wallet. Rails re-validate before spending: `onchain` via
 * `Ramps.offboard` → `Address.decode`, `lightning` via `getInvoiceSatoshis`.
 */

/** True if the string decodes as an Arkade address (canonical SDK check). */
export { isValidArkAddress } from "../wallet/utils";

/** True for a BOLT11 invoice (with or without a `lightning:` prefix). HRPs:
 *  mainnet, testnet, signet, regtest, simnet. The amount rides inside the HRP
 *  (`lnbc2500u1…`), so the tail stays loose. */
export const isLightningInvoice = (raw: string): boolean =>
    /^ln(bcrt|bc|tbs|tb|sb)[0-9a-z]+$/i.test(raw.replace(/^lightning:/i, ""));

/**
 * True for an LNURL or a Lightning address (`user@host`).
 *
 * TODO(lnurl): no rail consumes this yet — LNURL / Lightning-address routing is
 * planned future work. The predicate is exported ahead of the rail so consumers
 * can classify these targets today; until the rail lands, `route()` throws
 * "no rail for" on them. Keep the export (do not flag as unused).
 */
export const isLnurl = (raw: string): boolean =>
    /^lnurl/i.test(raw) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);

const BECH32_BTC = /^(bc1|tb1|bcrt1)[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,90}$/;

// BIP173 forbids mixed case: accept all-lower or all-upper, never a mix.
const isBech32Btc = (raw: string): boolean =>
    (raw === raw.toLowerCase() || raw === raw.toUpperCase()) && BECH32_BTC.test(raw.toLowerCase());

/** True for a bech32 (segwit) or base58 (legacy) Bitcoin address, any network —
 *  legacy covers testnet/regtest `m`/`n`/`2` alongside mainnet `1`/`3`. */
export const isBtcAddress = (raw: string): boolean =>
    isBech32Btc(raw) || /^[13mn2][a-km-zA-HJ-NP-Z1-9]{25,39}$/.test(raw);
