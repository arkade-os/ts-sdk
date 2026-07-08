import { virtualTxRepositoryConformance } from "./conformance/virtualTxRepository.conformance";
import { RealmVirtualTxRepository } from "../src/repositories/realm/virtualTxRepository";
import { createMockRealm } from "./helpers/mockRealm";

virtualTxRepositoryConformance(
    "realm",
    async () => new RealmVirtualTxRepository(createMockRealm()),
);
