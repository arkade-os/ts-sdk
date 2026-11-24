import { hex } from "@scure/base";
import { sha256 } from "@scure/btc-signer/utils.js";

import { fail, wrap } from "./errors";
import { canonical, decode, JcsError, type JsonValue } from "./jcs";
import { decodeValue, FORMAT, marshal, normalize, type Template } from "./schema";

const MAX_DOCUMENT_BYTES = 1 << 20;

/** Decoded but not yet checked against its artifacts. */
export interface Document {
    readonly id: string;
    /** The id with `delegation` removed: one spend however it is delegated. */
    readonly spendId: string;
    readonly canonical: Uint8Array;
    /** Referenced artifact ids, inputs first, in order of first use. */
    readonly artifactIds: readonly string[];
    /** The normalized syntax compile reads. */
    readonly template: Template;
}

/** Throws a TemplateError with stage "decode". The format is read before any v1 rule. */
export function decodeDocument(raw: Uint8Array): Document {
    try {
        return documentOf(raw);
    } catch (e) {
        throw wrap("decode", e);
    }
}

function documentOf(raw: Uint8Array): Document {
    if (raw.length > MAX_DOCUMENT_BYTES) throw fail("invalid_template", "document exceeds 1 MiB");
    let value: JsonValue;
    try {
        value = decode(raw);
    } catch (e) {
        if (e instanceof JcsError) throw fail("invalid_template", e.message);
        throw e;
    }
    if (!(value instanceof Map)) throw fail("invalid_template", "document must be an object");
    const format = value.get("format");
    if (typeof format !== "string" || format === "") {
        throw fail("invalid_template", "format must be a non-empty string");
    }
    if (format !== FORMAT) {
        throw fail("unsupported_version", `unsupported template version ${JSON.stringify(format)}`);
    }
    const t = decodeValue(value);
    normalize(t);
    const artifactIds: string[] = [];
    const contracts = [
        ...t.inputs.map((i) => i.contract),
        ...t.outputs.flatMap((o) => ("contract" in o.locking ? [o.locking.contract] : [])),
    ];
    for (const { definition: d } of contracts) {
        if ("artifact" in d && !artifactIds.includes(d.artifact)) artifactIds.push(d.artifact);
    }
    const bytes = canonical(marshal(t));
    return {
        id: hex.encode(sha256(bytes)),
        spendId: hex.encode(sha256(canonical(marshal({ ...t, delegation: undefined })))),
        canonical: bytes,
        artifactIds,
        template: t,
    };
}
