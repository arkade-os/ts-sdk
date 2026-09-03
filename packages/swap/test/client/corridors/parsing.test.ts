/**
 * The parsing matrix: every destination class, bare and as a BIP21 param,
 * against each module's `matches` and the registry's three-way count.
 *
 * The "bare and as a param" axis is not decoration. It is the axis two core
 * defects sat on — a base58 address lowercased into a different address on the
 * way through `BIP21.parse`, and an upper-case Arkade address dropped from the
 * params by a case-sensitive filter — and both made one destination classify
 * differently depending on which form it arrived in.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { AmbiguousDestination, MissingCorridorDep } from "../../../src/client/errors";
import { corridorSet } from "../../../src/client/corridors/registry";
import { encodeInvoice } from "../../helpers/bolt11";
import { FOREIGN_SIGNER, arkAddressFor, corridorBaseFor } from "./fixtures";

const HASH = "f5636521e98000697a6700b979c288ddad56cb3995a2eb07550872c466ccc3e5";
const NOW = 1_700_000_000;

const invoiceOn = (prefix: string, amount = "20u"): string =>
    encodeInvoice({ prefix, amount, timestamp: NOW - 60, expiry: 3_600, paymentHash: HASH });

/** BOLT11 permits an invoice with no amount, which lets a payer pay anything. */
const amountlessOn = (prefix: string): string =>
    encodeInvoice({ prefix, timestamp: NOW - 60, expiry: 3_600, paymentHash: HASH });

const ARK_REGTEST = arkAddressFor("regtest");
const ARK_MAINNET = arkAddressFor("bitcoin");
const ARK_FOREIGN = arkAddressFor("regtest", FOREIGN_SIGNER);

/** Bech32 on each network. */
const BCRT1 = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
const TB1 = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
const BC1 = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
/** Base58 P2PKH, mixed case on purpose: it is what a lowercasing parse ate. */
const TESTNET_P2PKH = "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn";

const claimOn = (network: Parameters<typeof corridorBaseFor>[0], raw: string) =>
    corridorSet(corridorBaseFor(network)).claim(raw);

describe("the parsing matrix", () => {
    beforeAll(() => {
        // The invoice expiry gate is one of §6's parse-boundary checks, so
        // `matches` reads the clock. Pin it rather than build invoices whose
        // validity outlives the suite.
        vi.useFakeTimers();
        vi.setSystemTime(NOW * 1000);
    });
    afterAll(() => vi.useRealTimers());

    describe("bare destinations", () => {
        it("claims an Arkade address for the arkade corridor", () => {
            expect(claimOn("regtest", ARK_REGTEST)).toEqual({
                corridor: "arkade",
                instrument: { kind: "address", address: ARK_REGTEST },
            });
        });

        it("claims an on-chain address for the onchain corridor", () => {
            expect(claimOn("regtest", BCRT1)).toEqual({
                corridor: "onchain",
                instrument: { kind: "address", address: BCRT1 },
            });
        });

        it("claims a bolt11 invoice for the lightning corridor, with its facts", () => {
            const invoice = invoiceOn("lnbcrt");
            expect(claimOn("regtest", invoice)).toEqual({
                corridor: "lightning",
                instrument: {
                    kind: "invoice",
                    bolt11: invoice,
                    paymentHash: HASH,
                    amount: 2_000n,
                    expiresAt: NOW - 60 + 3_600,
                },
            });
        });

        it("strips a `lightning:` prefix, as core's classifier does", () => {
            const invoice = invoiceOn("lnbcrt");
            const claim = claimOn("regtest", `lightning:${invoice}`);
            expect(claim?.corridor).toBe("lightning");
            expect(claim?.instrument).toMatchObject({ bolt11: invoice });
        });
    });

    describe("as a BIP21 param", () => {
        it("claims the `ark=` param", () => {
            expect(claimOn("regtest", `bitcoin:?ark=${ARK_REGTEST}`)).toEqual({
                corridor: "arkade",
                instrument: { kind: "address", address: ARK_REGTEST },
            });
        });

        it("claims an upper-case `ark=` param, exactly as it claims it bare", () => {
            // The filter was case-sensitive and dropped this with a
            // `console.warn`, while `arkTarget` claimed the same string bare.
            const upper = ARK_REGTEST.toUpperCase();
            expect(claimOn("regtest", upper)?.corridor).toBe("arkade");
            expect(claimOn("regtest", `bitcoin:?ark=${upper}`)).toEqual({
                corridor: "arkade",
                instrument: { kind: "address", address: upper },
            });
        });

        it("claims the URI body for the onchain corridor", () => {
            expect(claimOn("regtest", `bitcoin:${BCRT1}?amount=0.001`)).toEqual({
                corridor: "onchain",
                instrument: { kind: "address", address: BCRT1 },
            });
        });

        it("carries a base58 address through verbatim", () => {
            // The parse lowercased the URI body unconditionally, which is a
            // DIFFERENT base58 address — and `isBtcAddress` admits a lowercase
            // one, so the corruption classified fine and the corridor would
            // have claimed an address nobody typed.
            expect(claimOn("testnet", `bitcoin:${TESTNET_P2PKH}`)).toEqual({
                corridor: "onchain",
                instrument: { kind: "address", address: TESTNET_P2PKH },
            });
            expect(claimOn("testnet", TESTNET_P2PKH)?.instrument).toEqual({
                kind: "address",
                address: TESTNET_P2PKH,
            });
        });

        it("claims the `lightning=` param", () => {
            const invoice = invoiceOn("lnbcrt");
            const claim = claimOn("regtest", `bitcoin:?lightning=${invoice}`);
            expect(claim?.corridor).toBe("lightning");
            expect(claim?.instrument).toMatchObject({ bolt11: invoice, amount: 2_000n });
        });
    });

    describe("the network checks core does not make", () => {
        it("refuses another operator's Arkade address", () => {
            // `isValidArkAddress` proves bech32m and a 65-byte payload and
            // nothing about whose server key is embedded.
            expect(() => claimOn("regtest", ARK_FOREIGN)).toThrow(AmbiguousDestination);
            expect(() => claimOn("regtest", ARK_FOREIGN)).toThrow(/unknown operator signer key/);
        });

        it("refuses an Arkade address from another network", () => {
            expect(() => claimOn("regtest", ARK_MAINNET)).toThrow(/expected prefix "tark"/);
        });

        it("refuses a mainnet on-chain address on a regtest wallet", () => {
            expect(() => claimOn("regtest", BC1)).toThrow(AmbiguousDestination);
            expect(() => claimOn("regtest", BC1)).toThrow(/not a regtest address/);
        });

        it("refuses a testnet invoice on a mainnet wallet", () => {
            expect(() => claimOn("bitcoin", invoiceOn("lntb"))).toThrow(AmbiguousDestination);
            expect(() => claimOn("bitcoin", invoiceOn("lntb"))).toThrow(
                /testnet invoice and the wallet is on bitcoin/,
            );
        });

        it("refuses an `lnsb` invoice, which core admits and no network names", () => {
            // Core's regex carries five prefixes where §6 names four. `simnet`
            // is not a `NetworkName`, so it is refused rather than folded into
            // a neighbour.
            expect(() => claimOn("regtest", invoiceOn("lnsb"))).toThrow(
                /names no network this SDK knows/,
            );
        });

        it("refuses an expired invoice", () => {
            const expired = encodeInvoice({
                prefix: "lnbcrt",
                amount: "20u",
                timestamp: NOW - 7_200,
                expiry: 3_600,
                paymentHash: HASH,
            });
            expect(() => claimOn("regtest", expired)).toThrow(/expired 3600s ago/);
        });

        it("refuses an amountless invoice, because a destination is a send route", () => {
            expect(() => claimOn("regtest", amountlessOn("lnbcrt"))).toThrow(/names no amount/);
        });
    });

    describe("what the vocabulary cannot express", () => {
        it("claims an `lntbs` invoice on signet AND on mutinynet", () => {
            // They share the HRP exactly as they share `tark`, so a
            // signet-versus-mutinynet rejection is not expressible and must not
            // be claimed.
            const invoice = invoiceOn("lntbs");
            expect(claimOn("signet", invoice)?.corridor).toBe("lightning");
            expect(claimOn("mutinynet", invoice)?.corridor).toBe("lightning");
        });

        it("claims a testnet on-chain address on signet, mutinynet and testnet", () => {
            // `OnchainNetwork` has three members and all three of these fold
            // into `testnet`, so the address alone cannot tell them apart.
            for (const network of ["testnet", "signet", "mutinynet"] as const) {
                expect(claimOn(network, TB1)?.corridor).toBe("onchain");
                expect(claimOn(network, TESTNET_P2PKH)?.corridor).toBe("onchain");
            }
        });
    });

    describe("what the registry decides", () => {
        it("refuses a URI naming two corridors with nothing to choose between", () => {
            // Core resolves this by rail priority and chooses in silence, which
            // is safe for core — its rails are interchangeable and its quotes
            // are receiver-exact. Here the choice decides which asset moves and
            // against which counterparty.
            const uri = `bitcoin:${BCRT1}?ark=${ARK_REGTEST}`;
            expect(() => claimOn("regtest", uri)).toThrow(AmbiguousDestination);
            expect(() => claimOn("regtest", uri)).toThrow(/arkade and onchain/);
        });

        it("refuses a string nothing classifies", () => {
            expect(() => claimOn("regtest", "0xdac17f958d2ee523a2206206994597c13d831ec7")).toThrow(
                AmbiguousDestination,
            );
        });

        it("leaves an LNURL unclaimed rather than refusing it", () => {
            // Core classifies it; no corridor serves it. That is
            // `UnsupportedRoute` at route resolution, not a parse failure.
            expect(claimOn("regtest", "lnurl1dp68gurn8ghj7ct5d")).toBe(undefined);
            expect(claimOn("regtest", "payme@example.com")).toBe(undefined);
        });

        it("does not resolve the deps of a corridor the destination is not for", () => {
            // `MissingCorridorDep`'s own boundary note. The classifier that
            // decides whose business a string is reads the string and nothing
            // else, so a deliberately disabled corridor stays silent until
            // something actually addresses it.
            const disabled = corridorSet(corridorBaseFor("regtest"), {
                onchain: { chain: null },
                arkade: { repository: null },
            });
            expect(disabled.claim(invoiceOn("lnbcrt"))?.corridor).toBe("lightning");
            expect(() => disabled.claim(BCRT1)).toThrow(MissingCorridorDep);
            expect(() => disabled.claim(ARK_REGTEST)).toThrow(MissingCorridorDep);
        });

        it("asks a module only about its own destination class", () => {
            // Each module answers `undefined` for a string that is not its
            // business — the arm the registry counts as "not mine".
            const set = corridorSet(corridorBaseFor("regtest"));
            expect(set.get("onchain").matches(ARK_REGTEST)).toBe(undefined);
            expect(set.get("lightning").matches(BCRT1)).toBe(undefined);
            expect(set.get("arkade").matches(invoiceOn("lnbcrt"))).toBe(undefined);
        });
    });
});
