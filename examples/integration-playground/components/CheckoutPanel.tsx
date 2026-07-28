"use client";

import { Checkout } from "@arkade-os/checkout";
import { useState } from "react";

export function CheckoutPanel() {
    const [id, setId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function create() {
        setError(null);
        try {
            const res = await fetch("/api/checkout/create", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ amount: 1000, description: "playground test payment" }),
            });
            const body = await res.json();
            if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
            setId(body.id);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }

    return (
        <section>
            <h2>@arkade-os/checkout</h2>
            <p>
                Route handlers are mounted at <code>/api/checkout</code> from this package&apos;s{" "}
                <code>./server/route</code> subpath export. Server flows need
                <code> ARKADE_PRIVATE_KEY_HEX</code> set — see the package README.
            </p>
            <button onClick={create}>create checkout</button>
            {error ? (
                <pre style={{ background: "#f4f4f4", padding: 12, whiteSpace: "pre-wrap" }}>
                    error: {error}
                </pre>
            ) : null}
            {id ? <Checkout id={id} /> : null}
        </section>
    );
}
