# Native executor funded proof

For reviewers of the opt-in `NativeExecutor`, this runs real funding and spends against a fresh, isolated Bitcoin regtest using the images pinned by the `regtest` submodule. It exercises the existing wallet, ContractManager and SQLite repositories. It does not use the execution journal.

From the repository root, with Node **24.22.1**, pnpm **10.25.0**, Docker Engine and Compose:

```sh
git submodule update --init regtest
pnpm install --frozen-lockfile
pnpm --filter @arkade-os/sdk build
node packages/sdk/test/proof/native-executor/prove.mjs
```

The separate `Native executor funded proof` workflow runs this command on affected pull requests, including drafts. The existing SDK integration workflow and regtest defaults are unchanged.

The proof boards 200,000 fresh regtest sats, funds a 50,000-sat position and an equal-value decoy, and registers a distinct delegated position before funding it. A rejected callback dispatches nothing. A queued native spend must use the original source and payout despite caller mutation, return its accepted transaction ID despite a forced refresh error, and leave the decoy untouched. An ordinary wallet payment also demonstrates that locked positions stay out of selection.

Delegatee is paused before its position receives funds. The parent waits for every wallet actor's process-close event and checks those PIDs are gone before resuming that one labeled delegatee container. It observes the full 50,000-sat payout before reopening the same SQLite wallet. Recovery is forbidden from submitting transactions. A separate keyless audit process decodes the indexed creating transaction, checkpoint and payout, checks script/value lineage, exact recorded native proposal bytes, process ordering, service identities and source/build hashes.

`timed-savings.json` is the checked-in arkadec 0.1.0 optimized artifact; its embedded source must match `timed-savings.ark`. It includes a renewal branch, but this proof exercises only the matured offchain release branch. `stack.mjs` pins the `regtest` submodule commit and takes every image from that commit's `.env.defaults`, so a submodule bump only needs the pin updated. The actual running binary and all service image identities are recorded. No prior financial receipt is reused.

Each run prints its UUID directory under `.tmp/native-executor/`. `public/audit.json` is produced only after all assertions and owned-container cleanup pass; `public/manifest.json` hashes the explicit evidence set. `private/` contains local-only fixture keys, SQLite and logs. CI uploads only public JSON and explicitly excludes keys, databases, WALs, generated Compose/environment files and logs. Never publish `private/` or Docker inspect output containing environment secrets.

The runner stops only containers bearing its unique run label, including on failure. It leaves its containers and volumes for inspection and never deletes persistent volumes or touches another Docker project. A failed run has `public/failure.json` plus local details in `private/failure.txt` and actor logs. Existing chains and wallets cannot be supplied to this command.

This is evidence for native offchain execution and offline delegated payout. Renewal, scheduler ownership transfer, response-loss journal recovery, default-wallet migration and production deployment remain separate gates.
