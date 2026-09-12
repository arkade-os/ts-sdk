/**
 * Where a Node consumer's swap database lives.
 *
 * `arkade/swaps/swaps-<network>.sqlite` under the platform config directory,
 * which is the default §3 names and which nothing in this repo could resolve
 * before — there is no XDG, `Application Support` or `%APPDATA%` helper
 * anywhere in the SDK, so this is it.
 *
 * Per network, deliberately: a record's covenant, its solver and its market are
 * all network-scoped, and one file holding two networks' swaps would let a
 * mainnet restore read a regtest record as its own.
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
 * The platform's per-user configuration directory.
 *
 * The three conventions, in the order each platform expects:
 *
 * - Linux and the BSDs follow the XDG Base Directory spec — `$XDG_CONFIG_HOME`
 *   when set to an absolute path, else `~/.config`. A relative value is
 *   ignored, which the spec requires rather than suggests.
 * - macOS uses `~/Library/Application Support`.
 * - Windows uses `%APPDATA%`, falling back to the roaming path under the home
 *   directory when the variable is missing — as it is in some service contexts.
 */
export const configDir = (env: NodeJS.ProcessEnv = process.env): string => {
    if (process.platform === "win32") {
        return env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    }
    if (process.platform === "darwin") {
        return join(homedir(), "Library", "Application Support");
    }
    const xdg = env.XDG_CONFIG_HOME;
    // The spec: a relative path "should be ignored" rather than resolved
    // against the cwd, which would put the database wherever the process
    // happened to start.
    return xdg && xdg.startsWith("/") ? xdg : join(homedir(), ".config");
};

/**
 * The default database path for one network.
 *
 * Returned rather than created: opening it is what creates the directory, and a
 * caller that only wants to know where the file would be — to report it, to
 * back it up, to delete it — should not have to make one as a side effect.
 */
export const swapDatabasePath = (network: string, env: NodeJS.ProcessEnv = process.env): string => {
    assertSafeNetworkPathSegment(network);
    return join(configDir(env), "arkade", "swaps", `swaps-${network}.sqlite`);
};
