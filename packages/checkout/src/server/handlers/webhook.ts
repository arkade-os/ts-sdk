import { NextRequest, NextResponse } from "next/server";
import { getCheckout } from "../storage";
import { debug } from "../log";

/**
 * Webhook endpoint that triggers the claim process
 * This keeps the serverless function active even if the user closes the page
 */
export async function handleWebhook(request: NextRequest) {
    try {
        const { checkoutId, event } = await request.json();

        if (!checkoutId) {
            return NextResponse.json({ error: "checkoutId is required" }, { status: 400 });
        }

        // Get checkout details
        const checkout = await getCheckout(checkoutId);
        if (!checkout) {
            return NextResponse.json({ error: "Checkout not found" }, { status: 404 });
        }

        // Handle different webhook events
        switch (event) {
            case "page_closed":
                // User closed the page, trigger background claim
                await triggerBackgroundClaim(checkoutId);
                return NextResponse.json({
                    status: "accepted",
                    message: "Background claim process initiated",
                });

            case "keep_alive":
                // Heartbeat to keep function warm
                return NextResponse.json({
                    status: "alive",
                    checkoutStatus: checkout.status,
                });

            default:
                return NextResponse.json({ error: "Unknown event type" }, { status: 400 });
        }
    } catch (error) {
        console.error("Webhook error:", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Webhook processing failed" },
            { status: 500 },
        );
    }
}

/**
 * Triggers the claim process in the background by calling the claim endpoint
 */
async function triggerBackgroundClaim(checkoutId: string) {
    try {
        // Get the base URL from environment or construct it
        const baseUrl = process.env.VERCEL_URL
            ? `https://${process.env.VERCEL_URL}`
            : process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

        // Call the claim endpoint
        const response = await fetch(`${baseUrl}/api/arkade/claim`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ checkoutId }),
        });

        if (!response.ok) {
            console.error(`Background claim failed: ${response.status}`);
        }

        debug(`Background claim triggered for checkout ${checkoutId}`);
    } catch (error) {
        console.error("Failed to trigger background claim:", error);
        // Don't throw - we don't want webhook to fail if claim fails
    }
}
