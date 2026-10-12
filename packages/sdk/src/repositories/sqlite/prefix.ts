// A table name cannot be a bound parameter, so every prefixed repository
// interpolates it into SQL. This is the check that keeps that safe.
const SAFE_PREFIX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validate a SQLite table prefix and return it unchanged.
 *
 * Rejects a leading digit as well as punctuation: `1_vtxos` is not a valid SQL
 * identifier either.
 */
export function sanitizeTablePrefix(p: string): string {
    if (!SAFE_PREFIX.test(p)) throw new Error(`Invalid table prefix "${p}"`);
    return p;
}
