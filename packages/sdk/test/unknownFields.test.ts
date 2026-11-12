import { describe, expect, it } from "vitest";
import { Transaction } from "../src/utils/transaction";
import { ArkadeTweak, getArkPsbtFields, setArkPsbtField } from "../src/utils/unknownFields";

const hash = (b: number) => new Uint8Array(32).fill(b);
const key = { type: 222, key: new TextEncoder().encode("arkadetweak") };

describe("ArkadeTweak", () => {
    it.each([[[hash(1)]], [[hash(1), hash(2), hash(3)]]])(
        "round-trips %# through a PSBT",
        (hashes) => {
            const tx = new Transaction();
            tx.addInput({ txid: new Uint8Array(32), index: 0 });
            setArkPsbtField(tx, 0, ArkadeTweak, hashes);

            const decoded = Transaction.fromPSBT(tx.toPSBT());
            expect(getArkPsbtFields(decoded, 0, ArkadeTweak)).toEqual([hashes]);
            expect(ArkadeTweak.encode(hashes)[0]).toEqual(key);
        },
    );

    it.each([
        [[]],
        [[hash(1).subarray(1)]],
        [[new Uint8Array(33)]],
        [Array.from({ length: 17 }, (_, i) => hash(i))],
    ])("refuses to encode %#", (hashes) => {
        expect(() => ArkadeTweak.encode(hashes)).toThrow(/invalid arkade tweak/);
    });

    it.each([0, 33, 17 * 32])("refuses to decode a %i-byte value", (length) => {
        expect(() => ArkadeTweak.decode([key, new Uint8Array(length)])).toThrow(
            "invalid arkade tweak field length",
        );
    });
});
