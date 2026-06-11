const digest = "83e847f06e157c8da464824a556098452323158cc34f65d40a72ffd8ff1b90e3";

export function fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
    if (typeof globalThis.fetch !== "function") {
        throw new Error("Fetch API is not available in this environment.");
    }
    if (init) {
        init.headers = {
            ...init.headers,
            "X-Server-Digest": digest,
        };
    }
    return globalThis.fetch(input, init);
}
