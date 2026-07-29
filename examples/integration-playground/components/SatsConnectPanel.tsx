"use client";

import {
    ArkadeWalletProvider,
    useArkadeWallet,
    type ArkadeWalletProviderConfig,
} from "@arkade-os/sats-connect-react";

const config: ArkadeWalletProviderConfig<"mutinynet"> = {
    defaultNetwork: "mutinynet",
    networks: {
        mutinynet: {
            networkName: "signet",
            arkServerUrl: "https://mutinynet.arkade.sh",
            esploraUrl: "https://mutinynet.com/api",
            hasLightning: false,
            satsConnectNetwork: "Signet",
        },
    },
};

function Inner() {
    const { walletInfo, balance, isConnecting, error, connectWallet, disconnectWallet } =
        useArkadeWallet();

    return (
        <div>
            <button onClick={() => connectWallet()} disabled={isConnecting}>
                {isConnecting ? "connecting..." : "connect via Sats Connect"}
            </button>
            <button onClick={disconnectWallet} style={{ marginLeft: 8 }}>
                disconnect
            </button>
            <pre style={{ background: "#f4f4f4", padding: 12, whiteSpace: "pre-wrap" }}>
                {JSON.stringify({ walletInfo, balance, error }, null, 2)}
            </pre>
        </div>
    );
}

export function SatsConnectPanel() {
    return (
        <section>
            <h2>@arkade-os/sats-connect-react</h2>
            <p>
                React bindings over <code>@arkade-os/sats-connect</code>. Needs a Sats Connect
                wallet such as Xverse. Points at mutinynet.
            </p>
            <ArkadeWalletProvider config={config}>
                <Inner />
            </ArkadeWalletProvider>
        </section>
    );
}
