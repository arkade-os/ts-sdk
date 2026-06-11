const version = "0.9.7";

export function fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
    if (typeof globalThis.fetch !== "function") {
        throw new Error("Fetch API is not available in this environment.");
    }
    if (init) {
        init.headers = {
            ...init.headers,
            "X-Build-Version": version,
        };
    }
    return globalThis.fetch(input, init);
}
