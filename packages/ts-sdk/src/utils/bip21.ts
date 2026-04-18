/** Known BIP21 parameters including Arkade-specific extensions. */
export interface BIP21Params {
    address?: string;
    amount?: number;
    label?: string;
    message?: string;

    /** Optional Arkade address parameter. */
    ark?: string;

    /** Optional Silent Payment address parameter. */
    sp?: string;

    [key: string]: string | number | undefined;
}

/** Result returned by `BIP21.parse`. */
export interface BIP21ParseResult {
    originalString: string;
    params: BIP21Params;
}

export enum BIP21Error {
    INVALID_URI = "Invalid BIP21 URI",
    INVALID_ADDRESS = "Invalid address",
}

export class BIP21 {
    /**
     * Create a BIP21 URI from the provided parameters.
     *
     * @param params - BIP21 parameters to encode
     * @returns Encoded BIP21 URI
     */
    static create(params: BIP21Params): string {
        const { address, ...options } = params;

        // Build query string
        const queryParams: Record<string, string | number> = {};
        for (const [key, value] of Object.entries(options)) {
            if (value === undefined) continue;

            if (key === "amount") {
                if (!isFinite(value as number)) {
                    console.warn("Invalid amount");
                    continue;
                }
                if ((value as number) < 0) {
                    continue;
                }
                queryParams[key] = value;
            } else if (key === "ark") {
                // Validate Arkade address format
                if (
                    typeof value === "string" &&
                    (value.startsWith("ark") || value.startsWith("tark"))
                ) {
                    queryParams[key] = value;
                } else {
                    console.warn("Invalid ARK address format");
                }
            } else if (key === "sp") {
                // Validate Silent Payment address format (placeholder)
                if (typeof value === "string" && value.startsWith("sp")) {
                    queryParams[key] = value;
                } else {
                    console.warn("Invalid Silent Payment address format");
                }
            } else if (typeof value === "string" || typeof value === "number") {
                queryParams[key] = value;
            }
        }

        const query =
            Object.keys(queryParams).length > 0
                ? "?" +
                  new URLSearchParams(
                      Object.fromEntries(
                          Object.entries(queryParams).map(([k, v]) => [
                              k,
                              String(v),
                          ])
                      )
                  ).toString()
                : "";

        return `bitcoin:${address ? address.toLowerCase() : ""}${query}`;
    }

    /**
     * Parse a BIP21 URI and return its decoded parameters.
     *
     * @param uri - BIP21 URI to parse
     * @returns Parsed BIP21 URI data
     * @throws Error if the URI does not start with the `bitcoin:` scheme
     */
    static parse(uri: string): BIP21ParseResult {
        if (!uri.toLowerCase().startsWith("bitcoin:")) {
            throw new Error(BIP21Error.INVALID_URI);
        }

        // Remove the `bitcoin:` prefix while preserving the case of the rest.
        const withoutPrefix = uri.slice(
            uri.toLowerCase().indexOf("bitcoin:") + 8
        );

        const [address, query] = withoutPrefix.split("?");

        const params: BIP21Params = {};
        if (address) {
            params.address = address.toLowerCase();
        }

        if (query) {
            const queryParams = new URLSearchParams(query);
            for (const [key, value] of queryParams.entries()) {
                if (!value) continue;

                if (key === "amount") {
                    const amount = Number(value);
                    if (!isFinite(amount)) {
                        continue;
                    }
                    if (amount < 0) {
                        continue;
                    }
                    params[key] = amount;
                } else if (key === "ark") {
                    // Validate Arkade address format
                    if (value.startsWith("ark") || value.startsWith("tark")) {
                        params[key] = value;
                    } else {
                        console.warn("Invalid ARK address format");
                    }
                } else if (key === "sp") {
                    // Validate Silent Payment address format (placeholder)
                    if (value.startsWith("sp")) {
                        params[key] = value;
                    } else {
                        console.warn("Invalid Silent Payment address format");
                    }
                } else {
                    params[key] = value;
                }
            }
        }

        return {
            originalString: uri,
            params,
        };
    }
}
