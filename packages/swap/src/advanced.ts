/**
 * `@arkade-os/swap/advanced` — the orchestration below the verbs.
 *
 * The package root is the curated v2 surface: the client factory, the three
 * verbs, the route/amount/asset vocabulary, the error taxonomy, the durable
 * record, and storage. Everything the client's own modules define past that —
 * the drive for an app that runs swaps on its own schedule, the corridor
 * modules and the destination-claiming registry, quote preparation and
 * verification, the RFQ wire builders, the market picks, the record
 * projections — is HERE, on one deliberate subpath rather than advertised on
 * the root.
 *
 * Who this is for:
 *
 * - an app that drives swaps manually — `createSwapDrive`, `SwapDrive`,
 *   `readableRecord`, the record store adapters in `driveRecords`;
 * - a destination parser ahead of quoting — `resolveCorridorBase`,
 *   `corridorSet`, `ClaimedDestination` (the source-level API `V2_API.md`
 *   walks through);
 * - a custom quote flow — `acceptQuote`, `QuotePreparation`, `quoteViaRfq`,
 *   the `verify*` checks, `quoteFromFeed`, `eligibleMarkets`;
 * - a record reader — `recordLeg`, `corridorOutcome`, `swapOf`, the prefixes.
 *
 * Two honesty notes. First, this is a superset of the root's vocabulary, not
 * a disjoint layer: the verbs, the route types and the taxonomy are here too,
 * because they are the same declarations, and one import site should not need
 * two specifiers for one flow. Second, "advanced" is not "supported like the
 * root": these names move with the client's internals across minor versions,
 * where the root is the compatibility promise. If what you need is the v1
 * building blocks, that floor is `@arkade-os/swap/protocol`, deprecated but
 * stable — not this subpath.
 */
export * from "./client";
// The cancel plumbing for a manually-driven client: `client.cancel()` wraps
// this, and an app that composed its own drive needs the same act.
export { cancelSwap, type CancelInput, type CancelOutcome } from "./client/cancel";
