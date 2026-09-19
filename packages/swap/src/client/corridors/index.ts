/**
 * The corridor modules: one contract, three implementations, and the registry
 * that turns a destination string into a corridor plus an instrument.
 *
 * Under `client/` rather than beside `rfqCorridor.ts`, because the flat layout
 * is v1's and the v2 layer is deliberately kept off the package's root barrel
 * until the deprecation milestone decides what the published surface is.
 */
export * from "./bolt11";
export * from "./chainSource";
export * from "./contract";
export * from "./deps";
export * from "./registry";
export { arkadeCorridor } from "./arkade";
export {
    lightningCorridor,
    networksOfInvoiceHrp,
    INVOICE_HRPS,
    LIGHTNING_DRIVE,
} from "./lightning";
export { onchainCorridor, ONCHAIN_DRIVE } from "./onchain";
