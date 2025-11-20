import { useState, useCallback } from "react";
import ArkWallet from "./ArkWallet.js";

const wallet = new ArkWallet();

function App() {
    const [walletInfo, setWalletInfo] = useState(null);
    const [loading, setLoading] = useState(false);
    const [statusMessages, setStatusMessages] = useState([]);
    const [recipient, setRecipient] = useState("");
    const [amount, setAmount] = useState("");
    const [balance, setBalance] = useState(null);
    const [vtxos, setVtxos] = useState([]);
    const [boardingUtxos, setBoardingUtxos] = useState([]);
    const [transactionResult, setTransactionResult] = useState("");

    const addStatus = useCallback((message, type = "info") => {
        const timestamp = new Date().toLocaleTimeString();
        setStatusMessages((prev) => [...prev, { message, type, timestamp }]);
    }, []);

    const clearStatus = useCallback(() => {
        setStatusMessages([]);
    }, []);

    const connectWallet = async () => {
        try {
            setLoading(true);
            clearStatus();
            addStatus("Connecting to MetaMask Snap...", "info");

            const info = await wallet.connect();
            setWalletInfo(info);

            addStatus("Wallet connected successfully!", "success");
            addStatus(`Arkade address: ${info.arkAddress}`, "success");

            // Load additional wallet data
            await loadWalletData();
        } catch (error) {
            addStatus(`Connection failed: ${error.message}`, "error");
            setWalletInfo(null);
        } finally {
            setLoading(false);
        }
    };

    const loadWalletData = async () => {
        try {
            addStatus("Loading wallet data...", "info");

            const [walletBalance, walletVtxos, walletBoardingUtxos] =
                await Promise.all([
                    wallet.getBalance(),
                    wallet.getVtxos(),
                    wallet.getBoardingUtxos(),
                ]);

            setBalance(walletBalance);
            setVtxos(walletVtxos);
            setBoardingUtxos(walletBoardingUtxos);

            addStatus(
                `Balance loaded: ${walletBalance.total} sats total`,
                "success"
            );
            addStatus(
                `Available: ${walletBalance.available} sats, Boarding: ${walletBalance.boarding.total} sats`,
                "info"
            );
            addStatus(
                `Found ${walletVtxos.length} VTXOs and ${walletBoardingUtxos.length} boarding UTXOs`,
                "info"
            );
        } catch (error) {
            addStatus(`Failed to load wallet data: ${error.message}`, "error");
        }
    };

    const sendBitcoin = async () => {
        if (!walletInfo || !recipient || !amount) return;

        try {
            setLoading(true);
            clearStatus();
            addStatus("Sending Bitcoin via Arkade...", "info");

            const amountSats = parseInt(amount);

            addStatus("Submitting transaction to Arkade server...", "info");
            const arkTxid = await wallet.sendBitcoin(recipient, amountSats);

            setTransactionResult(arkTxid);
            addStatus("Transaction submitted successfully!", "success");
            addStatus(`Arkade Transaction ID: ${arkTxid}`, "success");

            // Refresh wallet data
            await loadWalletData();
        } catch (error) {
            addStatus(`Transaction failed: ${error.message}`, "error");
        } finally {
            setLoading(false);
        }
    };

    const settleToOnchain = async () => {
        if (!walletInfo) return;

        try {
            setLoading(true);
            clearStatus();
            addStatus("Starting settlement process...", "info");

            addStatus("Settling all funds to offchain address...", "info");
            const result = await wallet.settle();

            setTransactionResult(result.txid);
            addStatus("Settlement completed successfully!", "success");
            addStatus(`Settlement Transaction ID: ${result.txid}`, "success");
            addStatus(
                `Processed ${result.events.length} settlement events`,
                "info"
            );

            // Refresh wallet data
            await loadWalletData();
        } catch (error) {
            addStatus(`Settlement failed: ${error.message}`, "error");
        } finally {
            setLoading(false);
        }
    };

    const debugWallet = () => {
        const debugInfo = wallet.getDebugInfo();
        clearStatus();
        addStatus("=== Debug Information ===", "info");
        addStatus(`Connected: ${debugInfo.connected}`, "info");
        addStatus(`Has Wallet: ${debugInfo.hasWallet}`, "info");
        addStatus(`Has Identity: ${debugInfo.hasIdentity}`, "info");
        addStatus(`Arkade Server: ${debugInfo.arkServerUrl}`, "info");
        addStatus(`Esplora: ${debugInfo.esploraUrl}`, "info");
        addStatus(`Snap ID: ${debugInfo.snapId}`, "info");

        if (debugInfo.hasMetaMask) {
            addStatus("✅ MetaMask detected!", "success");
        } else {
            addStatus("❌ MetaMask not found", "error");
            addStatus("💡 Install MetaMask extension and refresh", "info");
        }
    };

    const isFormValid =
        walletInfo && recipient.trim() && amount && parseInt(amount) > 0;

    return (
        <div className="container">
            <div className="header">
                <h1>👾 Arkade x 🦊 MetaMask Snap</h1>
                <p>
                    Connect your MetaMask Snap to enter Arkade
                </p>
            </div>

            <div className="content">
                {/* Connection Section */}
                <div className="section">
                    <h2>Wallet Connection</h2>
                    <button
                        className="button"
                        onClick={connectWallet}
                        disabled={loading}
                    >
                        {loading
                            ? "Connecting..."
                            : walletInfo
                              ? "Connected ✓"
                              : "Connect MetaMask Snap"}
                    </button>

                    <button
                        className="button secondary"
                        onClick={debugWallet}
                        disabled={loading}
                    >
                        Debug Snap Detection
                    </button>
                </div>

                {/* Wallet Info */}
                {walletInfo && (
                    <div className="section">
                        <h2>Wallet Information</h2>
                        <div className="info-grid">
                            <div className="info-item">
                                <label>Taproot Address</label>
                                <span>{walletInfo.taprootAddress}</span>
                            </div>
                            <div className="info-item">
                                <label>Arkade Address</label>
                                <span>{walletInfo.arkAddress}</span>
                            </div>
                            <div className="info-item">
                                <label>User Public Key</label>
                                <span>{walletInfo.userPubKey}</span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Balance Section */}
                {balance && (
                    <div className="section">
                        <h2>Wallet Balance</h2>
                        <div className="info-grid">
                            <div className="info-item">
                                <label>Available Balance</label>
                                <span>{balance.available} sats</span>
                            </div>
                            <div className="info-item">
                                <label>Settled Balance</label>
                                <span>{balance.settled} sats</span>
                            </div>
                            <div className="info-item">
                                <label>Preconfirmed Balance</label>
                                <span>{balance.preconfirmed} sats</span>
                            </div>
                        </div>
                        <div className="info-grid">
                            <div className="info-item">
                                <label>Boarding Balance</label>
                                <span>{balance.boarding.total} sats</span>
                            </div>
                            <div className="info-item">
                                <label>Recoverable Balance</label>
                                <span>{balance.recoverable} sats</span>
                            </div>
                            <div className="info-item">
                                <label>Total Balance</label>
                                <span>{balance.total} sats</span>
                            </div>
                        </div>
                        <div className="info-grid">
                            <div className="info-item">
                                <label>VTXOs</label>
                                <span>{vtxos.length} available</span>
                            </div>
                            <div className="info-item">
                                <label>Boarding UTXOs</label>
                                <span>{boardingUtxos.length} available</span>
                            </div>
                        </div>
                        <button
                            className="button secondary"
                            onClick={loadWalletData}
                            disabled={loading}
                        >
                            Refresh Balance
                        </button>
                    </div>
                )}

                {/* Transaction Section */}
                {walletInfo && (
                    <div className="section">
                        <h2>Send Bitcoin (Arkade)</h2>
                        <div className="input-group">
                            <label>Recipient Arkade Address</label>
                            <input
                                type="text"
                                value={recipient}
                                onChange={(e) => setRecipient(e.target.value)}
                                placeholder="Enter Arkade address (tark...)..."
                                disabled={loading}
                            />
                        </div>

                        <div className="input-group">
                            <label>Amount (satoshis)</label>
                            <input
                                type="number"
                                value={amount}
                                onChange={(e) => setAmount(e.target.value)}
                                placeholder="Enter amount in satoshis..."
                                disabled={loading}
                            />
                        </div>

                        <button
                            className="button"
                            onClick={sendBitcoin}
                            disabled={!isFormValid || loading}
                        >
                            {loading ? "Sending..." : "Send Bitcoin via Arkade"}
                        </button>
                    </div>
                )}

                {/* Settlement Section */}
                {walletInfo && (
                    <div className="section">
                        <h2>Settlement</h2>
                        <p
                            style={{
                                fontSize: "0.9rem",
                                color: "#666",
                                marginBottom: "15px",
                            }}
                        >
                            Settle all your funds (boarding UTXOs + VTXOs) to
                            your offchain Arkade address.
                        </p>
                        <button
                            className="button secondary"
                            onClick={settleToOnchain}
                            disabled={loading}
                        >
                            {loading ? "Settling..." : "Settle All Funds"}
                        </button>
                    </div>
                )}

                {/* Transaction Result */}
                {transactionResult && (
                    <div className="section">
                        <h2>Transaction Result</h2>
                        <div className="info-item">
                            <label>Transaction ID</label>
                            <span
                                style={{
                                    fontFamily: "monospace",
                                    fontSize: "0.9rem",
                                }}
                            >
                                {transactionResult}
                            </span>
                        </div>
                        <p
                            style={{
                                fontSize: "0.9rem",
                                color: "#666",
                                marginTop: "10px",
                            }}
                        >
                            Your transaction has been submitted to the Arkade
                            server and will be processed in the next batch.
                        </p>
                    </div>
                )}

                {/* Status Log */}
                <div className="section">
                    <h2>Status Log</h2>
                    <div className="status-log">
                        {statusMessages.length === 0 ? (
                            <div className="status-message info">
                                <span className="timestamp">Ready</span>
                                Arkade Wallet Demo - Real Bitcoin transactions via
                                Arkade using MetaMask Snap
                            </div>
                        ) : (
                            statusMessages.map((msg, index) => (
                                <div
                                    key={index}
                                    className={`status-message ${msg.type}`}
                                >
                                    <span className="timestamp">
                                        {msg.timestamp}
                                    </span>
                                    {msg.message}
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default App;
