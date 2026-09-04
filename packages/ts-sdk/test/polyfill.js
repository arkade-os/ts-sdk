import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { EventSource } from "eventsource";

import { webcrypto } from "crypto";

if (typeof self === "undefined") {
    globalThis.self = globalThis;
}
globalThis.window = globalThis;
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
globalThis.EventSource = EventSource;

if (!globalThis.crypto) {
    globalThis.crypto = webcrypto;
} else if (!globalThis.crypto.subtle) {
    globalThis.crypto.subtle = webcrypto.subtle;
}
