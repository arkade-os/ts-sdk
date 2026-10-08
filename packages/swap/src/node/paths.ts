/**
 * Where a Node consumer's swap database lives: `arkade/swaps/swaps-<network>.sqlite` under the
 * platform config directory.
 *
 * Per network, deliberately: records are network-scoped, and one file holding two networks' swaps
 * would let a mainnet restore read a regtest record as its own.
 */
import { homedir } from "node:os";
import { join } from "node:path";

const NETWORK_PATH_SEGMENT = /^[a-z][a-z0-9-]{0,32}$/;

const assertSafeNetworkPathSegment = (network: string): void => {
    if (NETWORK_PATH_SEGMENT.test(network)) return;
    throw new Error(
        `Invalid network name for swap database path: ${JSON.stringify(network)}. ` +
            "Use lowercase letters, digits, and hyphens, starting with a letter.",
    );
};

/**
 * The platform's per-user configuration directory: `%APPDATA%` on Windows (falling back to the
 * roaming path, as the variable is missing in some service contexts), `~/Library/Application
 * Support` on macOS, else XDG (`$XDG_CONFIG_HOME` if absolute, else `~/.config`).
 */
export const configDir = (env: NodeJS.ProcessEnv = process.env): string => {
    if (process.platform === "win32") {
        return env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    }
    if (process.platform === "darwin") {
        return join(homedir(), "Library", "Application Support");
    }
    const xdg = env.XDG_CONFIG_HOME;
    // XDG spec: a relative value is ignored, not resolved against the cwd.
    return xdg && xdg.startsWith("/") ? xdg : join(homedir(), ".config");
};

/**
 * The default database path for one network. Returned, not created, so callers that only report,
 * back up or delete it don't make a directory as a side effect.
 */
export const swapDatabasePath = (network: string, env: NodeJS.ProcessEnv = process.env): string => {
    assertSafeNetworkPathSegment(network);
    return join(configDir(env), "arkade", "swaps", `swaps-${network}.sqlite`);
};
