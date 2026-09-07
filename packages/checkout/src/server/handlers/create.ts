import { NextRequest, NextResponse } from "next/server";
import { Wallet } from "@arkade-os/sdk";
import { ArkadeSwaps, BoltzSwapProvider } from "@arkade-os/boltz-swap";
import { getCachedPrivateKey } from "../vss";
import { setCheckout } from "../storage";

export async function handleCreate(request: NextRequest) {
    try {
        const { title, description, amountSats, metadata } = await request.json();

        // Get private key from VSS
        const identity = await getCachedPrivateKey();
        const wallet = await Wallet.create({
            identity,
            arkServerUrl: process.env.ARKADE_SERVER_URL || "https://arkade.computer",
        });

        const swapProvider = new BoltzSwapProvider({
            apiUrl: process.env.BOLTZ_API_URL || "https://api.ark.boltz.exchange",
            network: (process.env.ARKADE_NETWORK as any) || "bitcoin",
        });

        const arkadeLightning = new ArkadeSwaps({
            wallet,
            swapProvider,
        });

        // Create reverse swap
        const result = await arkadeLightning.createLightningInvoice({
            amount: amountSats,
            description: title,
        });

        // Store checkout
        const checkoutId = result.paymentHash;
        await setCheckout(checkoutId, {
            title,
            description,
            amountSats,
            metadata,
            invoice: result.invoice,
            paymentHash: result.paymentHash,
            pendingSwap: result.pendingSwap,
            expiry: result.expiry,
            status: "pending",
            createdAt: Date.now(),
        });

        return NextResponse.json({ checkoutId });
    } catch (error) {
        console.error("Error creating checkout:", error);

        // Print full error details for debugging
        if (error && typeof error === "object") {
            console.error(
                "Error details:",
                JSON.stringify(error, Object.getOwnPropertyNames(error), 2),
            );
            if ("errorData" in error) {
                console.error("Error data:", JSON.stringify((error as any).errorData, null, 2));
            }
        }

        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Failed to create checkout" },
            { status: 500 },
        );
    }
}
