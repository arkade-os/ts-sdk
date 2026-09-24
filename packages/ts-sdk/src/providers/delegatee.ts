import { hex } from "@scure/base";
import { baseFetch } from "../utils/fetch";
import { rateGate } from "./rateGate";
import {
    buildDelegateeArkadeScript,
    buildDelegateeTapLeaf,
    DEFAULT_DELEGATEE_MAX_FEE,
    DEFAULT_DELEGATEE_RENEWAL_WINDOW,
} from "../script/delegatee";

export interface DelegateeParams {
    renewalWindow?: number;
    maxFee?: number;
}

export interface DelegateeInfo {
    version: string;
    network: string;
    delegatePubkey: string;
    serverPubkey: string;
    emulatorPubkey: string;
    emulatorTweakedPubkey: string;
    arkadeScript: string;
    delegateTapscript: string;
    renewalWindow: number;
    maxFee: number;
}

export interface DelegateeDelegation {
    id: number;
    address: string;
    status: string;
    tapscripts?: string[];
    createdAt?: number;
    updatedAt?: number;
    renewalWindow?: number;
    maxFee?: number;
}

export interface DelegateeProvider {
    getInfo(params?: DelegateeParams): Promise<DelegateeInfo>;
    registerDelegation(
        tapscripts: string[],
        params: Required<DelegateeParams>,
    ): Promise<DelegateeDelegation>;
    getDelegation(address: string): Promise<unknown>;
    revokeDelegation(request: {
        address: string;
        pubkey: string;
        signature: string;
        timestamp: number;
    }): Promise<void>;
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
    constructor(
        public url: string,
        readonly options: { emulatorPubkey?: string } = {},
    ) {}

    async getInfo(params: DelegateeParams = {}): Promise<DelegateeInfo> {
        const renewalWindow = params.renewalWindow ?? DEFAULT_DELEGATEE_RENEWAL_WINDOW;
        const maxFee = params.maxFee ?? DEFAULT_DELEGATEE_MAX_FEE;
        const query = new URLSearchParams({
            renewalWindow: String(renewalWindow),
            maxFee: String(maxFee),
        });
        const url = `${this.url.replace(/\/+$/, "")}/v1/info?${query}`;
        const response = await rateGate.runHttp(url, () => baseFetch(url));
        if (!response.ok) {
            throw new Error(`Failed to get delegatee info: ${await response.text()}`);
        }

        const raw: unknown = await response.json();
        const info = parseDelegateeInfo(raw);
        if (
            this.options.emulatorPubkey &&
            info.emulatorPubkey.toLowerCase() !== this.options.emulatorPubkey.toLowerCase()
        ) {
            throw new Error(
                `Delegatee emulator key mismatch: expected ${this.options.emulatorPubkey}, got ${info.emulatorPubkey}`,
            );
        }
        validateDelegateeInfo(info);
        return info;
    }

    async registerDelegation(
        tapscripts: string[],
        params: Required<DelegateeParams>,
    ): Promise<DelegateeDelegation> {
        const url = `${this.url.replace(/\/+$/, "")}/v1/delegate`;
        const response = await baseFetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                tapscripts,
                renewalWindow: params.renewalWindow,
                maxFee: params.maxFee,
            }),
        });
        if (!response.ok) {
            throw new Error(`Failed to register delegatee: ${await response.text()}`);
        }
        const data: unknown = await response.json();
        if (!isObject(data) || !isObject(data.delegation)) {
            throw new Error("Invalid delegatee registration response");
        }
        return data.delegation as unknown as DelegateeDelegation;
    }

    async getDelegation(address: string): Promise<unknown> {
        const url = `${this.url.replace(/\/+$/, "")}/v1/delegate/${encodeURIComponent(address)}`;
        const response = await rateGate.runHttp(url, () => baseFetch(url));
        if (response.status === 404) {
            throw new DelegateeNotFoundError(address);
        }
        if (!response.ok) {
            throw new Error(`Failed to get delegatee delegation: ${await response.text()}`);
        }
        return response.json();
    }

    async revokeDelegation(request: {
        address: string;
        pubkey: string;
        signature: string;
        timestamp: number;
    }): Promise<void> {
        const url = `${this.url.replace(/\/+$/, "")}/v1/delegate/${encodeURIComponent(request.address)}/revoke`;
        const response = await baseFetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request),
        });
        if (!response.ok) {
            throw new Error(`Failed to revoke delegatee delegation: ${await response.text()}`);
        }
    }
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

function requiredNumber(object: Record<string, unknown>, key: string): number {
    const value = object[key];
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(number)) {
        throw new Error(`Invalid delegatee info: invalid ${key}`);
    }
    return number;
}

function parseDelegateeInfo(value: unknown): DelegateeInfo {
    if (!isObject(value)) throw new Error("Invalid delegatee info");
    return {
        version: requiredString(value, "version"),
        network: requiredString(value, "network"),
        delegatePubkey: requiredString(value, "delegatePubkey"),
        serverPubkey: requiredString(value, "serverPubkey"),
        emulatorPubkey: requiredString(value, "emulatorPubkey"),
        emulatorTweakedPubkey: requiredString(value, "emulatorTweakedPubkey"),
        arkadeScript: requiredString(value, "arkadeScript"),
        delegateTapscript: requiredString(value, "delegateTapscript"),
        renewalWindow: requiredNumber(value, "renewalWindow"),
        // The protobuf JSON gateway omits scalar fields with their zero value.
        maxFee: value.maxFee === undefined ? 0 : requiredNumber(value, "maxFee"),
    };
}

function decodeCompressed(value: string, label: string): Uint8Array {
    let bytes: Uint8Array;
    try {
        bytes = hex.decode(value);
    } catch {
        throw new Error(`Invalid delegatee info: ${label} is not hex`);
    }
    if (bytes.length !== 33 || (bytes[0] !== 0x02 && bytes[0] !== 0x03)) {
        throw new Error(`Invalid delegatee info: ${label} is not compressed`);
    }
    return bytes;
}

function validateDelegateeInfo(info: DelegateeInfo): void {
    const delegatePubkey = decodeCompressed(info.delegatePubkey, "delegatePubkey");
    const serverPubkey = decodeCompressed(info.serverPubkey, "serverPubkey");
    const emulatorPubkey = decodeCompressed(info.emulatorPubkey, "emulatorPubkey");
    const arkadeScript = buildDelegateeArkadeScript({
        delegatePubKey: delegatePubkey,
        renewalWindow: info.renewalWindow,
        maxFee: info.maxFee,
    });
    if (hex.encode(arkadeScript) !== info.arkadeScript.toLowerCase()) {
        throw new Error("Invalid delegatee info: covenant does not match its parameters");
    }

    const delegateLeaf = buildDelegateeTapLeaf(serverPubkey, emulatorPubkey, arkadeScript);
    const advertisedTweakedKey = decodeCompressed(
        info.emulatorTweakedPubkey,
        "emulatorTweakedPubkey",
    ).slice(1);
    if (hex.encode(delegateLeaf.emulatorTweakedPubKey) !== hex.encode(advertisedTweakedKey)) {
        throw new Error("Invalid delegatee info: emulator tweak does not match its covenant");
    }
    if (hex.encode(delegateLeaf.script) !== info.delegateTapscript.toLowerCase()) {
        throw new Error("Invalid delegatee info: delegate tapscript does not match its keys");
    }
}
