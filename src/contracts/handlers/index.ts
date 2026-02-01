export { contractHandlers } from "./registry";
export { DefaultContractHandler } from "./default";
export type { DefaultContractParams } from "./default";
export { VHTLCContractHandler } from "./vhtlc";
export type { VHTLCContractParams } from "./vhtlc";
export { BoardingContractHandler } from "./boarding";
export type { BoardingContractParams } from "./boarding";

// Register built-in handlers
import { contractHandlers } from "./registry";
import { DefaultContractHandler } from "./default";
import { VHTLCContractHandler } from "./vhtlc";
import { BoardingContractHandler } from "./boarding";

contractHandlers.register(DefaultContractHandler);
contractHandlers.register(VHTLCContractHandler);
contractHandlers.register(BoardingContractHandler);
