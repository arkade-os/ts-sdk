import { expect, it } from "vitest";

it("enables EventSource in swap workers for contract subscriptions", () => {
    expect(typeof EventSource).toBe("function");
});
