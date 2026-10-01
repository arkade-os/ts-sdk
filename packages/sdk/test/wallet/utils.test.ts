import { describe, it, expect } from "vitest";

import type { Contract } from "../../src/contracts/types";
import { extendVirtualCoinForContract, type ContractTapscriptCache } from "../../src/wallet/utils";
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
    it("throws when vtxo.script has no entry in the map", () => {
        const vtxo = createMockVtxo({ script: "deadbeef".repeat(8) });
        const map = new Map<string, Contract>([[delegateContract.script, delegateContract]]);

        expect(() => extendVirtualCoinForContract(vtxo, map)).toThrow(/no contract matched/);
    });

    it("throws when no second argument is provided", () => {
        const vtxo = createMockVtxo({ script: TEST_DELEGATE_SCRIPT });

        expect(() => extendVirtualCoinForContract(vtxo)).toThrow(/no contract matched/);
    });

    it("throws when the map is empty", () => {
        const vtxo = createMockVtxo({ script: TEST_DELEGATE_SCRIPT });

        expect(() => extendVirtualCoinForContract(vtxo, new Map())).toThrow(/no contract matched/);
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
        const extendedDelegate = extendVirtualCoinForContract(delegateVtxo, map);

        expect(extendedDefault.tapTree).not.toEqual(extendedDelegate.tapTree);
    });

    it("throws for an unknown contract type in the map", () => {
        const vtxo = createMockVtxo({ script: TEST_DELEGATE_SCRIPT });
        const bogus: Contract = {
            ...delegateContract,
            type: "not-a-real-type",
        };
        const map = new Map<string, Contract>([[bogus.script, bogus]]);

        expect(() => extendVirtualCoinForContract(vtxo, map)).toThrow(/handler/);
    });
});

describe("extendVirtualCoinForContract tapscript memoization", () => {
    it("returns identical tapscript data for VTXOs sharing a contract", () => {
        const map = new Map<string, Contract>([[defaultContract.script, defaultContract]]);
        const cache: ContractTapscriptCache = new Map();

        const a = extendVirtualCoinForContract(
            createMockVtxo({ script: TEST_DEFAULT_SCRIPT, vout: 0 }),
            map,
            cache,
        );
        const b = extendVirtualCoinForContract(
            createMockVtxo({ script: TEST_DEFAULT_SCRIPT, vout: 1 }),
            map,
            cache,
        );

        // Cached path: the memoized tapscripts must match what the uncached
        // path produces, so annotation output is unchanged.
        const uncached = extendVirtualCoinForContract(
            createMockVtxo({ script: TEST_DEFAULT_SCRIPT, vout: 2 }),
            map,
        );
        expect(a.tapTree).toEqual(uncached.tapTree);
        expect(a.forfeitTapLeafScript).toEqual(uncached.forfeitTapLeafScript);
        expect(a.intentTapLeafScript).toEqual(uncached.intentTapLeafScript);
        expect(b.tapTree).toEqual(a.tapTree);
        expect(b.vout).toBe(1);
    });

    it("returns independent tapscript copies when a cache is shared", () => {
        const map = new Map<string, Contract>([[defaultContract.script, defaultContract]]);
        const cache: ContractTapscriptCache = new Map();

        const a = extendVirtualCoinForContract(
            createMockVtxo({ script: TEST_DEFAULT_SCRIPT, vout: 0 }),
            map,
            cache,
        );
        const b = extendVirtualCoinForContract(
            createMockVtxo({ script: TEST_DEFAULT_SCRIPT, vout: 1 }),
            map,
            cache,
        );
        const cached = cache.get(defaultContract.script)!;

        expect(a.tapTree).not.toBe(b.tapTree);
        expect(a.tapTree).not.toBe(cached.tapTree);
        expect(a.forfeitTapLeafScript).not.toBe(b.forfeitTapLeafScript);
        expect(a.forfeitTapLeafScript[0]).not.toBe(b.forfeitTapLeafScript[0]);
        expect(a.forfeitTapLeafScript[0].internalKey).not.toBe(
            b.forfeitTapLeafScript[0].internalKey,
        );
        expect(a.forfeitTapLeafScript[0].merklePath[0]).not.toBe(
            b.forfeitTapLeafScript[0].merklePath[0],
        );

        const bTapTreeByte = b.tapTree[0];
        const bScriptByte = b.forfeitTapLeafScript[1][0];
        const bInternalKeyByte = b.forfeitTapLeafScript[0].internalKey[0];
        const bMerklePathByte = b.forfeitTapLeafScript[0].merklePath[0][0];
        const bVersion = b.forfeitTapLeafScript[0].version;
        const cachedTapTreeByte = cached.tapTree[0];
        const cachedScriptByte = cached.forfeitTapLeafScript[1][0];
        const cachedInternalKeyByte = cached.forfeitTapLeafScript[0].internalKey[0];
        const cachedMerklePathByte = cached.forfeitTapLeafScript[0].merklePath[0][0];
        const cachedVersion = cached.forfeitTapLeafScript[0].version;

        a.tapTree[0] ^= 0xff;
        a.forfeitTapLeafScript[1][0] ^= 0xff;
        a.forfeitTapLeafScript[0].internalKey[0] ^= 0xff;
        a.forfeitTapLeafScript[0].merklePath[0][0] ^= 0xff;
        a.forfeitTapLeafScript[0].version ^= 1;

        expect(b.tapTree[0]).toBe(bTapTreeByte);
        expect(b.forfeitTapLeafScript[1][0]).toBe(bScriptByte);
        expect(b.forfeitTapLeafScript[0].internalKey[0]).toBe(bInternalKeyByte);
        expect(b.forfeitTapLeafScript[0].merklePath[0][0]).toBe(bMerklePathByte);
        expect(b.forfeitTapLeafScript[0].version).toBe(bVersion);
        expect(cached.tapTree[0]).toBe(cachedTapTreeByte);
        expect(cached.forfeitTapLeafScript[1][0]).toBe(cachedScriptByte);
        expect(cached.forfeitTapLeafScript[0].internalKey[0]).toBe(cachedInternalKeyByte);
        expect(cached.forfeitTapLeafScript[0].merklePath[0][0]).toBe(cachedMerklePathByte);
        expect(cached.forfeitTapLeafScript[0].version).toBe(cachedVersion);
    });
});
