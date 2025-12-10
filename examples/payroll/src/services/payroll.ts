import {
    Wallet,
    SingleKey,
    RestArkProvider,
    RestIndexerProvider,
    EsploraProvider,
} from "@arkade-os/sdk";
import type {
    PayrollBatch,
    PayrollRecipient,
    CreatePayrollParams,
    ExecutePayrollParams,
    NetworkConfig,
    WalletBalance,
} from "../types";

/**
 * Generate a unique ID
 */
function generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Default network configuration for Arkade testnet
 */
export const DEFAULT_CONFIG: NetworkConfig = {
    arkServerUrl: "https://ark.arkade.computer",
    indexerUrl: "https://indexer.arkade.computer",
    esploraUrl: "https://esplora.arkade.computer",
    lendaswapUrl: "https://apilendaswap.lendasat.com",
    network: "bitcoin",
};

/**
 * Local storage key for payroll batches
 */
const STORAGE_KEY = "arkade_payroll_batches";

/**
 * ArkadePayrollService manages payroll batches and integrates with Arkade SDK
 * for transaction creation and execution
 */
export class ArkadePayrollService {
    private batches: Map<string, PayrollBatch> = new Map();
    private config: NetworkConfig;

    constructor(config: NetworkConfig = DEFAULT_CONFIG) {
        this.config = config;
        this.loadFromStorage();
    }

    /**
     * Load batches from local storage
     */
    private loadFromStorage(): void {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const parsed = JSON.parse(stored);
                for (const batch of parsed) {
                    batch.createdAt = new Date(batch.createdAt);
                    if (batch.approvedAt)
                        batch.approvedAt = new Date(batch.approvedAt);
                    if (batch.executedAt)
                        batch.executedAt = new Date(batch.executedAt);
                    this.batches.set(batch.id, batch);
                }
            }
        } catch (e) {
            console.warn("Failed to load payroll batches from storage:", e);
        }
    }

    /**
     * Save batches to local storage
     */
    private saveToStorage(): void {
        try {
            const data = Array.from(this.batches.values());
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            console.warn("Failed to save payroll batches to storage:", e);
        }
    }

    /**
     * Create a new payroll batch (Assistant action)
     * This creates a draft payroll that needs admin approval
     */
    createPayroll(
        params: CreatePayrollParams,
        createdBy: string
    ): PayrollBatch {
        const recipients: PayrollRecipient[] = params.recipients.map((r) => ({
            ...r,
            id: generateId(),
        }));

        const totalAmount = recipients.reduce((sum, r) => sum + r.amount, 0);

        const batch: PayrollBatch = {
            id: generateId(),
            name: params.name,
            recipients,
            totalAmount,
            status: "pending",
            createdAt: new Date(),
            createdBy,
        };

        this.batches.set(batch.id, batch);
        this.saveToStorage();

        return batch;
    }

    /**
     * Get a payroll batch by ID
     */
    getPayroll(id: string): PayrollBatch | undefined {
        return this.batches.get(id);
    }

    /**
     * Get all payroll batches
     */
    getAllPayrolls(): PayrollBatch[] {
        return Array.from(this.batches.values()).sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
        );
    }

    /**
     * Get pending payrolls (awaiting admin approval)
     */
    getPendingPayrolls(): PayrollBatch[] {
        return this.getAllPayrolls().filter((b) => b.status === "pending");
    }

    /**
     * Update a payroll batch recipients (only if pending)
     */
    updatePayroll(
        id: string,
        recipients: Omit<PayrollRecipient, "id">[]
    ): PayrollBatch {
        const batch = this.batches.get(id);
        if (!batch) {
            throw new Error(`Payroll ${id} not found`);
        }
        if (batch.status !== "pending") {
            throw new Error(
                `Cannot update payroll with status ${batch.status}`
            );
        }

        batch.recipients = recipients.map((r) => ({ ...r, id: generateId() }));
        batch.totalAmount = batch.recipients.reduce(
            (sum, r) => sum + r.amount,
            0
        );

        this.batches.set(id, batch);
        this.saveToStorage();

        return batch;
    }

    /**
     * Delete a payroll batch (only if pending)
     */
    deletePayroll(id: string): void {
        const batch = this.batches.get(id);
        if (!batch) {
            throw new Error(`Payroll ${id} not found`);
        }
        if (batch.status !== "pending" && batch.status !== "draft") {
            throw new Error(
                `Cannot delete payroll with status ${batch.status}`
            );
        }

        this.batches.delete(id);
        this.saveToStorage();
    }

    /**
     * Create an Arkade wallet from a private key
     */
    private async createWallet(privateKeyHex: string): Promise<Wallet> {
        const identity = SingleKey.fromHex(privateKeyHex);

        const arkProvider = new RestArkProvider(this.config.arkServerUrl);
        const indexerProvider = new RestIndexerProvider(this.config.indexerUrl);
        const onchainProvider = new EsploraProvider(this.config.esploraUrl);

        const wallet = await Wallet.create({
            identity,
            arkProvider,
            indexerProvider,
            onchainProvider,
        });

        return wallet;
    }

    /**
     * Get wallet balance for a given private key
     */
    async getWalletBalance(privateKeyHex: string): Promise<WalletBalance> {
        const wallet = await this.createWallet(privateKeyHex);
        return await wallet.getBalance();
    }

    /**
     * Get wallet address for a given private key
     */
    async getWalletAddress(privateKeyHex: string): Promise<string> {
        const wallet = await this.createWallet(privateKeyHex);
        return await wallet.getAddress();
    }

    /**
     * Execute a payroll batch (Admin action)
     * Signs and submits the transaction to Arkade
     */
    async executePayroll(params: ExecutePayrollParams): Promise<string> {
        const batch = this.batches.get(params.payrollId);
        if (!batch) {
            throw new Error(`Payroll ${params.payrollId} not found`);
        }
        if (batch.status !== "pending" && batch.status !== "approved") {
            throw new Error(
                `Cannot execute payroll with status ${batch.status}`
            );
        }

        try {
            // Create wallet from admin's private key
            const wallet = await this.createWallet(params.privateKey);

            // Check balance
            const balance = await wallet.getBalance();
            if (balance.available < batch.totalAmount) {
                throw new Error(
                    `Insufficient balance: ${balance.available} sats available, ` +
                        `${batch.totalAmount} sats required`
                );
            }

            // Prepare outputs for each recipient
            const recipients = batch.recipients.map((r) => ({
                address: r.address,
                amount: r.amount,
            }));

            // Execute batch send using wallet.settle() for multi-output support
            // For single recipient, we could use sendBitcoin, but settle handles batches better
            let arkTxId: string;

            if (recipients.length === 1) {
                // Single recipient - use sendBitcoin
                arkTxId = await wallet.sendBitcoin({
                    address: recipients[0].address,
                    amount: recipients[0].amount,
                });
            } else {
                // Multiple recipients - use settle with multiple outputs
                // Get available VTXOs
                const vtxos = await wallet.getVtxos();
                const boardingUtxos = await wallet.getBoardingUtxos();

                // Select inputs that cover the total amount
                const inputs = [...boardingUtxos, ...vtxos];

                // Create outputs array for settlement
                const outputs = recipients.map((r) => ({
                    address: r.address,
                    amount: BigInt(r.amount),
                }));

                arkTxId = await wallet.settle({
                    inputs,
                    outputs,
                });
            }

            // Update batch status
            batch.status = "executed";
            batch.executedAt = new Date();
            batch.approvedBy = "admin";
            batch.approvedAt = new Date();
            batch.arkTxId = arkTxId;

            this.batches.set(batch.id, batch);
            this.saveToStorage();

            return arkTxId;
        } catch (error) {
            // Update batch with error
            batch.status = "failed";
            batch.errorMessage =
                error instanceof Error ? error.message : String(error);

            this.batches.set(batch.id, batch);
            this.saveToStorage();

            throw error;
        }
    }

    /**
     * Approve a payroll without executing (for two-step workflow)
     */
    approvePayroll(id: string, approvedBy: string): PayrollBatch {
        const batch = this.batches.get(id);
        if (!batch) {
            throw new Error(`Payroll ${id} not found`);
        }
        if (batch.status !== "pending") {
            throw new Error(
                `Cannot approve payroll with status ${batch.status}`
            );
        }

        batch.status = "approved";
        batch.approvedAt = new Date();
        batch.approvedBy = approvedBy;

        this.batches.set(id, batch);
        this.saveToStorage();

        return batch;
    }

    /**
     * Reset a failed payroll to pending status for retry
     */
    resetPayroll(id: string): PayrollBatch {
        const batch = this.batches.get(id);
        if (!batch) {
            throw new Error(`Payroll ${id} not found`);
        }
        if (batch.status !== "failed") {
            throw new Error(`Can only reset failed payrolls`);
        }

        batch.status = "pending";
        batch.errorMessage = undefined;
        batch.approvedAt = undefined;
        batch.approvedBy = undefined;

        this.batches.set(id, batch);
        this.saveToStorage();

        return batch;
    }
}

// Export singleton instance
export const payrollService = new ArkadePayrollService();
