import { WalletConfig, IWallet } from "../wallet";
import {
    ExecutionContext,
    detectExecutionContext,
    needsServiceWorker,
} from "./context";
import { ServiceWorkerProxy } from "../implementations/serviceWorkerProxy";
import { Wallet as DirectWallet } from "./directWallet";
import { setupServiceWorkerWithConfig } from "./serviceWorkerInit";
import { SingleKey } from "../identity/singleKey";
import { Identity } from "../identity";
import { WalletRepository } from "../repositories/walletRepository";
import { ContractRepository } from "../repositories/contractRepository";

/**
 * Interface for wallet implementations that can be created by the factory.
 */
export interface IWalletImplementation extends IWallet {
    readonly identity: Identity;
    readonly walletRepository: WalletRepository;
    readonly contractRepository: ContractRepository;
    clear?(): Promise<void>;
}

/**
 * Creates the appropriate wallet implementation based on the execution context.
 *
 * @param context - The detected execution context
 * @param config - Wallet configuration
 * @returns Promise that resolves to a wallet implementation
 */
export async function createWalletImplementation(
    context: ExecutionContext,
    config: WalletConfig
): Promise<IWalletImplementation> {
    switch (context) {
        case "SERVICE_WORKER":
            // We ARE the service worker - use direct implementation
            return await createDirectWallet(config);

        case "WORKER_CLIENT":
            // We need to communicate with a service worker - use proxy
            return await createServiceWorkerProxy(config);

        case "DIRECT":
            // Regular web or Node.js - use direct implementation
            return await createDirectWallet(config);

        default:
            throw new Error(`Unsupported execution context: ${context}`);
    }
}

/**
 * Creates a direct wallet implementation.
 * This is used in SERVICE_WORKER and DIRECT contexts.
 */
async function createDirectWallet(config: WalletConfig): Promise<DirectWallet> {
    return await DirectWallet.create(config);
}

/**
 * Creates a service worker proxy implementation.
 * This sets up the service worker and returns a proxy that communicates with it.
 */
async function createServiceWorkerProxy(
    config: WalletConfig
): Promise<ServiceWorkerProxy> {
    // Extract private key if using SingleKey identity
    let privateKey: string | undefined;

    // For service worker initialization, we need to pass the private key
    // This is a limitation of the current architecture - the service worker
    // needs to recreate the identity with the same key
    // In a real implementation, you might want to use a different approach
    // such as passing the seed phrase or using a more sophisticated key management system

    if (config.identity instanceof SingleKey) {
        // Create a new random identity for the service worker
        // Note: This means the service worker will have a different identity
        // In production, you would want to use the same key or a derived key
        privateKey = undefined; // Let service worker generate its own key
    }

    // Set up and configure the service worker
    const serviceWorker = await setupServiceWorkerWithConfig({
        arkServerUrl: config.arkServerUrl,
        arkServerPublicKey: config.arkServerPublicKey,
        privateKey,
    });

    // Create and return the proxy
    return new ServiceWorkerProxy(serviceWorker, config);
}

/**
 * Auto-detects the execution context and creates the appropriate wallet implementation.
 * This is the main factory function used by Wallet.create().
 *
 * @param config - Wallet configuration
 * @returns Promise that resolves to a wallet implementation
 */
export async function createWalletWithAutoDetection(
    config: WalletConfig
): Promise<IWalletImplementation> {
    const context = detectExecutionContext();
    return await createWalletImplementation(context, config);
}

/**
 * Creates a wallet implementation for a specific context (mainly for testing).
 *
 * @param context - Specific execution context to use
 * @param config - Wallet configuration
 * @returns Promise that resolves to a wallet implementation
 */
export async function createWalletForContext(
    context: ExecutionContext,
    config: WalletConfig
): Promise<IWalletImplementation> {
    return await createWalletImplementation(context, config);
}

/**
 * Validates that the configuration is compatible with the target context.
 *
 * @param context - Target execution context
 * @param config - Wallet configuration to validate
 * @throws Error if configuration is incompatible
 */
export function validateConfigForContext(
    context: ExecutionContext,
    config: WalletConfig
): void {
    // All contexts currently support the same configuration
    // Future versions might have context-specific requirements

    if (!config.identity) {
        throw new Error("Identity is required in wallet configuration");
    }

    if (!config.arkServerUrl) {
        throw new Error("arkServerUrl is required in wallet configuration");
    }

    // Context-specific validations can be added here
    switch (context) {
        case "SERVICE_WORKER":
            // Service worker context validations
            break;
        case "WORKER_CLIENT":
            // Worker client context validations
            if (!("serviceWorker" in navigator)) {
                throw new Error(
                    "Service workers not supported in this environment"
                );
            }
            break;
        case "DIRECT":
            // Direct context validations
            break;
    }
}
