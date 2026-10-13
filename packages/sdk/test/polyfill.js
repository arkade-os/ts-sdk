import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { EventSource } from "eventsource";

if (typeof self === "undefined") {
    globalThis.self = globalThis;
}
globalThis.window = globalThis;
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
globalThis.EventSource = EventSource;
