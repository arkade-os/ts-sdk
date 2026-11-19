import { expectTypeOf, it } from "vitest";
import { arkade } from "../src";

it("exports PUT as a literal opcode and a script operation", () => {
    expectTypeOf(arkade.ARKADE_OP.PUT).toEqualTypeOf<0xbb>();
    expectTypeOf(arkade.ARKADE_OPS.PUT).toEqualTypeOf<0xbb>();
    expectTypeOf<"PUT">().toExtend<arkade.ArkadeScriptOP>();
});
