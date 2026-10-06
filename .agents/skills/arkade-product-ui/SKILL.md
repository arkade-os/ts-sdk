---
name: arkade-product-ui
description: >
  Build or polish a UI for any Arkade contract. Use for funding, spending a
  named function, watching coins, or an exit. Starts from emilkowalski/skills
  and the Impeccable scaffolding. Do not use for contract authoring or SDK internals.
---

# Arkade contract UI

The screen is a client of one or more artifacts. It offers the constructor, the funding step, and the spend functions the artifact actually has. It does not invent a second product model beside the contract.

A contract surface is Operate in [Impeccable](https://github.com/pbakaus/impeccable) (`skill/SKILL.src.md`): the user completes a task. A landing page on the same product is Persuade. If the skill is installed, run its context command once, use `shape` before a new surface, and read the craft floor immediately before editing. A narrow fix stays on the existing screen. Verify once at desktop and mobile, fix what that pass shows, confirm once, and stop.

Polish and motion come from [emilkowalski/skills](https://github.com/emilkowalski/skills), `emil-design-eng`. Load `prototype` while the flow is still fake, and `animate` only after that skill's decision framework says the motion should exist. An action the user repeats does not animate. A press uses `transform` only, ease-out, and `scale(0.97)` on `:active`. Review notes go in one table with Before, After, and Why.

## Match the artifact

Each primary action is one function on `contract.functions`, named as in the `.ark` file. Constructor fields are collected before coins lock. The spend screen sends the witnesses and outputs that function checks, and nothing else.

Numbers the user sees are the integers the covenant computes, in the units the contract uses. A display format is applied after that result. A preview that rounds in floating point and then spends the rounded value will disagree with the script.

Say when the page does not broadcast. A hash of the form fields is not a script, an address, or a payment.

Keep the clocks apart. `checkTime` is the emulator clock. `tx.time` is nLockTime. `older` starts when the output is mined, which is after unroll. One control does not represent both. Enable a spend when `getUtxos()` has a coin for it. A lookup still in flight is a loader on that control.

External data fails closed. Show the failure. Do not substitute a price, a balance, or a confirmation the feed did not return.

## Verify

Walk the contract's own path: construct, fund, spend each function the user can reach, and the exit. Then the edges that function defines: missing inputs, a rejected `require`, an empty wallet, and a second page that reads the same contract row. Desktop and a narrow viewport.

A screenshot of the resting screen is not that check.
