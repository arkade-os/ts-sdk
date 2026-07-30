import { intentRepositoryConformance } from "./conformance/intentRepository.conformance";
import { RealmIntentRepository } from "../src/repositories/realm/intentRepository";
import { createMockRealm } from "./helpers/mockRealm";

intentRepositoryConformance("realm", async () => new RealmIntentRepository(createMockRealm()));
