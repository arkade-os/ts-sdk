// What NativeExecutor needs from the arkade VM and the template engine, loaded on first use.
export { compile, decode, decodeArtifact, instantiate } from "./template";
export { seal } from "./template/ecies";
export { emulateOffchainTx, ExecutionError } from "./vm";
export { vmExtensionCodec } from "../extension/vmCodec";
