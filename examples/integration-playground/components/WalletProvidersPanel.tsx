"use client";

import {
    LeatherIdentity,
    OkxIdentity,
    PhantomIdentity,
    UnisatIdentity,
    type BrowserWalletIdentity,
} from "@arkade-os/wallet-providers";
import { hex } from "@scure/base";
import { useState } from "react";

// Each provider exposes the same Identity constructor shape —
// (publicKey: Uint8Array, address: string, provider) — but a different discovery
// call. The connect sequences below are taken from each provider's own @example
// block in packages/wallet-providers/src/providers/*.ts.
const CONNECTORS: Record<string, () => Promise<BrowserWalletIdentity>> = {
    async unisat() {
        const injected = (globalThis as Record<string, any>).unisat;
        if (!injected) throw new Error("window.unisat not found — is UniSat installed?");
        const accounts: string[] = await injected.requestAccounts();
        const publicKey: string = await injected.getPublicKey();
        return new UnisatIdentity(hex.decode(publicKey), accounts[0], injected);
    },

    async okx() {
        const injected = (globalThis as Record<string, any>).okxwallet?.bitcoin;
        if (!injected) throw new Error("window.okxwallet.bitcoin not found — is OKX installed?");
        const { address, publicKey } = await injected.connect();
        return new OkxIdentity(hex.decode(publicKey), address, injected);
    },

    async leather() {
        const injected = (globalThis as Record<string, any>).LeatherProvider;
        if (!injected) throw new Error("window.LeatherProvider not found — is Leather installed?");
        const resp = await injected.request("getAddresses");
        const p2tr = resp.result.addresses.find((a: { type: string }) => a.type === "p2tr");
        if (!p2tr) throw new Error("Leather returned no p2tr address");
        return new LeatherIdentity(hex.decode(p2tr.publicKey), p2tr.address, injected);
    },

    async phantom() {
        const injected = (globalThis as Record<string, any>).phantom?.bitcoin;
        if (!injected) throw new Error("window.phantom.bitcoin not found — is Phantom installed?");
        const accounts = await injected.requestAccounts();
        const p2tr = accounts.find((a: { addressType: string }) => a.addressType === "p2tr");
        if (!p2tr) throw new Error("Phantom returned no p2tr address");
        return new PhantomIdentity(hex.decode(p2tr.publicKey), p2tr.address, injected);
    },
};

export function WalletProvidersPanel() {
    const [status, setStatus] = useState("idle");

    async function connect(name: string) {
        setStatus(`connecting to ${name}...`);
        try {
            const identity = await CONNECTORS[name]();
            const xOnly = await identity.xOnlyPublicKey();
            setStatus(
                [
                    `provider: ${name}`,
                    `address:  ${identity.getAddress()}`,
                    `x-only:   ${hex.encode(xOnly)}`,
                ].join("\n"),
            );
        } catch (error) {
            setStatus(`error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return (
        <section>
            <h2>@arkade-os/wallet-providers</h2>
            <p>
                Builds an SDK <code>Identity</code> from an injected browser wallet. Each button
                resolves a different subpath export.
            </p>
            {Object.keys(CONNECTORS).map((name) => (
                <button key={name} onClick={() => connect(name)} style={{ marginRight: 8 }}>
                    {name}
                </button>
            ))}
            <pre style={{ background: "#f4f4f4", padding: 12, whiteSpace: "pre-wrap" }}>
                {status}
            </pre>
        </section>
    );
}
