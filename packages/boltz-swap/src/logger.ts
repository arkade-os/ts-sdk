/**
 * Logger interface for customizing log output
 */
export interface Logger {
    log: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
}

/**
 * Default logger using console
 */
export let logger: Logger = console;

/**
 * Set a custom logger to override the default console logging
 */
export function setLogger(customLogger: Logger): void {
    logger = customLogger;
}
