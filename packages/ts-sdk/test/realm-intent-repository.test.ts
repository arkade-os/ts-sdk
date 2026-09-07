import { intentRepositoryConformance } from "./conformance/intentRepository.conformance";
import { RealmIntentRepository } from "../src/repositories/realm/intentRepository";
import { createMockRealm } from "../../../config/test-helpers/mockRealm";

intentRepositoryConformance(
    "realm",
    async () => new RealmIntentRepository(createMockRealm({ ArkIntent: "intentTxId" })),
);
