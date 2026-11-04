import { batchRegistrationRepositoryConformance } from "./conformance/batchRegistrationRepository.conformance";
import { InMemoryBatchRegistrationRepository } from "../src/repositories/inMemory/batchRegistrationRepository";

batchRegistrationRepositoryConformance(
    "in-memory",
    async () => new InMemoryBatchRegistrationRepository(),
);
