export { contractHandlers } from "./registry";
export { DefaultContractHandler } from "./default";
export type { DefaultContractParams } from "./default";
export { DelegateContractHandler } from "./delegate";
export type { DelegateContractParams } from "./delegate";
export { VHTLCContractHandler } from "./vhtlc";
export type { VHTLCContractParams } from "./vhtlc";

// Register built-in handlers
import { contractHandlers } from "./registry";
import { DefaultContractHandler } from "./default";
import { DelegateContractHandler } from "./delegate";
import { VHTLCContractHandler } from "./vhtlc";

contractHandlers.register(DefaultContractHandler);
contractHandlers.register(DelegateContractHandler);
contractHandlers.register(VHTLCContractHandler);
