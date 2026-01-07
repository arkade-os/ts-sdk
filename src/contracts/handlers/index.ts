export { contractHandlers } from "./registry";
export { DefaultContractHandler } from "./default";
export type { DefaultContractParams } from "./default";
export { VHTLCContractHandler } from "./vhtlc";
export type { VHTLCContractParams } from "./vhtlc";

// Register built-in handlers
import { contractHandlers } from "./registry";
import { DefaultContractHandler } from "./default";
import { VHTLCContractHandler } from "./vhtlc";

contractHandlers.register(DefaultContractHandler);
contractHandlers.register(VHTLCContractHandler);
