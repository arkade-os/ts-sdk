import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { EventSource } from "eventsource";
import * as sdk from "../../../dist/index.js";

sdk.configureEventSource((url) => new EventSource(url));
export { sdk };
export const directory = dirname(fileURLToPath(import.meta.url));
export const repository = resolve(directory, "../../../../..");
export const hex = (bytes) => Buffer.from(bytes).toString("hex");
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const read = async (file) => JSON.parse(await readFile(file, "utf8"));
export const save = (file, value) =>
    writeFile(
        file,
        JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n",
        { flush: true, mode: 0o600 },
    );
const exec = promisify(execFile);
export async function command(binary, args, options = {}) {
    const result = await exec(binary, args, {
        cwd: repository,
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 16 * 1024 * 1024,
        ...options,
    });
    return result.stdout.trim();
}
export const docker = (...args) => command("docker", args);
export async function owned(state, name) {
    const [container] = JSON.parse(await docker("inspect", name));
    assert.equal(container.Config.Labels["io.arkade.proof.run"], state.runId);
    return container;
}
export function published(container, port) {
    const binding = container.NetworkSettings.Ports[`${port}/tcp`]?.[0];
    assert.equal(binding?.HostIp, "127.0.0.1");
    return `http://127.0.0.1:${binding.HostPort}`;
}
export async function waitFor(label, fn, timeout = 180000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        const value = await fn();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Timed out: ${label}`);
}
export function savingsTemplate(artifactId, args) {
    return {
        format: "delegateed-template/v1",
        type: "offchain",
        inputs: [
            {
                name: "funds",
                contract: { definition: { artifact: artifactId }, arguments: args },
                spend: { function: "release", leaf: "release" },
            },
        ],
        outputs: [
            { name: "payout", index: 0, value: { from: "funds" }, locking: `5120${args.payout}` },
        ],
        packets: { output_index: 1 },
    };
}
