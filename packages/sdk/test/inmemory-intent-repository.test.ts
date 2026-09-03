import { intentRepositoryConformance } from "./conformance/intentRepository.conformance";
import { InMemoryIntentRepository } from "../src/repositories/inMemory/intentRepository";

intentRepositoryConformance("in-memory", async () => new InMemoryIntentRepository());
