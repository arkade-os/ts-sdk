/**
 * The v2 client's vocabulary: asset identity, the corridor axis, the closed
 * route union, the amount law, the alias layer and the error taxonomy.
 *
 * Internal to the package for now. M8 is what slims the root export to the v2
 * surface and moves the v1 building blocks to `/protocol`; exporting any of
 * this from `src/index.ts` today would publish a surface the milestones after
 * this one are still deciding.
 */
export * from "./assetId";
export * from "./corridor";
export * from "./errors";
export * from "./primitives";
export * from "./route";
