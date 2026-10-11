import { ContractHandler } from "../types";

/**
 * Registry for contract handlers.
 *
 * Each contract type ("default", "vhtlc", etc.) has a handler that knows
 * how to create VtxoScripts, serialize params, and select spending paths.
 *
 * @example
 * ```typescript
 * // Register a custom handler
 * contractHandlers.register(myCustomHandler);
 *
 * // Get handler for a type
 * const handler = contractHandlers.get("vhtlc");
 * const script = handler.createScript(contract.params);
 * ```
 */
class ContractHandlerRegistry {
    private handlers = new Map<string, ContractHandler<unknown>>();

    /** @throws If a handler for this type is already registered */
    register(handler: ContractHandler<unknown>): void {
        if (this.handlers.has(handler.type)) {
            throw new Error(`Contract handler for type '${handler.type}' is already registered`);
        }
        this.handlers.set(handler.type, handler);
    }

    get(type: string): ContractHandler<unknown> | undefined {
        return this.handlers.get(type);
    }

    /** @throws If no handler is registered for this type */
    getOrThrow(type: string): ContractHandler<unknown> {
        const handler = this.get(type);
        if (!handler) {
            throw new Error(`No contract handler registered for type '${type}'`);
        }
        return handler;
    }

    has(type: string): boolean {
        return this.handlers.has(type);
    }

    getRegisteredTypes(): string[] {
        return Array.from(this.handlers.keys());
    }

    /** Unregister a handler (mainly for testing). */
    unregister(type: string): boolean {
        return this.handlers.delete(type);
    }

    /** Clear all handlers (mainly for testing). */
    clear(): void {
        this.handlers.clear();
    }
}

/** Global registry of contract handlers. */
export const contractHandlers = new ContractHandlerRegistry();
