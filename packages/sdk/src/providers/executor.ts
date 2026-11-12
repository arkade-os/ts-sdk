import { hex } from "@scure/base";
import { baseFetch } from "../utils/fetch";
import { rateGate } from "./rateGate";

export interface ExecutorInfo {
    version: string;
    network: string;
    cosignerPubkey: string;
    serverPubkey: string;
    emulatorPubkey: string;
}

/** The Executor's keys a wallet's delegated contracts are derived from. */
export type ExecutorContractKeys = Pick<
    ExecutorInfo,
    "cosignerPubkey" | "serverPubkey" | "emulatorPubkey"
>;

export interface ExecutorTemplate {
    id: string;
    status: string;
}

/** An instance of a template. */
export interface ExecutorDelegation {
    id: number;
    /** Slot 0's address for a watch, empty otherwise. */
    address: string;
    status: "active" | "cancelled" | "expired" | "done";
    templateId: string;
    variables: Record<string, string>;
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

export interface ExecutorProvider {
    getInfo(): Promise<ExecutorInfo>;
    listTemplates(): Promise<ExecutorTemplate[]>;
    registerDelegation(
        templateId: string,
        variables: Record<string, string>,
        options?: { expiresAt?: number },
    ): Promise<ExecutorDelegation>;
    getDelegation(address: string): Promise<ExecutorDelegationDetails>;
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
        options: { expiresAt?: number } = {},
    ): Promise<ExecutorDelegation> {
        const body: Record<string, unknown> = { templateId, variables };
        if (options.expiresAt !== undefined) {
            body.expiresAt = options.expiresAt;
        }
        const response = await baseFetch(this.endpoint("/v1/delegation"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            throw await failure(response, "register delegation");
        }
        const data: unknown = await response.json();
        return parseDelegation(isObject(data) ? data.delegation : undefined);
    }

    async getDelegation(address: string): Promise<ExecutorDelegationDetails> {
        const url = this.endpoint(`/v1/delegation?address=${encodeURIComponent(address)}`);
        const response = await rateGate.runHttp(url, () => baseFetch(url));
        if (!response.ok) {
            throw await failure(response, "get delegation");
        }
        const data: unknown = await response.json();
        if (!isObject(data)) {
            throw new Error("Invalid Executor delegation response");
        }
        return {
            delegation: parseDelegation(data.delegation),
            coins: optionalArray(data.coins, "coins").map(parseCoin),
        };
    }
}

async function failure(response: Response, what: string): Promise<Error> {
    return new Error(`Failed to ${what}: ${await response.text()}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function requiredString(object: Record<string, unknown>, key: string): string {
    const value = object[key];
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Invalid Executor info: missing ${key}`);
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
        address: typeof value.address === "string" ? value.address : "",
        status: oneOf(value.status, ["active", "cancelled", "expired", "done"], "status"),
        templateId,
        variables: parseVariables(value.variables),
        expiresAt: parseOptionalInt64(value.expiresAt, "expiresAt"),
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
