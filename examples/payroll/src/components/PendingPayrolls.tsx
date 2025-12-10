import { useState, useEffect } from "react";
import type { PayrollBatch, WalletBalance } from "../types";
import { formatAmount } from "../utils/csv";
import { payrollService } from "../services/payroll";

interface PayrollCardProps {
  batch: PayrollBatch;
  onExecute: (batchId: string) => void;
  onDelete: (batchId: string) => void;
  onReset: (batchId: string) => void;
}

function PayrollCard({ batch, onExecute, onDelete, onReset }: PayrollCardProps) {
  const [expanded, setExpanded] = useState(false);

  const statusColors: Record<string, string> = {
    draft: "#6b7280",
    pending: "#f59e0b",
    approved: "#3b82f6",
    executed: "#10b981",
    failed: "#ef4444",
  };

  return (
    <div className={`payroll-card status-${batch.status}`}>
      <div className="card-header" onClick={() => setExpanded(!expanded)}>
        <div className="card-info">
          <h3>{batch.name}</h3>
          <span className="card-meta">
            {batch.recipients.length} recipients | Created{" "}
            {batch.createdAt.toLocaleDateString()}
          </span>
        </div>
        <div className="card-status">
          <span
            className="status-badge"
            style={{ backgroundColor: statusColors[batch.status] }}
          >
            {batch.status}
          </span>
          <strong className="card-amount">{formatAmount(batch.totalAmount)}</strong>
        </div>
      </div>

      {expanded && (
        <div className="card-details">
          <table className="recipients-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Address</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {batch.recipients.map((r) => (
                <tr key={r.id}>
                  <td>{r.name || "-"}</td>
                  <td className="address">{r.address}</td>
                  <td>{formatAmount(r.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {batch.arkTxId && (
            <div className="tx-info">
              <strong>Transaction ID:</strong>{" "}
              <code>{batch.arkTxId}</code>
            </div>
          )}

          {batch.errorMessage && (
            <div className="error-info">
              <strong>Error:</strong> {batch.errorMessage}
            </div>
          )}

          <div className="card-actions">
            {batch.status === "pending" && (
              <>
                <button
                  className="btn-execute"
                  onClick={() => onExecute(batch.id)}
                >
                  Execute Payroll
                </button>
                <button
                  className="btn-delete"
                  onClick={() => onDelete(batch.id)}
                >
                  Delete
                </button>
              </>
            )}
            {batch.status === "failed" && (
              <button className="btn-reset" onClick={() => onReset(batch.id)}>
                Retry
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface ExecuteModalProps {
  batch: PayrollBatch;
  onClose: () => void;
  onExecuted: () => void;
}

function ExecuteModal({ batch, onClose, onExecuted }: ExecuteModalProps) {
  const [privateKey, setPrivateKey] = useState("");
  const [isExecuting, setIsExecuting] = useState(false);
  const [isCheckingBalance, setIsCheckingBalance] = useState(false);
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const checkBalance = async () => {
    if (!privateKey || privateKey.length < 64) {
      setError("Please enter a valid private key (64 hex characters)");
      return;
    }

    setIsCheckingBalance(true);
    setError(null);

    try {
      const [bal, addr] = await Promise.all([
        payrollService.getWalletBalance(privateKey),
        payrollService.getWalletAddress(privateKey),
      ]);
      setBalance(bal);
      setWalletAddress(addr);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to check balance");
    } finally {
      setIsCheckingBalance(false);
    }
  };

  const handleExecute = async () => {
    if (!privateKey) {
      setError("Please enter your private key");
      return;
    }

    setIsExecuting(true);
    setError(null);

    try {
      await payrollService.executePayroll({
        payrollId: batch.id,
        privateKey,
      });
      onExecuted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to execute payroll");
      setIsExecuting(false);
    }
  };

  const sufficientBalance = balance && balance.available >= batch.totalAmount;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Execute Payroll: {batch.name}</h3>
          <button className="btn-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="modal-body">
          <div className="payroll-summary">
            <div className="summary-row">
              <span>Recipients:</span>
              <strong>{batch.recipients.length}</strong>
            </div>
            <div className="summary-row">
              <span>Total Amount:</span>
              <strong>{formatAmount(batch.totalAmount)}</strong>
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="private-key">Admin Private Key (hex)</label>
            <input
              id="private-key"
              type="password"
              placeholder="Enter your private key..."
              value={privateKey}
              onChange={(e) => {
                setPrivateKey(e.target.value);
                setBalance(null);
                setWalletAddress(null);
              }}
              className="input-key"
            />
            <p className="input-hint">
              Your private key is used locally to sign the transaction and is never transmitted.
            </p>
          </div>

          {!balance && (
            <button
              className="btn-check-balance"
              onClick={checkBalance}
              disabled={isCheckingBalance || !privateKey}
            >
              {isCheckingBalance ? "Checking..." : "Check Balance"}
            </button>
          )}

          {balance && (
            <div className="balance-info">
              <h4>Wallet Balance</h4>
              {walletAddress && (
                <div className="wallet-address">
                  <span>Address:</span>
                  <code>{walletAddress}</code>
                </div>
              )}
              <div className="balance-grid">
                <div className="balance-item">
                  <span>Available:</span>
                  <strong className={sufficientBalance ? "sufficient" : "insufficient"}>
                    {formatAmount(balance.available)}
                  </strong>
                </div>
                <div className="balance-item">
                  <span>Settled:</span>
                  <span>{formatAmount(balance.settled)}</span>
                </div>
                <div className="balance-item">
                  <span>Preconfirmed:</span>
                  <span>{formatAmount(balance.preconfirmed)}</span>
                </div>
                <div className="balance-item">
                  <span>Required:</span>
                  <strong>{formatAmount(batch.totalAmount)}</strong>
                </div>
              </div>

              {!sufficientBalance && (
                <div className="insufficient-warning">
                  Insufficient balance. You need {formatAmount(batch.totalAmount - balance.available)}{" "}
                  more to execute this payroll.
                </div>
              )}
            </div>
          )}

          {error && <div className="error-message">{error}</div>}
        </div>

        <div className="modal-footer">
          <button className="btn-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-confirm"
            onClick={handleExecute}
            disabled={isExecuting || !balance || !sufficientBalance}
          >
            {isExecuting ? "Executing..." : "Sign & Execute"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface PendingPayrollsProps {
  refreshKey?: number;
}

export function PendingPayrolls({ refreshKey }: PendingPayrollsProps) {
  const [payrolls, setPayrolls] = useState<PayrollBatch[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<PayrollBatch | null>(null);
  const [filter, setFilter] = useState<"all" | "pending" | "executed" | "failed">("all");

  const loadPayrolls = () => {
    const all = payrollService.getAllPayrolls();
    setPayrolls(all);
  };

  useEffect(() => {
    loadPayrolls();
  }, [refreshKey]);

  const filteredPayrolls = payrolls.filter((p) => {
    if (filter === "all") return true;
    return p.status === filter;
  });

  const handleDelete = (batchId: string) => {
    if (confirm("Are you sure you want to delete this payroll?")) {
      payrollService.deletePayroll(batchId);
      loadPayrolls();
    }
  };

  const handleReset = (batchId: string) => {
    payrollService.resetPayroll(batchId);
    loadPayrolls();
  };

  const handleExecuted = () => {
    setSelectedBatch(null);
    loadPayrolls();
  };

  const stats = {
    total: payrolls.length,
    pending: payrolls.filter((p) => p.status === "pending").length,
    executed: payrolls.filter((p) => p.status === "executed").length,
    failed: payrolls.filter((p) => p.status === "failed").length,
    totalAmount: payrolls
      .filter((p) => p.status === "pending")
      .reduce((sum, p) => sum + p.totalAmount, 0),
  };

  return (
    <div className="pending-payrolls">
      <div className="section-header">
        <h2>Payroll Management</h2>
        <div className="stats">
          <span className="stat">
            <strong>{stats.pending}</strong> pending
          </span>
          <span className="stat">
            <strong>{stats.executed}</strong> executed
          </span>
          {stats.pending > 0 && (
            <span className="stat total">
              <strong>{formatAmount(stats.totalAmount)}</strong> to pay
            </span>
          )}
        </div>
      </div>

      <div className="filter-tabs">
        <button
          className={filter === "all" ? "active" : ""}
          onClick={() => setFilter("all")}
        >
          All ({stats.total})
        </button>
        <button
          className={filter === "pending" ? "active" : ""}
          onClick={() => setFilter("pending")}
        >
          Pending ({stats.pending})
        </button>
        <button
          className={filter === "executed" ? "active" : ""}
          onClick={() => setFilter("executed")}
        >
          Executed ({stats.executed})
        </button>
        <button
          className={filter === "failed" ? "active" : ""}
          onClick={() => setFilter("failed")}
        >
          Failed ({stats.failed})
        </button>
      </div>

      {filteredPayrolls.length === 0 ? (
        <div className="empty-state">
          {filter === "all"
            ? "No payrolls yet. Create one using the form above."
            : `No ${filter} payrolls.`}
        </div>
      ) : (
        <div className="payroll-list">
          {filteredPayrolls.map((batch) => (
            <PayrollCard
              key={batch.id}
              batch={batch}
              onExecute={(id) => setSelectedBatch(payrolls.find((p) => p.id === id) || null)}
              onDelete={handleDelete}
              onReset={handleReset}
            />
          ))}
        </div>
      )}

      {selectedBatch && (
        <ExecuteModal
          batch={selectedBatch}
          onClose={() => setSelectedBatch(null)}
          onExecuted={handleExecuted}
        />
      )}
    </div>
  );
}
