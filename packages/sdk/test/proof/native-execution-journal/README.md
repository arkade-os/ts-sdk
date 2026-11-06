# Native execution journal funded proof

For reviewers of `NativeExecutionJournal`, this runs one real recovery lifecycle against a fresh Bitcoin regtest and the public, pinned backend/service inputs shared with the [native proof](../native-executor/README.md). It uses the built public SDK and real SQLite storage, with every repository on the signing connection coordinated through `getSerializedExecutor`.

After building the SDK with Node **24.22.1**, pnpm **10.25.0** and Docker Engine/Compose available, run from the repository root:

```sh
node packages/sdk/test/proof/native-execution-journal/prove.mjs
```

The parent proof's funding actor boards fresh regtest sats and creates three distinct 50,000-sat positions. A real `PRAGMA query_only` write failure inside the awaited submission callback prevents all emulator requests and leaves no prepared slot. A second attempt commits the exact immutable proposal first. Its HTTP relay captures the emulator's actual successful signed response, then destroys the downstream connection before sending headers or a body. The signing wallet rejects the unknown result and exits with its prepared slot still occupied and no receipt.

A separate process opens only the wallet-state SQLite repository, source outpoint and public indexer configuration. It never opens signing material or constructs a Wallet. Actual REST replies altered to carry malformed/incomplete pagination or oversized bodies must remain unknown without receipts. Complete live signed transaction history then yields a bound historical receipt. Another keyless process reopens the same database and reads that receipt with zero RPCs; the prepared slot still refuses another admission. Neither process has permission to send a non-GET request through its transport.

Only after every preceding actor exits does the parent resume its own labeled delegatee, which was paused before funding. It observes the separate principal return before reopening the same wallet. The runner records one native emulator dispatch throughout, source/checkpoint/payout lineage, process-close barriers, actual service identities and source/build hashes. A separate auditor verifies required signatures, witness prevouts, exact proposal/response bytes and the complete explicit public evidence set. Sources and SDK build must remain unchanged during the run.

The existing funded-proof workflow runs this after the parent native proof. Each child run writes `.tmp/native-execution-journal/<uuid>/public/audit.json` and a hash manifest only after successful assertions and owned-service cleanup. It uploads public JSON only; keys, SQLite/WAL, generated Compose, environment and raw logs remain private. The command cannot accept an existing chain or wallet, stops only its labeled containers, and never deletes volumes.

This establishes accepted-but-lost-response reconciliation against configured-indexer history, not independent finality or authority to retry, release or hand off the occupied slot. Renewal, common coin ownership, scheduler migration and default-wallet cutover remain separate gates.
