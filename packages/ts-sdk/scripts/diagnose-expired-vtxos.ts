// Read-only diagnosis of virtual transactions that funded a lockup (old Boltz
// VHTLC) whose batch later expired and was swept.
//
//   pnpm exec vite-node --config vitest.config.ts scripts/diagnose-expired-vtxos.ts <txid> [txid...]
//   pnpm exec vite-node --config vitest.config.ts scripts/diagnose-expired-vtxos.ts --server https://arkade.computer <txid>
//
// Does not sign or broadcast. A key import only watches the sender's own vtxo
// script; a swept lockup is recovered by spending one leaf of the lockup script.

import { DEFAULT_ARKADE_SERVER_URL } from "../src/networks";
import { RestArkProvider } from "../src/providers/ark";
import { RestIndexerProvider } from "../src/providers/indexer";
import { diagnoseFundingOnServer, formatFundingReport } from "../src/rescue/diagnoseFunding";

function parseArgs(argv: string[]): { server: string; txids: string[] } {
    const txids: string[] = [];
    let server: string = DEFAULT_ARKADE_SERVER_URL;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--server") {
            const next = argv[++i];
            if (!next) throw new Error("--server requires a URL");
            server = next;
            continue;
        }
        if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
        txids.push(arg);
    }
    if (txids.length === 0) {
        throw new Error("usage: diagnose-expired-vtxos.ts [--server URL] <txid> [txid...]");
    }
    return { server, txids };
}

const { server, txids } = parseArgs(process.argv.slice(2));
const info = await new RestArkProvider(server).getInfo();
const report = await diagnoseFundingOnServer(info, new RestIndexerProvider(server), txids);
process.stdout.write(`${formatFundingReport(report)}\n`);
