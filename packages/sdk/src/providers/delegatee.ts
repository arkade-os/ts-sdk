import { hex } from "@scure/base";
import { baseFetch } from "../utils/fetch";
import { rateGate } from "./rateGate";

export interface DelegateeInfo {
    version: string;
    network: string;
    delegatePubkey: string;
    serverPubkey: string;
    emulatorPubkey: string;
}

export interface DelegateeTemplate {
    id: string;
    status: string;
}

/** One template input of a delegation. */
export interface DelegateeSlot {
    name: string;
    onchain: boolean;
    tapscripts: string[];
    /** "txid:vout" once bound, absent for a watch. */
    outpoint?: string;
}

/** An instance of a template. */
export interface DelegateeDelegation {
    id: number;
    /** Slot 0's address for a watch, empty otherwise. */
    address: string;
    status: "active" | "cancelled" | "expired" | "done";
    templateId: string;
    variables: Record<string, string>;
    /** The delegation whose settled transaction advertised this one, absent for a watch. */
    parentId?: number;
    expiresAt?: number;
    slots: DelegateeSlot[];
    createdAt?: number;
    updatedAt?: number;
}

export interface DelegateeVtxo {
    outpoint: string;
    amount: number;
    expiresAt?: number;
    preconfirmed: boolean;
    assets: { assetId: string; amount: bigint }[];
    createdAt?: number;
    renewableAt?: number;
    onchain: boolean;
}

export interface DelegateeRenewal {
    outpoints: string[];
    commitmentTxid?: string;
    success: boolean;
    error?: string;
    attemptedAt?: number;
}

export interface DelegateeDelegationDetails {
    delegation: DelegateeDelegation;
    vtxos: DelegateeVtxo[];
    renewals: DelegateeRenewal[];
}

export interface DelegateeProvider {
    getInfo(): Promise<DelegateeInfo>;
    listTemplates(): Promise<DelegateeTemplate[]>;
    registerDelegation(
        templateId: string,
        variables: Record<string, string>,
        options?: { expiresAt?: number },
    ): Promise<DelegateeDelegation>;
    getDelegation(address: string): Promise<DelegateeDelegationDetails>;
}

/** A delegation address has not been registered with this delegatee. */
export class DelegateeNotFoundError extends Error {
    constructor(readonly address: string) {
        super(`Delegatee delegation not found: ${address}`);
        this.name = "DelegateeNotFoundError";
    }
}

/** REST provider for delegatee's registration/renewal service. */
export class RestDelegateeProvider implements DelegateeProvider {
    constructor(public url: string) {}

    private endpoint(path: string): string {
        return `${this.url.replace(/\/+$/, "")}${path}`;
    }

    async getInfo(): Promise<DelegateeInfo> {
        const url = this.endpoint("/v1/info");
        const response = await rateGate.runHttp(url, () => baseFetch(url));
        if (!response.ok) {
            throw await failure(response, "get delegatee info");
        }

        return parseDelegateeInfo(await response.json());
    }

    async listTemplates(): Promise<DelegateeTemplate[]> {
        const url = this.endpoint("/v1/template");
        const response = await rateGate.runHttp(url, () => baseFetch(url));
        if (!response.ok) {
            throw await failure(response, "list delegatee templates");
        }
        const data: unknown = await response.json();
        // The protobuf JSON gateway omits empty repeated fields.
        const templates = isObject(data) ? (data.templates ?? []) : undefined;
        if (!Array.isArray(templates)) {
            throw new Error("Invalid delegatee templates response");
        }
        return templates.map(parseTemplate);
    }

    async registerDelegation(
        templateId: string,
        variables: Record<string, string>,
        options: { expiresAt?: number } = {},
    ): Promise<DelegateeDelegation> {
        const body: Record<string, unknown> = { templateId, variables };
        if (options.expiresAt !== undefined) {
            body.expiresAt = options.expiresAt;
        }
        const response = await baseFetch(this.endpoint("/v1/delegate"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            throw await failure(response, "register delegatee");
        }
        const data: unknown = await response.json();
        return parseDelegation(isObject(data) ? data.delegation : undefined);
    }

    async getDelegation(address: string): Promise<DelegateeDelegationDetails> {
        const url = this.endpoint(`/v1/delegate/${encodeURIComponent(address)}`);
        const response = await rateGate.runHttp(url, () => baseFetch(url));
        if (response.status === 404) {
            throw new DelegateeNotFoundError(address);
        }
        if (!response.ok) {
            throw await failure(response, "get delegatee delegation");
        }
        const data: unknown = await response.json();
        if (!isObject(data)) {
            throw new Error("Invalid delegatee delegation response");
        }
        return {
            delegation: parseDelegation(data.delegation),
            vtxos: optionalArray(data.vtxos, "vtxos").map(parseVtxo),
            renewals: optionalArray(data.renewals, "renewals").map(parseRenewal),
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
        throw new Error(`Invalid delegatee info: missing ${key}`);
    }
    return value;
}

/**
 * int64 and uint64 fields are strings over the protobuf JSON gateway, and zero values are
 * omitted entirely.
 */
function parseInt64(value: unknown, label: string): number {
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.length > 0) {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed)) {
            throw new Error(`Invalid delegatee response: ${label} is not an integer`);
        }
        return parsed;
    }
    throw new Error(`Invalid delegatee response: missing ${label}`);
}

function parseUint64(value: unknown, label: string): bigint {
    if ((typeof value === "string" && /^[0-9]+$/.test(value)) || Number.isSafeInteger(value)) {
        return BigInt(value as string | number);
    }
    throw new Error(`Invalid delegatee response: ${label} is not an amount`);
}

function parseVariables(value: unknown): Record<string, string> {
    if (value === undefined) return {};
    if (!isObject(value) || Object.values(value).some((v) => typeof v !== "string")) {
        throw new Error("Invalid delegatee delegation: variables are not strings");
    }
    return value as Record<string, string>;
}

function parseOptionalInt64(value: unknown, label: string): number | undefined {
    if (value === undefined) return undefined;
    return parseInt64(value, label);
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalArray(value: unknown, label: string): unknown[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        throw new Error(`Invalid delegatee response: ${label} is not an array`);
    }
    return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
    if (!allowed.includes(value as T)) {
        throw new Error(`Invalid delegatee delegation: unknown ${label} ${String(value)}`);
    }
    return value as T;
}

function parseSlot(value: unknown): DelegateeSlot {
    if (!isObject(value)) {
        throw new Error("Invalid delegatee delegation: invalid slot");
    }
    const name = value.name;
    if (typeof name !== "string" || name.length === 0) {
        throw new Error("Invalid delegatee delegation: slot missing name");
    }
    return {
        name,
        onchain: value.onchain === true,
        tapscripts: optionalArray(value.tapscripts, "slot tapscripts").map((t) => String(t)),
        outpoint: optionalString(value.outpoint),
    };
}

function parseDelegation(value: unknown): DelegateeDelegation {
    if (!isObject(value)) {
        throw new Error("Invalid delegatee delegation");
    }
    const templateId = value.templateId;
    if (typeof templateId !== "string" || templateId.length === 0) {
        throw new Error("Invalid delegatee delegation: missing templateId");
    }
    return {
        id: parseInt64(value.id, "id"),
        address: typeof value.address === "string" ? value.address : "",
        status: oneOf(value.status, ["active", "cancelled", "expired", "done"], "status"),
        templateId,
        variables: parseVariables(value.variables),
        parentId: parseOptionalInt64(value.parentId, "parentId"),
        expiresAt: parseOptionalInt64(value.expiresAt, "expiresAt"),
        slots: optionalArray(value.slots, "slots").map(parseSlot),
        createdAt: parseOptionalInt64(value.createdAt, "createdAt"),
        updatedAt: parseOptionalInt64(value.updatedAt, "updatedAt"),
    };
}

function parseVtxo(value: unknown): DelegateeVtxo {
    if (!isObject(value) || typeof value.outpoint !== "string") {
        throw new Error("Invalid delegatee vtxo");
    }
    return {
        outpoint: value.outpoint,
        amount: parseInt64(value.amount, "amount"),
        expiresAt: parseOptionalInt64(value.expiresAt, "expiresAt"),
        preconfirmed: value.preconfirmed === true,
        assets: optionalArray(value.assets, "assets").map((a) => {
            if (!isObject(a) || typeof a.assetId !== "string") {
                throw new Error("Invalid delegatee vtxo asset");
            }
            return { assetId: a.assetId, amount: parseUint64(a.amount, "asset amount") };
        }),
        createdAt: parseOptionalInt64(value.createdAt, "createdAt"),
        renewableAt: parseOptionalInt64(value.renewableAt, "renewableAt"),
        onchain: value.onchain === true,
    };
}

function parseRenewal(value: unknown): DelegateeRenewal {
    if (!isObject(value)) throw new Error("Invalid delegatee renewal");
    return {
        outpoints: optionalArray(value.outpoints, "outpoints").map((o) => String(o)),
        commitmentTxid: optionalString(value.commitmentTxid),
        success: value.success === true,
        error: optionalString(value.error),
        attemptedAt: parseOptionalInt64(value.attemptedAt, "attemptedAt"),
    };
}

function parseTemplate(value: unknown): DelegateeTemplate {
    if (!isObject(value) || typeof value.id !== "string" || value.id.length === 0) {
        throw new Error("Invalid delegatee template: missing id");
    }
    return { id: value.id, status: typeof value.status === "string" ? value.status : "" };
}

function parseDelegateeInfo(value: unknown): DelegateeInfo {
    if (!isObject(value)) throw new Error("Invalid delegatee info");
    const info: DelegateeInfo = {
        version: requiredString(value, "version"),
        network: requiredString(value, "network"),
        delegatePubkey: requiredString(value, "delegatePubkey"),
        serverPubkey: requiredString(value, "serverPubkey"),
        emulatorPubkey: requiredString(value, "emulatorPubkey"),
    };
    decodeCompressed(info.delegatePubkey, "delegatePubkey");
    decodeCompressed(info.serverPubkey, "serverPubkey");
    decodeCompressed(info.emulatorPubkey, "emulatorPubkey");
    return info;
}

function decodeCompressed(value: string, label: string): void {
    let bytes: Uint8Array;
    try {
        bytes = hex.decode(value);
    } catch {
        throw new Error(`Invalid delegatee info: ${label} is not hex`);
    }
    if (bytes.length !== 33 || (bytes[0] !== 0x02 && bytes[0] !== 0x03)) {
        throw new Error(`Invalid delegatee info: ${label} is not compressed`);
    }
}
