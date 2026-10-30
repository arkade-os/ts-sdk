import { expectTypeOf, it } from "vitest";
import { ReadonlyWallet, Wallet, waitForIncomingFunds, type NotifiesIncomingFunds } from "../src";

it("waitForIncomingFunds depends on the capability, not the class Wallet", () => {
    expectTypeOf(waitForIncomingFunds).parameter(0).toEqualTypeOf<NotifiesIncomingFunds>();
});

it("wallets satisfy the capability, so existing callers keep working", () => {
    expectTypeOf<Wallet>().toExtend<NotifiesIncomingFunds>();
    expectTypeOf<ReadonlyWallet>().toExtend<NotifiesIncomingFunds>();
});
