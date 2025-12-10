/**
 * Represents a single recipient in a payroll transaction
 */
export interface PayrollRecipient {
  id: string;
  address: string;
  amount: number;
  name?: string;
}

/**
 * Status of a payroll transaction
 */
export type PayrollStatus = "draft" | "pending" | "approved" | "executed" | "failed";

/**
 * Represents a payroll batch that can contain multiple recipients
 */
export interface PayrollBatch {
  id: string;
  name: string;
  recipients: PayrollRecipient[];
  totalAmount: number;
  status: PayrollStatus;
  createdAt: Date;
  createdBy: string;
  approvedAt?: Date;
  approvedBy?: string;
  executedAt?: Date;
  arkTxId?: string;
  errorMessage?: string;
}

/**
 * Parameters for creating a new payroll batch
 */
export interface CreatePayrollParams {
  name: string;
  recipients: Omit<PayrollRecipient, "id">[];
}

/**
 * Parameters for executing a payroll (admin action)
 */
export interface ExecutePayrollParams {
  payrollId: string;
  privateKey: string;
}

/**
 * Funding options for payroll
 */
export type FundingSource = "arkade_balance" | "usdt_ethereum";

/**
 * Parameters for funding payroll via Lendaswap
 */
export interface FundPayrollParams {
  payrollId: string;
  source: FundingSource;
  ethereumAddress?: string;
}

/**
 * Result of parsing a CSV file
 */
export interface CsvParseResult {
  recipients: Omit<PayrollRecipient, "id">[];
  errors: string[];
}

/**
 * Network configuration
 */
export interface NetworkConfig {
  arkServerUrl: string;
  indexerUrl: string;
  esploraUrl: string;
  lendaswapUrl: string;
  network: "bitcoin" | "testnet" | "regtest";
}

/**
 * Wallet balance information
 */
export interface WalletBalance {
  boarding: {
    confirmed: number;
    unconfirmed: number;
    total: number;
  };
  settled: number;
  preconfirmed: number;
  available: number;
  recoverable: number;
  total: number;
}

/**
 * User roles in the payroll system
 */
export type UserRole = "assistant" | "admin";
