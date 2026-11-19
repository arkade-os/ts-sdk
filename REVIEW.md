# REVIEW.md

How to review a PR in this repo, for humans and agents. Authors self-review against it before
opening a PR. Invariants live in `AGENTS.md`; check them, don't restate them here.

## Priorities

In this order. Report nothing outside them.

1. **Invariants** from `AGENTS.md`: contracts ownership, key provisioning, `fromPSBT`, `sdk`
   importing a plugin.
2. **Correctness and security.**
3. **Scope**: the description matches the diff, the PR covers one topic, a large PR is split,
   and a change to `packages/**/src` or any `package.json` carries a `CHANGELOG.md` entry
   (`AGENTS.md`, Changelog).
4. **Taste rules** below.

Out of scope: formatting and import order (biome), naming unless misleading, "consider adding a
test" without naming the failure it would catch.

## Severity and cap

- **critical**: funds or keys at risk, or an `AGENTS.md` invariant broken.
- **high**: wrong behavior on a reachable path; an undocumented breaking change.
- **medium**: scope problems; a test gap with a named failure; a taste rule with a concrete cost.
- **low**: any other taste rule.

Report at most 5 findings. Critical and high are always reported, even past the cap; medium,
then low, fill the remaining slots.

## Size

Changed lines = additions + deletions, excluding lockfiles and generated files. Above 440, before
reviewing line by line: judge whether the PR splits along topics, and whether the description
accounts for every change in the diff. A change the description doesn't explain is a finding.

One topic is the bar, not the count alone: a large single-topic PR is still digestible, a large
multi-topic one is not.

## PR description

Explain, don't inventory. Use the sections that apply: what, why (the problem, alternatives
rejected), how tested, not covered / follow-ups, compatibility. Length scales with risk, not
with the file count.

Flag: no description or only a link, no testing information, a file-by-file walkthrough, dense
prose that restates the diff.

## Taste rules

- **Overengineering**: no new abstraction, option or flag without ≥2 callers (or one in the same
  PR). No "future-proofing" parameters.
- **Comments**: why, never what. More than ~3 lines only for an invariant or non-obvious
  constraint. No changelog-in-comments ("previously…", "fixed by…").
- **Tests**: one test per behavior; don't test mocks or types; don't duplicate at unit level what
  an e2e already pins unless it isolates a failure mode.
- **Docs**: TSDoc is the source of truth; README/docs link rather than restate. No new
  `docs/*.md` without a stated reader.

## Calibration

- Good: [#1102](https://github.com/arkade-os/ts-sdk/pull/1102) (131 lines, one fix: problem,
  rejected alternative, test matrix, what's not covered);
  [#1108](https://github.com/arkade-os/ts-sdk/pull/1108) (255 lines: usage snippet, one
  paragraph per commit, compatibility and limits stated).
- Fair: [#1069](https://github.com/arkade-os/ts-sdk/pull/1069) (676 lines, one feature, well
  tested, but the description is a wall of dense bullets).
- Poor but digestible: [#1079](https://github.com/arkade-os/ts-sdk/pull/1079) (2,114 lines,
  one topic, prose too dense to scan).
- Bad: [#972](https://github.com/arkade-os/ts-sdk/pull/972) (2,868 lines across 38 files; the
  description is one line linking elsewhere, with no why and no testing).
