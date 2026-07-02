export class ArkError extends Error {
    constructor(
        readonly code: number,
        readonly message: string,
        readonly name: string,
        readonly metadata?: Record<string, string>,
    ) {
        super(message);
    }
}

/**
 * Try to convert an error to an ArkError class, returning undefined if the error is not an ArkError
 * @param error - The error to parse
 * @returns The parsed ArkError, or undefined if the error is not an ArkError
 */
export function maybeArkError(error: any): ArkError | undefined {
    try {
        if (!(error instanceof Error)) return undefined;
        const decoded = JSON.parse(error.message);

        // Preferred: the structured ErrorDetails the server attaches in details[].
        if (Array.isArray(decoded.details)) {
            for (const details of decoded.details) {
                if (!("@type" in details)) continue;
                const type = details["@type"];
                if (type !== "type.googleapis.com/ark.v1.ErrorDetails") continue;

                if (!("code" in details)) continue;

                const code = details.code;

                if (!("message" in details)) continue;
                const message = details.message;

                if (!("name" in details)) continue;
                const name = details.name;

                let metadata: Record<string, string> | undefined;
                if ("metadata" in details && isMetadata(details.metadata)) {
                    metadata = details.metadata;
                }

                return new ArkError(code, message, name, metadata);
            }
        }

        // Fallback: arkd's guard interceptors (build-version, digest) run outside
        // the error-detail converter, so their REST errors arrive with an empty
        // `details[]` and the structured name only in the top-level message, as
        // "NAME (code): human message". Recover the name and code so callers can
        // still branch on the error name (metadata is unavailable on this path).
        if (typeof decoded.message === "string") {
            const m = decoded.message.match(/^([A-Z][A-Z0-9_]*) \((\d+)\): ([\s\S]*)$/);
            if (m) return new ArkError(Number(m[2]), m[3], m[1]);
        }

        return undefined;
    } catch (e) {
        return undefined;
    }
}

function isMetadata(value: any): value is Record<string, string> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
