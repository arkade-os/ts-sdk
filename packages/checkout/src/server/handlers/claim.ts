import { NextRequest, NextResponse } from "next/server";
import { Wallet } from "@arkade-os/sdk";
import { ArkadeSwaps, BoltzSwapProvider } from "@arkade-os/boltz-swap";
import { getCachedPrivateKey } from "../vss";
import { getCheckout, updateCheckout } from "../storage";
import { debug } from "../log";

export const maxDuration = 300; // 5 minutes

export async function handleClaim(request: NextRequest) {
    const { checkoutId } = await request.json();
    debug("[claim] Starting claim for checkoutId:", checkoutId);

    const checkout = await getCheckout(checkoutId);
    if (!checkout) {
        console.error("[claim] Checkout not found:", checkoutId);
        return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    debug("[claim] Checkout found, status:", checkout.status);

    if (!checkout.pendingSwap) {
        console.error("[claim] No pendingSwap data in checkout:", checkoutId);
        return NextResponse.json({ error: "No pending swap found" }, { status: 400 });
    }

    debug("[claim] pendingSwap id:", checkout.pendingSwap.id);

    try {
        // Get private key from VSS
        debug("[claim] Getting private key...");
        const identity = await getCachedPrivateKey();
        debug("[claim] Creating wallet...");
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

        debug("[claim] Calling waitAndClaim...");
        const result = await arkadeLightning.waitAndClaim(checkout.pendingSwap);
        debug("[claim] waitAndClaim result:", result);

        // Update checkout status
        await updateCheckout(checkoutId, {
            status: "paid",
            txid: result.txid,
            paidAt: Date.now(),
        });

        debug("[claim] Checkout updated to paid, txid:", result.txid);
        return NextResponse.json({ status: "paid", txid: result.txid });
    } catch (error) {
        console.error("[claim] Error claiming swap:", error);
        console.error(
            "[claim] Error details:",
            JSON.stringify(error, Object.getOwnPropertyNames(error), 2),
        );
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}
