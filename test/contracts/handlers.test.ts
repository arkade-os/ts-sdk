import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { DefaultContractHandler } from "../../src/contracts/handlers/default";
import { DelegateContractHandler } from "../../src/contracts/handlers/delegate";
import { VHTLCContractHandler } from "../../src/contracts/handlers/vhtlc";
import {
    Contract,
    contractHandlers,
    DefaultVtxo,
    DelegateVtxo,
} from "../../src";
import {
    createDefaultContractParams,
    createDelegateContractParams,
    createMockVtxo,
    TEST_PUB_KEY,
    TEST_SERVER_PUB_KEY,
    TEST_DELEGATE_PUB_KEY,
} from "./helpers";
import { timelockToSequence } from "../../src/contracts/handlers/helpers";

describe("Contract Registry", () => {
    it("should have default handler registered", () => {
        expect(contractHandlers.has("default")).toBe(true);
        const handler = contractHandlers.get("default");
        expect(handler).toBeDefined();
        expect(handler?.type).toBe("default");
    });

    it("should have VHTLC handler registered", () => {
        expect(contractHandlers.has("vhtlc")).toBe(true);
        const handler = contractHandlers.get("vhtlc");
        expect(handler).toBeDefined();
        expect(handler?.type).toBe("vhtlc");
    });

    it("should have delegate handler registered", () => {
        expect(contractHandlers.has("delegate")).toBe(true);
        const handler = contractHandlers.get("delegate");
        expect(handler).toBeDefined();
        expect(handler?.type).toBe("delegate");
    });

    it("should return undefined for unregistered handler", () => {
        expect(contractHandlers.get("custom")).toBeUndefined();
    });
});

describe("DefaultContractHandler", () => {
    it("creates a script matching the expected pkScript", () => {
        const params = {
            type: "default",
            params: {
                pubKey: "304f9960ebb31cd5f49bd18673042be1ae286019225e08e861233e06ea95fffe",
                serverPubKey:
                    "56f810de93e500e745b7dabfcb2b798b216a70a99de7edee79bf1791379bf62d",
                csvTimelock: timelockToSequence({
                    type: "seconds",
                    value: 86016n,
                }).toString(),
            },
            script: "5120985a208e36f3263160cf47605dfd9c10e358b08dd4a7b75b1eb37725f64797d9",
            address:
                "tark1qpt0syx7j0jspe69kldtljet0x9jz6ns4xw70m0w0xl30yfhn0mzmxz6yz8rduexx9sv73mqth7ecy8rtzcgm498kad3avmhyhmy097ew6h83g",
            state: "active",
        };

        const script = DefaultContractHandler.createScript(params.params);

        expect(hex.encode(script.pkScript)).toEqual(params.script);
    });

    it("should create script from params", () => {
        const params = {
            pubKey: hex.encode(TEST_PUB_KEY),
            serverPubKey: hex.encode(TEST_SERVER_PUB_KEY),
            csvTimelock: DefaultContractHandler.serializeParams({
                pubKey: TEST_PUB_KEY,
                serverPubKey: TEST_SERVER_PUB_KEY,
                csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
            }).csvTimelock,
        };

        const script = DefaultContractHandler.createScript(params);

        expect(script).toBeDefined();
        expect(script.pkScript).toBeDefined();
    });

    it("should serialize and deserialize params", () => {
        const original = {
            pubKey: TEST_PUB_KEY,
            serverPubKey: TEST_SERVER_PUB_KEY,
            csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
        };

        const serialized = DefaultContractHandler.serializeParams(original);
        const deserialized =
            DefaultContractHandler.deserializeParams(serialized);

        expect(deserialized.pubKey).toBeInstanceOf(Uint8Array);
        expect(deserialized.serverPubKey).toBeInstanceOf(Uint8Array);
        expect(Array.from(deserialized.pubKey)).toEqual(
            Array.from(TEST_PUB_KEY)
        );
    });

    it("should select forfeit path when collaborative", () => {
        const params = createDefaultContractParams();
        const script = DefaultContractHandler.createScript(params);
        const contract: Contract = {
            type: "default",
            params,
            script: hex.encode(script.pkScript),
            address: "address",
            state: "active",
            createdAt: Date.now(),
        };

        const path = DefaultContractHandler.selectPath(script, contract, {
            collaborative: true,
            currentTime: Date.now(),
        });

        expect(path).toBeDefined();
        expect(path?.leaf).toBeDefined();
    });

    it("should select exit path when not collaborative", () => {
        const params = createDefaultContractParams();
        const script = DefaultContractHandler.createScript(params);
        const contract: Contract = {
            type: "default",
            params,
            script: hex.encode(script.pkScript),
            address: "address",
            state: "active",
            createdAt: Date.now(),
        };

        const path = DefaultContractHandler.selectPath(script, contract, {
            collaborative: false,
            currentTime: Date.now(),
            vtxo: createMockVtxo({
                status: {
                    confirmed: true,
                    block_height: 100,
                    block_time: 1000,
                },
            }),
            blockHeight: 300,
        });

        expect(path).toBeDefined();
        expect(path?.leaf).toBeDefined();
    });

    it("should return multiple spendable paths", () => {
        const params = createDefaultContractParams();
        const script = DefaultContractHandler.createScript(params);
        const contract: Contract = {
            type: "default",
            params,
            script: hex.encode(script.pkScript),
            address: "address",
            state: "active",
            createdAt: Date.now(),
        };

        const paths = DefaultContractHandler.getSpendablePaths(
            script,
            contract,
            {
                collaborative: true,
                currentTime: Date.now(),
                blockHeight: 300,
                vtxo: createMockVtxo({
                    status: {
                        confirmed: true,
                        block_height: 100,
                        block_time: 1000,
                    },
                }),
            }
        );

        // Should have both forfeit and exit paths when collaborative
        expect(paths.length).toBeGreaterThanOrEqual(2);
    });

    it("should include sequence on exit path when csvTimelock is set", () => {
        const params = createDefaultContractParams();
        const script = DefaultContractHandler.createScript(params);
        const contract: Contract = {
            type: "default",
            params,
            script: hex.encode(script.pkScript),
            address: "address",
            state: "active",
            createdAt: Date.now(),
        };

        const paths = DefaultContractHandler.getSpendablePaths(
            script,
            contract,
            {
                collaborative: false,
                currentTime: Date.now(),
                blockHeight: 300,
                vtxo: createMockVtxo({
                    status: {
                        confirmed: true,
                        block_height: 100,
                        block_time: 1000,
                    },
                }),
            }
        );

        expect(paths).toHaveLength(1);
        expect(paths[0].sequence).toBe(Number(params.csvTimelock));
    });

    it("should omit sequence on exit path when csvTimelock is missing", () => {
        const params = {
            pubKey: hex.encode(TEST_PUB_KEY),
            serverPubKey: hex.encode(TEST_SERVER_PUB_KEY),
        };
        const script = DefaultContractHandler.createScript(params);
        const contract: Contract = {
            type: "default",
            params,
            script: hex.encode(script.pkScript),
            address: "address",
            state: "active",
            createdAt: Date.now(),
        };

        const paths = DefaultContractHandler.getSpendablePaths(
            script,
            contract,
            {
                collaborative: false,
                currentTime: Date.now(),
                vtxo: createMockVtxo({
                    status: {
                        confirmed: true,
                        block_height: 100,
                        block_time: 1000,
                    },
                }),
            }
        );

        expect(paths).toHaveLength(1);
        expect(paths[0].sequence).toBeUndefined();
    });

    it("should enforce CSV for spendable paths", () => {
        const params = createDefaultContractParams();
        const script = DefaultContractHandler.createScript(params);
        const contract: Contract = {
            type: "default",
            params,
            script: hex.encode(script.pkScript),
            address: "address",
            state: "active",
            createdAt: Date.now(),
        };

        const vtxo = createMockVtxo({
            status: { confirmed: true, block_height: 100, block_time: 1000 },
        });

        const notMature = DefaultContractHandler.getSpendablePaths(
            script,
            contract,
            {
                collaborative: false,
                currentTime: Date.now(),
                blockHeight: 150,
                vtxo,
            }
        );
        expect(notMature).toHaveLength(0);

        const mature = DefaultContractHandler.getSpendablePaths(
            script,
            contract,
            {
                collaborative: false,
                currentTime: Date.now(),
                blockHeight: 300,
                vtxo,
            }
        );
        expect(mature).toHaveLength(1);
        expect(mature[0].sequence).toBe(Number(params.csvTimelock));
    });
});

describe("DelegateContractHandler", () => {
    it("should create script from params", () => {
        const params = createDelegateContractParams();
        const script = DelegateContractHandler.createScript(params);

        expect(script).toBeDefined();
        expect(script.pkScript).toBeDefined();
        // Delegate script should have 3 leaves: forfeit, exit, delegate
        expect(script.forfeit()).toBeDefined();
        expect(script.exit()).toBeDefined();
        expect(script.delegate()).toBeDefined();
    });

    it("should produce a different pkScript than default with same keys", () => {
        const defaultParams = createDefaultContractParams();
        const delegateParams = createDelegateContractParams();

        const defaultScript =
            DefaultContractHandler.createScript(defaultParams);
        const delegateScript =
            DelegateContractHandler.createScript(delegateParams);

        // Same keys but delegate adds a third leaf, so pkScript must differ
        expect(hex.encode(delegateScript.pkScript)).not.toEqual(
            hex.encode(defaultScript.pkScript)
        );
    });

    it("should serialize and deserialize params", () => {
        const original = {
            pubKey: TEST_PUB_KEY,
            serverPubKey: TEST_SERVER_PUB_KEY,
            delegatePubKey: TEST_DELEGATE_PUB_KEY,
            csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
        };

        const serialized = DelegateContractHandler.serializeParams(original);
        const deserialized =
            DelegateContractHandler.deserializeParams(serialized);

        expect(deserialized.pubKey).toBeInstanceOf(Uint8Array);
        expect(deserialized.serverPubKey).toBeInstanceOf(Uint8Array);
        expect(deserialized.delegatePubKey).toBeInstanceOf(Uint8Array);
        expect(Array.from(deserialized.pubKey)).toEqual(
            Array.from(TEST_PUB_KEY)
        );
        expect(Array.from(deserialized.delegatePubKey)).toEqual(
            Array.from(TEST_DELEGATE_PUB_KEY)
        );
    });

    it("should produce identical pkScript after serialize roundtrip", () => {
        const original = {
            pubKey: TEST_PUB_KEY,
            serverPubKey: TEST_SERVER_PUB_KEY,
            delegatePubKey: TEST_DELEGATE_PUB_KEY,
            csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
        };

        const serialized = DelegateContractHandler.serializeParams(original);
        const script1 = DelegateContractHandler.createScript(serialized);

        const deserialized =
            DelegateContractHandler.deserializeParams(serialized);
        const reserialized =
            DelegateContractHandler.serializeParams(deserialized);
        const script2 = DelegateContractHandler.createScript(reserialized);

        expect(hex.encode(script2.pkScript)).toEqual(
            hex.encode(script1.pkScript)
        );
    });

    it("should select forfeit path when collaborative", () => {
        const params = createDelegateContractParams();
        const script = DelegateContractHandler.createScript(params);
        const contract: Contract = {
            type: "delegate",
            params,
            script: hex.encode(script.pkScript),
            address: "address",
            state: "active",
            createdAt: Date.now(),
        };

        const path = DelegateContractHandler.selectPath(script, contract, {
            collaborative: true,
            currentTime: Date.now(),
        });

        expect(path).toBeDefined();
        expect(path?.leaf).toBeDefined();
    });

    it("should select exit path when not collaborative and CSV satisfied", () => {
        const params = createDelegateContractParams();
        const script = DelegateContractHandler.createScript(params);
        const contract: Contract = {
            type: "delegate",
            params,
            script: hex.encode(script.pkScript),
            address: "address",
            state: "active",
            createdAt: Date.now(),
        };

        const path = DelegateContractHandler.selectPath(script, contract, {
            collaborative: false,
            currentTime: Date.now(),
            vtxo: createMockVtxo({
                status: {
                    confirmed: true,
                    block_height: 100,
                    block_time: 1000,
                },
            }),
            blockHeight: 300,
        });

        expect(path).toBeDefined();
        expect(path?.leaf).toBeDefined();
    });

    it("should return null when not collaborative and CSV not satisfied", () => {
        const params = createDelegateContractParams();
        const script = DelegateContractHandler.createScript(params);
        const contract: Contract = {
            type: "delegate",
            params,
            script: hex.encode(script.pkScript),
            address: "address",
            state: "active",
            createdAt: Date.now(),
        };

        const path = DelegateContractHandler.selectPath(script, contract, {
            collaborative: false,
            currentTime: Date.now(),
            vtxo: createMockVtxo({
                status: {
                    confirmed: true,
                    block_height: 100,
                    block_time: 1000,
                },
            }),
            blockHeight: 150, // not mature enough
        });

        expect(path).toBeNull();
    });

    it("should return 3 paths when collaborative (forfeit + exit + delegate)", () => {
        const params = createDelegateContractParams();
        const script = DelegateContractHandler.createScript(params);
        const contract: Contract = {
            type: "delegate",
            params,
            script: hex.encode(script.pkScript),
            address: "address",
            state: "active",
            createdAt: Date.now(),
        };

        const paths = DelegateContractHandler.getAllSpendingPaths(
            script,
            contract,
            {
                collaborative: true,
                currentTime: Date.now(),
            }
        );

        // forfeit + exit + delegate = 3
        expect(paths).toHaveLength(3);
    });

    it("should return only exit when not collaborative in getAllSpendingPaths", () => {
        const params = createDelegateContractParams();
        const script = DelegateContractHandler.createScript(params);
        const contract: Contract = {
            type: "delegate",
            params,
            script: hex.encode(script.pkScript),
            address: "address",
            state: "active",
            createdAt: Date.now(),
        };

        const paths = DelegateContractHandler.getAllSpendingPaths(
            script,
            contract,
            {
                collaborative: false,
                currentTime: Date.now(),
            }
        );

        // only exit
        expect(paths).toHaveLength(1);
    });

    it("should return 2 spendable paths when collaborative and CSV satisfied", () => {
        const params = createDelegateContractParams();
        const script = DelegateContractHandler.createScript(params);
        const contract: Contract = {
            type: "delegate",
            params,
            script: hex.encode(script.pkScript),
            address: "address",
            state: "active",
            createdAt: Date.now(),
        };

        const paths = DelegateContractHandler.getSpendablePaths(
            script,
            contract,
            {
                collaborative: true,
                currentTime: Date.now(),
                blockHeight: 300,
                vtxo: createMockVtxo({
                    status: {
                        confirmed: true,
                        block_height: 100,
                        block_time: 1000,
                    },
                }),
            }
        );

        // forfeit + exit = 2 (delegate path requires manual intervention)
        expect(paths).toHaveLength(2);
    });

    it("should enforce CSV for spendable paths", () => {
        const params = createDelegateContractParams();
        const script = DelegateContractHandler.createScript(params);
        const contract: Contract = {
            type: "delegate",
            params,
            script: hex.encode(script.pkScript),
            address: "address",
            state: "active",
            createdAt: Date.now(),
        };

        const vtxo = createMockVtxo({
            status: { confirmed: true, block_height: 100, block_time: 1000 },
        });

        // Not mature: only forfeit + delegate (no exit)
        const notMature = DelegateContractHandler.getSpendablePaths(
            script,
            contract,
            {
                collaborative: true,
                currentTime: Date.now(),
                blockHeight: 150,
                vtxo,
            }
        );
        // forfeit only (exit not spendable yet, delegate requires manual intervention)
        expect(notMature).toHaveLength(1);

        // Non-collaborative not mature: no paths at all
        const nonCollabNotMature = DelegateContractHandler.getSpendablePaths(
            script,
            contract,
            {
                collaborative: false,
                currentTime: Date.now(),
                blockHeight: 150,
                vtxo,
            }
        );
        expect(nonCollabNotMature).toHaveLength(0);

        // Mature: forfeit + exit
        const mature = DelegateContractHandler.getSpendablePaths(
            script,
            contract,
            {
                collaborative: true,
                currentTime: Date.now(),
                blockHeight: 300,
                vtxo,
            }
        );
        expect(mature).toHaveLength(2);
    });

    it("should include sequence on exit path when csvTimelock is set", () => {
        const params = createDelegateContractParams();
        const script = DelegateContractHandler.createScript(params);
        const contract: Contract = {
            type: "delegate",
            params,
            script: hex.encode(script.pkScript),
            address: "address",
            state: "active",
            createdAt: Date.now(),
        };

        const paths = DelegateContractHandler.getSpendablePaths(
            script,
            contract,
            {
                collaborative: false,
                currentTime: Date.now(),
                blockHeight: 300,
                vtxo: createMockVtxo({
                    status: {
                        confirmed: true,
                        block_height: 100,
                        block_time: 1000,
                    },
                }),
            }
        );

        expect(paths).toHaveLength(1);
        expect(paths[0].sequence).toBe(Number(params.csvTimelock));
    });
});

describe("VHTLCContractHandler", () => {
    it("creates the correct script and handles de/serialization", () => {
        const receiverXOnly =
            "1e1bb85455fe3f5aed60d101aa4dbdb9e7714f6226769a97a17a5331dadcd53b";
        const senderXOnly =
            "0192e796452d6df9697c280542e1560557bcf79a347d925895043136225c7cb4";
        const serverXOnly =
            "aad52d58162e9eefeafc7ad8a1cdca8060b5f01df1e7583362d052e266208f88";

        const params = {
            type: "vhtlc",
            params: {
                sender: senderXOnly,
                receiver: receiverXOnly,
                server: serverXOnly,
                hash: "4d487dd3753a89bc9fe98401d1196523058251fc",
                refundLocktime: "265",
                claimDelay: timelockToSequence({
                    type: "blocks",
                    value: 17n,
                }).toString(),
                refundDelay: timelockToSequence({
                    type: "blocks",
                    value: 144n,
                }).toString(),
                refundNoReceiverDelay: timelockToSequence({
                    type: "blocks",
                    value: 144n,
                }).toString(),
            },
        };

        const script = VHTLCContractHandler.createScript(params.params);

        // Verify the script is created and has expected structure
        expect(script.pkScript).toBeDefined();
        expect(script.pkScript.length).toBeGreaterThan(0);

        // Verify the script can produce all expected leaf scripts
        expect(script.claim()).toBeDefined();
        expect(script.refund()).toBeDefined();
        expect(script.refundWithoutReceiver()).toBeDefined();
        expect(script.unilateralClaim()).toBeDefined();
        expect(script.unilateralRefund()).toBeDefined();
        expect(script.unilateralRefundWithoutReceiver()).toBeDefined();

        // Verify serialization roundtrip works
        const deserialized = VHTLCContractHandler.deserializeParams(
            params.params
        );
        const reserialized = VHTLCContractHandler.serializeParams(deserialized);
        const script2 = VHTLCContractHandler.createScript(reserialized);

        expect(hex.encode(script2.pkScript)).toEqual(
            hex.encode(script.pkScript)
        );
    });

    it("should enforce CSV for unilateral spendable paths", () => {
        const receiverXOnly =
            "1e1bb85455fe3f5aed60d101aa4dbdb9e7714f6226769a97a17a5331dadcd53b";
        const senderXOnly =
            "0192e796452d6df9697c280542e1560557bcf79a347d925895043136225c7cb4";
        const serverXOnly =
            "aad52d58162e9eefeafc7ad8a1cdca8060b5f01df1e7583362d052e266208f88";

        const params = {
            sender: senderXOnly,
            receiver: receiverXOnly,
            server: serverXOnly,
            hash: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f",
            refundLocktime: "800000",
            claimDelay: "10",
            refundDelay: "12",
            refundNoReceiverDelay: "14",
            preimage: "010203",
        };

        const script = VHTLCContractHandler.createScript(params);
        const contract: Contract = {
            type: "vhtlc",
            params,
            script: hex.encode(script.pkScript),
            address: "address",
            state: "active",
            createdAt: Date.now(),
        };

        const vtxo = createMockVtxo({
            status: { confirmed: true, block_height: 100, block_time: 1000 },
        });

        const notMature = VHTLCContractHandler.getSpendablePaths(
            script,
            contract,
            {
                collaborative: false,
                currentTime: Date.now(),
                blockHeight: 105,
                walletPubKey: receiverXOnly,
                vtxo,
            }
        );
        expect(notMature).toHaveLength(0);

        const mature = VHTLCContractHandler.getSpendablePaths(
            script,
            contract,
            {
                collaborative: false,
                currentTime: Date.now(),
                blockHeight: 200,
                walletPubKey: receiverXOnly,
                vtxo,
            }
        );
        expect(mature).toHaveLength(1);
        expect(mature[0].sequence).toBe(Number(params.claimDelay));
    });
});
