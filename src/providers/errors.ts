export class ArkError extends Error {
    constructor(
        readonly code: number,
        readonly message: string,
        readonly name: string,
        readonly metadata?: Record<string, string>
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

        if (!("details" in decoded)) return undefined;
        if (!Array.isArray(decoded.details)) return undefined;

        // search for a valid details object with the correct type
        for (const details of decoded.details) {
            if (!("@type" in details)) return undefined;
            const type = details["@type"];
            if (type !== "type.googleapis.com/ark.v1.ErrorDetails")
                return undefined;

            if (!("code" in details)) return undefined;
            const code = details.code;

            if (!("message" in details)) return undefined;
            const message = details.message;

            if (!("name" in details)) return undefined;
            const name = details.name;

            let metadata: Record<string, string> | undefined;
            if ("metadata" in details && isMetadata(details.metadata)) {
                metadata = details.metadata;
            }

            return new ArkError(code, message, name, metadata);
        }
        return undefined;
    } catch (e) {
        return undefined;
    }
}

function isMetadata(value: any): value is Record<string, string> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
