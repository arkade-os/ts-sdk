import { createContext, useState, useCallback, useMemo, useEffect, type ReactNode } from "react";
import { Wallet, Ramps } from "@arkade-os/sdk";
import { ArkadeSwaps, BoltzSwapProvider } from "@arkade-os/boltz-swap";
import { ArkadeWallet } from "@arkade-os/sats-connect";
import type {
    ArkadeWalletProviderConfig,
    ArkadeWalletContextType,
    WalletInfo,
    Balance,
    Transaction,
} from "./types";

const ArkadeWalletContext = createContext<ArkadeWalletContextType<string> | undefined>(undefined);

export interface ArkadeWalletProviderProps<TNetwork extends string> {
    children: ReactNode;
    config: ArkadeWalletProviderConfig<TNetwork>;
}

export function ArkadeWalletProvider<TNetwork extends string>({
    children,
    config,
}: ArkadeWalletProviderProps<TNetwork>) {
    const {
        networks,
        defaultNetwork,
        autoConnectKey = "arkade:autoConnect",
        connectMessage = "Connect to Arkade Bitcoin Layer 2 Wallet",
    } = config;

    const [wallet, setWallet] = useState<Wallet | null>(null);
    const [arkWallet, setArkWallet] = useState<ArkadeWallet | null>(null);
    const [walletInfo, setWalletInfo] = useState<WalletInfo | null>(null);
    const [balance, setBalance] = useState<Balance | null>(null);
    const [transactions, setTransactions] = useState<Transaction[]>([]);
    const [isConnecting, setIsConnecting] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [currentNetwork, setCurrentNetwork] = useState<TNetwork>(defaultNetwork);

    const currentNetworkConfig = useMemo(
        () => networks[currentNetwork],
        [networks, currentNetwork],
    );

    const fetchBalance = async (arkWalletInstance: ArkadeWallet): Promise<Balance> => {
        const bal = await arkWalletInstance.getBalance();
        const vtxos = await arkWalletInstance.getVtxos();
        const boardingUtxos = await arkWalletInstance.getBoardingUtxos();

        let onchainBalance = 0;
        for (const utxo of boardingUtxos) {
            onchainBalance += Number(utxo.value);
        }

        const vtxoList = vtxos.map((vtxo: any) => ({
            id: vtxo.txid ? `${vtxo.txid}:${vtxo.vout}` : vtxo.id,
            amount: Number(vtxo.value || vtxo.amount),
            expiry: vtxo.expiry?.median || 0,
            status: vtxo.virtualStatus?.state || "pending",
        }));

        const balanceData: Balance = {
            total: Number(bal.total) + onchainBalance,
            onchain: onchainBalance,
            offchain: Number(bal.available),
            settled: Number(bal.available),
            preconfirmed: 0,
            recoverable: Number(bal.total) - Number(bal.available),
            vtxoList,
        };

        setBalance(balanceData);
        return balanceData;
    };

    const connectWallet = useCallback(
        async (options?: { silent?: boolean }) => {
            const silent = options?.silent ?? false;
            setIsConnecting(true);
            if (!silent) {
                setError(null);
            }

            try {
                const networkConfig = networks[currentNetwork];
                const arkWalletInstance = new ArkadeWallet({
                    arkServerUrl: networkConfig.arkServerUrl,
                    esploraUrl: networkConfig.esploraUrl,
                    satsConnectNetwork: networkConfig.satsConnectNetwork,
                    connectMessage,
                });

                const info = await arkWalletInstance.connect();
                const walletInstance = arkWalletInstance.getWallet();

                if (!walletInstance) {
                    throw new Error("Failed to initialize Arkade wallet");
                }

                setArkWallet(arkWalletInstance);
                setWallet(walletInstance);
                setWalletInfo({
                    arkAddress: info.arkAddress,
                    boardingAddress: info.boardingAddress,
                    paymentAddress: info.paymentAddress,
                    ordinalsAddress: info.ordinalAddress,
                    network: currentNetwork,
                    userPubKey: info.userPubKey,
                });

                await fetchBalance(arkWalletInstance);
                if (typeof window !== "undefined") {
                    window.localStorage.setItem(autoConnectKey, "1");
                }
            } catch (err: any) {
                if (!silent) {
                    setError(err.message || "Failed to connect wallet");
                }
                setArkWallet(null);
                setWallet(null);
                setWalletInfo(null);
                setBalance(null);
            } finally {
                setIsConnecting(false);
            }
        },
        [currentNetwork, networks, autoConnectKey, connectMessage],
    );

    const disconnectWallet = useCallback(() => {
        arkWallet?.reset();
        setArkWallet(null);
        setWallet(null);
        setWalletInfo(null);
        setBalance(null);
        setTransactions([]);
        setError(null);
        if (typeof window !== "undefined") {
            window.localStorage.removeItem(autoConnectKey);
        }
    }, [arkWallet, autoConnectKey]);

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }
        if (wallet || isConnecting) {
            return;
        }
        if (window.localStorage.getItem(autoConnectKey) !== "1") {
            return;
        }
        connectWallet({ silent: true }).catch(() => {});
    }, [wallet, isConnecting, connectWallet, autoConnectKey]);

    const getBalance = useCallback(
        async (options?: { silent?: boolean }) => {
            const silent = options?.silent ?? false;
            if (!arkWallet) {
                throw new Error("Wallet not connected");
            }

            if (!silent) {
                setIsLoading(true);
                setError(null);
            }

            try {
                await fetchBalance(arkWallet);
            } catch (err: any) {
                if (!silent) {
                    setError(err.message || "Failed to fetch balance");
                }
                throw err;
            } finally {
                if (!silent) {
                    setIsLoading(false);
                }
            }
        },
        [arkWallet],
    );

    const sendBitcoin = useCallback(
        async (toAddress: string, amount: number): Promise<string> => {
            if (!arkWallet) {
                throw new Error("Wallet not connected");
            }

            setIsLoading(true);
            setError(null);

            try {
                const txid = await arkWallet.sendBitcoin(toAddress, amount);
                await fetchBalance(arkWallet);
                return txid;
            } catch (err: any) {
                setError(err.message || "Failed to send Bitcoin");
                throw err;
            } finally {
                setIsLoading(false);
            }
        },
        [arkWallet],
    );

    const getTransactionHistory = useCallback(async () => {
        if (!wallet) {
            throw new Error("Wallet not connected");
        }

        setIsLoading(true);
        setError(null);

        try {
            const history = await wallet.getTransactionHistory();

            const txList: Transaction[] = history.map((tx: any) => ({
                txid: tx.key?.arkTxid || tx.key?.boardingTxid || tx.key?.commitmentTxid || "",
                amount: Number(tx.amount),
                type: tx.type === "sent" ? ("send" as const) : ("receive" as const),
                timestamp: tx.createdAt ? tx.createdAt * 1000 : Date.now(),
                layer:
                    tx.type === "boarding" || tx.type === "exit"
                        ? ("onchain" as const)
                        : ("offchain" as const),
                status: tx.settled ? "settled" : "pending",
            }));

            setTransactions(txList);
        } catch (err: any) {
            setError(err.message || "Failed to fetch transaction history");
            throw err;
        } finally {
            setIsLoading(false);
        }
    }, [wallet]);

    const payLightningInvoice = useCallback(
        async (invoice: string): Promise<string> => {
            if (!wallet) {
                throw new Error("Wallet not connected");
            }

            const networkConfig = networks[currentNetwork];

            if (!networkConfig.hasLightning || !networkConfig.boltzUrl) {
                throw new Error(`Lightning not supported on ${currentNetwork} network`);
            }

            setIsLoading(true);
            setError(null);

            try {
                const swapProvider = new BoltzSwapProvider({
                    apiUrl: networkConfig.boltzUrl,
                    network: networkConfig.networkName as "bitcoin" | "testnet",
                });
                const lightning = new ArkadeSwaps({
                    wallet: wallet as any,
                    swapProvider,
                });

                const result = await lightning.sendLightningPayment({ invoice });

                if (arkWallet) {
                    await fetchBalance(arkWallet);
                }

                return result.preimage || "";
            } catch (err: any) {
                setError(err.message || "Failed to pay Lightning invoice");
                throw err;
            } finally {
                setIsLoading(false);
            }
        },
        [wallet, arkWallet, currentNetwork, networks],
    );

    const createLightningInvoice = useCallback(
        async (amount: number, description?: string): Promise<string> => {
            if (!wallet) {
                throw new Error("Wallet not connected");
            }

            const networkConfig = networks[currentNetwork];

            if (!networkConfig.hasLightning || !networkConfig.boltzUrl) {
                throw new Error(`Lightning not supported on ${currentNetwork} network`);
            }

            setIsLoading(true);
            setError(null);

            try {
                const swapProvider = new BoltzSwapProvider({
                    apiUrl: networkConfig.boltzUrl,
                    network: networkConfig.networkName as "bitcoin" | "testnet",
                });
                const lightning = new ArkadeSwaps({
                    wallet: wallet as any,
                    swapProvider,
                });

                const result = await lightning.createLightningInvoice({
                    amount,
                    description: description || "Arkade wallet payment",
                });

                lightning
                    .waitAndClaim(result.pendingSwap)
                    .then(async () => {
                        if (arkWallet) {
                            await fetchBalance(arkWallet);
                        }
                    })
                    .catch((err) => {
                        setError(err?.message || "Failed to claim swap");
                    });

                return result.invoice;
            } catch (err: any) {
                setError(err.message || "Failed to create Lightning invoice");
                throw err;
            } finally {
                setIsLoading(false);
            }
        },
        [wallet, arkWallet, currentNetwork, networks],
    );

    const onboardFunds = useCallback(async (): Promise<string> => {
        if (!wallet) {
            throw new Error("Wallet not connected");
        }

        setIsLoading(true);
        setError(null);

        try {
            const info = await wallet.arkProvider.getInfo();
            const ramps = new Ramps(wallet);
            const txid = await ramps.onboard(info.fees);

            if (arkWallet) {
                await fetchBalance(arkWallet);
            }

            return txid;
        } catch (err: any) {
            setError(err.message || "Failed to onboard funds");
            throw err;
        } finally {
            setIsLoading(false);
        }
    }, [wallet, arkWallet]);

    const switchNetwork = useCallback(
        async (network: TNetwork) => {
            setCurrentNetwork(network);

            if (wallet) {
                disconnectWallet();
            }
        },
        [wallet, disconnectWallet],
    );

    const value = useMemo<ArkadeWalletContextType<TNetwork>>(
        () => ({
            wallet,
            walletInfo,
            balance,
            transactions,
            isConnecting,
            isLoading,
            error,
            connectWallet,
            disconnectWallet,
            getBalance,
            sendBitcoin,
            getTransactionHistory,
            payLightningInvoice,
            createLightningInvoice,
            onboardFunds,
            switchNetwork,
            currentNetwork,
            currentNetworkConfig,
        }),
        [
            wallet,
            walletInfo,
            balance,
            transactions,
            isConnecting,
            isLoading,
            error,
            connectWallet,
            disconnectWallet,
            getBalance,
            sendBitcoin,
            getTransactionHistory,
            payLightningInvoice,
            createLightningInvoice,
            onboardFunds,
            switchNetwork,
            currentNetwork,
            currentNetworkConfig,
        ],
    );

    return (
        <ArkadeWalletContext.Provider value={value as unknown as ArkadeWalletContextType<string>}>
            {children}
        </ArkadeWalletContext.Provider>
    );
}

export { ArkadeWalletContext };
