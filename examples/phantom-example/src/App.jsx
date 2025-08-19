import { useState } from "react";
import "./App.css";
import { OnchainWallet, networks } from "@arkade-os/sdk";
import { Transaction } from "@scure/btc-signer";

function App() {
    const [address, setAddress] = useState(null);
    const [txid, setTxid] = useState(null);

    const createAndSignTransaction = async () => {
        try {
            const provider = window.phantom.bitcoin;
            const pubkey = await provider.getPublicKey();

            const phantomIdentity = {
                xOnlyPublicKey: () => pubkey,
                sign: async (tx) => {
                    const psbtBytes = tx.toPSBT();
                    const signedPsbt = await provider.signPSBT(psbtBytes, {
                        inputsToSign: [{ index: 0, publicKey: pubkey }],
                    });
                    return Transaction.fromPSBT(signedPsbt);
                },
            };

            const wallet = new OnchainWallet(phantomIdentity, "mainnet");
            const txid = await wallet.send({
                amount: 1000,
                address: address,
            });

            setTxid(txid);
        } catch (error) {
            console.error("Error creating and signing transaction:", error);
            alert(
                "Error creating and signing transaction. See console for details."
            );
        }
    };

    const connectWallet = async () => {
        if (window.phantom && window.phantom.bitcoin) {
            try {
                const provider = window.phantom.bitcoin;
                const accounts = await provider.requestAccounts();
                setAddress(accounts[0]);
            } catch (error) {
                console.error("Error connecting to Phantom:", error);
            }
        } else {
            alert("Phantom wallet not found. Please install it.");
        }
    };

    return (
        <div className="App">
            <header className="App-header">
                <h1>Arkade SDK Phantom Example</h1>
                {address ? (
                    <div>
                        <p>Connected Address:</p>
                        <p>{address}</p>
                        <button onClick={createAndSignTransaction}>
                            Create & Sign Transaction
                        </button>
                        {txid && (
                            <div>
                                <p>Transaction ID:</p>
                                <pre>{txid}</pre>
                            </div>
                        )}
                    </div>
                ) : (
                    <button onClick={connectWallet}>Connect to Phantom</button>
                )}
            </header>
        </div>
    );
}

export default App;
