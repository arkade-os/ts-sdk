import { intentRepositoryConformance } from "./conformance/intentRepository.conformance";
import { IndexedDBIntentRepository } from "../src/repositories/indexedDB/intentRepository";

// IndexedDB is provided globally by test/polyfill.js (indexeddbshim).
let n = 0;
intentRepositoryConformance(
    "indexeddb",
    async () => new IndexedDBIntentRepository(`intent-${n++}`),
);
