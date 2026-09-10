# Wallet Restore Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make explicit SDK wallet restoration run registered plugin recovery, provide asset-swap recovery as a reusable SDK integration, and have the reference wallet use it during imported-wallet restoration.

**Architecture:** The core SDK owns a wallet-scoped, plugin-agnostic restore-hook registry backed by a `WeakMap`. `Wallet` and `ServiceWorkerWallet` run a stable snapshot of those hooks only after their core restore succeeds, with the existing or new in-flight promise covering both phases. The swap package registers its repository restorer through that generic API; the reference wallet registers the swap hook before calling `restore()` and continues using its existing incremental reconciliation during ordinary startup.

**Tech Stack:** TypeScript, Vitest, pnpm, tsup, React, Service Workers, Biome, ESLint.

**Spec:** `docs/superpowers/specs/2026-09-10-wallet-restore-hooks-design.md`

## Global Constraints

- Core may expose generic lifecycle hooks but must never import or special-case `@arkade-os/swap`.
- Hooks run only for explicit `wallet.restore()` calls; `Wallet.create()` and normal reference-wallet startup remain unchanged.
- Preserve structural compatibility of `IWallet`; do not add a required member to it.
- Use strict test-first development: observe each targeted test fail for the intended missing behavior before implementing it.
- Preserve the wallet's existing `AssetSwapsProvider` reconciliation because it handles normal boot, late history, and watcher coverage.
- Package the final swap build as a tarball for the reference wallet and update both the dependency and lockfile atomically.

---

## Task 1: Add the generic core restore-hook registry

**Files:**

- Create: `packages/ts-sdk/src/wallet/restoreHooks.ts`
- Create: `packages/ts-sdk/test/walletRestoreHooks.test.ts`
- Modify: `packages/ts-sdk/src/wallet/index.ts`
- Modify: `packages/ts-sdk/src/index.ts` only if the wallet barrel is not already re-exported

- [ ] Write registry contract tests first.

  Cover registration order, replacement by duplicate ID without changing order, exact/idempotent unregister, an old unregister not removing a replacement, snapshot behavior for registrations/removals during a run, and aggregation after every hook has been attempted.

  ```ts
  import {
    registerWalletRestoreHook,
    runWalletRestoreHooks,
  } from "../src/wallet/restoreHooks";

  it("runs a stable snapshot in registration order and aggregates failures", async () => {
    const wallet = {} as IWallet;
    const calls: string[] = [];
    registerWalletRestoreHook(wallet, {
      id: "first",
      restore: async () => {
        calls.push("first");
        throw new Error("first failed");
      },
    });
    registerWalletRestoreHook(wallet, {
      id: "second",
      restore: async () => void calls.push("second"),
    });

    await expect(runWalletRestoreHooks(wallet)).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: "first failed" })],
    });
    expect(calls).toEqual(["first", "second"]);
  });
  ```

- [ ] Run the focused test and confirm RED because the module/API does not exist.

  Run: `pnpm --filter @arkade-os/sdk exec vitest run test/walletRestoreHooks.test.ts`

- [ ] Implement the registry with an identity-safe unregister closure.

  ```ts
  import type { IWallet } from "./index";

  export interface WalletRestoreHook {
    id: string;
    restore(wallet: IWallet): Promise<void>;
  }

  interface RegisteredHook extends WalletRestoreHook {}

  const restoreHooks = new WeakMap<IWallet, RegisteredHook[]>();

  export function registerWalletRestoreHook(
    wallet: IWallet,
    hook: WalletRestoreHook,
  ): () => void {
    const hooks = restoreHooks.get(wallet) ?? [];
    const entry = { ...hook };
    const existing = hooks.findIndex(({ id }) => id === hook.id);
    if (existing === -1) hooks.push(entry);
    else hooks[existing] = entry;
    restoreHooks.set(wallet, hooks);

    return () => {
      const current = restoreHooks.get(wallet);
      if (!current) return;
      const index = current.indexOf(entry);
      if (index === -1) return;
      current.splice(index, 1);
      if (current.length === 0) restoreHooks.delete(wallet);
    };
  }

  export async function runWalletRestoreHooks(wallet: IWallet): Promise<void> {
    const snapshot = [...(restoreHooks.get(wallet) ?? [])];
    const errors: unknown[] = [];
    for (const hook of snapshot) {
      try {
        await hook.restore(wallet);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Wallet restore hooks failed");
  }
  ```

  Export `WalletRestoreHook` and `registerWalletRestoreHook` from the public barrel. Keep `runWalletRestoreHooks` importable by core wallet implementations; annotate it `@internal` and do not include it in the root public barrel if a direct internal import suffices.

- [ ] Run the focused test and confirm GREEN.

  Run: `pnpm --filter @arkade-os/sdk exec vitest run test/walletRestoreHooks.test.ts`

- [ ] Format and commit the registry.

  Run: `pnpm --filter @arkade-os/sdk format`

  Commit: `feat(sdk): add wallet restore hook registry`

---

## Task 2: Run hooks from direct `Wallet.restore()`

**Files:**

- Modify: `packages/ts-sdk/src/wallet/wallet.ts`
- Modify: `packages/ts-sdk/test/restore.test.ts`

- [ ] Add direct-wallet integration tests before implementation.

  Add cases to the existing `Wallet.restore` suite proving:

  - core address scan/refill completes before a hook starts;
  - a core restore failure skips every hook;
  - two concurrent calls return the same work and invoke a delayed hook once;
  - a hook registered during the current run waits until the next explicit restore;
  - multiple hook failures surface as one `AggregateError` after all hooks run.

  Register hooks against the harness wallet and call every returned unregister in test cleanup.

- [ ] Run the focused restore suite and confirm RED because hooks are not invoked.

  Run: `pnpm --filter @arkade-os/sdk exec vitest run test/restore.test.ts`

- [ ] Compose core recovery and hooks inside the existing `_restoreInFlight` promise.

  ```ts
  this._restoreInFlight = (async () => {
    await this._runRestore(gapLimit);
    await runWalletRestoreHooks(this);
  })().finally(() => {
    this._restoreInFlight = undefined;
  });
  ```

  Keep gap-limit validation before setting the promise. Do not alter `Wallet.create()`.

- [ ] Re-run the focused restore and registry suites and confirm GREEN.

  Run: `pnpm --filter @arkade-os/sdk exec vitest run test/restore.test.ts test/walletRestoreHooks.test.ts`

- [ ] Commit direct wallet integration.

  Commit: `feat(sdk): run hooks after wallet restore`

---

## Task 3: Run hooks from `ServiceWorkerWallet.restore()`

**Files:**

- Modify: `packages/ts-sdk/src/wallet/serviceWorker/wallet.ts`
- Modify: `packages/ts-sdk/test/serviceWorker/wallet.test.ts`

- [ ] Add proxy integration tests before implementation.

  Prove worker restore completes before local hooks start, concurrent proxy restores coalesce through local hook completion, worker failure skips hooks, and a local hook failure is surfaced after worker success. The hook must receive the `ServiceWorkerWallet` proxy instance.

- [ ] Run the focused test and confirm RED because proxy restore currently ends after the worker response.

  Run: `pnpm --filter @arkade-os/sdk exec vitest run test/serviceWorker/wallet.test.ts`

- [ ] Add a local in-flight guard covering both phases.

  ```ts
  private _restoreInFlight?: Promise<void>;

  async restore(opts?: { gapLimit?: number }): Promise<void> {
    if (this._restoreInFlight) return this._restoreInFlight;
    this._restoreInFlight = (async () => {
      await this._restoreWorkerWallet(opts);
      await runWalletRestoreHooks(this);
    })().finally(() => {
      this._restoreInFlight = undefined;
    });
    return this._restoreInFlight;
  }
  ```

  Extract the current request/response and worker `AggregateError` reconstruction into `_restoreWorkerWallet`; do not attempt to serialize callbacks through `postMessage`.

- [ ] Re-run the focused proxy and registry suites and confirm GREEN.

  Run: `pnpm --filter @arkade-os/sdk exec vitest run test/serviceWorker/wallet.test.ts test/walletRestoreHooks.test.ts`

- [ ] Commit proxy integration.

  Commit: `feat(sdk): run restore hooks for worker wallets`

---

## Task 4: Add the asset-swap restore registration helper

**Files:**

- Create: `packages/swap/src/registerRestore.ts`
- Create: `packages/swap/test/registerRestore.test.ts`
- Modify: `packages/swap/src/index.ts`

- [ ] Write orchestration tests before implementation.

  Cover default derivation of the wallet indexer and Ark server public key, explicit indexer override, forwarding `arkServerUrl`, repository, transactions, and `prepareNew`, delivery of the complete result to async `onResult`, stable-ID replacement on repeated registration, callback rejection propagation, and non-throwing `coverageError` delivery through the result.

  Use a real in-memory repository where practical; mock `restoreAssetSwapRepository` only at the helper boundary to verify argument wiring without repeating its existing behavioral suite.

- [ ] Run the focused test and confirm RED because `registerAssetSwapRestore` is absent.

  Run: `pnpm --filter @arkade-os/swap exec vitest run test/registerRestore.test.ts`

- [ ] Implement and export the helper.

  ```ts
  export interface RegisterAssetSwapRestoreOptions {
    arkServerUrl: string;
    repository: AssetSwapRepository;
    indexer?: RestoreIndexer;
    serverPubkey?: Uint8Array;
    prepareNew?: RestoreAssetSwapRepositoryOptions["prepareNew"];
    onResult?: (
      result: RestoreAssetSwapRepositoryResult,
    ) => void | Promise<void>;
  }

  export function registerAssetSwapRestore(
    wallet: IWallet,
    options: RegisterAssetSwapRestoreOptions,
  ): () => void {
    return registerWalletRestoreHook(wallet, {
      id: "arkade-os:asset-swap",
      restore: async (restoredWallet) => {
        const txs = await restoredWallet.getTransactionHistory();
        const result = await restoreAssetSwapRepository({
          wallet: restoredWallet,
          arkServerUrl: options.arkServerUrl,
          indexer: options.indexer ?? restoredWallet.indexerProvider,
          repository: options.repository,
          txs,
          serverPubkey: options.serverPubkey ?? restoredWallet.arkServerPublicKey,
          prepareNew: options.prepareNew,
        });
        await options.onResult?.(result);
      },
    });
  }
  ```

  Adjust exact imported type names to the existing `restoreRepository.ts` declarations. Keep `restoreAssetSwapRepository` exported for manual and incremental reconciliation.

- [ ] Run swap helper and existing repository suites and confirm GREEN.

  Run: `pnpm --filter @arkade-os/swap exec vitest run test/registerRestore.test.ts test/restoreRepository.test.ts`

- [ ] Run type checking and commit.

  Run: `pnpm --filter @arkade-os/swap typecheck`

  Commit: `feat(swap): register repository restore with wallet`

---

## Task 5: Document core and swap restoration

**Files:**

- Modify: `packages/ts-sdk/README.md`
- Modify: `packages/swap/README.md`

- [ ] Add a concise core SDK section explaining that `wallet.restore()` performs core recovery and then registered hooks, that registration is wallet-instance scoped, and that ordinary creation/startup does not run hooks.

- [ ] Add a complete swap README section titled `Restore an imported wallet` next to storage/restore documentation.

  Include this lifecycle:

  ```ts
  const unregisterSwapRestore = registerAssetSwapRestore(wallet, {
    arkServerUrl,
    repository,
    onResult: ({ restored, updated, coverageError }) => {
      if (coverageError) console.warn("Swap coverage was incomplete", coverageError);
      console.info(`Restored ${restored.length}, updated ${updated.length}`);
    },
  });

  await wallet.restore();
  ```

  Explain that the hook runs after core history recovery; registration is idempotent by stable hook ID; `coverageError` is result-level and still reaches `onResult`; callback failures reject `restore()`; custom/proxy wallets can provide `indexer` and `serverPubkey`; manual `restoreAssetSwapRepository` remains appropriate for normal startup and later incremental reconciliation.

- [ ] Update the swap recovery-layer description so explicit wallet restore is the orchestrated layer while ordinary incremental scans remain documented.

- [ ] Format/check affected packages and commit documentation.

  Run: `pnpm --filter @arkade-os/sdk lint`

  Run: `pnpm --filter @arkade-os/swap lint`

  Commit: `docs: explain plugin recovery during wallet restore`

---

## Task 6: Integrate the helper into the reference wallet import path

**Files:**

- Create: `work/wallet/src/test/providers/wallet.test.tsx`
- Modify: `work/wallet/src/providers/wallet.tsx`
- Modify: `work/wallet/package.json`
- Modify: `work/wallet/pnpm-lock.yaml`
- Modify: `work/wallet/vendor/README.md`
- Replace: `work/wallet/vendor/arkade-os-swap-0.0.14-pr901-0999579.tgz`

- [ ] Add a focused `WalletProvider` import/restore test before changing the provider.

  Mock `ServiceWorkerWallet.setup`, `registerAssetSwapRestore`, and unrelated persistence/network boundaries. Record ordered events and prove `registerAssetSwapRestore` is called with the created proxy, Ark server URL, configured indexer, and `assetSwapRepository` before `svcWallet.restore()`. Add a non-restoring case proving the hook may be registered but is not invoked because `restore()` is not called.

- [ ] Run the focused wallet test and confirm RED because no swap hook is registered.

  Run from `work/wallet`: `pnpm exec vitest run src/test/providers/wallet.test.tsx`

- [ ] Register swap recovery immediately after `ServiceWorkerWallet.setup` and before the existing `if (restoring) await svcWallet.restore()` block.

  ```ts
  registerAssetSwapRestore(svcWallet, {
    arkServerUrl,
    repository: assetSwapRepository,
    indexer,
  });
  ```

  Reuse the same configured indexer already constructed for the wallet. No presentation callback is required during import: `AssetSwapsProvider` mounts afterward and reads the rebuilt repository. Keep its existing incremental `restoreAssetSwapRepository` effect unchanged.

- [ ] Re-run the focused provider and asset-swaps suites and confirm GREEN.

  Run: `pnpm exec vitest run src/test/providers/wallet.test.tsx src/test/providers/assetSwaps.test.tsx`

- [ ] Build and pack the final swap package from the ts-sdk commit that includes Tasks 1–5.

  Run from `work/ts-sdk`: `pnpm --filter @arkade-os/swap build`

  Run from `work/ts-sdk/packages/swap`: `pnpm pack --pack-destination ../../../wallet/vendor`

  Rename the tarball to `arkade-os-swap-0.0.14-pr901-<ts-sdk-short-sha>.tgz`. Update `package.json`, `pnpm-lock.yaml`, and `vendor/README.md`; remove only the superseded `arkade-os-swap-0.0.14-pr901-0999579.tgz` after verifying the new absolute target lies under `work/wallet/vendor`.

- [ ] Install against the new tarball without broad dependency upgrades and re-run focused tests.

  Run from `work/wallet`: `pnpm install --lockfile-only`

  Run: `pnpm exec vitest run src/test/providers/wallet.test.tsx src/test/providers/assetSwaps.test.tsx`

- [ ] Commit reference-wallet integration.

  Commit: `feat: restore asset swaps with imported wallets`

---

## Task 7: Verify, publish branches, and update PRs

**Files:**

- Verify all files changed above
- Update PR descriptions for ts-sdk #901 and wallet #976

- [ ] Run full ts-sdk verification and record exact results.

  Run from `work/ts-sdk`:

  ```text
  pnpm --filter @arkade-os/sdk test:unit
  pnpm --filter @arkade-os/swap test:unit
  pnpm --filter @arkade-os/sdk typecheck
  pnpm --filter @arkade-os/swap typecheck
  pnpm --filter @arkade-os/sdk build
  pnpm --filter @arkade-os/swap build
  pnpm --filter @arkade-os/sdk smoke:dist
  pnpm --filter @arkade-os/swap smoke:dist
  pnpm --filter @arkade-os/sdk lint
  pnpm --filter @arkade-os/swap lint
  ```

- [ ] Run full reference-wallet verification and record exact results.

  Run from `work/wallet`:

  ```text
  pnpm test:unit
  pnpm exec tsc --noEmit
  pnpm lint
  pnpm build
  ```

- [ ] Inspect both working trees and diffs, ensuring no unrelated user changes or generated artifacts are included.

  Run: `git status --short` and `git diff --check` in each repository.

- [ ] Force-add the ignored design and plan files, commit any final formatting-only changes, and push `feat/swap-restore-orchestration` to ts-sdk #901.

- [ ] Confirm the tarball filename in wallet #976 points at the pushed ts-sdk commit, rebuild/repack once if the source commit changed, then push `fix/caip19-registry-cards`.

- [ ] Update ts-sdk #901 to describe the generic restore hook, swap registration helper, explicit-restore semantics, service-worker behavior, and tests. Update wallet #976 to describe import-time registration, the vendored tarball SHA, and why incremental reconciliation remains.

- [ ] Wait for all required CI checks on both PR heads. If a check fails, inspect the first actionable failure, reproduce locally where possible, fix test-first, and repeat verification before pushing.

- [ ] Report final PR URLs, head SHAs, verification commands, and CI/merge status. Do not merge either PR unless that is still part of the user's standing instruction and branch protection/checks permit it.
