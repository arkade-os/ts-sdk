import { describe, it, expect } from "vitest";
import { selectPendingRecoveryOutpoints } from "../src/wallet/vtxo-manager";
import type { SignerSet } from "../src/wallet/signerRotation";

const NOW = 1_700_000_000;
const ACTIVE = "aa".repeat(32);
const EXPIRED_SIGNER = "bb".repeat(32);
const MIGRATABLE_SIGNER = "cc".repeat(32);
const DUE_NOW_SIGNER = "dd".repeat(32);
const UNKNOWN_SIGNER = "ee".repeat(32);

const signerSet: SignerSet = {
    active: ACTIVE,
    deprecated: new Map([
        [EXPIRED_SIGNER, BigInt(NOW - 100)], // cutoff passed → EXPIRED
        [MIGRATABLE_SIGNER, BigInt(NOW + 10_000)], // cutoff ahead → MIGRATABLE
        [DUE_NOW_SIGNER, 0n], // no cutoff → DUE_NOW
    ]),
};

// Minimal VirtualCoin-shaped stub: selectPendingRecoveryOutpoints only reads
// txid/vout (outpoint), isSpent (isSpendable), and virtualStatus.state (swept).
const vtxo = (txid: string, vout: number, state: string, isSpent = false) =>
    ({ txid, vout, value: 1000, isSpent, virtualStatus: { state } }) as never;

const row = (serverPubKey: string, vtxos: unknown[]) =>
    ({ contract: { params: { serverPubKey } }, vtxos }) as never;

describe("selectPendingRecoveryOutpoints", () => {
    it("returns only EXPIRED-signer VTXOs that are spendable but not yet swept", () => {
        const out = selectPendingRecoveryOutpoints(
            [
                row(ACTIVE, [vtxo("active", 0, "settled")]), // CURRENT → no
                row(EXPIRED_SIGNER, [vtxo("exp-settled", 0, "settled")]), // EXPIRED awaiting sweep → YES
                row(EXPIRED_SIGNER, [vtxo("exp-swept", 0, "swept")]), // EXPIRED swept → no (recoverable)
                row(EXPIRED_SIGNER, [vtxo("exp-spent", 1, "settled", true)]), // spent → no (!spendable)
                row(MIGRATABLE_SIGNER, [vtxo("mig", 0, "settled")]), // MIGRATABLE → still spendable
                row(DUE_NOW_SIGNER, [vtxo("due", 0, "settled")]), // DUE_NOW → still spendable
                row(UNKNOWN_SIGNER, [vtxo("unk", 0, "settled")]), // UNKNOWN_SIGNER → untouched
            ],
            signerSet,
            NOW,
        );
        expect([...out]).toEqual(["exp-settled:0"]);
    });

    it("is empty when there are no deprecated signers", () => {
        const out = selectPendingRecoveryOutpoints(
            [row(ACTIVE, [vtxo("a", 0, "settled")])],
            { active: ACTIVE, deprecated: new Map() },
            NOW,
        );
        expect(out.size).toBe(0);
    });
});
