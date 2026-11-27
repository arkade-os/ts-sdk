import { describe, expect, it } from "vitest";
import {
    BITCOIN_EMULATOR_PUBKEY,
    getNetwork,
    MUTINYNET_EMULATOR_PUBKEY,
    trustedEmulatorOverride,
} from "../src/networks";

const RETIRED = "02" + "11".repeat(32);
const OWN = "03" + "22".repeat(32);
const retired = { bitcoin: [RETIRED] };

describe("trustedEmulatorOverride", () => {
    const bitcoin = getNetwork("bitcoin");

    it("drops the current pin", () => {
        expect(trustedEmulatorOverride(bitcoin, BITCOIN_EMULATOR_PUBKEY, retired)).toBeUndefined();
    });

    it("drops a retired pin of the network", () => {
        expect(trustedEmulatorOverride(bitcoin, RETIRED, retired)).toBeUndefined();
        expect(trustedEmulatorOverride(bitcoin, RETIRED.toUpperCase(), retired)).toBeUndefined();
    });

    it("keeps an app's own key", () => {
        expect(trustedEmulatorOverride(bitcoin, OWN, retired)).toBe(OWN);
    });

    it("does not read another network's pin as the network's own", () => {
        expect(trustedEmulatorOverride(bitcoin, MUTINYNET_EMULATOR_PUBKEY, retired)).toBe(
            MUTINYNET_EMULATOR_PUBKEY,
        );
    });

    it("keeps every key on a network with no pin", () => {
        const signet = getNetwork("signet");
        expect(trustedEmulatorOverride(signet, RETIRED, { signet: [RETIRED] })).toBe(RETIRED);
        expect(trustedEmulatorOverride({ ...bitcoin, name: undefined }, OWN)).toBe(OWN);
    });
});
