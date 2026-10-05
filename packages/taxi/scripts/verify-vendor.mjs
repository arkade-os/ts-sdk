import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const root = new URL("../vendor/", import.meta.url);
const { artifacts } = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
for (const artifact of artifacts) {
    const bytes = readFileSync(new URL(artifact.file, root));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== artifact.sha256 || bytes.length !== artifact.bytes)
        throw new Error(`Frozen Taxi archive mismatch: ${artifact.file}`);
}
console.log(`Verified ${artifacts.length} frozen Taxi development archives`);
