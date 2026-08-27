import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";

import {
    assertValidServerUnrollScript,
    defaultCheckpointExitDelayPolicy,
    resolveCheckpointExitDelayPolicy,
    DEFAULT_MIN_CHECKPOINT_EXIT_DELAY_SECONDS,
    REGTEST_MIN_CHECKPOINT_EXIT_DELAY_SECONDS,
    MUTINYNET_MIN_CHECKPOINT_EXIT_DELAY_SECONDS,
    SIGNET_MIN_CHECKPOINT_EXIT_DELAY_SECONDS,
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
        // ARKD_CHECKPOINT_EXIT_DELAY values a regtest deployment may set; both
        // must clear the regtest floor. This repo's own envs are all 20 now —
        // 5 is kept as coverage of the lower bound the floor was sized for.
        [5n, "regtest", "accept", "low block-typed regtest value"],
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
        ).toThrow(/does not match the advertised forfeitPubkey/);
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

    it("reports a multi-pubkey script distinctly from a wrong single pubkey", () => {
        const checkpointTapscript = hex.encode(
            CSVMultisigTapscript.encode({
                timelock: { value: 604_672n, type: "seconds" },
                pubkeys: [hex.decode(FORFEIT_XONLY), hex.decode(OTHER_XONLY)],
            }).script,
        );
        expect(() =>
            assertValidServerUnrollScript(
                checkpointTapscript,
                resolveCheckpointExitDelayPolicy(networks.bitcoin, {
                    advertisedForfeitPubkey: hex.decode(FORFEIT_XONLY),
                }),
            ),
        ).toThrow(/must commit to exactly one pubkey, got 2/);
    });

    // A block-typed timelock above 511 is legal BIP-68 (the type comes from the
    // disable flag, not the magnitude). Re-deriving the type from the value
    // would read it as seconds, letting it slip past `requireSeconds` and
    // mis-scale it against the floor.
    describe("block-typed timelocks above the 512 seconds boundary", () => {
        const blocks = (value: number) =>
            hex.encode(
                CSVMultisigTapscript.encode({
                    timelock: { value, type: "blocks" },
                    pubkeys: [hex.decode(FORFEIT_XONLY)],
                }).script,
            );

        it("rejects them as block-typed on mainnet, even below the floor in nominal seconds", () => {
            expect(() =>
                assertValidServerUnrollScript(
                    blocks(1_000),
                    resolveCheckpointExitDelayPolicy(networks.bitcoin, { minSeconds: 600n }),
                ),
            ).toThrow(/block-typed timelocks are not accepted \(got 1000\)/);
        });

        it("scales them by nominal block time on regtest instead of reading them as seconds", () => {
            // 600 blocks is ~100h of nominal wall clock, far above the regtest
            // floor — but only 600 if misread as seconds.
            const result = assertValidServerUnrollScript(
                blocks(600),
                defaultCheckpointExitDelayPolicy(networks.regtest),
            );
            expect(result.params.timelock).toEqual({ value: 600n, type: "blocks" });
        });
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

    it("names the override that would accept the delay", () => {
        // The floor is a client-side policy, so a rejection is actionable — but
        // only if the message says which knob moves it. 4096s is what the hosted
        // mutinynet operator advertises, and mutinynet is structurally identical
        // to testnet here, so this is the rejection consumers actually meet.
        expect(() =>
            assertValidServerUnrollScript(
                encodeCheckpointTapscript(4096n),
                defaultCheckpointExitDelayPolicy(networks.bitcoin),
            ),
        ).toThrow(/minCheckpointExitDelaySeconds/);
    });

    it("quotes the value that would accept it, not just the option name", () => {
        // Naming the option still leaves the reader to derive what to set it to.
        // The rejected delay is exactly that value, so the message carries it
        // and nothing has to be worked out from the rest of the sentence.
        expect(() =>
            assertValidServerUnrollScript(
                encodeCheckpointTapscript(4096n),
                defaultCheckpointExitDelayPolicy(networks.bitcoin),
            ),
        ).toThrow(/minCheckpointExitDelaySeconds: 4096n/);
    });
});

describe("hosted networks that advertise below the generic floor", () => {
    // Verbatim `ArkInfo.checkpointTapscript` as served by each hosted Arkade
    // Service. Held as raw wire strings rather than re-encoded from the
    // constants, so a constant that drifts from what the operator actually
    // serves fails here instead of passing against itself.
    const ADVERTISED = {
        bitcoin: "039e0440b27520b43a8363118c084a04d4f6a50ebfa58e81957f8cceceb2aee0ab64c9fd2d9977ac",
        signet: "03a80040b275202697695adaf0635333d6240739de02feb3f6852e180c596b69a77536aadb7123ac",
        mutinynet:
            "03080040b27520dfcaec558c7e78cf3e38b898ba8a43cfb5727266bae32c5c5b3aeb32c558aa0bac",
    } as const;

    it("defaults mutinynet to the delay its operator advertises", () => {
        expect(MUTINYNET_MIN_CHECKPOINT_EXIT_DELAY_SECONDS).toBe(4_096n);
        expect(defaultCheckpointExitDelayPolicy(networks.mutinynet)).toEqual({
            minSeconds: MUTINYNET_MIN_CHECKPOINT_EXIT_DELAY_SECONDS,
            requireSeconds: true,
        });
    });

    it("defaults signet to the delay its operator advertises", () => {
        // 168 * 512: a 24h setting rounded down to BIP-68's 512s granularity,
        // which is the only reason it misses the 86400s floor — by 384s.
        expect(SIGNET_MIN_CHECKPOINT_EXIT_DELAY_SECONDS).toBe(86_016n);
        expect(defaultCheckpointExitDelayPolicy(networks.signet)).toEqual({
            minSeconds: SIGNET_MIN_CHECKPOINT_EXIT_DELAY_SECONDS,
            requireSeconds: true,
        });
    });

    it("leaves bitcoin and testnet on the generic floor", () => {
        expect(defaultCheckpointExitDelayPolicy(networks.bitcoin).minSeconds).toBe(
            DEFAULT_MIN_CHECKPOINT_EXIT_DELAY_SECONDS,
        );
        expect(defaultCheckpointExitDelayPolicy(networks.testnet).minSeconds).toBe(
            DEFAULT_MIN_CHECKPOINT_EXIT_DELAY_SECONDS,
        );
    });

    // Each network's floor is exactly the delay its own fixture decodes to, so
    // asserting the decoded value against the constant pins the two together:
    // a constant moved in either direction stops matching the wire bytes.
    const ADVERTISED_SECONDS = {
        bitcoin: 605_184n,
        signet: SIGNET_MIN_CHECKPOINT_EXIT_DELAY_SECONDS,
        mutinynet: MUTINYNET_MIN_CHECKPOINT_EXIT_DELAY_SECONDS,
    } as const;

    for (const network of ["bitcoin", "signet", "mutinynet"] as const) {
        it(`accepts what the hosted ${network} service serves, with no override`, () => {
            const result = assertValidServerUnrollScript(
                ADVERTISED[network],
                defaultCheckpointExitDelayPolicy(networks[network]),
            );
            expect(result.params.timelock).toEqual({
                value: ADVERTISED_SECONDS[network],
                type: "seconds",
            });
        });
    }

    it("does not spill the relaxed floors onto testnet", () => {
        // testnet shares every other `Network` field with signet and mutinynet,
        // so a default keyed on anything but the name would relax it too.
        for (const tapscript of [ADVERTISED.signet, ADVERTISED.mutinynet]) {
            expect(() =>
                assertValidServerUnrollScript(
                    tapscript,
                    defaultCheckpointExitDelayPolicy(networks.testnet),
                ),
            ).toThrow(/below the 86400s floor/);
        }
    });

    it("keeps the generic floor for a Network that carries no name", () => {
        // Fail closed: a hand-built network has no name to match on and must not
        // inherit a relaxed floor just because it looks like the tb-family.
        const { name, ...unnamed } = networks.mutinynet;
        expect(name).toBe("mutinynet");
        expect(defaultCheckpointExitDelayPolicy(unnamed).minSeconds).toBe(
            DEFAULT_MIN_CHECKPOINT_EXIT_DELAY_SECONDS,
        );
    });
});
