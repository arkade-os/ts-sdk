import { TaxiClient, TaxiError } from "@arkade-taxi/client";
import { boundedFetch } from "./context";

export interface RememberedTaxi {
    network: string;
    url: string;
    operatorKey: string;
}

export interface TaxiActivity {
    role: "sender" | "receiver";
    network: string;
    taxiUrl: string;
    transferId: string;
    mode?: "recycle" | "purchase" | "sponsored";
    /** Bitcoin records omit assetId and express units in sats. */
    assetId?: string;
    units: string;
    carrierSats?: string;
    fare?: { currency: "sats" | "asset"; units: string };
    destination?: string;
    returnsTo?: "sender" | "receiver";
    lockupTxid?: string;
    claimTxid?: string;
    spentTxid?: string;
    state: string;
    submissionPhase?: string;
    failureCode?: string;
    failureDetail?: string;
    updatedAt: number;
    createdAt: number;
}

type Status = Awaited<ReturnType<TaxiClient["status"]>>;
type StatusClient = Pick<TaxiClient, "status" | "sponsoredStatus">;

export interface TaxiActivityStoreOptions {
    storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
    client?: (url: string) => StatusClient;
    onError?: (error: unknown, message: string) => void;
    /** Unix seconds. */
    now?: () => number;
    pageProtocol?: string;
}

const STORAGE_KEY = "taxiActivity";
const MAX_CLOSED = 200;
const MAX_TEXT = 512;
const MAX_UNITS = 2n ** 64n - 1n;
// A larger Unix timestamp cannot be rendered as a JavaScript Date.
const MAX_TIME = 8_640_000_000_000;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const RANK = new Map([
    ["quoted", 0],
    ["locking", 1],
    ["locked", 2],
    ["recovering", 3],
    ["recycled", 4],
    ["purchased", 4],
    ["refunded", 4],
    ["recovered", 4],
    ["expired", 4],
]);
const isUnits = (value: unknown): value is string =>
    typeof value === "string" && DECIMAL.test(value) && BigInt(value) <= MAX_UNITS;
const isText = (value: unknown): value is string =>
    typeof value === "string" && value.length <= MAX_TEXT;
const isTime = (value: unknown): value is number =>
    Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_TIME;
const optional = (value: unknown, check: (value: unknown) => boolean): boolean =>
    value === undefined || check(value);
const isTxid = (value: unknown): value is string =>
    typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isHttpUrl = (value: unknown): boolean => {
    try {
        return typeof value === "string" && ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
        return false;
    }
};

export const isTaxiActivity = (value: unknown): value is TaxiActivity => {
    const r = value as Partial<TaxiActivity> | null;
    return (
        typeof r === "object" &&
        r !== null &&
        (r.role === "sender" || r.role === "receiver") &&
        typeof r.network === "string" &&
        isHttpUrl(r.taxiUrl) &&
        typeof r.transferId === "string" &&
        r.transferId.length <= 128 &&
        /^[A-Za-z0-9._:-]+$/.test(r.transferId) &&
        optional(
            r.mode,
            (mode) => mode === "recycle" || mode === "purchase" || mode === "sponsored",
        ) &&
        optional(r.assetId, (id) => typeof id === "string" && /^[0-9a-fA-F]{68}$/.test(id)) &&
        isUnits(r.units) &&
        optional(r.carrierSats, isUnits) &&
        optional(r.fare, (fare) => {
            const { currency, units } = (fare ?? {}) as Partial<NonNullable<TaxiActivity["fare"]>>;
            return (currency === "sats" || currency === "asset") && isUnits(units);
        }) &&
        optional(r.destination, isText) &&
        optional(r.returnsTo, (to) => to === "sender" || to === "receiver") &&
        [r.lockupTxid, r.claimTxid, r.spentTxid].every((txid) => optional(txid, isTxid)) &&
        (r.state === "gone" || RANK.has(r.state as string)) &&
        [r.submissionPhase, r.failureCode, r.failureDetail].every((text) =>
            optional(text, isText),
        ) &&
        isTime(r.updatedAt) &&
        isTime(r.createdAt)
    );
};

export const taxiActivityKey = ({
    role,
    taxiUrl,
    transferId,
}: Pick<TaxiActivity, "role" | "taxiUrl" | "transferId">): string =>
    `${role} ${taxiUrl} ${transferId}`;

export const isTaxiActivityOpen = ({
    mode,
    state,
}: Pick<TaxiActivity, "mode" | "state">): boolean =>
    ["quoted", "locking", ...(mode === "sponsored" ? [] : ["locked", "recovering"])].includes(
        state,
    );

const advances = (current: TaxiActivity, next: TaxiActivity): boolean => {
    if (next.state === "gone") return isTaxiActivityOpen(current);
    if (current.state === "gone") return true;
    const [from, to] = [RANK.get(current.state)!, RANK.get(next.state)!];
    return to > from || (to === from && next.updatedAt >= current.updatedAt);
};
const statusOf = ({
    state,
    submissionPhase,
    failureCode,
    failureDetail,
    updatedAt,
}: TaxiActivity) => ({ state, submissionPhase, failureCode, failureDetail, updatedAt });
const merge = (current: TaxiActivity, next: TaxiActivity): TaxiActivity => ({
    ...current,
    ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)),
    ...statusOf(advances(current, next) ? next : current),
    createdAt: current.createdAt,
});
const withinCap = (records: TaxiActivity[]): TaxiActivity[] => {
    const evicted = new Set(
        records
            .filter((r) => !isTaxiActivityOpen(r))
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(MAX_CLOSED),
    );
    return records.filter((r) => !evicted.has(r));
};

export const taxiActivityTxids = (r: TaxiActivity): string[] => {
    const locked = (RANK.get(r.state) ?? 0) >= 2 && r.state !== "expired";
    return [locked ? r.lockupTxid : undefined, r.claimTxid, r.spentTxid].filter(isTxid);
};

export class TaxiActivityStore {
    private version = 0;
    private readonly listeners = new Set<() => void>();
    private readonly inFlight = new Map<string, Promise<void>>();
    private readonly failing = new Set<string>();
    private readonly unknownStates = new Set<string>();

    constructor(private readonly options: TaxiActivityStoreOptions) {}

    private report(error: unknown, message: string): void {
        try {
            this.options.onError?.(error, message);
        } catch {
            /* Diagnostics cannot abort a payment. */
        }
    }

    private readAll(): TaxiActivity[] {
        try {
            const raw = this.options.storage.getItem(STORAGE_KEY);
            const stored: unknown = raw === null ? [] : JSON.parse(raw);
            return Array.isArray(stored) ? stored.filter(isTaxiActivity) : [];
        } catch {
            return [];
        }
    }

    private notify(): void {
        this.version += 1;
        this.listeners.forEach((fn) => fn());
    }

    readonly read = (network: string): TaxiActivity[] =>
        this.readAll().filter((r) => r.network === network);
    readonly getVersion = (): number => this.version;
    readonly subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    readonly record = (next: TaxiActivity): void => {
        try {
            const records = this.readAll();
            const current = records.find((r) => taxiActivityKey(r) === taxiActivityKey(next));
            const merged = current ? merge(current, next) : next;
            if (!isTaxiActivity(merged))
                return this.report(merged, `not recording Taxi transfer ${next.transferId}`);
            if (current && JSON.stringify(current) === JSON.stringify(merged)) return;
            this.options.storage.setItem(
                STORAGE_KEY,
                JSON.stringify(withinCap([merged, ...records.filter((r) => r !== current)])),
            );
            this.notify();
        } catch (error) {
            this.report(error, `could not record Taxi transfer ${next.transferId}`);
        }
    };

    readonly recordStatus = (r: TaxiActivity, status: Status): void => {
        if (status.transferId !== r.transferId) return;
        if (r.role === "sender" && status.outpoint && status.outpoint.txid !== r.lockupTxid) return;
        if (!RANK.has(status.state)) {
            if (!this.unknownStates.has(status.state))
                this.report(status.state, "unknown Taxi transfer state");
            this.unknownStates.add(status.state);
            return;
        }
        this.record({
            ...r,
            state: status.state,
            submissionPhase: status.submissionPhase?.slice(0, MAX_TEXT),
            failureCode: status.failureCode?.slice(0, MAX_TEXT),
            failureDetail: status.failureDetail?.slice(0, MAX_TEXT),
            ...(status.spentTxid ? { spentTxid: status.spentTxid } : {}),
            updatedAt: status.updatedAt,
        });
    };

    readonly forget = (): void => {
        this.options.storage.removeItem(STORAGE_KEY);
        this.notify();
    };

    readonly refresh = (r: TaxiActivity, client?: StatusClient): Promise<void> => {
        const key = taxiActivityKey(r);
        const running = this.inFlight.get(key);
        if (running) return running;
        client ??=
            this.options.client?.(r.taxiUrl) ??
            new TaxiClient({ baseUrl: r.taxiUrl, fetch: boundedFetch });
        const read =
            r.mode === "sponsored"
                ? client.sponsoredStatus(r.transferId)
                : client.status(r.transferId);
        const run = read
            .then(
                (status) => this.recordStatus(r, status),
                (error) => {
                    if (!(error instanceof TaxiError && error.code === "not_found")) throw error;
                    this.record({
                        ...r,
                        state: "gone",
                        submissionPhase: undefined,
                        failureCode: undefined,
                        failureDetail: undefined,
                        updatedAt: this.options.now?.() ?? Math.floor(Date.now() / 1000),
                    });
                },
            )
            .finally(() => this.inFlight.delete(key));
        this.inFlight.set(key, run);
        return run;
    };

    readonly poll = async (
        network: string,
        pageProtocol = this.options.pageProtocol,
    ): Promise<void> => {
        await Promise.all(
            this.read(network)
                .filter(
                    (r) =>
                        isTaxiActivityOpen(r) &&
                        !(pageProtocol === "https:" && new URL(r.taxiUrl).protocol === "http:"),
                )
                .map((r) => {
                    const key = taxiActivityKey(r);
                    return this.refresh(r).then(
                        () => {
                            this.failing.delete(key);
                        },
                        (error) => {
                            if (!this.failing.has(key))
                                this.report(error, `could not read Taxi transfer ${r.transferId}`);
                            this.failing.add(key);
                        },
                    );
                }),
        );
    };
}
