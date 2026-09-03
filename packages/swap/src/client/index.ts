/**
 * The v2 client's vocabulary: asset identity, the corridor axis, the closed
 * route union, the amount law, the alias layer, the error taxonomy, the
 * corridor modules, and the durable record `accept()` writes.
 *
 * Internal to the package for now. M8 is what slims the root export to the v2
 * surface and moves the v1 building blocks to `/protocol`; exporting any of
 * this from `src/index.ts` today would publish a surface the milestones after
 * this one are still deciding.
 */
export * from "./accept";
export * from "./aliases";
export * from "./aliasTable";
export * from "./amount";
export * from "./assetId";
export * from "./client";
export * from "./corridor";
export * from "./corridors";
export * from "./discovery";
export * from "./errors";
export * from "./market";
export * from "./policy";
export * from "./primitives";
export * from "./quote";
export * from "./quoteOffer";
export * from "./quoteRfq";
export * from "./record";
export * from "./resolve";
export * from "./rfqAmount";
export * from "./rfqWire";
export * from "./route";
export * from "./transport";
export * from "./verify";
