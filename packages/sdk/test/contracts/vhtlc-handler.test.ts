/**
 * The `vhtlc` (V1) handler's two contract-manager-facing properties:
 * `deriveTapscripts` and `isGenericallySpendable`.
 *
 * These two are a pair, and the pairing is the point. Before either existed a
 * `vhtlc` row was safe only by cancellation: `deriveContractTapscripts` falls
 * back to `script.forfeit()`, no VHTLC script defines one, so annotation threw
 * and the row's VTXOs were dropped before they could be persisted. They were
 * invisible, not protected — and the `isGenericallySpendable: true` sitting
 * next to that was unobservable rather than correct. Deriving the annotation
 * leaf without also closing the gate would have made a V1 escrow visible AND
 * selectable by unprompted renewal in one change.
 *
 * @see vhtlcV2-handler.test.ts for the same properties on ScriptV2, and for
 * the parity pins that keep the two handlers from drifting apart.
 */
import { describe, it, expect, vi } from "vitest";
import { hex } from "@scure/base";

import {
    ContractManager,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    VHTLC,
    gatedContracts,
    isContractGenericallySpendable,
    scriptFromTapLeafScript,
    type Contract,
} from "../../src";
import { VHTLCContractHandler } from "../../src/contracts/handlers/vhtlc";
import { deriveContractTapscripts } from "../../src/wallet/utils";
import { createMockIndexerProvider, createMockVtxo } from "./helpers";

const SENDER = "0192e796452d6df9697c280542e1560557bcf79a347d925895043136225c7cb4";
const RECEIVER = "1e1bb85455fe3f5aed60d101aa4dbdb9e7714f6226769a97a17a5331dadcd53b";
const SERVER = "aad52d58162e9eefeafc7ad8a1cdca8060b5f01df1e7583362d052e266208f88";
/** HASH160 output — VHTLC validates this at exactly 20 bytes. */
const HASH = "4d487dd3753a89bc9fe98401d1196523058251fc";

/** V1 takes the same eight mandatory fields as V2, minus the covenant leaves. */
const params = (over: Record<string, string> = {}): Record<string, string> => ({
    sender: SENDER,
    receiver: RECEIVER,
    server: SERVER,
    hash: HASH,
    refundLocktime: "800000",
    claimDelay: "10",
    refundDelay: "12",
    refundNoReceiverDelay: "14",
    ...over,
});

const contractOf = (p: Record<string, string>): Contract => ({
    type: "vhtlc",
    params: p,
    script: hex.encode(VHTLCContractHandler.createScript(p).pkScript),
    address: "ark1lockup",
    state: "active",
    createdAt: Date.now(),
});

const leafHex = (leaf: unknown): string => hex.encode(scriptFromTapLeafScript(leaf as never));

describe("VHTLCContractHandler (v1)", () => {
    it("inherits a working refundWithoutReceiver() from VHTLC.BaseScript", () => {
        const script = VHTLCContractHandler.createScript(params());
        expect(script).toBeInstanceOf(VHTLC.Script);
        // The leaf the annotation depends on must resolve in V1's own tree,
        // not merely be declared on the shared base class.
        expect(leafHex(script.refundWithoutReceiver())).toBe(script.refundWithoutReceiverScript);
    });

    it("derives annotation tapscripts rather than falling back to a forfeit() it lacks", () => {
        const p = params();
        const script = VHTLCContractHandler.createScript(p);

        // The pipeline entry point, not just the handler method: this is the
        // call `annotateVtxos` makes, and the one that used to throw
        // `legacy.forfeit is not a function`.
        const derived = deriveContractTapscripts(contractOf(p));
        expect(leafHex(derived.intentTapLeafScript)).toBe(script.refundWithoutReceiverScript);
        expect(leafHex(derived.forfeitTapLeafScript)).toBe(script.refundWithoutReceiverScript);
        expect(hex.encode(derived.tapTree)).toBe(hex.encode(script.encode()));
    });

    it("is never generically spendable — a live lockup is escrow", () => {
        const contract = contractOf(params());
        expect(VHTLCContractHandler.isGenericallySpendable?.(contract)).toBe(false);
        expect(isContractGenericallySpendable(contract)).toBe(false);
    });

    /**
     * The whole point of the pairing, in one assertion: the VTXOs of a
     * registered V1 lockup now survive the sync (so the balance is no longer
     * permanently invisible) AND are withheld from generic selection (so an
     * unprompted renewal cannot sweep the escrow that just became visible).
     */
    it("syncs a registered lockup's vtxos but withholds them from generic selection", async () => {
        const p = params();
        const script = hex.encode(VHTLCContractHandler.createScript(p).pkScript);
        const indexer = createMockIndexerProvider();
        (indexer.getVtxos as ReturnType<typeof vi.fn>).mockResolvedValue({
            vtxos: [createMockVtxo({ script, value: 5000 })],
            page: undefined,
        });

        const manager = await ContractManager.create({
            indexerProvider: indexer,
            contractRepository: new InMemoryContractRepository(),
            walletRepository: new InMemoryWalletRepository(),
        });
        const contract = await manager.createContract({
            type: "vhtlc",
            params: p,
            script,
            address: "ark1lockup",
        });

        const [entry] = await manager.getContractsWithVtxos({ script });
        expect(entry.vtxos).toHaveLength(1);
        expect(entry.vtxos[0].value).toBe(5000);
        expect(leafHex(entry.vtxos[0].intentTapLeafScript)).toBe(
            VHTLCContractHandler.createScript(p).refundWithoutReceiverScript,
        );
        // Visible, and not degraded...
        expect(manager.getSyncState().mode).toBe("online");
        // ...but closed to generic spending. `getSpendableVtxos` drops exactly
        // the scripts this map holds, which is what keeps `runPeriodicSettle`
        // from selecting the lockup.
        expect(gatedContracts([contract]).get(script)).toBe("vhtlc");

        manager.dispose();
    });
});
