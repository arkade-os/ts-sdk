import { batchRegistrationRepositoryConformance } from "./conformance/batchRegistrationRepository.conformance";
import { RealmBatchRegistrationRepository } from "../src/repositories/realm/batchRegistrationRepository";
import { createMockRealm } from "../../../config/test-helpers/mockRealm";

batchRegistrationRepositoryConformance(
    "realm",
    async () => new RealmBatchRegistrationRepository(createMockRealm({ ArkIntent: "intentTxId" })),
);
