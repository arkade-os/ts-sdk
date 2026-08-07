import { describe, it, expect, vi } from "vitest";
import { hex } from "@scure/base";
import { sha256 } from "@scure/btc-signer/utils.js";

import {
    assertValidBatchExpiry,
    defaultBatchExpiryPolicy,
    resolveBatchExpiryPolicy,
    DEFAULT_MIN_BATCH_EXPIRY_SECONDS,
    REGTEST_MIN_BATCH_EXPIRY_SECONDS,
} from "../src/wallet/batchExpiry";
import { createArkadeBatchHandler } from "../src/arkade/batch";
import { ServerResponseMismatchError } from "../src/providers/errors";
import { networks } from "../src/networks";
import type { SignerSession } from "../src/tree/signingSession";
import type { ArkProvider, BatchStartedEvent } from "../src/providers/ark";
import type { EmulatorProvider } from "../src/providers/emulator";
import type { Identity } from "../src/identity";
import type { Intent } from "../src/intent";

const INTENT_ID = "intent-123";
const SIGNER_XONLY = "11".repeat(32);

describe("defaultBatchExpiryPolicy", () => {
    it("requires seconds off regtest", () => {
        expect(defaultBatchExpiryPolicy(networks.bitcoin)).toEqual({
            minSeconds: DEFAULT_MIN_BATCH_EXPIRY_SECONDS,
            requireSeconds: true,
        });
        expect(defaultBatchExpiryPolicy(networks.testnet).requireSeconds).toBe(true);
        expect(defaultBatchExpiryPolicy(networks.signet).requireSeconds).toBe(true);
        expect(defaultBatchExpiryPolicy(networks.mutinynet).requireSeconds).toBe(true);
    });

    it("allows blocks on regtest with a lower floor", () => {
        expect(defaultBatchExpiryPolicy(networks.regtest)).toEqual({
            minSeconds: REGTEST_MIN_BATCH_EXPIRY_SECONDS,
            requireSeconds: false,
        });
    });

    it("applies overrides on top of the network default", () => {
        expect(resolveBatchExpiryPolicy(networks.bitcoin, { minSeconds: 0n })).toEqual({
            minSeconds: 0n,
            requireSeconds: true,
        });
    });
});

describe("assertValidBatchExpiry", () => {
    const cases: Array<[bigint, keyof typeof networks, "accept" | "reject", string]> = [
        [1n, "bitcoin", "reject", "1-block sweep"],
        [511n, "bitcoin", "reject", "max block-typed value"],
        [512n, "bitcoin", "reject", "8.5 minutes"],
        [86_016n, "bitcoin", "reject", "512*168, just under 24h"],
        [86_528n, "bitcoin", "accept", "512*169, just over 24h"],
        [604_672n, "bitcoin", "accept", "arkd default, ~7 days"],
        [1n, "regtest", "reject", "1-block sweep on regtest"],
        [10n, "regtest", "accept", "at the regtest floor"],
        [100n, "regtest", "accept", "unit-test fixture value"],
        [180n, "regtest", "accept", "compose.ark.yml value"],
    ];

    for (const [value, network, expected, label] of cases) {
        it(`${expected}s ${value} on ${network} (${label})`, () => {
            const run = () =>
                assertValidBatchExpiry(value, defaultBatchExpiryPolicy(networks[network]));
            if (expected === "accept") {
                expect(run()).toEqual({
                    value,
                    type: value >= 512n ? "seconds" : "blocks",
                });
            } else {
                expect(run).toThrow(ServerResponseMismatchError);
            }
        });
    }

    it("rejects a value that differs from the advertised vtxoTreeExpiry", () => {
        expect(() =>
            assertValidBatchExpiry(86_528n, {
                minSeconds: 0n,
                requireSeconds: false,
                advertisedVtxoTreeExpiry: 604_672n,
            }),
        ).toThrow(/does not match the advertised vtxoTreeExpiry 604672/);
    });

    it("accepts a value equal to the advertised vtxoTreeExpiry", () => {
        expect(
            assertValidBatchExpiry(604_672n, {
                ...defaultBatchExpiryPolicy(networks.bitcoin),
                advertisedVtxoTreeExpiry: 604_672n,
            }),
        ).toEqual({ value: 604_672n, type: "seconds" });
    });

    it("still applies the floor when nothing is advertised", () => {
        expect(() =>
            assertValidBatchExpiry(512n, {
                ...defaultBatchExpiryPolicy(networks.bitcoin),
                advertisedVtxoTreeExpiry: undefined,
            }),
        ).toThrow(/below the 86400s floor/);
    });

    it("still applies the floor when the value equals the advertised vtxoTreeExpiry", () => {
        expect(() =>
            assertValidBatchExpiry(512n, {
                ...defaultBatchExpiryPolicy(networks.bitcoin),
                advertisedVtxoTreeExpiry: 512n,
            }),
        ).toThrow(/below the 86400s floor/);
    });

    it("still rejects a block-typed value equal to the advertised vtxoTreeExpiry", () => {
        expect(() =>
            assertValidBatchExpiry(144n, {
                ...defaultBatchExpiryPolicy(networks.bitcoin),
                advertisedVtxoTreeExpiry: 144n,
            }),
        ).toThrow(/block-typed timelocks are not accepted/);
    });
});

describe("createArkadeBatchHandler batch expiry", () => {
    function makeArkProvider() {
        return {
            confirmRegistration: vi.fn(async () => {}),
            getInfo: vi.fn(async () => ({
                forfeitPubkey: "02" + "22".repeat(32),
            })),
        } as unknown as ArkProvider;
    }

    function makeSession() {
        return {
            getPublicKey: vi.fn(async () => hex.decode("02" + SIGNER_XONLY)),
            init: vi.fn(async () => {}),
        } as unknown as SignerSession;
    }

    function makeHandler(
        arkProvider: ArkProvider,
        session: SignerSession,
        network = networks.bitcoin,
    ) {
        return createArkadeBatchHandler(
            INTENT_ID,
            [],
            {} as unknown as Identity,
            "signed-proof",
            {} as unknown as Intent.RegisterMessage,
            session,
            arkProvider,
            {} as unknown as EmulatorProvider,
            network,
        );
    }

    const batchStarted = (batchExpiry: bigint) =>
        ({
            id: "batch-1",
            intentIdHashes: [hex.encode(sha256(new TextEncoder().encode(INTENT_ID)))],
            batchExpiry,
        }) as unknown as BatchStartedEvent;

    it("rejects an out-of-policy expiry without confirming or initializing signing", async () => {
        const arkProvider = makeArkProvider();
        const session = makeSession();

        await expect(
            makeHandler(arkProvider, session).onBatchStarted(batchStarted(1n)),
        ).rejects.toThrow(ServerResponseMismatchError);

        expect(arkProvider.confirmRegistration).not.toHaveBeenCalled();
        expect(session.init).not.toHaveBeenCalled();
    });

    it("confirms and proceeds on an in-policy expiry", async () => {
        const arkProvider = makeArkProvider();

        await expect(
            makeHandler(arkProvider, makeSession()).onBatchStarted(batchStarted(604_672n)),
        ).resolves.toEqual({ skip: false });

        expect(arkProvider.confirmRegistration).toHaveBeenCalledWith(INTENT_ID);
    });

    it("does not validate or confirm when the intent is not ours", async () => {
        const arkProvider = makeArkProvider();

        await expect(
            makeHandler(arkProvider, makeSession()).onBatchStarted({
                id: "batch-1",
                intentIdHashes: ["ff".repeat(32)],
                batchExpiry: 1n,
            } as unknown as BatchStartedEvent),
        ).resolves.toEqual({ skip: true });

        expect(arkProvider.confirmRegistration).not.toHaveBeenCalled();
    });
});
