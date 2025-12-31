if (typeof self === "undefined") {
    globalThis.self = globalThis;
}

import setGlobalVars from "indexeddbshim/src/node.js";
globalThis.window = globalThis;
setGlobalVars(null, { checkOrigin: false, memoryDatabase: "" });
import { EventSource } from "eventsource";
globalThis.EventSource = EventSource;
