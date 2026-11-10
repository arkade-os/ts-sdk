import assert from "node:assert/strict";
import { test } from "node:test";
import { assertReleaseDependencies } from "./release-dependencies.mjs";

const vendoredDiscovery = "file:../../vendor/solver-discovery.tgz";

test("swap release rejects a vendored discovery dependency", () => {
    assert.throws(
        () => assertReleaseDependencies(["swap"], vendoredDiscovery),
        /Replace.*@arkade-os\/solver-discovery.*published release/,
    );
});

test("combined SDK and swap release rejects the dependency before either can publish", () => {
    assert.throws(
        () => assertReleaseDependencies(["sdk", "swap"], vendoredDiscovery),
        /Cannot release.*file:/,
    );
});

test("swap release accepts a published discovery dependency", () => {
    assert.doesNotThrow(() => assertReleaseDependencies(["sdk", "swap"], "^0.3.1"));
});

test("a selection without swap is unaffected by its vendored dependency", () => {
    assert.doesNotThrow(() => assertReleaseDependencies(["sdk"], vendoredDiscovery));
});
