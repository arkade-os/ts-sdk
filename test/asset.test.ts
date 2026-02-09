import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import {
    AssetId,
    AssetRef,
    AssetRefType,
    AssetInput,
    AssetInputs,
    AssetOutput,
    AssetOutputs,
    Metadata,
    AssetGroup,
    Packet,
} from "../src/asset";

import assetIdFixtures from "./fixtures/asset_id_fixtures.json";
import assetRefFixtures from "./fixtures/asset_ref_fixtures.json";
import assetInputFixtures from "./fixtures/asset_input_fixtures.json";
import assetOutputFixtures from "./fixtures/asset_output_fixtures.json";
import metadataFixtures from "./fixtures/metadata_fixtures.json";
import assetGroupFixtures from "./fixtures/asset_group_fixtures.json";
import packetFixtures from "./fixtures/packet_fixtures.json";

describe("AssetId", () => {
    describe("valid", () => {
        assetIdFixtures.valid.forEach((v) => {
            it(v.name, () => {
                const index = v.index & 0xffff; // Handle overflow/underflow
                const assetId = AssetId.create(v.txid, index);
                expect(assetId).toBeDefined();

                const serialized = assetId.serialize();
                expect(serialized).toBeDefined();
                expect(serialized.length).toBeGreaterThan(0);
                expect(assetId.toString()).toBe(v.serializedHex);

                const fromString = AssetId.fromString(v.serializedHex);
                expect(hex.encode(fromString.txid)).toBe(v.txid);
                expect(fromString.groupIndex).toBe(index);
                expect(fromString.toString()).toBe(v.serializedHex);
            });
        });
    });

    describe("invalid", () => {
        describe("create", () => {
            assetIdFixtures.invalid.newAssetId.forEach((v) => {
                it(v.name, () => {
                    expect(() => AssetId.create(v.txid, v.index)).toThrow(
                        v.expectedError
                    );
                });
            });
        });

        describe("fromString", () => {
            assetIdFixtures.invalid.newAssetIdFromString.forEach((v) => {
                it(v.name, () => {
                    expect(() => AssetId.fromString(v.serializedHex)).toThrow(
                        v.expectedError
                    );
                });
            });
        });
    });
});

describe("AssetRef", () => {
    describe("valid", () => {
        describe("from id", () => {
            assetRefFixtures.valid.newAssetRefFromId.forEach((v) => {
                it(v.name, () => {
                    const assetId = AssetId.create(v.txid, v.index);
                    const assetRef = AssetRef.fromId(assetId);

                    expect(assetRef).toBeDefined();
                    expect(assetRef.type).toBe(AssetRefType.ByID);

                    const serialized = assetRef.serialize();
                    expect(serialized).toBeDefined();
                    expect(serialized.length).toBeGreaterThan(0);
                    expect(assetRef.toString()).toBe(v.serializedHex);
                });
            });
        });

        describe("from group index", () => {
            assetRefFixtures.valid.newAssetRefFromGroup.forEach((v) => {
                it(v.name, () => {
                    const assetRef = AssetRef.fromGroupIndex(v.index);

                    expect(assetRef).toBeDefined();
                    expect(assetRef.type).toBe(AssetRefType.ByGroup);

                    const serialized = assetRef.serialize();
                    expect(serialized).toBeDefined();
                    expect(serialized.length).toBeGreaterThan(0);
                    expect(assetRef.toString()).toBe(v.serializedHex);
                });
            });
        });
    });

    describe("invalid", () => {
        describe("from string", () => {
            assetRefFixtures.invalid.newAssetRefFromString.forEach((v) => {
                it(v.name, () => {
                    expect(() => AssetRef.fromString(v.serializedHex)).toThrow(
                        v.expectedError
                    );
                });
            });
        });
    });
});

describe("AssetInput", () => {
    describe("valid", () => {
        describe("newInput", () => {
            assetInputFixtures.valid.newInput.forEach((v) => {
                it(v.name, () => {
                    let input: AssetInput;
                    if (v.type === "intent") {
                        input = AssetInput.createIntent(
                            v.txid!,
                            v.vin,
                            v.amount
                        );
                    } else {
                        input = AssetInput.create(v.vin, v.amount);
                    }

                    expect(input).toBeDefined();

                    const serialized = input.serialize();
                    expect(serialized).toBeDefined();
                    expect(serialized.length).toBeGreaterThan(0);
                    expect(input.toString()).toBe(v.serializedHex);

                    const fromString = AssetInput.fromString(v.serializedHex);
                    expect(fromString.vin).toBe(v.vin);
                    expect(fromString.amount).toBe(BigInt(v.amount));
                    expect(fromString.toString()).toBe(v.serializedHex);
                });
            });
        });

        describe("newInputs", () => {
            assetInputFixtures.valid.newInputs.forEach((v) => {
                it(v.name, () => {
                    const inputs: AssetInput[] = v.inputs.map((inp) => {
                        if (inp.type === "intent") {
                            return AssetInput.createIntent(
                                inp.txid!,
                                inp.vin,
                                inp.amount
                            );
                        }
                        return AssetInput.create(inp.vin, inp.amount);
                    });

                    const assetInputs = AssetInputs.create(inputs);
                    expect(assetInputs).toBeDefined();

                    const serialized = assetInputs.serialize();
                    expect(serialized).toBeDefined();
                    expect(serialized.length).toBeGreaterThan(0);
                    expect(assetInputs.toString()).toBe(v.serializedHex);

                    const fromString = AssetInputs.fromString(v.serializedHex);
                    expect(fromString.inputs.length).toBe(
                        assetInputs.inputs.length
                    );
                });
            });
        });
    });

    describe("invalid", () => {
        describe("newInput", () => {
            assetInputFixtures.invalid.newInput.forEach((v) => {
                it(v.name, () => {
                    expect(() =>
                        AssetInput.createIntent(v.txid, v.vin, v.amount ?? 0)
                    ).toThrow();
                });
            });
        });

        describe("fromString", () => {
            assetInputFixtures.invalid.newInputFromString.forEach((v) => {
                it(v.name, () => {
                    expect(() =>
                        AssetInput.fromString(v.serializedHex)
                    ).toThrow();
                });
            });
        });
    });
});

describe("AssetOutput", () => {
    describe("valid", () => {
        describe("newOutput", () => {
            assetOutputFixtures.valid.newOutput.forEach((v) => {
                it(v.name, () => {
                    const output = AssetOutput.create(v.vout, v.amount);
                    expect(output).toBeDefined();

                    const serialized = output.serialize();
                    expect(serialized).toBeDefined();
                    expect(serialized.length).toBeGreaterThan(0);
                    expect(output.toString()).toBe(v.serializedHex);

                    const fromString = AssetOutput.fromString(v.serializedHex);
                    expect(fromString.vout).toBe(v.vout);
                    expect(fromString.amount).toBe(BigInt(v.amount));
                    expect(fromString.toString()).toBe(v.serializedHex);
                });
            });
        });

        describe("newOutputs", () => {
            assetOutputFixtures.valid.newOutputs.forEach((v) => {
                it(v.name, () => {
                    const outputs = v.outputs.map((out) =>
                        AssetOutput.create(out.vout, out.amount)
                    );
                    const assetOutputs = AssetOutputs.create(outputs);

                    expect(assetOutputs).toBeDefined();

                    const serialized = assetOutputs.serialize();
                    expect(serialized).toBeDefined();
                    expect(serialized.length).toBeGreaterThan(0);
                    expect(assetOutputs.toString()).toBe(v.serializedHex);

                    const fromString = AssetOutputs.fromString(v.serializedHex);
                    expect(fromString.outputs.length).toBe(
                        assetOutputs.outputs.length
                    );
                });
            });
        });
    });

    describe("invalid", () => {
        describe("fromString", () => {
            assetOutputFixtures.invalid.newOutputFromString.forEach((v) => {
                it(v.name, () => {
                    expect(() =>
                        AssetOutput.fromString(v.serializedHex)
                    ).toThrow(v.expectedError);
                });
            });
        });

        describe("newOutputs", () => {
            assetOutputFixtures.invalid.newOutputs.forEach((v) => {
                it(v.name, () => {
                    const outputs = v.outputs.map((out) =>
                        AssetOutput.create(out.vout, out.amount)
                    );
                    expect(() => AssetOutputs.create(outputs)).toThrow(
                        v.expectedError
                    );
                });
            });
        });
    });
});

describe("Metadata", () => {
    describe("valid", () => {
        metadataFixtures.valid.forEach((v) => {
            it(v.name, () => {
                const metadata = Metadata.create(v.key, v.value);
                expect(metadata).toBeDefined();

                const serialized = metadata.serialize();
                expect(serialized).toBeDefined();
                expect(serialized.length).toBeGreaterThan(0);
                expect(metadata.toString()).toBe(v.serializedHex);

                const hash = metadata.hash();
                expect(hex.encode(hash)).toBe(v.hash);

                const fromString = Metadata.fromString(v.serializedHex);
                expect(fromString.keyString).toBe(v.key);
                expect(fromString.valueString).toBe(v.value);
            });
        });
    });

    describe("invalid", () => {
        describe("from key value", () => {
            metadataFixtures.invalid.newMetadata.forEach((v) => {
                it(v.name, () => {
                    expect(() => Metadata.create(v.key, v.value)).toThrow(
                        v.expectedError
                    );
                });
            });
        });

        describe("from string", () => {
            metadataFixtures.invalid.newMetadataFromString.forEach((v) => {
                it(v.name, () => {
                    expect(() => Metadata.fromString(v.serializedHex)).toThrow(
                        v.expectedError
                    );
                });
            });
        });
    });
});

// Helper functions for parsing fixtures
interface AssetIdFixture {
    txid?: string;
    index?: number;
}

interface AssetRefFixture {
    assetId?: AssetIdFixture;
    groupIndex?: number;
}

interface AssetInputFixture {
    type: string;
    vin: number;
    txid?: string;
    amount: number;
}

interface AssetOutputFixture {
    vout: number;
    amount: number;
}

interface MetadataFixture {
    key: string;
    value: string;
}

function parseAssetId(f: AssetIdFixture | undefined): AssetId | null {
    if (!f || (!f.txid && f.index === undefined)) return null;
    if (!f.txid) return null;
    return AssetId.create(f.txid, f.index ?? 0);
}

function parseAssetRef(f: AssetRefFixture | undefined): AssetRef | null {
    if (!f) return null;
    if (!f.assetId?.txid && f.groupIndex === undefined) return null;
    if (f.assetId?.txid) {
        const id = parseAssetId(f.assetId);
        if (!id) return null;
        return AssetRef.fromId(id);
    }
    return AssetRef.fromGroupIndex(f.groupIndex ?? 0);
}

function parseAssetInput(f: AssetInputFixture): AssetInput {
    if (f.type === "local") {
        return AssetInput.create(f.vin, f.amount);
    }
    return AssetInput.createIntent(f.txid!, f.vin, f.amount);
}

function parseAssetOutput(f: AssetOutputFixture): AssetOutput {
    return AssetOutput.create(f.vout, f.amount);
}

function parseMetadata(f: MetadataFixture): Metadata {
    return Metadata.create(f.key, f.value);
}

describe("AssetGroup", () => {
    describe("valid", () => {
        assetGroupFixtures.valid.forEach((v) => {
            it(v.name, () => {
                const assetId = parseAssetId(v.assetId as AssetIdFixture);
                const controlAsset = parseAssetRef(
                    v.controlAsset as AssetRefFixture
                );
                const inputs = (v.inputs || []).map((i) =>
                    parseAssetInput(i as AssetInputFixture)
                );
                const outputs = (v.outputs || []).map((o) =>
                    parseAssetOutput(o as AssetOutputFixture)
                );
                const metadata = (v.metadata || []).map((m) =>
                    parseMetadata(m as MetadataFixture)
                );

                const assetGroup = AssetGroup.create(
                    assetId,
                    controlAsset,
                    inputs.length ? inputs : [],
                    outputs.length ? outputs : [],
                    metadata.length ? metadata : []
                );
                expect(assetGroup).toBeDefined();

                const serialized = assetGroup.serialize();
                expect(serialized).toBeDefined();
                expect(serialized.length).toBeGreaterThan(0);
                expect(assetGroup.toString()).toBe(v.serializedHex);

                const fromString = AssetGroup.fromString(v.serializedHex);
                if (assetId) {
                    expect(fromString.assetId).toBeDefined();
                    expect(fromString.assetId!.toString()).toBe(
                        assetId.toString()
                    );
                } else {
                    expect(fromString.assetId).toBeNull();
                }
                if (controlAsset) {
                    expect(fromString.controlAsset).toBeDefined();
                    expect(fromString.controlAsset!.toString()).toBe(
                        controlAsset.toString()
                    );
                } else {
                    expect(fromString.controlAsset).toBeNull();
                }
            });
        });
    });

    describe("invalid", () => {
        describe("fromString", () => {
            assetGroupFixtures.invalid.newAssetGroupFromString.forEach((v) => {
                it(v.name, () => {
                    expect(() =>
                        AssetGroup.fromString(v.serializedHex)
                    ).toThrow(v.expectedError);
                });
            });
        });
    });
});

describe("Packet", () => {
    interface PacketAssetFixture {
        assetId?: AssetIdFixture;
        controlAsset?: AssetRefFixture;
        metadata?: MetadataFixture[];
        inputs?: AssetInputFixture[];
        outputs?: AssetOutputFixture[];
    }

    function parsePacketAsset(f: PacketAssetFixture): AssetGroup {
        const assetId = parseAssetId(f.assetId);
        const controlAsset = parseAssetRef(f.controlAsset);
        const inputs = (f.inputs || []).map((i) =>
            parseAssetInput(i as AssetInputFixture)
        );
        const outputs = (f.outputs || []).map((o) =>
            parseAssetOutput(o as AssetOutputFixture)
        );
        const metadata = (f.metadata || []).map((m) =>
            parseMetadata(m as MetadataFixture)
        );

        return AssetGroup.create(
            assetId,
            controlAsset,
            inputs.length ? inputs : [],
            outputs.length ? outputs : [],
            metadata.length ? metadata : []
        );
    }

    describe("valid", () => {
        describe("newPacket", () => {
            packetFixtures.valid.newPacket.forEach((v) => {
                it(v.name, () => {
                    const assets = v.assets.map((a) =>
                        parsePacketAsset(a as PacketAssetFixture)
                    );
                    const packet = Packet.create(assets);

                    expect(packet).toBeDefined();

                    const serialized = packet.serialize();
                    expect(serialized).toBeDefined();
                    expect(serialized.length).toBeGreaterThan(0);

                    const txOut = packet.txOut();
                    expect(txOut.amount).toBe(BigInt(v.expectedAmount));
                    expect(hex.encode(txOut.script)).toBe(v.expectedScript);

                    const fromString = Packet.fromString(v.expectedScript);
                    expect(fromString.groups.length).toBe(assets.length);
                });
            });
        });

        describe("newPacketFromString", () => {
            packetFixtures.valid.newPacketFromString.forEach((v) => {
                it(v.name, () => {
                    const packet = Packet.fromString(v.script);
                    expect(packet).toBeDefined();

                    const serialized = packet.serialize();
                    expect(serialized).toBeDefined();
                    expect(serialized.length).toBeGreaterThan(0);
                    expect(packet.toString()).toBe(v.script);
                });
            });
        });

        describe("newPacketFromTxOut", () => {
            packetFixtures.valid.newPacketFromTxOut.forEach((v) => {
                it(v.name, () => {
                    const script = hex.decode(v.script);
                    expect(Packet.isAssetPacket(script)).toBe(true);

                    const packet = Packet.fromTxOut(script);
                    expect(packet).toBeDefined();

                    const serialized = packet.serialize();
                    expect(serialized).toBeDefined();
                    expect(serialized.length).toBeGreaterThan(0);
                    expect(packet.toString()).toBe(v.script);

                    const fromString = Packet.fromString(v.script);
                    expect(fromString.groups.length).toBe(packet.groups.length);
                });
            });
        });

        describe("leafTxPacket", () => {
            packetFixtures.valid.leafTxPacket.forEach((v) => {
                it(v.name, () => {
                    const intentTxid = hex.decode(v.intentTxid);
                    const packet = Packet.fromString(v.script);

                    expect(packet).toBeDefined();

                    const leafTxPacket = packet.leafTxPacket(intentTxid);
                    expect(leafTxPacket).toBeDefined();
                    expect(leafTxPacket.toString()).toBe(
                        v.expectedLeafTxPacket
                    );
                });
            });
        });
    });

    describe("invalid", () => {
        describe("newPacket", () => {
            packetFixtures.invalid.newPacket.forEach((v) => {
                it(v.name, () => {
                    if (v.assets.length === 0) {
                        expect(() => Packet.create([])).toThrow(
                            v.expectedError
                        );
                    } else {
                        const assets = v.assets.map((a) =>
                            parsePacketAsset(a as PacketAssetFixture)
                        );
                        expect(() => Packet.create(assets)).toThrow(
                            v.expectedError
                        );
                    }
                });
            });
        });

        describe("newPacketFromString", () => {
            packetFixtures.invalid.newPacketFromString.forEach((v) => {
                it(v.name, () => {
                    expect(() => Packet.fromString(v.script)).toThrow(
                        v.expectedError
                    );
                });
            });
        });

        describe("newPacketFromTxOut", () => {
            packetFixtures.invalid.newPacketFromTxOut.forEach((v) => {
                it(v.name, () => {
                    const script = v.script
                        ? hex.decode(v.script)
                        : new Uint8Array(0);
                    expect(Packet.isAssetPacket(script)).toBe(false);
                    expect(() => Packet.fromTxOut(script)).toThrow();
                });
            });
        });
    });
});
