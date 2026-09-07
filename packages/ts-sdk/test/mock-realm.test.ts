import { describe, it, expect } from "vitest";
import { createMockRealm } from "../../../config/test-helpers/mockRealm";

// The shared mock's own coverage. `== null` has no caller in this package's
// repointed suites yet — RealmContractRepository emits it, and converging that
// suite onto this mock is a follow-up — so it needs a direct test or it ships
// unexercised.

const SCHEMAS = { Row: "id" };

describe("mockRealm", () => {
    it("matches a `col == null` clause against null and absent properties alike", () => {
        const realm = createMockRealm(SCHEMAS);
        realm.write(() => {
            realm.create("Row", { id: "explicit", watch: null });
            realm.create("Row", { id: "absent" });
            realm.create("Row", { id: "set", watch: true });
        });

        const matched = [...realm.objects<{ id: string }>("Row").filtered("watch == null")];
        expect(matched.map((r) => r.id).sort()).toEqual(["absent", "explicit"]);
    });

    it("combines a null clause with a bound one inside an OR group", () => {
        const realm = createMockRealm(SCHEMAS);
        realm.write(() => {
            realm.create("Row", { id: "a", watch: null });
            realm.create("Row", { id: "b", watch: true });
            realm.create("Row", { id: "c", watch: false });
        });

        const matched = [
            ...realm
                .objects<{ id: string }>("Row")
                .filtered("(watch == $0 OR watch == null)", true),
        ];
        expect(matched.map((r) => r.id).sort()).toEqual(["a", "b"]);
    });

    it("throws on a schema with no configured primary key", () => {
        const realm = createMockRealm(SCHEMAS);
        expect(() => realm.write(() => realm.create("Other", { id: "a" }))).toThrow(
            /no primary key configured/,
        );
    });
});
