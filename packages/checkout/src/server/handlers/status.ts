import { NextRequest, NextResponse } from "next/server";
import { BoltzSwapProvider } from "@arkade-os/boltz-swap";
import { getCheckout, updateCheckout } from "../storage";
import { debug } from "../log";

export async function handleStatus(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id")!;

    debug("[status] Checking checkout:", id);
    const checkout = await getCheckout(id);
    if (!checkout) {
        debug("[status] Checkout not found:", id);
        return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    debug("[status] Checkout status:", checkout.status);

    // Only query Boltz while pending and we have a swap id
    if (checkout.status !== "pending" || !checkout.pendingSwap?.id) {
        return NextResponse.json(checkout);
    }

    try {
        const swapProvider = new BoltzSwapProvider({
            apiUrl: process.env.BOLTZ_API_URL || "https://api.ark.boltz.exchange",
            network: (process.env.ARKADE_NETWORK as any) || "bitcoin",
        });

        const swapStatus = await swapProvider.getSwapStatus(checkout.pendingSwap.id);
        debug("[status] Boltz swap status:", swapStatus.status);

        const paidStatuses = [
            "invoice.paid",
            "invoice.settled",
            "transaction.claim.pending",
            "transaction.mempool",
            "transaction.confirmed",
            "transaction.claimed",
        ];
        const expiredStatuses = [
            "invoice.expired",
            "invoice.failedToPay",
            "transaction.failed",
            "transaction.lockupFailed",
            "transaction.refunded",
            "swap.expired",
        ];

        if (paidStatuses.includes(swapStatus.status)) {
            await updateCheckout(id, { status: "paid", paidAt: Date.now() });
            return NextResponse.json({ ...checkout, status: "paid" });
        }

        if (expiredStatuses.includes(swapStatus.status)) {
            await updateCheckout(id, { status: "expired" });
            return NextResponse.json({ ...checkout, status: "expired" });
        }
    } catch (error) {
        console.error("[status] Error checking Boltz status:", error);
    }

    return NextResponse.json(checkout);
}
