import { NextRequest, NextResponse } from "next/server";
import { handleCreate } from "./handlers/create";
import { handleClaim } from "./handlers/claim";
import { handleStatus } from "./handlers/status";
import { handleWebhook } from "./handlers/webhook";

export async function POST(request: NextRequest) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Route to appropriate handler
    if (pathname.endsWith("/create")) {
        return handleCreate(request);
    } else if (pathname.endsWith("/claim")) {
        return handleClaim(request);
    } else if (pathname.endsWith("/webhook")) {
        return handleWebhook(request);
    }

    return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function GET(request: NextRequest) {
    const url = new URL(request.url);

    if (url.searchParams.has("id")) {
        return handleStatus(request);
    }

    return NextResponse.json({ error: "Not found" }, { status: 404 });
}
