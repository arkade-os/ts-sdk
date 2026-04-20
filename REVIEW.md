# ts-sdk Critical Review — `fxi-issue-with-default-address`

**Scope:** Deep review of shortcomings and potential bugs in the current branch, targeting the three reported symptom clusters:

1. VTXO state is frequently out of sync.
2. Multi-contract support is buggy — the codebase was opinionated for single-contract and multi-contract was retrofitted.
3. Users constantly retrying a register-intent because of a timeout, despite register-intent having no time horizon and being free to live in the background.

This document captures every finding from the review, organized by theme, with file:line references and proposed fixes. Recommendations at the end reflect two design decisions made during review:

- **Keep the single global sync cursor.** Bulk polling is the hot path and partial polls can safely skip advancing the global cursor, relying on `OVERLAP_MS` to cover gaps.
- **`contractId` is the script.** `Contract.script` is already the primary key of the contracts store; VTXO rows should be keyed by script too.

---

## Executive summary

Three root causes account for most of the observed symptoms:

### 1. The sync cursor never advances in normal operation

`syncContracts` in `src/contracts/contractManager.ts` only advances the global cursor when `options.contracts === undefined`. Every non-`refreshVtxos({})` caller passes `options.contracts`, so in practice the cursor is write-only from `refreshVtxos` — and nothing calls `refreshVtxos({})` on a schedule. Combined with `OVERLAP_MS = 30min`, the wallet re-queries the same 30-minute window forever. "Stale state" is the steady state, not an exception.

### 2. `extendVirtualCoin(this, vtxo)` is hard-wired to the default contract's tapscript

`src/wallet/utils.ts:19` uses `wallet.offchainTapscript` unconditionally. Every callsite that walks VTXOs across all contracts but passes `this` (the wallet) writes the wrong `forfeitTapLeafScript` / `intentTapLeafScript` / `tapTree` for VTXOs that don't belong to the default contract. These are exactly the values used at forfeit/register/delete time. This is the retrofit-single-contract footgun, manifest.

### 3. The register-intent retry cascade is driven outside the SDK

`settle()` has no deadline, no internal retry, and no way to distinguish "stream closed transiently" from "server rejected". When the consumer wraps it in its own retry:

- `renewVtxos()` re-fires on every `vtxo_received` after the 30s cooldown.
- `safeRegisterIntent`'s "duplicated input" branch deletes intents for **all** wallet coins — including delegator-issued intents.
- The delegator's next call throws "VTXO_ALREADY_SPENT", which the VtxoManager listener silently swallows.

Three retry loops stacked on top of each other, with no observable state for the consumer to break the cycle.

---

## Detailed findings

### A. Stale VTXO state

#### A.1 Sync cursor is never advanced in the hot path — critical

**File:** `src/contracts/contractManager.ts` — `syncContracts`

```ts
const mustUpdateCursor =
    options.contracts === undefined && (window.after ?? 0) < cursor;
```

Every caller except `refreshVtxos({})` passes `contracts`:

| Caller | Passes `contracts`? | Advances cursor? |
|---|---|---|
| `initialize()` | yes — from contract repo | **no** |
| `getContractsWithVtxos(filter)` | yes — filtered list | **no** |
| `handleContractEvent('vtxo_received'&#124;'vtxo_spent')` | yes — `[event.contract]` | **no** |
| `refreshVtxos(opts)` | only when `opts.scripts` present | advances if no scripts |

Nothing calls `refreshVtxos({})` on a schedule, so in practice the cursor is never advanced.

**Consequence:** every sync queries `[cursor - OVERLAP_MS, now]` from the indexer, perpetually. The 30-minute overlap that was added "as a safety margin for longer operations like settlement, onboarding, etc." (comment in `src/utils/syncCursors.ts`) is really masking this broken cursor rather than defending against boundary races.

**Fix:** ensure a bulk sync path runs periodically so the cursor advances. Two options:

- Make `initialize()` call `syncContracts({})` (no `contracts`) after loading the contract list — a single bulk catch-up on startup that also sets the cursor.
- Add a periodic timer (or piggyback on `ContractWatcher`'s failsafe poll) that calls `refreshVtxos({})` every N minutes.

Both keep the subset-sync-doesn't-advance rule intact. `OVERLAP_MS` can then drop from 30 minutes back to ~5 minutes once the cursor actually moves.

---

#### A.2 Upsert-only `saveVtxos` + `spendableOnly: true` — high

**File:** `src/worker/expo/processors/contractPollProcessor.ts:70`

```ts
await walletRepository.saveVtxos(contract.address, allVtxos);
```

The Expo background processor fetches VTXOs with `spendableOnly: true` from the indexer and calls `saveVtxos`. Every repository implementation (`indexedDB`, `sqlite`, `realm`, `inMemory`) implements `saveVtxos` as upsert — no batch delete. A VTXO that becomes spent between polls stays in the DB marked as spendable forever.

In contrast, `ContractManager.syncContracts` (`contractManager.ts:744`, `:831`) fetches *without* `spendableOnly`, so it sees the spent records and overwrites them. The processor and the manager have diverged in semantics.

**Fix:** introduce a `replaceVtxos(script, vtxos)` repo primitive (see §D.1) or drop `spendableOnly: true` from the processor. The former is preferable — it makes the "replace contents for this contract" operation a first-class primitive.

---

#### A.3 `ContractWatcher.lastKnownVtxos` is in-memory only — medium

**File:** `src/contracts/contractWatcher.ts`

`lastKnownVtxos: Set<string>` is populated from subscription pushes and used to diff new vs. seen. The set resets to empty on every fresh process, so the first push after restart is treated as a full new set and re-emits `vtxo_received` for every VTXO already in the repo.

Downstream listeners that act on "new" events (`VtxoManager.renewVtxos` via event, `DelegatorManager.delegate`) then re-trigger against VTXOs they already processed.

**Fix:** seed `lastKnownVtxos` from the repository on watcher start. The `(txid, vout)` set for a given script is one query away.

---

#### A.4 `reconcilePendingFrontier` only runs once at `initialize()` — medium

**File:** `src/contracts/contractManager.ts`

`ContractManager.initialize()` calls `reconcilePendingFrontier` once to catch up on anything missed while offline.

On `connection_reset`, `handleContractEvent` instead does `fetchContractVxosFromIndexer(activeWatchedContracts, true)` — a full refetch of only the actively-watched subset. Inactive-but-still-holding-VTXOs contracts (typical for delegator sub-accounts after expiry rotation) are skipped, and the full-history reconciliation logic doesn't re-run.

**Consequence:** a long disconnect followed by reconnect can leave inactive contracts in drifted state until the next bulk sync — which per §A.1 may never happen.

**Fix:** on `connection_reset`, re-run `reconcilePendingFrontier` across *all* contracts with stored VTXOs, not just the active-watched subset.

---

#### A.5 `VtxoManager.knownBoardingUtxos` / `sweptBoardingUtxos` in-memory — medium

**File:** `src/wallet/vtxo-manager.ts`

Same class of bug as §A.3. These sets are used to guard against re-emitting boarding events and re-sweeping; they reset on every process start. Re-sweeps and duplicate onboarding attempts become possible across restarts.

**Fix:** persist the "seen" set, or rebuild it from repository state at startup.

---

### B. Multi-contract footguns (retrofit single-contract leakage)

#### B.1 `extendVirtualCoin(wallet, vtxo)` uses the default contract's tapscript unconditionally — critical

**File:** `src/wallet/utils.ts:19`

```ts
export function extendVirtualCoin(
    wallet: { offchainTapscript: ReadonlyWallet["offchainTapscript"] },
    vtxo: VirtualCoin
): ExtendedVirtualCoin {
    return {
        ...vtxo,
        forfeitTapLeafScript: wallet.offchainTapscript.forfeit(),
        intentTapLeafScript:  wallet.offchainTapscript.forfeit(),
        tapTree:              wallet.offchainTapscript.encode(),
    };
}
```

This takes the wallet's default `offchainTapscript` and stamps every VTXO with it. For VTXOs that belong to a non-default contract (delegator, VHTLC, secondary descriptor) the stamped tapscript is wrong. When the VTXO is later used as an input for forfeit/register/delete, the signing step uses those wrong paths.

**Callsites that invoke this with `this` (or a wallet) despite the VTXOs potentially being from non-default contracts:**

| File | Line | Context |
|---|---|---|
| `src/wallet/wallet.ts` | 717, 720 | `notifyIncomingFunds` path |
| `src/wallet/wallet.ts` | 2507 | `updateDbAfterOffchainTx` |
| `src/wallet/wallet.ts` | 2624 | `updateDbAfterSettle` — overwrites tapscript metadata for inputs that came from non-default contracts |
| `src/wallet/serviceWorker/wallet-message-handler.ts` | 1138, 1144 | Service-worker flow |

**Callsites that do the right thing:**

| File | Line | Context |
|---|---|---|
| `src/contracts/contractManager.ts` | 744, 831 | Uses `extendVtxoFromContract(vtxo, contract)` |
| `src/worker/expo/taskRunner.ts` | 144 | Falls back to `extendVtxoFromContract` when contract is passed |
| `src/wallet/expo/wallet.ts` | 142 | Same |

The pattern is obvious: code written after multi-contract support knows better. Older callsites don't.

**Fix:** see §D.2 — key VTXO rows by script, lookup the owning contract by `vtxo.script`, and route every extend helper through a single contract-aware function. Once the DB persists the script per row, there is no excuse for `extendVirtualCoin` to take a wallet instead of a contract.

---

#### B.2 `ContractWatcher.processSubscriptionVtxos` broadcasts VTXOs to every matching script — high

**File:** `src/contracts/contractWatcher.ts`

```ts
// Multiple scripts - assign virtual outputs to all matching contracts
// This is a limitation: we can't know which virtual output belongs to which script
for (const script of scripts) {
    ... // emits event for every (vtxo × script)
}
```

If the subscription covers N scripts, each incoming VTXO fires N events. Downstream handlers then:

- Save the same VTXO under N different contract addresses in the repo (§B.3 interaction).
- Trigger N renewal / delegation attempts.

`RENEWAL_COOLDOWN_MS` and `renewalInProgress` mutex hide the renewal duplication, but not the repo bloat.

**Fix:** each VTXO already carries `script` (`VirtualCoin.script` — `wallet/index.ts:522`, populated by the indexer). Use `vtxo.script` to attribute it to exactly one contract rather than fanning out across all watched scripts.

---

#### B.3 `saveVtxos(address, …)` keys by address → cross-contract writes silently conflict — medium

**File:** `src/repositories/indexedDB/schema.ts:17`

```ts
vtxosStore = db.createObjectStore(STORE_VTXOS, {
    keyPath: ["address", "txid", "vout"],
});
```

Each VTXO row is keyed by the address the caller passed to `saveVtxos`. If any caller writes `saveVtxos(walletDefaultAddress, vtxosThatBelongToContractX)` — because it fell back to the default address — those rows shadow contract X's rows. Nothing enforces "the address must match the VTXO's owning contract".

`extendVirtualCoin(this, vtxo)` already primes this scenario because it doesn't know the true owning contract; if the caller later saves using the wrong address, the wrong tapscript and the wrong address collude to produce a ghost row.

**Fix:** see §D.2 — promote `script` to primary key and drop the external-address argument. Each row derives its key from `vtxo.script`, making wrong-address writes structurally impossible.

---

#### B.4 `handleContractEvent('connection_reset')` refetches only `activeWatchedContracts` — medium

**File:** `src/contracts/contractManager.ts`

On subscription reconnect, only actively-watched contracts are refetched. Inactive-but-still-holding-VTXOs contracts skip the refetch. Their VTXOs can drift while the subscription was down.

**Fix:** refetch every contract with stored VTXOs on reconnect, not just the active-watched subset. See also §A.4.

---

### C. Concurrency / retry cascade — the register-intent loop

#### C.1 `settle()` has no deadline and no SDK-level retry — high

**File:** `src/wallet/wallet.ts:1595-1628` (`_settleImpl`)

```ts
try {
    const stream = this.arkProvider.getEventStream(abortController.signal, topics);
    const intentId = await this.safeRegisterIntent(intent);
    const handler = this.createBatchHandler(intentId, params.inputs, recipients, session);
    const commitmentTxid = await Batch.join(stream, handler, { ... });
    await this.updateDbAfterSettle(params.inputs, commitmentTxid);
    return commitmentTxid;
} catch (error) {
    await this.arkProvider.deleteIntent(deleteIntent).catch(() => {});
    throw error;
} finally {
    abortController.abort();
}
```

`Batch.join` throws `"event stream closed"` when the stream terminates without a finalization event (common during long server-side waits). There is no wrapper that distinguishes:

- "Stream closed mid-batch, safe to retry and register a fresh intent"
- "Server rejected the intent, don't retry"
- "Already registered successfully, the intent is sitting on the server — just wait"

Every consumer that wraps `settle()` in a retry loop is flying blind. This is the **primary driver of the "constantly retrying register intent with timeouts" symptom**: the timeout is the consumer's, not the SDK's, and the SDK cannot tell the consumer "you already succeeded; the next batch will include you".

Additionally: `deleteIntent(...).catch(() => {})` on failure silently drops delete-failures. If the server-side intent wasn't actually deleted, the next `settle()` hits §C.2's "duplicated input" path.

**Fix (structural):**

- Classify errors coming out of `Batch.join` into at least: `StreamClosedRetryable`, `ServerRejected`, `AlreadyRegistered`. Expose the classification to callers.
- Optionally: keep an in-SDK `pendingIntentId` → `status` map so the consumer can poll rather than retry. Register-intent should be a fire-and-follow, not a fire-and-forget-and-retry.
- Log / surface `deleteIntent` failures; don't silently swallow.

---

#### C.2 `safeRegisterIntent`'s "duplicated input" recovery deletes **all** wallet intents — high

**File:** `src/wallet/wallet.ts:1920-1946`

```ts
async safeRegisterIntent(intent: SignedIntent<Intent.RegisterMessage>): Promise<string> {
    try {
        return await this.arkProvider.registerIntent(intent);
    } catch (error) {
        if (
            error instanceof ArkError &&
            error.code === 0 &&
            error.message.includes("duplicated input")
        ) {
            const allSpendableCoins = await this.getVtxos({ withRecoverable: true });
            const deleteIntent = await this.makeDeleteIntentSignature(allSpendableCoins);
            await this.arkProvider.deleteIntent(deleteIntent);
            return this.arkProvider.registerIntent(intent);
        }
        throw error;
    }
}
```

This nukes every live intent the wallet has on the server — including the `DelegatorManager`'s concurrent registrations for sub-accounts. Those delegator calls then throw their own `"VTXO_ALREADY_SPENT"` or `"duplicated input"` on their next operation, which is the symptom the vtxo-manager listener catches at `vtxo-manager.ts:1010-1020` and silently swallows.

Result: the wallet settles, but the delegation quietly fails — and since the delegator retries on the next `vtxo_received`, you get the **register → lose-delegate → retry delegate → collide again** oscillation that shows up in telemetry as constant register-intent retries.

**Fix:** scope the delete to only the colliding inputs. The server's error payload should identify them (or should be extended to do so). A "nuke all and retry" semantics was reasonable for single-contract single-intent-at-a-time operation, but not for multi-contract with concurrent delegator intents.

---

#### C.3 `renewVtxos` driven by `vtxo_received` re-fires on every received batch — high

**File:** `src/wallet/vtxo-manager.ts:983-1030`

```ts
const stopWatching = contractManager.onContractEvent((event) => {
    if (event.type !== "vtxo_received") return;

    const msSinceLastRenewal = Date.now() - this.lastRenewalTimestamp;
    const shouldRenew =
        !this.renewalInProgress &&
        msSinceLastRenewal >= VtxoManager.RENEWAL_COOLDOWN_MS;

    if (shouldRenew) {
        this.renewVtxos().catch((e) => { /* swallow known errors */ });
    }
    delegatorManager?.delegate(event.vtxos, destination).catch(...);
});
```

Cooldown is 30s, mutex is `renewalInProgress`. If a user settle emits `vtxo_received` while a renewal is in-flight, the cooldown + mutex block it — fine.

Problem: `lastRenewalTimestamp = Date.now()` is only set **on success** (`vtxo-manager.ts:736`, inside the `try` block before `return txid`). If settle throws mid-flight (stream close, connector mismatch, duplicated input), the timestamp is *not* updated, so the next `vtxo_received` can immediately re-enter renewal.

Interleave with a consumer also retrying user settles and you get multiple settles fighting for the `_txLock`.

**Fix:** update `lastRenewalTimestamp` in the `finally` block (on every attempt, success or failure) to enforce the cooldown regardless of outcome. Also, distinguish transient-retryable from persistent-fail failures using §C.1's classification; exponential-backoff renewal retries rather than free-running them at the natural event cadence.

---

#### C.4 `_txLock` wraps `settle/send/sendBitcoin` — user actions silently queue behind background renewal — medium

**File:** `src/wallet/wallet.ts` (`_txLock` serializes these)

If `renewVtxos()` holds the lock for minutes (server-side batch wait), a user-initiated `send()` sits invisibly in the queue. The consumer can't see queue depth and times out from its own perspective, then retries, which queues yet another call.

**Fix:** either expose queue depth, or reject concurrent calls with `TX_LOCK_BUSY` (fast-fail) so the consumer can back off deliberately rather than stacking attempts.

---

#### C.5 `getVtxos()` triggers sync-on-read — concurrent sync storm — medium

**File:** `src/wallet/wallet.ts` — `getVtxos` goes through `getContractsWithVtxos`, which calls `syncContracts`.

Read paths trigger writes. If three UI components call `getVtxos()` on mount, three concurrent syncs race. There's no coalescer.

Combined with §A.1 (cursor never advances), each one re-scans 30 minutes of indexer history. Multiplied by the number of concurrent readers.

**Fix:** coalesce in-flight syncs — a single promise shared across concurrent callers until it resolves. This is a common pattern, ~20 lines.

---

#### C.6 `finalizePendingTxs` gated behind `hasPendingTxFlag`, only runs at startup — low

**File:** `src/wallet/wallet.ts:2012`

If a batch finalization commits VTXOs to the server but the client crashes before the DB write, the flag persists and the next startup catches up. But: if the flag is *not* set (crashed before setting it) or cleared by a later bug, pending state is orphaned with no periodic reconciliation to notice.

**Fix:** run this on every app-foreground, not just startup.

---

### D. Repository / persistence

#### D.1 No batch-replace primitive in `WalletRepository` — high

**File:** `src/repositories/walletRepository.ts`

```ts
saveVtxos(address: string, vtxos: ExtendedVirtualCoin[]): Promise<void>;
deleteVtxos(address: string): Promise<void>;
```

- `saveVtxos` is upsert-only — absent keys are not removed.
- `deleteVtxos` nukes *all* rows for an address — too coarse.

There's no "replace contents for this script with this set" primitive. `ContractManager.syncContracts` achieves replace semantics only because it fetches everything (no `spendableOnly`) and overwrites every known row. The background processor (§A.2) doesn't, and consumers can't.

**Fix:** add `replaceVtxos(script, vtxos): Promise<void>` that atomically deletes rows not present in the new set. Every repository implementation gets it; every caller gets a safe primitive.

---

#### D.2 VTXO rows should be keyed by script, not address — critical

**File:** `src/repositories/indexedDB/schema.ts:17`

```ts
keyPath: ["address", "txid", "vout"]
```

**Current state, unified:**

- `Contract.script` is documented as the unique primary key for contracts (`contracts/types.ts:58`).
- The contracts store is keyed by `script` (`schema.ts:147`).
- `VirtualCoin.script` is already an optional field populated by the indexer (`wallet/index.ts:522`: *"The scriptPubKey (hex) locking this virtual output, as returned by the indexer"*).
- `ContractVtxo extends ExtendedVirtualCoin { contractScript: string }` (`contracts/types.ts:84`).
- VTXO DB rows are keyed by `address` — but address is 1:1 with script, so this is *already* effectively contract-scoped keying, just using the wrong column.

**Why "add / promote the script column" is the right move:**

1. **Scripts are network-independent, addresses aren't.** Addresses depend on network params (bech32 HRP, etc.); script hex doesn't. That makes script the correct join key against the contracts table (which already uses `script` as its primary key).
2. **Structural fix for §B.3.** `saveVtxos(address, …)` takes the address as an *external* argument — the caller chooses what to write. If the key were derived from `vtxo.script` directly, wrong-address writes become impossible.
3. **Structural fix for §B.1.** `extendVirtualCoin(vtxo)` can be replaced with a single helper: `async (contractRepo, vtxo) => extendVtxoFromContract(vtxo, await contractRepo.getByScript(vtxo.script))`. No more `this.offchainTapscript` fallback. No more "wallet argument that doesn't know which contract you mean".
4. **Unlocks §D.1 cleanly.** `replaceVtxos(script, vtxos)` is the natural primitive once the key is script-based.

**Proposed shape:**

- Promote `script` to primary key: `keyPath: ["script", "txid", "vout"]`.
- Keep `address` as a secondary index for UI queries and back-compat.
- Persist `script` on every row (`VirtualCoin.script` becomes required, not optional).
- Repo API:
  - `saveVtxos(vtxos: ExtendedVirtualCoin[])` — drop the separate address arg; each row carries its own script.
  - `replaceVtxos(script: string, vtxos: ExtendedVirtualCoin[])` — new primitive from §D.1.
  - `getVtxos(scriptOrAddress: string)` — accept either for back-compat; internally normalize to script via the contracts store.
- One-time migration on schema bump: re-derive `script` from `address` (you have the contract list, it's just a lookup).

This single structural change closes §B.1, §B.3, §D.1 simultaneously.

---

### E. Minor / footnote

- **`SAFETY_LAG_MS = 30_000`** applied only when *advancing* the cursor — since we don't advance (§A.1), it never kicks in.
- **`OVERLAP_MS = 30 * 60 * 1000`** — comment reads "Increased to 30 minutes as a safety margin for longer operations like settlement, onboarding, etc." This is papering over §A.1. Reduce to ~5 minutes once the cursor actually moves.
- **`deleteIntent(...).catch(() => {})`** at `wallet.ts:1623` silently drops failures. If the server-side intent wasn't deleted, the next settle hits §C.2's "duplicated input" path.
- **`contractPollProcessor` and `ContractManager.syncContracts` share no code.** Divergent semantics (spendableOnly, upsert-only, different cursor handling) are guaranteed to drift. Consider extracting a shared core.
- **`DelegatorManagerImpl.delegate` uses `Promise.allSettled`** across expiry groups — multiple in-flight intents increase the odds of hitting §C.2.
- **Cursor handling design note.** The single-global-cursor model is deliberate: bulk polling is the hot path, and if per-contract cursors existed we'd have to use the oldest one anyway. Subset polls intentionally do not advance the global cursor — `OVERLAP_MS` covers the gap. Do not propose per-contract cursors as a fix.

---

## Recommended order of attack

Fix these first — they collapse multiple bugs each:

### Wave 1

1. **§D.2 (key VTXOs by script)** — single structural change that kills §B.1, §B.3, §D.1. Makes `extendVirtualCoin` contract-aware by construction and eliminates wrong-address writes. Includes the `replaceVtxos(script, vtxos)` primitive.
2. **§A.1 (cursor actually advances)** — ensure `initialize()` does a one-shot bulk sync with `contracts=undefined`, and add a periodic bulk sync (or hook into `ContractWatcher` failsafe poll). Drop `OVERLAP_MS` back to ~5 minutes. Single global cursor stays.
3. **§C.2 (`safeRegisterIntent` delete scoping)** — scope the "duplicated input" delete to only the colliding inputs, not all wallet coins. Breaks the register-delegator oscillation loop.

### Wave 2

4. **§A.2 (drop `spendableOnly: true` from the processor or use `replaceVtxos`)** — once §D.1 is shipped, swap in `replaceVtxos`.
5. **§B.2 (watcher script attribution)** — use `vtxo.script` to attribute incoming subscription VTXOs to exactly one contract.
6. **§C.1 (settle error classification)** — introduce error classes so consumers can distinguish retryable from non-retryable. Optionally add a `pendingIntentId` tracker for fire-and-follow semantics.
7. **§C.3 (renewVtxos cooldown on failure)** — move `lastRenewalTimestamp` update to `finally`.
8. **§C.5 (coalesce concurrent syncs)** — small helper to share in-flight sync promises across callers.

### Wave 3

9. §A.3, §A.4, §A.5 — seed in-memory sets from the repo; re-run `reconcilePendingFrontier` on reconnect across all contracts with stored VTXOs.
10. §C.4 (`_txLock` observability) — either expose queue depth or fast-fail with `TX_LOCK_BUSY`.
11. §C.6 — run `finalizePendingTxs` on every app-foreground, not just startup.
12. §E cleanups — surface `deleteIntent` failures; share code between `contractPollProcessor` and `syncContracts`.

---

## Appendix A — Key callsite map

### `extendVirtualCoin` / `extendVtxoFromContract` callsites

| File:line | Uses | Correct? |
|---|---|---|
| `src/wallet/wallet.ts:717` | `extendVirtualCoin(this, vtxo)` | ❌ single-contract |
| `src/wallet/wallet.ts:720` | `extendVirtualCoin(this, vtxo)` | ❌ single-contract |
| `src/wallet/wallet.ts:2507` | `extendVirtualCoin(this, input)` | ❌ single-contract |
| `src/wallet/wallet.ts:2624` | `extendVirtualCoin(this, input)` | ❌ single-contract |
| `src/wallet/serviceWorker/wallet-message-handler.ts:1138` | `extendVirtualCoin(readonlyWallet, vtxo)` | ❌ single-contract |
| `src/wallet/serviceWorker/wallet-message-handler.ts:1144` | `extendVirtualCoin(readonlyWallet, vtxo)` | ❌ single-contract |
| `src/contracts/contractManager.ts:744` | `extendVtxoFromContract(vtxo, contract)` | ✅ contract-aware |
| `src/contracts/contractManager.ts:831` | `extendVtxoFromContract(vtxo, contract)` | ✅ contract-aware |
| `src/worker/expo/taskRunner.ts:144` | `extendVtxoFromContract(vtxo, contract)` | ✅ contract-aware |
| `src/worker/expo/taskRunner.ts:146` | `extendVirtualCoin({offchainTapscript}, vtxo)` | ❌ single-contract fallback |
| `src/wallet/expo/wallet.ts:142` | `extendVtxoFromContract(vtxo, contract)` | ✅ contract-aware |
| `src/wallet/expo/wallet.ts:144` | `extendVirtualCoin(wallet, vtxo)` | ❌ single-contract fallback |

### `saveVtxos` callsites

| File:line | Address arg | Notes |
|---|---|---|
| `src/contracts/contractManager.ts:750` | `addr` (contract.address) | ✅ correct |
| `src/contracts/contractManager.ts:771` | contract address | ✅ correct |
| `src/worker/expo/processors/contractPollProcessor.ts:70` | `contract.address` | ✅ correct but `spendableOnly: true` → §A.2 |
| `src/wallet/wallet.ts:2581` | depends on path | ⚠️ audit required |
| `src/wallet/wallet.ts:2644` | `addr` in `spentVtxos` loop | ⚠️ audit required |
| `src/wallet/serviceWorker/wallet-message-handler.ts:1151` | `address` | ⚠️ audit required |
| `src/repositories/migrations/fromStorageAdapter.ts:81` | `addressData.address` | ✅ migration-only |

### `syncContracts` callers and cursor advancement

| Caller | Passes `contracts`? | Advances cursor? |
|---|---|---|
| `ContractManager.initialize()` | yes | no |
| `ContractManager.getContractsWithVtxos(filter)` | yes | no |
| `ContractManager.handleContractEvent('vtxo_received'&#124;'vtxo_spent')` | yes (`[event.contract]`) | no |
| `ContractManager.refreshVtxos({})` | no | yes |
| `ContractManager.refreshVtxos({scripts})` | yes | no |

---

## Appendix B — Design decisions affirmed during review

1. **Single global sync cursor is intentional.** Bulk polling is the hot path; partial polls don't advance the cursor and rely on `OVERLAP_MS` to cover gaps. Do not propose per-contract cursors.
2. **`contractId` = `Contract.script`.** Already documented as the primary key of the contracts store. VTXO rows should be keyed by script too.
3. **`OVERLAP_MS = 30 minutes` is a symptom, not a feature.** It compensates for §A.1. Once the cursor advances normally, this can drop to ~5 minutes.
