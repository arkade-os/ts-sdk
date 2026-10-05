import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

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

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const typecheck = spawnSync(
    process.execPath,
    [
        require.resolve("typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target",
        "ES2022",
        "--module",
        "Node16",
        "--moduleResolution",
        "Node16",
        "test/types/commonjs.cts",
    ],
    { cwd: packageRoot, encoding: "utf8" },
);
if (typecheck.stdout) process.stdout.write(typecheck.stdout);
if (typecheck.stderr) process.stderr.write(typecheck.stderr);
assert.equal(typecheck.status, 0, "CommonJS TypeScript consumer must resolve the public package exports");
console.log("Taxi CommonJS TypeScript consumer resolves the public declarations");
