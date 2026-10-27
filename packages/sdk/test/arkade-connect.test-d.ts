import { expectTypeOf, it } from "vitest";
import { arkade } from "../src";

type Options = arkade.ArkadeConnectOptions;
const getInfo = async () => ({}) as any;

it("accepts each form on its own", () => {
    expectTypeOf({ service: { network: "bitcoin" as const } }).toExtend<Options>();
    expectTypeOf({ service: { operatorUrl: "http://localhost:7070" } }).toExtend<Options>();
    expectTypeOf({ arkade: { getInfo } }).toExtend<Options>();
});

it("rejects service together with arkade", () => {
    expectTypeOf({
        service: { network: "bitcoin" as const },
        arkade: { getInfo },
    }).not.toExtend<Options>();
});

it("rejects storage in the provider form", () => {
    expectTypeOf({
        arkade: { getInfo },
        storage: { contractRepository: {} as any },
    }).not.toExtend<Options>();
});

it("rejects a network one-liner other than mainnet", () => {
    expectTypeOf({ network: "mutinynet" as const }).not.toExtend<arkade.ArkadeService>();
    expectTypeOf({ network: "bitcoin" as const }).toExtend<arkade.ArkadeService>();
});
