import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const request = { url: "https://taxi.example", payer: "receiver" };
for (const api of [await import("@arkade-os/taxi"), require("@arkade-os/taxi")]) {
    const encoded = api.encodeTaxiParams(request);
    assert.deepEqual(api.decodeTaxiParams(new URLSearchParams(encoded.slice(1))), request);
    assert.throws(
        () => api.decodeTaxiParams(new URLSearchParams(encoded + "&taxipayer=sender")),
        /Invalid Taxi repayment preference/,
    );
}
console.log("Taxi ESM and CommonJS requests preserve repayment preferences");
