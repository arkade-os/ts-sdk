import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";

import { networks } from "../src/networks";
import { arkade, CSVMultisigTapscript } from "../src";

const SERVER_XONLY = "11".repeat(32);

/**
 * Minimal providers for `Arkade.connect`. The emulator counts its `getInfo`
 * calls so a test can assert connect never asks it who it is.
 */
function stubProviders(emulatorSignerPubkey: string) {
    let emulatorInfoCalls = 0;
    const checkpointTapscript = hex.encode(
        CSVMultisigTapscript.encode({
            timelock: { type: "blocks", value: 10n },
            pubkeys: [hex.decode(SERVER_XONLY)],
        }).script,
    );
    const arkProvider = {
        async getInfo() {
            return { signerPubkey: "02" + SERVER_XONLY, checkpointTapscript } as any;
        },
        async submitTx() {
            throw new Error("not used");
        },
        async finalizeTx() {},
    } as any;
    const emulator = {
        async getInfo() {
            emulatorInfoCalls++;
            return { signerPubkey: emulatorSignerPubkey };
        },
        async submitTx() {
            throw new Error("not used");
        },
        async submitIntent() {
            throw new Error("not used");
        },
        async submitFinalization() {
            throw new Error("not used");
        },
        async submitOnchainTx() {
            throw new Error("not used");
        },
    } as any;
    return { arkProvider, emulator, emulatorInfoCalls: () => emulatorInfoCalls };
}

describe("Arkade.connect co-signer resolution", () => {
    const CLAIMED = "03" + "ab".repeat(32);

    it("uses arkd's signer key and never asks the emulator who it is", async () => {
        const { arkProvider, emulator, emulatorInfoCalls } = stubProviders(CLAIMED);
        const ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            network: networks.regtest,
        });
        expect(hex.encode(ark.emulatorKey)).toBe("02" + SERVER_XONLY);
        expect(emulatorInfoCalls()).toBe(0);
    });

    it("lets the override replace arkd's key", async () => {
        const custom = "02" + "cd".repeat(32);
        const { arkProvider, emulator } = stubProviders(CLAIMED);
        const ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            network: networks.regtest,
            emulatorPubkey: custom,
        });
        expect(hex.encode(ark.emulatorKey)).toBe(custom);
    });

    it.each([
        ["not hex", "not-hex"],
        ["x-only", "ab".repeat(32)],
        ["uncompressed", "04" + "ab".repeat(64)],
        ["short", "02" + "ab".repeat(31)],
        ["uppercase", ("02" + "ab".repeat(32)).toUpperCase()],
        ["empty", ""],
    ])("rejects a malformed override (%s) instead of passing it through", async (_, bad) => {
        const { arkProvider } = stubProviders(CLAIMED);
        await expect(
            arkade.Arkade.connect({ arkade: arkProvider, emulatorPubkey: bad }),
        ).rejects.toThrow(/compressed/);
    });
});
