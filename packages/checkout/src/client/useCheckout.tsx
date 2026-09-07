"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface CheckoutMetadata {
    type?: string;
    successUrl?: string;
    [key: string]: any;
}

interface CheckoutParams {
    title: string;
    description: string;
    amount: number;
    currency: "USD" | "BTC" | "SAT";
    metadata?: CheckoutMetadata;
}

export function useCheckout() {
    const router = useRouter();
    const [isNavigating, setIsNavigating] = useState(false);

    const navigate = async (params: CheckoutParams) => {
        setIsNavigating(true);

        try {
            // Convert amount to sats if needed
            let amountSats = params.amount;
            if (params.currency === "USD") {
                // Fetch BTC price and convert
                const res = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot");
                const { data } = await res.json();
                const btcPrice = parseFloat(data.amount);
                amountSats = Math.ceil((params.amount / btcPrice) * 100_000_000);
            } else if (params.currency === "BTC") {
                amountSats = Math.ceil(params.amount * 100_000_000);
            }

            // Create checkout via unified API
            const response = await fetch("/api/arkade/create", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    title: params.title,
                    description: params.description,
                    amountSats,
                    metadata: params.metadata,
                }),
            });

            const { checkoutId } = await response.json();

            // Navigate to hosted checkout page
            router.push(`/checkout/${checkoutId}`);
        } catch (error) {
            console.error("Checkout creation failed:", error);
            throw error;
        } finally {
            setIsNavigating(false);
        }
    };

    return { navigate, isNavigating };
}
