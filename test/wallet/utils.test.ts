import { describe, it, expect } from "vitest";

import type { Contract } from "../../src/contracts/types";
import {
    extendVirtualCoinForContract,
    collectVtxoScripts,
} from "../../src/wallet/utils";
import {
    createDefaultContractParams,
    createDelegateContractParams,
    createMockVtxo,
    TEST_DEFAULT_SCRIPT,
    TEST_DELEGATE_SCRIPT,
} from "../contracts/helpers";

const defaultContract: Contract = {
    type: "default",
    params: createDefaultContractParams(),
    script: TEST_DEFAULT_SCRIPT,
    address: "ark1default",
    state: "active",
    createdAt: Date.now(),
};

const delegateContract: Contract = {
    type: "delegate",
    params: createDelegateContractParams(),
    script: TEST_DELEGATE_SCRIPT,
    address: "ark1delegate",
    state: "active",
    createdAt: Date.now(),
};

describe("extendVirtualCoinForContract", () => {
    it("resolves via map when vtxo.script matches a known contract", () => {
        const vtxo = createMockVtxo({ script: TEST_DELEGATE_SCRIPT });
        const map = new Map<string, Contract>([
            [defaultContract.script, defaultContract],
            [delegateContract.script, delegateContract],
        ]);

        const extended = extendVirtualCoinForContract(vtxo, map);

        // The extension uses the delegate contract's tapscript, not the
        // default one — multi-contract VTXOs must not be stamped with the
        // wrong forfeit/intent data.
        expect(extended.tapTree).toBeDefined();
        expect(extended.forfeitTapLeafScript).toBeDefined();
    });

    it("throws when vtxo.script has no entry in the map", () => {
        const vtxo = createMockVtxo({ script: "deadbeef".repeat(8) });
        const map = new Map<string, Contract>([
            [delegateContract.script, delegateContract],
        ]);

        expect(() => extendVirtualCoinForContract(vtxo, map)).toThrow(
            /no contract matched/
        );
    });

    it("throws when no second argument is provided", () => {
        const vtxo = createMockVtxo({ script: TEST_DELEGATE_SCRIPT });

        expect(() => extendVirtualCoinForContract(vtxo)).toThrow(
            /no contract matched/
        );
    });

    it("uses a directly-passed Contract without consulting vtxo.script", () => {
        // vtxo.script intentionally mismatches — with a direct Contract the
        // caller is asserting ownership, so no map lookup happens.
        const vtxo = createMockVtxo({ script: "cafebabe".repeat(8) });

        const extended = extendVirtualCoinForContract(vtxo, delegateContract);

        expect(extended.tapTree).toBeDefined();
        expect(extended.forfeitTapLeafScript).toBeDefined();
    });

    it("throws when the map is empty", () => {
        const vtxo = createMockVtxo({ script: TEST_DELEGATE_SCRIPT });

        expect(() => extendVirtualCoinForContract(vtxo, new Map())).toThrow(
            /no contract matched/
        );
    });

    it("routes two VTXOs from different contracts to different tapscripts", () => {
        // The correctness regression this helper prevents: with a shared
        // default-tapscript path, every VTXO was stamped with the same
        // forfeit/intent data regardless of the owning contract.
        const defaultVtxo = createMockVtxo({ script: TEST_DEFAULT_SCRIPT });
        const delegateVtxo = createMockVtxo({ script: TEST_DELEGATE_SCRIPT });
        const map = new Map<string, Contract>([
            [defaultContract.script, defaultContract],
            [delegateContract.script, delegateContract],
        ]);

        const extendedDefault = extendVirtualCoinForContract(defaultVtxo, map);
        const extendedDelegate = extendVirtualCoinForContract(
            delegateVtxo,
            map
        );

        expect(extendedDefault.tapTree).not.toEqual(extendedDelegate.tapTree);
    });

    it("throws for an unknown contract type in the map", () => {
        const vtxo = createMockVtxo({ script: TEST_DELEGATE_SCRIPT });
        const bogus: Contract = {
            ...delegateContract,
            type: "not-a-real-type",
        };
        const map = new Map<string, Contract>([[bogus.script, bogus]]);

        expect(() => extendVirtualCoinForContract(vtxo, map)).toThrow(
            /handler/
        );
    });
});

describe("collectVtxoScripts", () => {
    it("returns a unique, ordered-by-insertion list across batches", () => {
        const scripts = collectVtxoScripts(
            [{ script: "a" }, { script: "b" }, { script: "a" }],
            [{ script: "c" }, { script: "b" }]
        );

        expect(scripts).toEqual(["a", "b", "c"]);
    });

    it("drops entries without a script", () => {
        const scripts = collectVtxoScripts([
            { script: "a" },
            {},
            { script: undefined },
            { script: "b" },
        ]);

        expect(scripts).toEqual(["a", "b"]);
    });

    it("returns [] for no batches", () => {
        expect(collectVtxoScripts()).toEqual([]);
    });

    it("returns [] for empty batches", () => {
        expect(collectVtxoScripts([], [])).toEqual([]);
    });
});
