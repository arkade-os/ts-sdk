import { useState } from "react";
import {
    lendaswapService,
    type SwapQuote,
    type SwapOrder,
} from "../services/lendaswap";
import { formatAmount } from "../utils/csv";

interface FundingPanelProps {
    arkadeAddress: string;
    requiredAmount: number;
    onFunded?: () => void;
}

export function FundingPanel({
    arkadeAddress,
    requiredAmount,
    onFunded,
}: FundingPanelProps) {
    const [usdtAmount, setUsdtAmount] = useState("");
    const [quote, setQuote] = useState<SwapQuote | null>(null);
    const [order, setOrder] = useState<SwapOrder | null>(null);
    const [txHash, setTxHash] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [step, setStep] = useState<
        "quote" | "deposit" | "claim" | "complete"
    >("quote");

    // BTC price approximation for UI hints
    const btcPriceUsd = 100_000;
    const requiredUsd = (requiredAmount / 100_000_000) * btcPriceUsd;

    const handleGetQuote = async () => {
        if (!usdtAmount || parseFloat(usdtAmount) <= 0) {
            setError("Please enter a valid USDT amount");
            return;
        }

        setIsLoading(true);
        setError(null);

        try {
            // Convert USDT to smallest units (6 decimals)
            const amountSmallest = BigInt(
                Math.floor(parseFloat(usdtAmount) * 1_000_000)
            );
            const quoteResult = await lendaswapService.getQuote(amountSmallest);
            setQuote(quoteResult);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to get quote");
        } finally {
            setIsLoading(false);
        }
    };

    const handleCreateOrder = async () => {
        if (!quote) return;

        setIsLoading(true);
        setError(null);

        try {
            const orderResult = await lendaswapService.createSwapOrder(
                quote.sourceAmount,
                arkadeAddress
            );
            setOrder(orderResult);
            setStep("deposit");
        } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to create order");
        } finally {
            setIsLoading(false);
        }
    };

    const handleConfirmDeposit = async () => {
        if (!order || !txHash) {
            setError("Please enter the Ethereum transaction hash");
            return;
        }

        setIsLoading(true);
        setError(null);

        try {
            await lendaswapService.confirmDeposit(order.swapId, txHash);
            setStep("claim");
        } catch (e) {
            setError(
                e instanceof Error ? e.message : "Failed to confirm deposit"
            );
        } finally {
            setIsLoading(false);
        }
    };

    const handleClaim = async () => {
        if (!order) return;

        setIsLoading(true);
        setError(null);

        try {
            await lendaswapService.claimOnArkade(order.swapId);
            setStep("complete");
            onFunded?.();
        } catch (e) {
            setError(
                e instanceof Error ? e.message : "Failed to claim on Arkade"
            );
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="funding-panel">
            <h3>Fund via USDT (Ethereum)</h3>
            <p className="description">
                Swap USDT from Ethereum to BTC on Arkade using Lendaswap.
            </p>

            {step === "quote" && (
                <div className="step-content">
                    <div className="funding-hint">
                        <span>Required for payroll:</span>
                        <strong>{formatAmount(requiredAmount)}</strong>
                        <span className="usd-equiv">
                            (~${requiredUsd.toFixed(2)} USD)
                        </span>
                    </div>

                    <div className="form-group">
                        <label htmlFor="usdt-amount">USDT Amount</label>
                        <input
                            id="usdt-amount"
                            type="number"
                            placeholder="Enter USDT amount"
                            value={usdtAmount}
                            onChange={(e) => {
                                setUsdtAmount(e.target.value);
                                setQuote(null);
                            }}
                            min="10"
                            step="0.01"
                        />
                    </div>

                    <button
                        className="btn-primary"
                        onClick={handleGetQuote}
                        disabled={isLoading || !usdtAmount}
                    >
                        {isLoading ? "Getting Quote..." : "Get Quote"}
                    </button>

                    {quote && (
                        <div className="quote-result">
                            <h4>Swap Quote</h4>
                            <div className="quote-grid">
                                <div className="quote-item">
                                    <span>You send:</span>
                                    <strong>
                                        $
                                        {(
                                            Number(quote.sourceAmount) /
                                            1_000_000
                                        ).toFixed(2)}{" "}
                                        USDT
                                    </strong>
                                </div>
                                <div className="quote-item">
                                    <span>You receive:</span>
                                    <strong>
                                        {formatAmount(
                                            Number(quote.targetAmount)
                                        )}
                                    </strong>
                                </div>
                                <div className="quote-item">
                                    <span>Protocol fee:</span>
                                    <span>
                                        {formatAmount(
                                            Number(quote.protocolFee)
                                        )}
                                    </span>
                                </div>
                                <div className="quote-item">
                                    <span>Expires:</span>
                                    <span>
                                        {quote.expiresAt.toLocaleTimeString()}
                                    </span>
                                </div>
                            </div>

                            <button
                                className="btn-primary"
                                onClick={handleCreateOrder}
                                disabled={isLoading}
                            >
                                {isLoading
                                    ? "Creating Order..."
                                    : "Create Swap Order"}
                            </button>
                        </div>
                    )}
                </div>
            )}

            {step === "deposit" && order && (
                <div className="step-content">
                    <h4>Step 2: Deposit USDT on Ethereum</h4>
                    <p>
                        Send your USDT to the HTLC contract using your Ethereum
                        wallet (MetaMask, etc).
                    </p>

                    <div className="deposit-instructions">
                        <div className="instruction-item">
                            <span>Contract Address:</span>
                            <code>{order.contractAddress}</code>
                        </div>
                        <div className="instruction-item">
                            <span>Amount:</span>
                            <strong>
                                $
                                {(
                                    Number(order.sourceAmount) / 1_000_000
                                ).toFixed(2)}{" "}
                                USDT
                            </strong>
                        </div>
                        <div className="instruction-item">
                            <span>Hash Lock:</span>
                            <code className="small">{order.hashLock}</code>
                        </div>
                        <div className="instruction-item">
                            <span>Timelock:</span>
                            <span>
                                {new Date(
                                    order.timelock * 1000
                                ).toLocaleString()}
                            </span>
                        </div>
                    </div>

                    <div className="form-group">
                        <label htmlFor="tx-hash">
                            Ethereum Transaction Hash
                        </label>
                        <input
                            id="tx-hash"
                            type="text"
                            placeholder="0x..."
                            value={txHash}
                            onChange={(e) => setTxHash(e.target.value)}
                        />
                    </div>

                    <button
                        className="btn-primary"
                        onClick={handleConfirmDeposit}
                        disabled={isLoading || !txHash}
                    >
                        {isLoading ? "Confirming..." : "Confirm Deposit"}
                    </button>
                </div>
            )}

            {step === "claim" && (
                <div className="step-content">
                    <h4>Step 3: Claim BTC on Arkade</h4>
                    <p>
                        Your USDT deposit has been confirmed. Click below to
                        claim your BTC on Arkade.
                    </p>

                    <div className="claim-info">
                        <span>Destination:</span>
                        <code>{arkadeAddress}</code>
                    </div>

                    <button
                        className="btn-primary"
                        onClick={handleClaim}
                        disabled={isLoading}
                    >
                        {isLoading ? "Claiming..." : "Claim BTC on Arkade"}
                    </button>
                </div>
            )}

            {step === "complete" && (
                <div className="step-content success">
                    <h4>Swap Complete!</h4>
                    <p>Your BTC has been credited to your Arkade wallet.</p>
                    <button
                        className="btn-secondary"
                        onClick={() => setStep("quote")}
                    >
                        Make Another Swap
                    </button>
                </div>
            )}

            {error && <div className="error-message">{error}</div>}
        </div>
    );
}
