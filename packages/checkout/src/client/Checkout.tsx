"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";

interface CheckoutProps {
    id: string;
}

export function Checkout({ id }: CheckoutProps) {
    const router = useRouter();
    const [checkout, setCheckout] = useState<any>(null);
    const [qrCode, setQrCode] = useState("");
    const [status, setStatus] = useState<"pending" | "paid" | "expired">("pending");

    useEffect(() => {
        loadCheckout();
    }, [id]);

    async function loadCheckout() {
        // Fetch checkout details
        const res = await fetch(`/api/arkade/status?id=${id}`);
        const data = await res.json();
        setCheckout(data);

        // Generate QR code
        const qr = await QRCode.toDataURL(data.invoice.toUpperCase(), { width: 400 });
        setQrCode(qr);

        // Start claim process in background
        claimPayment();

        // Poll status
        pollStatus();
    }

    async function claimPayment() {
        await fetch("/api/arkade/claim", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ checkoutId: id }),
        });
    }

    function pollStatus() {
        const interval = setInterval(async () => {
            const res = await fetch(`/api/arkade/status?id=${id}`);
            const data = await res.json();

            if (data.status === "paid") {
                setStatus("paid");
                clearInterval(interval);

                // Redirect to success URL if provided
                if (checkout?.metadata?.successUrl) {
                    router.push(checkout.metadata.successUrl);
                }
            } else if (data.status === "expired") {
                setStatus("expired");
                clearInterval(interval);
            }
        }, 3000);

        // Stop after 10 minutes
        setTimeout(() => clearInterval(interval), 600000);
    }

    if (!checkout) return <div>Loading...</div>;

    if (status === "paid") {
        return (
            <div className="arkade-checkout-success">
                <h1>✓ Payment Confirmed</h1>
                <p>Thank you for your purchase</p>
            </div>
        );
    }

    if (status === "expired") {
        return (
            <div className="arkade-checkout-expired">
                <h1>Invoice Expired</h1>
                <p>Please create a new checkout</p>
            </div>
        );
    }

    return (
        <div className="arkade-checkout">
            <div className="arkade-checkout-header">
                <h1>{checkout.title}</h1>
                <p>{checkout.description}</p>
                <div className="arkade-checkout-amount">
                    {checkout.amountSats.toLocaleString()} sats
                </div>
            </div>

            <div className="arkade-checkout-qr">
                <img src={qrCode} alt="Lightning Invoice" />
            </div>

            <div className="arkade-checkout-invoice">
                <input value={checkout.invoice} readOnly />
                <button onClick={() => navigator.clipboard.writeText(checkout.invoice)}>
                    Copy Invoice
                </button>
            </div>

            <div className="arkade-checkout-status">Waiting for payment...</div>
        </div>
    );
}
