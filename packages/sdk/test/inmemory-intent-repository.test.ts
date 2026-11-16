import { intentRepositoryConformance } from "./conformance/intentRepository.conformance";
import { InMemoryBatchRegistrationRepository } from "../src/repositories/inMemory/intentRepository";

intentRepositoryConformance("in-memory", async () => new InMemoryBatchRegistrationRepository());
