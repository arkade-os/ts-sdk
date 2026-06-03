import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { BoardingContractHandler } from "../../../src/contracts/handlers/boarding";
import { DefaultContractHandler } from "../../../src/contracts/handlers/default";
import {
    contractHandlers,
    DefaultVtxo,
    BoardingContractHandler as RootBoardingContractHandler,
} from "../../../src";
import { isDiscoverable } from "../../../src/contracts/types";
import { sequenceToTimelock, timelockToSequence } from "../../../src/utils/timelock";

const TEST_PUB_KEY_HEX = "5b3a7b5e8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f";
const TEST_PUB_KEY = hex.decode(TEST_PUB_KEY_HEX);
const TEST_SERVER_PUB_KEY_HEX = "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b";
const TEST_SERVER_PUB_KEY = hex.decode(TEST_SERVER_PUB_KEY_HEX);

// Boarding-exit delay sourced from ArkInfo.boardingExitDelay (seconds),
// distinct from the offchain unilateral-exit delay used by `default`.
const BOARDING_EXIT_DELAY = { value: 86016n, type: "seconds" as const };
const UNILATERAL_EXIT_DELAY = { value: 512n, type: "seconds" as const };

const boardingParams = (csvTimelock = BOARDING_EXIT_DELAY) => ({
    pubKey: TEST_PUB_KEY_HEX,
    serverPubKey: TEST_SERVER_PUB_KEY_HEX,
    csvTimelock: timelockToSequence(csvTimelock).toString(),
});

describe("BoardingContractHandler registration", () => {
    it("is registered under type 'boarding'", () => {
        expect(contractHandlers.has("boarding")).toBe(true);
        const handler = contractHandlers.get("boarding");
        expect(handler).toBeDefined();
        expect(handler?.type).toBe("boarding");
    });

    it("registers the exported handler object instance", () => {
        expect(BoardingContractHandler.type).toBe("boarding");
        expect(contractHandlers.get("boarding")).toBe(BoardingContractHandler);
    });

    it("is exported from the package root (the only public entrypoint)", () => {
        // package.json exposes only "." for the core API, so consumers must be
        // able to import the built-in handler from the root entry like the
        // default/delegate/vhtlc handlers.
        expect(RootBoardingContractHandler).toBe(BoardingContractHandler);
        expect(RootBoardingContractHandler.type).toBe("boarding");
    });
});

describe("BoardingContractHandler.createScript", () => {
    it("matches the boardingTapscript construction (DefaultVtxo.Script) for the boarding timelock", () => {
        // The current/legacy wallet-setup construction of boardingTapscript.
        const legacy = new DefaultVtxo.Script({
            pubKey: TEST_PUB_KEY,
            serverPubKey: TEST_SERVER_PUB_KEY,
            csvTimelock: BOARDING_EXIT_DELAY,
        });

        const fromHandler = BoardingContractHandler.createScript(boardingParams());

        expect(fromHandler).toBeInstanceOf(DefaultVtxo.Script);
        expect(hex.encode(fromHandler.pkScript)).toEqual(hex.encode(legacy.pkScript));
    });

    it("produces a DefaultVtxo.Script with forfeit and exit leaves", () => {
        const script = BoardingContractHandler.createScript(boardingParams());
        expect(script.forfeit()).toBeDefined();
        expect(script.exit()).toBeDefined();
    });

    it("sources the CSV timelock from the boarding delay, not the unilateral exit delay", () => {
        const boarding = BoardingContractHandler.createScript(boardingParams(BOARDING_EXIT_DELAY));
        const offchain = DefaultContractHandler.createScript({
            pubKey: TEST_PUB_KEY_HEX,
            serverPubKey: TEST_SERVER_PUB_KEY_HEX,
            csvTimelock: timelockToSequence(UNILATERAL_EXIT_DELAY).toString(),
        });

        // Same pubkeys, different CSV timelock value → different pkScript.
        expect(hex.encode(boarding.pkScript)).not.toEqual(hex.encode(offchain.pkScript));

        // Boarding built from the boarding delay matches default built from the
        // same boarding delay — they share a script shape, differing only by the
        // CSV value. This pins that boarding adds no new timelock semantics.
        const defaultWithBoardingDelay = DefaultContractHandler.createScript(boardingParams());
        expect(hex.encode(boarding.pkScript)).toEqual(
            hex.encode(defaultWithBoardingDelay.pkScript),
        );
    });
});

describe("BoardingContractHandler on-chain & Arkade address derivation", () => {
    it("derives the on-chain boarding address from the handler script (matches legacy boardingTapscript)", () => {
        const network = { bech32: "bcrt", hrp: "tark" } as any;
        const legacy = new DefaultVtxo.Script({
            pubKey: TEST_PUB_KEY,
            serverPubKey: TEST_SERVER_PUB_KEY,
            csvTimelock: BOARDING_EXIT_DELAY,
        });
        const fromHandler = BoardingContractHandler.createScript(boardingParams());

        expect(fromHandler.onchainAddress(network)).toEqual(legacy.onchainAddress(network));
    });

    it("derives the Arkade address matching DefaultVtxo.Script for the same hrp/server key/params", () => {
        const hrp = "tark";
        const legacy = new DefaultVtxo.Script({
            pubKey: TEST_PUB_KEY,
            serverPubKey: TEST_SERVER_PUB_KEY,
            csvTimelock: BOARDING_EXIT_DELAY,
        });
        const fromHandler = BoardingContractHandler.createScript(boardingParams());

        expect(fromHandler.address(hrp, TEST_SERVER_PUB_KEY).encode()).toEqual(
            legacy.address(hrp, TEST_SERVER_PUB_KEY).encode(),
        );
    });
});

describe("BoardingContractHandler param serialize/deserialize", () => {
    it("round-trips params using the same timelock helpers as default", () => {
        const typed = {
            pubKey: TEST_PUB_KEY,
            serverPubKey: TEST_SERVER_PUB_KEY,
            csvTimelock: BOARDING_EXIT_DELAY,
        };

        const serialized = BoardingContractHandler.serializeParams(typed);
        expect(serialized).toEqual(DefaultContractHandler.serializeParams(typed));
        expect(serialized.csvTimelock).toEqual(timelockToSequence(BOARDING_EXIT_DELAY).toString());

        const deserialized = BoardingContractHandler.deserializeParams(serialized);
        expect(Array.from(deserialized.pubKey)).toEqual(Array.from(TEST_PUB_KEY));
        expect(Array.from(deserialized.serverPubKey)).toEqual(Array.from(TEST_SERVER_PUB_KEY));
        expect(deserialized.csvTimelock).toEqual(BOARDING_EXIT_DELAY);
    });

    it("produces an identical pkScript after a serialize round trip", () => {
        const typed = {
            pubKey: TEST_PUB_KEY,
            serverPubKey: TEST_SERVER_PUB_KEY,
            csvTimelock: BOARDING_EXIT_DELAY,
        };
        const serialized = BoardingContractHandler.serializeParams(typed);
        const script1 = BoardingContractHandler.createScript(serialized);

        const reserialized = BoardingContractHandler.serializeParams(
            BoardingContractHandler.deserializeParams(serialized),
        );
        const script2 = BoardingContractHandler.createScript(reserialized);

        expect(hex.encode(script2.pkScript)).toEqual(hex.encode(script1.pkScript));
    });

    it("falls back to the default timelock when csvTimelock is missing", () => {
        const script = BoardingContractHandler.createScript({
            pubKey: TEST_PUB_KEY_HEX,
            serverPubKey: TEST_SERVER_PUB_KEY_HEX,
        });
        const expected = new DefaultVtxo.Script({
            pubKey: TEST_PUB_KEY,
            serverPubKey: TEST_SERVER_PUB_KEY,
            csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
        });
        expect(hex.encode(script.pkScript)).toEqual(hex.encode(expected.pkScript));
    });

    it("throws on invalid pubkey params", () => {
        expect(() =>
            BoardingContractHandler.createScript({
                pubKey: "not-hex",
                serverPubKey: TEST_SERVER_PUB_KEY_HEX,
                csvTimelock: timelockToSequence(BOARDING_EXIT_DELAY).toString(),
            }),
        ).toThrow();
    });

    it("uses the same BIP68 sequence round-trip as default/delegate", () => {
        const seq = timelockToSequence(BOARDING_EXIT_DELAY);
        expect(sequenceToTimelock(seq)).toEqual(BOARDING_EXIT_DELAY);
    });
});

describe("BoardingContractHandler is not discoverable", () => {
    it("does not implement discoverAt", () => {
        expect((BoardingContractHandler as { discoverAt?: unknown }).discoverAt).toBeUndefined();
    });

    it("isDiscoverable(BoardingContractHandler) is false", () => {
        expect(isDiscoverable(BoardingContractHandler)).toBe(false);
        // sanity: the default handler IS discoverable, proving the guard works
        expect(isDiscoverable(DefaultContractHandler)).toBe(true);
    });

    it("is excluded from the scanner's discoverable handler set", () => {
        const discoverables = contractHandlers
            .getRegisteredTypes()
            .map((t) => contractHandlers.get(t))
            .filter(isDiscoverable)
            .map((h) => h!.type);
        expect(discoverables).not.toContain("boarding");
    });
});

describe("BoardingContractHandler spend paths reuse the default surface", () => {
    const params = boardingParams();
    const script = BoardingContractHandler.createScript(params);
    const contract = {
        type: "boarding",
        params,
        script: hex.encode(script.pkScript),
        address: "address",
        state: "active" as const,
        createdAt: 0,
    };

    it("selects the forfeit path when collaborative", () => {
        const path = BoardingContractHandler.selectPath(script, contract, {
            collaborative: true,
            currentTime: 0,
        });
        expect(path?.leaf).toBeDefined();
    });

    it("selects the exit path (with sequence) after the boarding CSV matures", () => {
        const paths = BoardingContractHandler.getSpendablePaths(script, contract, {
            collaborative: false,
            currentTime: Date.now(),
            blockHeight: 300,
            vtxo: {
                txid: "00".repeat(32),
                vout: 0,
                value: 1000,
                status: { confirmed: true, block_height: 100, block_time: 1 },
                virtualStatus: { state: "settled" },
                createdAt: new Date(),
            } as any,
        });
        expect(paths).toHaveLength(1);
        expect(paths[0].sequence).toEqual(Number(params.csvTimelock));
    });
});
