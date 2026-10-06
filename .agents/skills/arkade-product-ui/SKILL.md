---
name: arkade-product-ui
description: >
  Build or polish an Arkade product UI. Use for a desk, vault, swap, quote,
  lock, or settlement screen. Starts from emilkowalski/skills and the
  Impeccable scaffolding, then applies Arkade covenant and regtest constraints.
  Do not use for contract authoring or SDK internals.
---

# Arkade product UI

An Arkade screen is an Operate surface: the user completes a quote, a lock, a settle, or an exit. A marketing page in the same product is Persuade. Pick the mode from the surface.

## Start from the two design sources

1. Impeccable ([pbakaus/impeccable](https://github.com/pbakaus/impeccable), `skill/SKILL.src.md`). If the project has the skill installed, run its context command once, then the playbook for the request (`shape` before a new surface, `craft-floor` immediately before editing). Missing `PRODUCT.md` on a new surface goes through `init`. A narrow fix of an existing screen stays on that screen. Verify in one desktop-and-mobile pass, fix what that pass shows, confirm once, and stop.
2. Emil Kowalski's skills ([emilkowalski/skills](https://github.com/emilkowalski/skills)). Load `emil-design-eng` for polish and motion. Load `prototype` when the screen is still a prototype. Load `animate` only after the decision framework says the motion should exist.

Motion that the user hits on every quote, keystroke, or countdown does not animate. A lock button scales on press (`transform: scale(0.97)`), with `transition` naming `transform` and a custom ease-out (`cubic-bezier(0.23, 1, 0.32, 1)`). Do not use `transition: all` or `ease-in` on a control.

When reviewing UI, use one markdown table with Before, After, and Why columns.

## What the screen is allowed to claim

The footer and the status line name the covenant path that will actually run: the function, the signature count, the deadline. If the prototype does not broadcast, say that. A SHA-256 of the terms is not a witness program and is not a payment.

Constructor values (`kind`, strike, collateral, expiry, side, exit) are chosen before coins lock. The screen collects them once. It does not ask the user to re-confirm them inside a spend, and it does not imply the contract re-checks them.

Show the settlement number from the same integer formula the contract uses. Prices in USD cents, amounts and payoffs in sats, dust at 330 sats folded into the other output. A preview that uses floating point and then displays BTC will disagree with the covenant.

`checkTime` is the emulator clock. `older` starts when the output is mined. Do not draw one timeline for both. Arm the action when `getUtxos()` returns; a loader covers an in-flight exit lookup.

## Quote and lock

One primary action. Validate the amount before setting a quoting flag. Keep the selected strike across a re-render of the strike list. The countdown is the contract `deadline`, not a second constant in the page.

A spot feed fails closed: try the next source, and if both fail, show the failure. Do not invent a price. A median that ignores a single spiked print should say so when the prototype is demonstrating that.

## Verify the screen

Exercise the path a user takes: choose the product, pick a strike, type an amount, receive a premium, lock, and open the settlement preview. Then the edges: empty amount, expired lock, a feed error, dust, and the other product on the same state. Check the pages that share the quote or the locked terms. Desktop and a narrow viewport.

A single screenshot of the resting screen is not that check.
