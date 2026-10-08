import { virtualTxRepositoryConformance } from "./conformance/virtualTxRepository.conformance";
import { IndexedDBVirtualTxRepository } from "../src/repositories/indexedDB/virtualTxRepository";

// IndexedDB is provided globally by test/polyfill.js (indexeddbshim).
let n = 0;
virtualTxRepositoryConformance(
    "indexeddb",
    async () => new IndexedDBVirtualTxRepository(`vtx-${n++}`),
);
