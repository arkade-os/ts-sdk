import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";

import { assertValidServerUnrollScript } from "../src/wallet/checkpointExitDelay";
import { ServerResponseMismatchError } from "../src/providers/errors";
import { networks } from "../src/networks";
import { CSVMultisigTapscript } from "../src/script/tapscript";

const FORFEIT_XONLY = "11".repeat(32);
const OTHER_XONLY = "22".repeat(32);
const FORFEIT = hex.decode(FORFEIT_XONLY);

function encodeCheckpointTapscript(value: bigint, pubkeyXOnlyHex: string = FORFEIT_XONLY): string {
    const timelock = { value, type: value >= 512n ? ("seconds" as const) : ("blocks" as const) };
    return hex.encode(
        CSVMultisigTapscript.encode({
            timelock,
            pubkeys: [hex.decode(pubkeyXOnlyHex)],
        }).script,
    );
}

describe("assertValidServerUnrollScript", () => {
    const cases: Array<[bigint, keyof typeof networks, "accept" | "reject", string]> = [
        [1n, "bitcoin", "reject", "block-typed"],
        [511n, "bitcoin", "reject", "max block-typed value"],
        [512n, "bitcoin", "accept", "smallest seconds-typed CSV"],
        [4_096n, "bitcoin", "accept", "hosted mutinynet value"],
        [86_016n, "bitcoin", "accept", "hosted signet value"],
        [604_672n, "bitcoin", "accept", "arkd default, ~7 days"],
        [1n, "testnet", "reject", "block-typed"],
        [1n, "signet", "reject", "block-typed"],
        [1n, "mutinynet", "reject", "block-typed"],
        [0n, "regtest", "reject", "zero blocks"],
        [1n, "regtest", "accept", "1 block"],
        [20n, "regtest", "accept", "SDK/swap regtest env value"],
        [512n, "regtest", "accept", "seconds-typed on regtest"],
    ];

    for (const [value, network, expected, label] of cases) {
        it(`${expected}s ${value} on ${network} (${label})`, () => {
            const run = () =>
                assertValidServerUnrollScript(encodeCheckpointTapscript(value), networks[network]);
            if (expected === "accept") {
                expect(run().params.timelock).toEqual({
                    value,
                    type: value >= 512n ? "seconds" : "blocks",
                });
            } else {
                expect(run).toThrow(ServerResponseMismatchError);
            }
        });
    }

    it("rejects an undecodable script", () => {
        expect(() => assertValidServerUnrollScript("zz", networks.bitcoin)).toThrow(
            ServerResponseMismatchError,
        );
        expect(() => assertValidServerUnrollScript("zz", networks.bitcoin)).toThrow(
            /invalid checkpointTapscript from server/,
        );
    });

    it("rejects an empty script", () => {
        expect(() => assertValidServerUnrollScript("", networks.bitcoin)).toThrow(
            ServerResponseMismatchError,
        );
    });

    it("rejects a pubkey that does not match the advertised forfeitPubkey", () => {
        expect(() =>
            assertValidServerUnrollScript(
                encodeCheckpointTapscript(604_672n, OTHER_XONLY),
                networks.bitcoin,
                FORFEIT,
            ),
        ).toThrow(/does not match the advertised forfeitPubkey/);
    });

    it("accepts a pubkey equal to the advertised forfeitPubkey", () => {
        const result = assertValidServerUnrollScript(
            encodeCheckpointTapscript(604_672n, FORFEIT_XONLY),
            networks.bitcoin,
            FORFEIT,
        );
        expect(hex.encode(result.params.pubkeys[0])).toBe(FORFEIT_XONLY);
    });

    it("skips the pubkey check when nothing is advertised", () => {
        expect(() =>
            assertValidServerUnrollScript(
                encodeCheckpointTapscript(604_672n, OTHER_XONLY),
                networks.bitcoin,
            ),
        ).not.toThrow();
    });

    it("reports a multi-pubkey script distinctly from a wrong single pubkey", () => {
        const checkpointTapscript = hex.encode(
            CSVMultisigTapscript.encode({
                timelock: { value: 604_672n, type: "seconds" },
                pubkeys: [FORFEIT, hex.decode(OTHER_XONLY)],
            }).script,
        );
        expect(() =>
            assertValidServerUnrollScript(checkpointTapscript, networks.bitcoin, FORFEIT),
        ).toThrow(/must commit to exactly one pubkey, got 2/);
    });

    it("does not name a config option when rejecting the floor", () => {
        expect(() =>
            assertValidServerUnrollScript(encodeCheckpointTapscript(0n), networks.regtest),
        ).toThrow(/below the 512s floor$/);
    });

    describe("block-typed timelocks above the 512 seconds boundary", () => {
        const blocks = (value: bigint) =>
            hex.encode(
                CSVMultisigTapscript.encode({
                    timelock: { value, type: "blocks" },
                    pubkeys: [FORFEIT],
                }).script,
            );

        it("rejects them as block-typed on mainnet", () => {
            expect(() => assertValidServerUnrollScript(blocks(1_000n), networks.bitcoin)).toThrow(
                /block-typed timelocks are not accepted \(got 1000\)/,
            );
        });

        it("keeps the block type on regtest instead of reading them as seconds", () => {
            const result = assertValidServerUnrollScript(blocks(600n), networks.regtest);
            expect(result.params.timelock).toEqual({ value: 600n, type: "blocks" });
        });
    });
});

describe("hosted Arkade Services", () => {
    const ADVERTISED = {
        bitcoin: {
            tapscript:
                "039e0440b27520b43a8363118c084a04d4f6a50ebfa58e81957f8cceceb2aee0ab64c9fd2d9977ac",
            seconds: 605_184n,
        },
        signet: {
            tapscript:
                "03a80040b275202697695adaf0635333d6240739de02feb3f6852e180c596b69a77536aadb7123ac",
            seconds: 86_016n,
        },
        mutinynet: {
            tapscript:
                "03080040b27520dfcaec558c7e78cf3e38b898ba8a43cfb5727266bae32c5c5b3aeb32c558aa0bac",
            seconds: 4_096n,
        },
    } as const;

    for (const [network, { tapscript, seconds }] of Object.entries(ADVERTISED)) {
        it(`accepts what the hosted ${network} service serves`, () => {
            const result = assertValidServerUnrollScript(
                tapscript,
                networks[network as keyof typeof ADVERTISED],
            );
            expect(result.params.timelock).toEqual({ value: seconds, type: "seconds" });
        });
    }
});
