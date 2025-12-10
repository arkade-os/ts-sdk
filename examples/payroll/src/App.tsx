import { useState } from "react";
import type { PayrollBatch, UserRole } from "./types";
import { PayrollForm } from "./components/PayrollForm";
import { PendingPayrolls } from "./components/PendingPayrolls";
import { FundingPanel } from "./components/FundingPanel";
import "./App.css";

function App() {
  const [role, setRole] = useState<UserRole>("assistant");
  const [refreshKey, setRefreshKey] = useState(0);
  const [showFunding, setShowFunding] = useState(false);
  const [recentBatch, setRecentBatch] = useState<PayrollBatch | null>(null);

  const handlePayrollCreated = (batch: PayrollBatch) => {
    setRecentBatch(batch);
    setRefreshKey((k) => k + 1);
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-content">
          <h1>Arkade Payroll</h1>
          <p className="subtitle">Send payments to multiple recipients on Arkade</p>
        </div>

        <div className="role-switcher">
          <button
            className={role === "assistant" ? "active" : ""}
            onClick={() => setRole("assistant")}
          >
            Assistant
          </button>
          <button
            className={role === "admin" ? "active" : ""}
            onClick={() => setRole("admin")}
          >
            Admin
          </button>
        </div>
      </header>

      <main className="app-main">
        {role === "assistant" && (
          <div className="assistant-view">
            <PayrollForm onCreated={handlePayrollCreated} />

            {recentBatch && (
              <div className="success-message">
                Payroll "{recentBatch.name}" created successfully with{" "}
                {recentBatch.recipients.length} recipients.
                <button onClick={() => setRecentBatch(null)} className="btn-dismiss">
                  Dismiss
                </button>
              </div>
            )}

            <div className="info-box">
              <h3>How it works</h3>
              <ol>
                <li>
                  <strong>Create a payroll</strong> by adding recipients manually or importing a CSV file.
                </li>
                <li>
                  <strong>Payroll is submitted</strong> for admin approval (pending status).
                </li>
                <li>
                  <strong>Admin reviews and executes</strong> the payroll by signing with their private key.
                </li>
                <li>
                  <strong>Recipients receive</strong> BTC on Arkade as new virtual outputs (VTXOs).
                </li>
              </ol>
            </div>
          </div>
        )}

        {role === "admin" && (
          <div className="admin-view">
            <div className="admin-actions">
              <button
                className={`btn-funding ${showFunding ? "active" : ""}`}
                onClick={() => setShowFunding(!showFunding)}
              >
                {showFunding ? "Hide Funding" : "Fund Wallet"}
              </button>
            </div>

            {showFunding && (
              <FundingPanel
                arkadeAddress="ark1qexampleaddress..."
                requiredAmount={1000000}
                onFunded={() => setRefreshKey((k) => k + 1)}
              />
            )}

            <PendingPayrolls refreshKey={refreshKey} />
          </div>
        )}
      </main>

      <footer className="app-footer">
        <p>
          Built with <a href="https://github.com/arkade-os/ts-sdk">@arkade-os/sdk</a> and{" "}
          <a href="https://github.com/lendasat/lendaswap-sdk">Lendaswap SDK</a>
        </p>
      </footer>
    </div>
  );
}

export default App;
