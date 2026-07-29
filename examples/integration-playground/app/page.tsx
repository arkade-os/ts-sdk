import { CheckoutPanel } from "../components/CheckoutPanel";
import { SatsConnectPanel } from "../components/SatsConnectPanel";
import { SnapPanel } from "../components/SnapPanel";
import { WalletProvidersPanel } from "../components/WalletProvidersPanel";

export default function Page() {
    return (
        <main style={{ display: "grid", gap: 32, maxWidth: 760 }}>
            <header>
                <h1 style={{ marginBottom: 4 }}>Arkade integration playground</h1>
                <p style={{ marginTop: 0, color: "#555" }}>
                    One panel per ported package. This exists mainly so CI can typecheck and bundle
                    all of them together — that is what catches broken export maps and ESM/CJS
                    resolution. The wallet flows below need the matching browser extension and
                    cannot be automated.
                </p>
            </header>
            <WalletProvidersPanel />
            <SatsConnectPanel />
            <SnapPanel />
            <CheckoutPanel />
        </main>
    );
}
