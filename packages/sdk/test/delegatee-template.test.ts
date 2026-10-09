import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import { boardingWatch, renewalWatch } from "../src/script/delegateeTemplate";
import vectors from "./fixtures/delegatee/vectors.json";

describe("renewalWatch and boardingWatch", () => {
    const info = () => ({ ...keys, network: "regtest" });

    it("derive the variables and addresses of the Go engine from the delegation params", () => {
        const renewal = renewalWatch(info(), hex.decode(vectors.owner), params);
        expect(renewal.variables).toEqual(vectors.renewal.variables);
        expect(renewal.address).toBe(vectors.renewal.address);
        expect(renewal.tapscripts.map((s) => hex.encode(s))).toEqual(vectors.renewal.tapscripts);

        const boarding = boardingWatch(info(), hex.decode(vectors.owner), params);
        expect(boarding.variables).toEqual(vectors.boarding.variables);
        expect(boarding.address).toBe(vectors.boarding.address);
        expect(boarding.tapscripts.map((s) => hex.encode(s))).toEqual(vectors.boarding.tapscripts);
    });

    it("need a boarding exit delay for boarding", () => {
        const { boardingExitDelay: _, ...renewalOnly } = params;
        expect(() => boardingWatch(info(), hex.decode(vectors.owner), renewalOnly)).toThrow(
            "boarding needs an exit delay",
        );
    });
});

const keys = {
    serverPubkey: vectors.serverPubkey,
    emulatorPubkey: vectors.emulatorPubkey,
    delegatePubkey: vectors.delegatePubkey,
};

// the variables of the vectors: 512 s and 1024 s in BIP 68, a day, 500 sats
const params = {
    exitDelay: 0x400001,
    renewalWindow: 86400,
    maxFee: 500,
    boardingExitDelay: 0x400002,
};
