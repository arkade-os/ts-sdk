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

/**
 * The Arkade address prefixes, matched case-INSENSITIVELY.
 *
 * Bech32m forbids a case *mix*, not upper case, and `ArkAddress.decode`
 * accepts an all-upper address — so a case-sensitive filter dropped, with a
 * `console.warn`, an address the bare classifier (`arkTarget`) claims happily.
 * One destination classifying differently bare than as an `ark=` param is the
 * defect; this is the only place the two forms are told apart.
 */
const ARK_HRP = /^t?ark/i;

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
                const amount = value as number;
                if (!isFinite(amount) || !Number.isSafeInteger(Math.trunc(amount))) {
                    console.warn("Invalid amount");
                    continue;
                }
                if (amount < 0) {
                    continue;
                }
                queryParams[key] = value;
            } else if (key === "ark") {
                // Validate Arkade address format
                if (typeof value === "string" && ARK_HRP.test(value)) {
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
                          Object.entries(queryParams).map(([k, v]) => [k, String(v)]),
                      ),
                  ).toString()
                : "";

        return `bitcoin:${address ?? ""}${query}`;
    }

    /**
     * Integer-sats amount encoded in a BIP21 URI (`amount=` is BTC), or
     * `undefined` when absent or the URI is unparseable. Shared by the payment
     * rails, which accept either a bare address or a BIP21 URI.
     *
     * @param uri - BIP21 URI (or bare address) to read the amount from
     * @returns The amount in satoshis, or `undefined`
     */
    static amountSats(uri: string): number | undefined {
        try {
            const btc = BIP21.parse(uri).params.amount;
            return typeof btc === "number" ? Math.round(btc * 1e8) : undefined;
        } catch {
            return undefined;
        }
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
        const withoutPrefix = uri.slice(uri.toLowerCase().indexOf("bitcoin:") + 8);

        const [address, query] = withoutPrefix.split("?");

        const params: BIP21Params = {};
        if (address) {
            // Verbatim. Base58 is case-SENSITIVE, so lowercasing here produced a
            // DIFFERENT address and did it silently: `isBtcAddress` admits a
            // lowercase base58 string, so the corruption passed classification
            // and the rail funded whatever the mangled string decoded to.
            // Bech32 is unharmed either way — BIP173 forbids a case MIX, not
            // upper case, and every decoder in this SDK takes an all-upper
            // address.
            params.address = address;
        }

        if (query) {
            const queryParams = new URLSearchParams(query);
            for (const [key, value] of queryParams.entries()) {
                if (!value) continue;

                if (key === "amount") {
                    // BIP21 ABNF: amount = *digit [ "." *digit ], so digits are
                    // optional on either side of the decimal point (".5", "5.").
                    if (!/^(?:\d+\.?\d*|\.\d+)$/.test(value)) {
                        continue;
                    }
                    const amount = Number(value);
                    if (!isFinite(amount) || !Number.isSafeInteger(Math.trunc(amount))) {
                        continue;
                    }
                    params[key] = amount;
                } else if (key === "ark") {
                    // Validate Arkade address format
                    if (ARK_HRP.test(value)) {
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
