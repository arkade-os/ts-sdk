/**
 * The v2 client's whole module vocabulary: asset identity, the corridor axis,
 * the closed route union, the amount law, the alias layer, the error taxonomy,
 * the corridor modules, the drive, and the durable record `accept()` writes.
 *
 * This barrel is NOT the package surface. The root (`src/index.ts`) exports a
 * curated subset — the client, the verbs, the route/amount/asset vocabulary,
 * the taxonomy, the durable record — and everything else here reaches
 * consumers through `src/advanced.ts` (`@arkade-os/swap/advanced`), the
 * deliberate deep subpath for manual driving, custom quote flows and record
 * reading. The v1 building blocks are on neither: `/protocol` is their floor.
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
export * from "./drive";
export * from "./driveRecords";
export * from "./errors";
export * from "./market";
export * from "./outcome";
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
export * from "./sats";
export * from "./transport";
export * from "./verbs";
export * from "./verify";
