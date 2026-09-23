import { createRequire } from "node:module";
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(root, "../../package.json"));
const esbuild = require("esbuild");

const buildOnly = process.argv.includes("--build");
const outfile = path.join(root, "dist", "app.js");

const options = {
    entryPoints: [path.join(root, "src", "main.ts")],
    bundle: true,
    format: "esm",
    outfile,
    platform: "browser",
    target: "es2022",
    sourcemap: true,
    logLevel: "info",
};

if (buildOnly) {
    await esbuild.build(options);
} else {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    const port = Number(process.env.PORT || 4173);
    const types = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".map": "application/json",
        ".css": "text/css; charset=utf-8",
    };
    http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
        const file = path.join(root, rel);
        if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
            res.writeHead(404);
            res.end("not found");
            return;
        }
        res.writeHead(200, {
            "content-type": types[path.extname(file)] ?? "application/octet-stream",
        });
        createReadStream(file).pipe(res);
    }).listen(port, "127.0.0.1", () => {
        console.log(`escrow demo http://127.0.0.1:${port}`);
    });
}
