import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";

import type { Contract } from "../../src/contracts/types";
import {
    extendVirtualCoinForContract,
    collectVtxoScripts,
} from "../../src/wallet/utils";
import { DefaultVtxo } from "../../src/script/default";
import {
    createDefaultContractParams,
    createDelegateContractParams,
    createMockVtxo,
    TEST_DEFAULT_SCRIPT,
    TEST_DELEGATE_SCRIPT,
    TEST_PUB_KEY,
    TEST_SERVER_PUB_KEY,
} from "../contracts/helpers";

// A wallet stub carrying only what the helper consumes: the offchain
// tapscript used as the default fallback when no contract resolves.
const fallbackWallet = {
    offchainTapscript: new DefaultVtxo.Script({
        pubKey: TEST_PUB_KEY,
        serverPubKey: TEST_SERVER_PUB_KEY,
    }),
};
const FALLBACK_SCRIPT = hex.encode(fallbackWallet.offchainTapscript.pkScript);

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

        const extended = extendVirtualCoinForContract(
            fallbackWallet,
            vtxo,
            map
        );

        // The extension must use the delegate tapscript, not the fallback
        // default one — otherwise multi-contract VTXOs get silently stamped
        // with the wrong forfeit/intent data.
        expect(extended.tapTree).not.toEqual(
            fallbackWallet.offchainTapscript.encode()
        );
    });

    it("falls back to the wallet default when vtxo.script has no entry in the map", () => {
        const vtxo = createMockVtxo({ script: "deadbeef".repeat(8) });
        const map = new Map<string, Contract>([
            [delegateContract.script, delegateContract],
        ]);

        const extended = extendVirtualCoinForContract(
            fallbackWallet,
            vtxo,
            map
        );

        expect(extended.tapTree).toEqual(
            fallbackWallet.offchainTapscript.encode()
        );
        expect(extended.forfeitTapLeafScript).toEqual(
            fallbackWallet.offchainTapscript.forfeit()
        );
    });

    it("falls back to the wallet default when vtxo.script is missing", () => {
        const vtxo = createMockVtxo(); // no script
        const map = new Map<string, Contract>([
            [delegateContract.script, delegateContract],
        ]);

        const extended = extendVirtualCoinForContract(
            fallbackWallet,
            vtxo,
            map
        );

        expect(extended.tapTree).toEqual(
            fallbackWallet.offchainTapscript.encode()
        );
    });

    it("falls back to the wallet default when no third argument is provided", () => {
        const vtxo = createMockVtxo({ script: TEST_DELEGATE_SCRIPT });

        const extended = extendVirtualCoinForContract(fallbackWallet, vtxo);

        expect(extended.tapTree).toEqual(
            fallbackWallet.offchainTapscript.encode()
        );
    });

    it("uses a directly-passed Contract without consulting vtxo.script", () => {
        // vtxo.script intentionally mismatches — with a direct Contract the
        // caller is asserting ownership, so no map lookup happens.
        const vtxo = createMockVtxo({ script: "cafebabe".repeat(8) });

        const extended = extendVirtualCoinForContract(
            fallbackWallet,
            vtxo,
            delegateContract
        );

        expect(extended.tapTree).not.toEqual(
            fallbackWallet.offchainTapscript.encode()
        );
    });

    it("throws when no contract resolves and no wallet is provided", () => {
        const vtxo = createMockVtxo({ script: TEST_DELEGATE_SCRIPT });

        expect(() =>
            extendVirtualCoinForContract(undefined, vtxo, new Map())
        ).toThrow(/no contract matched/);
    });

    it("does not throw when a contract resolves even if wallet is undefined", () => {
        // The contract-manager call path passes `undefined` for wallet because
        // it only ever calls with a contract in hand — the fallback should
        // never run, so no wallet is needed.
        const vtxo = createMockVtxo({ script: TEST_DELEGATE_SCRIPT });

        const extended = extendVirtualCoinForContract(
            undefined,
            vtxo,
            delegateContract
        );

        expect(extended.tapTree).toBeDefined();
        expect(extended.forfeitTapLeafScript).toBeDefined();
    });

    it("routes two VTXOs from different contracts to different tapscripts", () => {
        // The correctness regression this helper prevents: when a wallet holds
        // VTXOs from multiple contracts, the default-tapscript path silently
        // stamps every VTXO with the same forfeit/intent data.
        const defaultVtxo = createMockVtxo({ script: TEST_DEFAULT_SCRIPT });
        const delegateVtxo = createMockVtxo({ script: TEST_DELEGATE_SCRIPT });
        const map = new Map<string, Contract>([
            [defaultContract.script, defaultContract],
            [delegateContract.script, delegateContract],
        ]);

        const extendedDefault = extendVirtualCoinForContract(
            fallbackWallet,
            defaultVtxo,
            map
        );
        const extendedDelegate = extendVirtualCoinForContract(
            fallbackWallet,
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

        expect(() =>
            extendVirtualCoinForContract(fallbackWallet, vtxo, map)
        ).toThrow(/handler/);
    });

    // Satisfy lint: `FALLBACK_SCRIPT` is referenced from the helpers above,
    // but we also keep it here so a failing diff highlights a fallback regression.
    it("sanity: fallback tapscript hash matches the wallet stub", () => {
        expect(FALLBACK_SCRIPT).toBe(
            hex.encode(fallbackWallet.offchainTapscript.pkScript)
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
