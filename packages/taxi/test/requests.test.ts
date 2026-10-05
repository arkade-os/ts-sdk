import { describe, it, expect } from "vitest";
import { decodeTaxiParams, encodeTaxiParams } from "../src/requests";

const decode = (query: string) => decodeTaxiParams(new URLSearchParams(query));
const KEY = "a".repeat(64);

describe("Taxi payment request extension", () => {
    it.each(["receiver", "sender"] as const)(
        "round trips amountless requests and %s repayment preference",
        (payer) => {
            const taxi = { url: "https://taxi.example/path?x=1&y=2", payer };
            expect(decode(encodeTaxiParams(taxi))).toEqual(taxi);
        },
    );

    it("preserves legacy key pinning and fare choice, including case-insensitive query names", () => {
        expect(decode(`TAXI=https%3A%2F%2Ftaxi.example&TaxiKey=${KEY}&TaxiFare=flat`)).toEqual({
            url: "https://taxi.example",
            operatorKey: KEY,
            fareId: "flat",
        });
    });

    it.each(["file:///tmp", "not a url"])("ignores invalid optional legacy Taxi URL %s", (url) => {
        expect(decode(`taxi=${encodeURIComponent(url)}`)).toBeUndefined();
    });

    it.each(["NOTHEX", KEY.toUpperCase()])("ignores malformed legacy key %s", (key) => {
        expect(decode(`taxi=https://taxi.example&taxikey=${key}`)).toBeUndefined();
    });

    it.each(["invalid", "", "receiver&TaxiPayer=sender"])(
        "refuses ambiguous repayment preference %s",
        (payer) => {
            expect(() => decode(`taxi=https://taxi.example&taxipayer=${payer}`)).toThrow(
                "Invalid Taxi repayment preference",
            );
        },
    );

    it("never weakens sender-covered delivery when a descriptor is invalid", () => {
        expect(() => decode("taxikey=broken&taxipayer=sender")).toThrow(
            "Invalid Taxi repayment preference",
        );
        expect(() => decode("taxi=file:///tmp&taxipayer=sender")).toThrow(
            "Invalid Taxi repayment preference",
        );
    });

    it("escapes all parameters to prevent a value from adding or replacing the preference", () => {
        expect(
            encodeTaxiParams({
                url: "https://taxi.example",
                operatorKey: "k&taxi=x",
                fareId: "a&taxipayer=sender",
            }),
        ).toBe(
            "&taxi=https%3A%2F%2Ftaxi.example&taxikey=k%26taxi%3Dx&taxifare=a%26taxipayer%3Dsender",
        );
    });
});
