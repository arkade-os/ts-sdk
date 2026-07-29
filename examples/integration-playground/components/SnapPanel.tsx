"use client";

import { useState } from "react";

// A snap is invoked over RPC through MetaMask, never imported — which is why
// @arkade-os/snap is deliberately not a dependency of this example.
const SNAP_ID = "npm:@arkade-os/snap";

export function SnapPanel() {
    const [status, setStatus] = useState("idle");

    async function invoke() {
        setStatus("requesting...");
        try {
            const ethereum = (globalThis as Record<string, any>).ethereum;
            if (!ethereum) throw new Error("window.ethereum not found — install MetaMask Flask");

            await ethereum.request({
                method: "wallet_requestSnaps",
                params: { [SNAP_ID]: {} },
            });
            const result = await ethereum.request({
                method: "wallet_invokeSnap",
                params: { snapId: SNAP_ID, request: { method: "arkade_getPublicKey" } },
            });
            setStatus(JSON.stringify(result, null, 2));
        } catch (error) {
            setStatus(`error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return (
        <section>
            <h2>@arkade-os/snap</h2>
            <p>
                Installs the snap and calls <code>arkade_getPublicKey</code>. Requires MetaMask
                Flask. Resolves the snap from npm, so it exercises the published package rather than
                this working tree.
            </p>
            <button onClick={invoke}>install snap + arkade_getPublicKey</button>
            <pre style={{ background: "#f4f4f4", padding: 12, whiteSpace: "pre-wrap" }}>
                {status}
            </pre>
        </section>
    );
}
