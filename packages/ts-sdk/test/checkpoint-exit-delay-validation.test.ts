import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";

import {
    assertValidServerUnrollScript,
    defaultCheckpointExitDelayPolicy,
    resolveCheckpointExitDelayPolicy,
    DEFAULT_MIN_CHECKPOINT_EXIT_DELAY_SECONDS,
    REGTEST_MIN_CHECKPOINT_EXIT_DELAY_SECONDS,
} from "../src/wallet/checkpointExitDelay";
import { ServerResponseMismatchError } from "../src/providers/errors";
import { networks } from "../src/networks";
import { CSVMultisigTapscript } from "../src/script/tapscript";

const FORFEIT_XONLY = "11".repeat(32);
const OTHER_XONLY = "22".repeat(32);

function encodeCheckpointTapscript(value: bigint, pubkeyXOnlyHex: string = FORFEIT_XONLY): string {
    const timelock = { value, type: value >= 512n ? ("seconds" as const) : ("blocks" as const) };
    return hex.encode(
        CSVMultisigTapscript.encode({
            timelock,
            pubkeys: [hex.decode(pubkeyXOnlyHex)],
        }).script,
    );
}

describe("defaultCheckpointExitDelayPolicy", () => {
    it("requires seconds off regtest", () => {
        expect(defaultCheckpointExitDelayPolicy(networks.bitcoin)).toEqual({
            minSeconds: DEFAULT_MIN_CHECKPOINT_EXIT_DELAY_SECONDS,
            requireSeconds: true,
        });
        expect(defaultCheckpointExitDelayPolicy(networks.testnet).requireSeconds).toBe(true);
        expect(defaultCheckpointExitDelayPolicy(networks.signet).requireSeconds).toBe(true);
        expect(defaultCheckpointExitDelayPolicy(networks.mutinynet).requireSeconds).toBe(true);
    });

    it("allows blocks on regtest with a lower floor", () => {
        expect(defaultCheckpointExitDelayPolicy(networks.regtest)).toEqual({
            minSeconds: REGTEST_MIN_CHECKPOINT_EXIT_DELAY_SECONDS,
            requireSeconds: false,
        });
    });

    it("applies overrides on top of the network default", () => {
        expect(resolveCheckpointExitDelayPolicy(networks.bitcoin, { minSeconds: 0n })).toEqual({
            minSeconds: 0n,
            requireSeconds: true,
        });
    });
});

describe("assertValidServerUnrollScript", () => {
    const cases: Array<[bigint, keyof typeof networks, "accept" | "reject", string]> = [
        [1n, "bitcoin", "reject", "1-block sweep"],
        [511n, "bitcoin", "reject", "max block-typed value"],
        [512n, "bitcoin", "reject", "8.5 minutes"],
        [86_016n, "bitcoin", "reject", "512*168, just under 24h"],
        [86_528n, "bitcoin", "accept", "512*169, just over 24h"],
        [604_672n, "bitcoin", "accept", "arkd default, ~7 days"],
        [1n, "regtest", "reject", "1-block sweep on regtest"],
        // ARKD_CHECKPOINT_EXIT_DELAY defaults used across this repo's regtest
        // envs: 5 (packages/boltz-swap/.env.regtest) and 20
        // (packages/ts-sdk/.env.regtest, packages/swap/.env.regtest) — both
        // must clear the regtest floor.
        [5n, "regtest", "accept", "boltz-swap regtest env value"],
        [20n, "regtest", "accept", "ts-sdk/swap regtest env value"],
    ];

    for (const [value, network, expected, label] of cases) {
        it(`${expected}s ${value} on ${network} (${label})`, () => {
            const checkpointTapscript = encodeCheckpointTapscript(value);
            const run = () =>
                assertValidServerUnrollScript(
                    checkpointTapscript,
                    defaultCheckpointExitDelayPolicy(networks[network]),
                );
            if (expected === "accept") {
                const result = run();
                expect(result.params.timelock).toEqual({
                    value,
                    type: value >= 512n ? "seconds" : "blocks",
                });
            } else {
                expect(run).toThrow(ServerResponseMismatchError);
            }
        });
    }

    it("rejects an undecodable script", () => {
        expect(() =>
            assertValidServerUnrollScript("zz", defaultCheckpointExitDelayPolicy(networks.bitcoin)),
        ).toThrow(ServerResponseMismatchError);
        expect(() =>
            assertValidServerUnrollScript("zz", defaultCheckpointExitDelayPolicy(networks.bitcoin)),
        ).toThrow(/invalid checkpointTapscript from server/);
    });

    it("rejects an empty script", () => {
        expect(() =>
            assertValidServerUnrollScript("", defaultCheckpointExitDelayPolicy(networks.bitcoin)),
        ).toThrow(ServerResponseMismatchError);
    });

    it("rejects a pubkey that does not match the advertised forfeitPubkey", () => {
        const checkpointTapscript = encodeCheckpointTapscript(604_672n, OTHER_XONLY);
        expect(() =>
            assertValidServerUnrollScript(
                checkpointTapscript,
                resolveCheckpointExitDelayPolicy(networks.bitcoin, {
                    advertisedForfeitPubkey: hex.decode(FORFEIT_XONLY),
                }),
            ),
        ).toThrow(/do not match the advertised forfeitPubkey/);
    });

    it("accepts a pubkey equal to the advertised forfeitPubkey", () => {
        const checkpointTapscript = encodeCheckpointTapscript(604_672n, FORFEIT_XONLY);
        const result = assertValidServerUnrollScript(
            checkpointTapscript,
            resolveCheckpointExitDelayPolicy(networks.bitcoin, {
                advertisedForfeitPubkey: hex.decode(FORFEIT_XONLY),
            }),
        );
        expect(hex.encode(result.params.pubkeys[0])).toBe(FORFEIT_XONLY);
    });

    it("skips the pubkey check when nothing is advertised", () => {
        const checkpointTapscript = encodeCheckpointTapscript(604_672n, OTHER_XONLY);
        expect(() =>
            assertValidServerUnrollScript(
                checkpointTapscript,
                defaultCheckpointExitDelayPolicy(networks.bitcoin),
            ),
        ).not.toThrow();
    });

    it("still applies the floor when no pubkey is advertised", () => {
        const checkpointTapscript = encodeCheckpointTapscript(512n);
        expect(() =>
            assertValidServerUnrollScript(
                checkpointTapscript,
                defaultCheckpointExitDelayPolicy(networks.bitcoin),
            ),
        ).toThrow(/below the 86400s floor/);
    });
});
