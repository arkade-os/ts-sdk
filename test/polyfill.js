if (typeof self === "undefined") {
    globalThis.self = globalThis;
}

import { indexedDB, IDBKeyRange } from "fake-indexeddb";
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

import { EventSource } from "eventsource";
globalThis.EventSource = EventSource;
