import { virtualTxRepositoryConformance } from "./conformance/virtualTxRepository.conformance";
import { InMemoryVirtualTxRepository } from "../src/repositories/inMemory/virtualTxRepository";

virtualTxRepositoryConformance(
    "in-memory",
    async () => new InMemoryVirtualTxRepository()
);
