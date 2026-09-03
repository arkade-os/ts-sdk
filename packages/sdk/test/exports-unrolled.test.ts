import { describe, expect, it } from "vitest";
import * as sdk from "../src";
import type { ExecutorOptions, OnExitObserved, WalletBalance } from "../src";

// The barrel is the only surface a consumer sees, and `src/index.ts` re-exports
// through two hand-maintained lists — so a predicate can exist, be correct, and
// still be unreachable.
describe("unrolled-VTXO public surface", () => {
    it("exports the location-axis predicate and the exit-observed seam", () => {
        expect(typeof sdk.canSweepOnchain).toBe("function");
        expect(typeof sdk.exitObserverFor).toBe("function");
        expect(typeof sdk.notifyExitObserved).toBe("function");
        expect(typeof sdk.Unroll.sessionFor).toBe("function");
        expect(typeof sdk.UnilateralExit.execute).toBe("function");
    });

    it("types the new balance bucket and executor option", () => {
        const hook: OnExitObserved = () => {};
        const opts: ExecutorOptions = { onExitObserved: hook };
        const unrolled: WalletBalance["unrolled"] = 0;
        expect(opts.onExitObserved).toBe(hook);
        expect(unrolled).toBe(0);
    });
});
