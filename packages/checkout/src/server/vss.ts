import { SingleKey } from "@arkade-os/sdk";

/**
 * Fetches the private key from VSS (Verifiable Secret Sharing)
 * This assumes you have a VSS service endpoint configured
 */
export async function getPrivateKeyFromVSS(): Promise<SingleKey> {
    // Check if we should use VSS
    const vssEnabled = process.env.ARKADE_USE_VSS === "true";

    if (!vssEnabled) {
        // Fallback to env variable
        if (!process.env.ARKADE_PRIVATE_KEY_HEX) {
            throw new Error("ARKADE_PRIVATE_KEY_HEX environment variable is not set");
        }
        return SingleKey.fromHex(process.env.ARKADE_PRIVATE_KEY_HEX);
    }

    // VSS configuration
    const vssUrl = process.env.VSS_URL;
    const vssKeyId = process.env.VSS_KEY_ID;
    const vssAuthToken = process.env.VSS_AUTH_TOKEN;

    if (!vssUrl || !vssKeyId) {
        throw new Error("VSS_URL and VSS_KEY_ID must be set when ARKADE_USE_VSS=true");
    }

    try {
        // Fetch the private key from VSS
        const response = await fetch(`${vssUrl}/secrets/${vssKeyId}`, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                ...(vssAuthToken && { Authorization: `Bearer ${vssAuthToken}` }),
            },
        });

        if (!response.ok) {
            throw new Error(`VSS request failed: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();

        // Assuming VSS returns the key in a 'value' or 'secret' field
        const privateKeyHex = data.value || data.secret || data.privateKey;

        if (!privateKeyHex) {
            throw new Error("VSS response does not contain private key");
        }

        return SingleKey.fromHex(privateKeyHex);
    } catch (error) {
        console.error("Failed to fetch private key from VSS:", error);
        throw new Error(
            `VSS fetch failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
    }
}

/**
 * Cache for the private key to avoid repeated VSS calls
 * In serverless environments, this will be fresh on each cold start
 */
let cachedIdentity: SingleKey | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Gets the private key with caching
 */
export async function getCachedPrivateKey(): Promise<SingleKey> {
    const now = Date.now();

    // Return cached key if still valid
    if (cachedIdentity && now - cacheTimestamp < CACHE_TTL) {
        return cachedIdentity;
    }

    // Fetch new key
    cachedIdentity = await getPrivateKeyFromVSS();
    cacheTimestamp = now;

    return cachedIdentity;
}
