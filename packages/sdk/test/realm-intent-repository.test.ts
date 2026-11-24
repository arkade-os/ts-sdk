import { intentRepositoryConformance } from "./conformance/intentRepository.conformance";
import { RealmBatchRegistrationRepository } from "../src/repositories/realm/intentRepository";
import { createMockRealm } from "../../../config/test-helpers/mockRealm";

intentRepositoryConformance(
    "realm",
    async () => new RealmBatchRegistrationRepository(createMockRealm({ ArkIntent: "intentTxId" })),
);
