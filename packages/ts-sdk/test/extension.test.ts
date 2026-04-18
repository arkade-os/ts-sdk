import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { Extension } from "../src/extension";
import {
    AssetGroup,
    AssetRef,
    AssetOutput,
    Packet,
} from "../src/extension/asset";
import { Transaction } from "../src/utils/transaction";
import extensionFixtures from "./fixtures/extension_fixtures.json";

interface IsExtensionFixture {
    name: string;
    hex: string;
}
interface ExtensionFixtureValid {
    newExtensionFromBytes: Array<{
        name: string;
        hex: string;
        expectedPacketCount: number;
        expectedPacketTypes: number[];
    }>;
    roundtrip: Array<{
        name: string;
        hex: string;
    }>;
}
interface ExtensionFixtureInvalid {
    newExtensionFromBytes: Array<{
        name: string;
        hex: string;
        expectedError: string;
    }>;
}
interface ExtensionFixtures {
    valid: ExtensionFixtureValid;
    invalid: ExtensionFixtureInvalid;
    isExtension?: {
        true: IsExtensionFixture[];
        false: IsExtensionFixture[];
    };
}

const extFixtures = extensionFixtures as ExtensionFixtures;

describe("Extension", () => {
    describe("valid", () => {
        describe("newExtensionFromBytes", () => {
            extFixtures.valid.newExtensionFromBytes.forEach((v) => {
                it(v.name, () => {
                    const data = hex.decode(v.hex);
                    const ext = Extension.fromBytes(data);
                    expect(ext).toBeDefined();
                    const assetPacket = ext.getAssetPacket();
                    if (v.expectedPacketTypes.includes(0)) {
                        expect(assetPacket).not.toBeNull();
                    } else {
                        expect(assetPacket).toBeNull();
                    }
                });
            });
        });

        describe("roundtrip", () => {
            extFixtures.valid.roundtrip.forEach((v) => {
                it(v.name, () => {
                    const data = hex.decode(v.hex);
                    const ext = Extension.fromBytes(data);
                    const serialized = ext.serialize();
                    expect(hex.encode(serialized)).toBe(v.hex);
                    expect(Extension.isExtension(serialized)).toBe(true);

                    const txOut = ext.txOut();
                    expect(txOut.amount).toBe(0n);
                    expect(hex.encode(txOut.script)).toBe(v.hex);
                });
            });
        });

        describe("isExtension", () => {
            extFixtures.isExtension?.true.forEach((v) => {
                it(`true: ${v.name}`, () => {
                    const data = v.hex ? hex.decode(v.hex) : new Uint8Array(0);
                    expect(Extension.isExtension(data)).toBe(true);
                });
            });

            extFixtures.isExtension?.false.forEach((v) => {
                it(`false: ${v.name}`, () => {
                    const data = v.hex ? hex.decode(v.hex) : new Uint8Array(0);
                    expect(Extension.isExtension(data)).toBe(false);
                });
            });
        });

        describe("newExtensionFromTx", () => {
            function makeExtTx(
                extraOutputs: Array<{ script: Uint8Array; amount: bigint }> = []
            ): Transaction {
                const group = AssetGroup.create(
                    null,
                    AssetRef.fromGroupIndex(0),
                    [],
                    [AssetOutput.create(0, 21000000n)],
                    []
                );
                const packet = Packet.create([group]);
                const ext = Extension.create([packet]);
                const tx = new Transaction();
                for (const out of extraOutputs) tx.addOutput(out);
                tx.addOutput(ext.txOut());
                return tx;
            }

            it("extension as only output", () => {
                const tx = makeExtTx();
                const ext = Extension.fromTx(tx);
                expect(ext).toBeDefined();
                expect(ext.getAssetPacket()).not.toBeNull();
            });

            it("extension among multiple outputs", () => {
                const tx = makeExtTx([
                    { script: new Uint8Array([0x51]), amount: 1000n },
                ]);
                const ext = Extension.fromTx(tx);
                expect(ext).toBeDefined();
                expect(ext.getAssetPacket()).not.toBeNull();
            });

            it("no extension output throws", () => {
                const tx = new Transaction();
                tx.addOutput({ script: new Uint8Array([0x51]), amount: 1000n });
                expect(() => Extension.fromTx(tx)).toThrow(
                    "no extension output found in transaction"
                );
            });

            it("no outputs throws", () => {
                const tx = new Transaction();
                expect(() => Extension.fromTx(tx)).toThrow(
                    "no extension output found in transaction"
                );
            });
        });

        it("getAssetPacket returns the embedded Packet", () => {
            const data = hex.decode(extFixtures.valid.roundtrip[0].hex);
            const ext = Extension.fromBytes(data);
            const assetPacket = ext.getAssetPacket();
            expect(assetPacket).not.toBeNull();
            expect(assetPacket!.groups.length).toBeGreaterThan(0);
        });

        it("Extension.create wraps a Packet and round-trips", () => {
            const group = AssetGroup.create(
                null,
                AssetRef.fromGroupIndex(0),
                [],
                [AssetOutput.create(0, 21000000n)],
                []
            );
            const packet = Packet.create([group]);
            const ext = Extension.create([packet]);
            const script = ext.serialize();
            expect(Extension.isExtension(script)).toBe(true);

            const reparsed = Extension.fromBytes(script);
            const reparsedPacket = reparsed.getAssetPacket();
            expect(reparsedPacket).not.toBeNull();
            expect(reparsedPacket!.groups.length).toBe(1);
        });
    });

    describe("invalid", () => {
        describe("newExtensionFromBytes", () => {
            extFixtures.invalid.newExtensionFromBytes.forEach((v) => {
                it(v.name, () => {
                    const data = v.hex ? hex.decode(v.hex) : new Uint8Array(0);
                    expect(() => Extension.fromBytes(data)).toThrow(
                        v.expectedError
                    );
                });
            });
        });
    });
});
