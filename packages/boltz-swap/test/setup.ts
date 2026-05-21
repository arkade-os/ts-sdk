import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { EventSource } from "eventsource";

// Minimal browser-ish globals for tests
(globalThis as any).indexedDB = indexedDB;
(globalThis as any).IDBKeyRange = IDBKeyRange;
(globalThis as any).window = globalThis;
(globalThis as any).EventSource = EventSource;
