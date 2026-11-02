import { baseFetch } from "../utils/fetch";
import { rateGate } from "./rateGate";

export interface DelegateeInfo {
    version: string;
    network: string;
    delegatePubkey: string;
    serverPubkey: string;
    emulatorPubkey: string;
    encryptionPubkey?: string;
}

export interface DelegateeDocument {
    id: string;
    document: string;
    createdAt?: string;
}

export interface DelegateeDelegation {
    id: string;
    address: string;
    status: string;
    outpoint?: string;
}

export interface DelegateeStatus {
    delegation: DelegateeDelegation;
    vtxos: { outpoint: string; amount: string; expiresAt: string; preconfirmed: boolean }[];
    renewals: { outpoints: string[]; commitmentTxid: string; success: boolean; error: string }[];
}

/** Template executor API. Separate from the existing signed-intent DelegateProvider. */
export interface DelegateeProvider {
    getInfo(): Promise<DelegateeInfo>;
    registerArtifact(document: unknown): Promise<DelegateeDocument>;
    registerTemplate(document: unknown): Promise<DelegateeDocument>;
    registerDelegation(
        templateId: string,
        variables?: Record<string, string>,
        expiresAt?: number,
    ): Promise<DelegateeDelegation>;
    getDelegation(address: string): Promise<DelegateeStatus>;
}

export class RestDelegateeProvider implements DelegateeProvider {
    constructor(readonly url: string) {}

    private async request<T>(path: string, body?: unknown): Promise<T> {
        const url = `${this.url.replace(/\/$/, "")}/v1/${path}`;
        const send = () =>
            baseFetch(
                url,
                body === undefined
                    ? undefined
                    : {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify(body),
                      },
            );
        const response = body === undefined ? await rateGate.runHttp(url, send) : await send();
        if (!response.ok)
            throw new Error(`Delegatee ${path}: HTTP ${response.status}: ${await response.text()}`);
        return response.json() as Promise<T>;
    }

    async getInfo(): Promise<DelegateeInfo> {
        const info = await this.request<DelegateeInfo>("info");
        if (
            !info.network ||
            !/^(02|03)[0-9a-f]{64}$/.test(info.serverPubkey) ||
            !/^(02|03)[0-9a-f]{64}$/.test(info.emulatorPubkey)
        ) {
            throw new Error("Delegatee: invalid info");
        }
        return info;
    }

    async registerArtifact(document: unknown): Promise<DelegateeDocument> {
        const response = await this.request<{ artifact: DelegateeDocument }>("artifact", {
            document: JSON.stringify(document),
        });
        return response.artifact;
    }

    async registerTemplate(document: unknown): Promise<DelegateeDocument> {
        const response = await this.request<{ template: DelegateeDocument }>("template", {
            document: JSON.stringify(document),
        });
        return response.template;
    }

    async registerDelegation(
        templateId: string,
        variables: Record<string, string> = {},
        expiresAt = 0,
    ): Promise<DelegateeDelegation> {
        if (!Number.isSafeInteger(expiresAt) || expiresAt < 0)
            throw new Error("Delegatee: invalid expiry");
        const response = await this.request<{ delegation: DelegateeDelegation }>("delegate", {
            templateId,
            variables,
            expiresAt,
        });
        return response.delegation;
    }

    getDelegation(address: string): Promise<DelegateeStatus> {
        return this.request(`delegate/${encodeURIComponent(address)}`);
    }
}
