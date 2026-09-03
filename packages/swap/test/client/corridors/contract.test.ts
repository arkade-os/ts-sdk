/**
 * What each module declares, checked against the manager that will run it.
 *
 * These are declarations and not behaviour, so what is worth asserting is that
 * they agree with the code they describe: the action names are the manager's
 * own union, the seams are the two `RfqSwapManagerDeps` takes, and the deadline
 * set is the one the swap types already fix.
 */
import { describe, expect, it } from "vitest";
import { arkadeCorridor } from "../../../src/client/corridors/arkade";
import type { CorridorPass, RouteSide } from "../../../src/client/corridors/contract";
import { lightningCorridor } from "../../../src/client/corridors/lightning";
import { onchainCorridor } from "../../../src/client/corridors/onchain";
import type { RfqSwapActionName } from "../../../src/swapManager";
import { corridorBaseFor } from "./fixtures";
import { resolveCorridorDeps } from "../../../src/client/corridors/deps";

const base = corridorBaseFor("regtest");
const arkade = arkadeCorridor(resolveCorridorDeps("arkade", undefined, base));
const lightning = lightningCorridor(resolveCorridorDeps("lightning", undefined, base));
const onchain = onchainCorridor(resolveCorridorDeps("onchain", undefined, base));

const ALL_ACTIONS: readonly RfqSwapActionName[] = ["claimOnchain", "claimLockup", "refundArkade"];
const passes = (drive: Partial<Record<RouteSide, CorridorPass>>): CorridorPass[] =>
    Object.values(drive);

describe("what a corridor module declares", () => {
    it("keys on the corridor, not on a route pair", () => {
        // v1's registry keys on `RfqSwap["kind"]`, two of whose three members
        // are this same corridor from opposite ends.
        expect(lightning.corridor).toBe("lightning");
        expect(Object.keys(lightning.drive).sort()).toEqual(["give", "take"]);
    });

    it("names only actions the manager can execute", () => {
        for (const module of [arkade, lightning, onchain]) {
            for (const pass of passes(module.drive)) {
                for (const action of pass.actions) expect(ALL_ACTIONS).toContain(action);
            }
        }
    });

    it("names only the two seams a pass reads", () => {
        // `RfqSwapManagerDeps` excludes `RfqTransport` by name: nothing the
        // manager decides depends on the solver answering.
        for (const module of [arkade, lightning, onchain]) {
            for (const pass of passes(module.drive)) {
                for (const seam of pass.seams) expect(["indexer", "chain"]).toContain(seam);
            }
        }
    });

    describe("the lightning corridor", () => {
        it("inverts the lockup's owner with the direction", () => {
            // The trader funds the lockup on a send; the solver funds it on a
            // receive, where every non-claim leaf is the solver's.
            expect(lightning.drive.take?.lockups).toEqual([
                { covenant: "arkade_lockup", owner: "trader", deadline: "refund_locktime" },
            ]);
            expect(lightning.drive.give?.lockups).toEqual([
                { covenant: "arkade_lockup", owner: "solver", deadline: "refund_locktime" },
            ]);
        });

        it("refunds on the send and claims on the receive, never both", () => {
            expect(lightning.drive.take?.actions).toEqual(["refundArkade"]);
            expect(lightning.drive.give?.actions).toEqual(["claimLockup"]);
        });

        it("reads one seam, on both directions", () => {
            expect(lightning.drive.take?.seams).toEqual(["indexer"]);
            expect(lightning.drive.give?.seams).toEqual(["indexer"]);
        });
    });

    describe("the onchain corridor", () => {
        it("is the only corridor that reads a second covenant", () => {
            expect(onchain.drive.take?.lockups).toEqual([
                { covenant: "arkade_lockup", owner: "trader", deadline: "refund_locktime" },
                { covenant: "onchain_htlc", owner: "solver", deadline: "htlc_refund_locktime" },
            ]);
            expect(onchain.drive.take?.seams).toEqual(["indexer", "chain"]);
        });

        it("declares nothing for `onchain -> arkade`", () => {
            // Outside the `Route` union: it adds a deadline, a seam AND an
            // action the manager does not drive, and declaring the lockup half
            // alone is what would let the trader's L1 refund window pass.
            expect(onchain.drive.give).toBe(undefined);
        });
    });

    it("declares no pass for the arkade corridor at all", () => {
        // `arkade -> arkade` is an offer covenant: no lockup, no
        // `refundLocktime`, no manager action, and a watcher of its own that
        // reads the wallet's own contract events.
        expect(arkade.drive).toEqual({});
    });

    it("closes its deps over at construction", () => {
        expect(onchain.deps.networkName).toBe("regtest");
        expect(lightning.deps.networkName).toBe("regtest");
        expect(arkade.deps.network.hrp).toBe("tark");
    });
});
