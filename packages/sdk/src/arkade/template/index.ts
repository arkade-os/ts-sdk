import { type Definition, decodeArtifact as parseArtifact } from "./abi";
import { wrap } from "./errors";

export type { Definition } from "./abi";
export { type Artifacts, compileDocument as compile, type Template } from "./compile";
export type { ContractKeys } from "./contract";
export { decodeDocument as decode, type Document } from "./document";
export { type Code, type Stage, TemplateError } from "./errors";
export type { Action, Fee } from "./build/build";
export type { Asset, Source } from "./build/draft";
export {
    type Bindings,
    BoundTemplate,
    type BuildRequest,
    bind,
    build,
    type Context,
    type Decrypt,
    Instance,
    instantiate,
} from "./build/instance";

/** Throws a TemplateError with stage "compile", as Go's CompileDocuments reports a bad artifact. */
export function decodeArtifact(raw: Uint8Array): { id: string; definition: Definition } {
    try {
        return parseArtifact(raw);
    } catch (e) {
        throw wrap("compile", e);
    }
}
