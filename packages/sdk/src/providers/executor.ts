import { hex } from "@scure/base";
import { baseFetch } from "../utils/fetch";
import { rateGate } from "./rateGate";
import type { ExecutorContractKeys } from "../script/executor/executorTemplate";

export type { ExecutorContractKeys };

export interface ExecutorInfo extends ExecutorContractKeys {
    version: string;
    network: string;
    /** Seals template secrets for this Executor; absent when it has no encryption key. */
    encryptionPubkey?: string;
}

export interface ExecutorTemplate {
    id: string;
    status: string;
}

export interface ExecutorTemplateParam {
    name: string;
    type: string;
}

/** A template with its document, as `getTemplate` and `registerTemplate` return it. */
export interface ExecutorTemplateDetails extends ExecutorTemplate {
    document: string;
    artifactIds: string[];
    params: ExecutorTemplateParam[];
    /** proof, virtual or onchain. */
    type: string;
    createdAt?: number;
}

export interface ExecutorArtifact {
    id: string;
    document: string;
    createdAt?: number;
}

export interface ExecutorDelegationInput {
    name: string;
    onchain: boolean;
    script: string;
    address: string;
}

/** An instance of a template. */
export interface ExecutorDelegation {
    id: number;
    inputs: ExecutorDelegationInput[];
    status: "active" | "cancelled" | "expired" | "done";
    templateId: string;
    variables: Record<string, string>;
    /** Unix seconds, as the service's `service.openapi.json` defines it. */
    expiresAt?: number;
}

export interface DelegatedOutput {
    outpoint: string;
    amount: number;
    status: "present" | "spent";
    expiresAt?: number;
    due?: number;
    spentBy?: string;
}

export interface ExecutorDelegationDetails {
    delegation: ExecutorDelegation;
    coins: DelegatedOutput[];
}

/**
 * An executor request that failed. `status` is the HTTP status when the service answered, and
 * undefined when the request never reached it or got an answer that is not the service's. A
 * 404 from `getDelegation` means the service does not know the watch.
 */
export class ExecutorRequestError extends Error {
    constructor(
        message: string,
        readonly status?: number,
    ) {
        super(message);
        this.name = "ExecutorRequestError";
    }
}

export interface ExecutorProvider {
    getInfo(): Promise<ExecutorInfo>;
    listTemplates(): Promise<ExecutorTemplate[]>;
    registerDelegation(
        templateId: string,
        variables: Record<string, string>,
        options?: { expiresAt?: number; signal?: AbortSignal },
    ): Promise<ExecutorDelegation>;
    getDelegation(
        address: string,
        options?: { signal?: AbortSignal },
    ): Promise<ExecutorDelegationDetails>;
    // Optional, so a provider serving delegated boarding alone still conforms.
    /** `document` is the JSON text, or an object to send as its JSON. */
    registerArtifact?(
        document: string | object,
        options?: { signal?: AbortSignal },
    ): Promise<ExecutorArtifact>;
    getArtifact?(id: string, options?: { signal?: AbortSignal }): Promise<ExecutorArtifact>;
    /** Needs the template's artifacts registered first; `document` as in `registerArtifact`. */
    registerTemplate?(
        document: string | object,
        options?: { signal?: AbortSignal },
    ): Promise<ExecutorTemplateDetails>;
    getTemplate?(id: string, options?: { signal?: AbortSignal }): Promise<ExecutorTemplateDetails>;
}

/** REST provider for the Executor, the service that renews and boards a wallet's coins. */
export class RestExecutorProvider implements ExecutorProvider {
    constructor(public url: string) {}

    private endpoint(path: string): string {
        return `${this.url.replace(/\/+$/, "")}${path}`;
    }

    async getInfo(): Promise<ExecutorInfo> {
        const url = this.endpoint("/v1/info");
        const response = await rateGate.runHttp(url, () => baseFetch(url));
        if (!response.ok) {
            throw await failure(response, "get Executor info");
        }

        return parseExecutorInfo(await response.json());
    }

    async listTemplates(): Promise<ExecutorTemplate[]> {
        const url = this.endpoint("/v1/templates");
        const response = await rateGate.runHttp(url, () => baseFetch(url));
        if (!response.ok) {
            throw await failure(response, "list Executor templates");
        }
        const data: unknown = await response.json();
        // The protobuf JSON gateway omits empty repeated fields.
        const templates = isObject(data) ? (data.templates ?? []) : undefined;
        if (!Array.isArray(templates)) {
            throw new Error("Invalid Executor templates response");
        }
        return templates.map(parseTemplate);
    }

    async registerDelegation(
        templateId: string,
        variables: Record<string, string>,
        options: { expiresAt?: number; signal?: AbortSignal } = {},
    ): Promise<ExecutorDelegation> {
        const body: Record<string, unknown> = { templateId, variables };
        if (options.expiresAt !== undefined) {
            body.expiresAt = options.expiresAt;
        }
        const url = this.endpoint("/v1/delegation");
        const response = await baseFetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: options.signal,
        });
        if (response.status === 429) {
            rateGate.reportRateLimited(url, response.headers?.get("retry-after"));
        }
        if (!response.ok) {
            throw await failure(response, "register delegation");
        }
        const data: unknown = await response.json();
        return parseDelegation(isObject(data) ? data.delegation : undefined);
    }

    async getDelegation(
        address: string,
        options: { signal?: AbortSignal } = {},
    ): Promise<ExecutorDelegationDetails> {
        const data = await this.getJson(
            `/v1/delegation?address=${encodeURIComponent(address)}`,
            "get Executor delegation",
            options.signal,
        );
        if (!isObject(data)) {
            throw new Error("Invalid Executor delegation response");
        }
        return {
            delegation: parseDelegation(data.delegation),
            coins: optionalArray(data.coins, "coins").map(parseCoin),
        };
    }

    async registerArtifact(
        document: string | object,
        options: { signal?: AbortSignal } = {},
    ): Promise<ExecutorArtifact> {
        const data = await this.postJson(
            "/v1/artifact",
            { document: documentText(document) },
            "register Executor artifact",
            options.signal,
        );
        return parseArtifact(isObject(data) ? data.artifact : undefined);
    }

    async getArtifact(
        id: string,
        options: { signal?: AbortSignal } = {},
    ): Promise<ExecutorArtifact> {
        const data = await this.getJson(
            `/v1/artifact/${encodeURIComponent(id)}`,
            "get Executor artifact",
            options.signal,
        );
        return parseArtifact(isObject(data) ? data.artifact : undefined);
    }

    async registerTemplate(
        document: string | object,
        options: { signal?: AbortSignal } = {},
    ): Promise<ExecutorTemplateDetails> {
        const data = await this.postJson(
            "/v1/template",
            { document: documentText(document) },
            "register Executor template",
            options.signal,
        );
        return parseTemplateDetails(isObject(data) ? data.template : undefined);
    }

    async getTemplate(
        id: string,
        options: { signal?: AbortSignal } = {},
    ): Promise<ExecutorTemplateDetails> {
        const data = await this.getJson(
            `/v1/template/${encodeURIComponent(id)}`,
            "get Executor template",
            options.signal,
        );
        return parseTemplateDetails(isObject(data) ? data.template : undefined);
    }

    private async postJson(
        path: string,
        body: unknown,
        what: string,
        signal?: AbortSignal,
    ): Promise<unknown> {
        const url = this.endpoint(path);
        const response = await baseFetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal,
        });
        if (response.status === 429) {
            rateGate.reportRateLimited(url, response.headers?.get("retry-after"));
        }
        if (!response.ok) {
            throw await notFoundFailure(response, what);
        }
        return response.json();
    }

    private async getJson(path: string, what: string, signal?: AbortSignal): Promise<unknown> {
        const url = this.endpoint(path);
        const response = await rateGate.runHttp(url, () => baseFetch(url, { signal }));
        if (!response.ok) {
            throw await notFoundFailure(response, what);
        }
        return response.json();
    }
}

/** Only the Executor's own NOT_FOUND says it lacks the record, not a proxy's 404 page. */
async function notFoundFailure(response: Response, what: string): Promise<ExecutorRequestError> {
    const body = await response.text();
    return new ExecutorRequestError(
        `Failed to ${what} (${response.status}): ${body}`,
        response.status === 404 && !isGrpcNotFound(body) ? undefined : response.status,
    );
}

async function failure(response: Response, what: string): Promise<ExecutorRequestError> {
    return new ExecutorRequestError(
        `Failed to ${what} (${response.status}): ${await response.text()}`,
        response.status,
    );
}

function documentText(document: string | object): string {
    return typeof document === "string" ? document : JSON.stringify(document);
}

/** The gateway's gRPC status body for NOT_FOUND, whatever its message. */
function isGrpcNotFound(body: string): boolean {
    try {
        const parsed: unknown = JSON.parse(body);
        return isObject(parsed) && parsed.code === 5;
    } catch {
        return false;
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function requiredString(object: Record<string, unknown>, key: string, what = "info"): string {
    const value = object[key];
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Invalid Executor ${what}: missing ${key}`);
    }
    return value;
}

/**
 * int64 and uint64 fields are strings over the protobuf JSON gateway, and zero values are
 * omitted entirely.
 */
function parseInt64(value: unknown, label: string): number {
    if (typeof value === "number" || (typeof value === "string" && value.length > 0)) {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed)) {
            throw new Error(`Invalid Executor response: ${label} is not an integer`);
        }
        return parsed;
    }
    throw new Error(`Invalid Executor response: missing ${label}`);
}

function parseAmount(value: unknown, label: string): number {
    const amount = parseInt64(value, label);
    if (amount < 0) throw new Error(`Invalid Executor response: ${label} is negative`);
    return amount;
}

function parseVariables(value: unknown): Record<string, string> {
    if (value === undefined) return {};
    if (!isObject(value) || Object.values(value).some((v) => typeof v !== "string")) {
        throw new Error("Invalid Executor delegation: variables are not strings");
    }
    return value as Record<string, string>;
}

function parseOptionalInt64(value: unknown, label: string): number | undefined {
    if (value === undefined) return undefined;
    return parseInt64(value, label);
}

function optionalArray(value: unknown, label: string): unknown[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        throw new Error(`Invalid Executor response: ${label} is not an array`);
    }
    return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
    if (!allowed.includes(value as T)) {
        throw new Error(`Invalid Executor delegation: unknown ${label} ${String(value)}`);
    }
    return value as T;
}

function parseDelegation(value: unknown): ExecutorDelegation {
    if (!isObject(value)) {
        throw new Error("Invalid Executor delegation");
    }
    const templateId = value.templateId;
    if (typeof templateId !== "string" || templateId.length === 0) {
        throw new Error("Invalid Executor delegation: missing templateId");
    }
    return {
        id: parseInt64(value.id, "id"),
        inputs: optionalArray(value.inputs, "inputs").map(parseInput),
        status: oneOf(value.status, ["active", "cancelled", "expired", "done"], "status"),
        templateId,
        variables: parseVariables(value.variables),
        expiresAt: parseOptionalInt64(value.expiresAt, "expiresAt"),
    };
}

function parseInput(value: unknown): ExecutorDelegationInput {
    if (!isObject(value)) {
        throw new Error("Invalid Executor delegation input");
    }
    const field = (key: string): string => {
        const v = value[key];
        if (typeof v !== "string" || v.length === 0) {
            throw new Error(`Invalid Executor delegation input: missing ${key}`);
        }
        return v;
    };
    return {
        name: field("name"),
        // the gateway omits false
        onchain: value.onchain === true,
        script: field("script"),
        address: field("address"),
    };
}

function parseCoin(value: unknown): DelegatedOutput {
    if (!isObject(value) || typeof value.outpoint !== "string") {
        throw new Error("Invalid delegated output");
    }
    return {
        outpoint: value.outpoint,
        amount: parseAmount(value.amount, "amount"),
        status: oneOf(value.status, ["present", "spent"], "coin status"),
        expiresAt: parseOptionalInt64(value.expiresAt, "expiresAt"),
        due: parseOptionalInt64(value.due, "due"),
        spentBy: typeof value.spentBy === "string" && value.spentBy ? value.spentBy : undefined,
    };
}

function parseTemplate(value: unknown): ExecutorTemplate {
    if (!isObject(value) || typeof value.id !== "string" || value.id.length === 0) {
        throw new Error("Invalid Executor template: missing id");
    }
    return { id: value.id, status: typeof value.status === "string" ? value.status : "" };
}

function parseTemplateDetails(value: unknown): ExecutorTemplateDetails {
    if (!isObject(value)) throw new Error("Invalid Executor template");
    const artifactIds = optionalArray(value.artifactIds, "artifactIds");
    if (artifactIds.some((id) => typeof id !== "string" || id.length === 0)) {
        throw new Error("Invalid Executor template: artifactIds are not strings");
    }
    return {
        id: requiredString(value, "id", "template"),
        status: requiredString(value, "status", "template"),
        document: requiredString(value, "document", "template"),
        artifactIds: artifactIds as string[],
        params: optionalArray(value.params, "params").map((param) => {
            if (!isObject(param)) throw new Error("Invalid Executor template param");
            return {
                name: requiredString(param, "name", "template param"),
                type: requiredString(param, "type", "template param"),
            };
        }),
        type: requiredString(value, "type", "template"),
        createdAt: parseOptionalInt64(value.createdAt, "createdAt"),
    };
}

function parseArtifact(value: unknown): ExecutorArtifact {
    if (!isObject(value)) throw new Error("Invalid Executor artifact");
    return {
        id: requiredString(value, "id", "artifact"),
        document: requiredString(value, "document", "artifact"),
        createdAt: parseOptionalInt64(value.createdAt, "createdAt"),
    };
}

function parseExecutorInfo(value: unknown): ExecutorInfo {
    if (!isObject(value)) throw new Error("Invalid Executor info");
    const info: ExecutorInfo = {
        version: requiredString(value, "version"),
        network: requiredString(value, "network"),
        cosignerPubkey: requiredString(value, "cosignerPubkey"),
        serverPubkey: requiredString(value, "serverPubkey"),
        emulatorPubkey: requiredString(value, "emulatorPubkey"),
    };
    decodeCompressed(info.cosignerPubkey, "cosignerPubkey");
    decodeCompressed(info.serverPubkey, "serverPubkey");
    decodeCompressed(info.emulatorPubkey, "emulatorPubkey");
    if (value.encryptionPubkey !== undefined && value.encryptionPubkey !== "") {
        info.encryptionPubkey = requiredString(value, "encryptionPubkey");
        decodeCompressed(info.encryptionPubkey, "encryptionPubkey");
    }
    return info;
}

function decodeCompressed(value: string, label: string): void {
    let bytes: Uint8Array;
    try {
        bytes = hex.decode(value);
    } catch {
        throw new Error(`Invalid Executor info: ${label} is not hex`);
    }
    if (bytes.length !== 33 || (bytes[0] !== 0x02 && bytes[0] !== 0x03)) {
        throw new Error(`Invalid Executor info: ${label} is not compressed`);
    }
}
