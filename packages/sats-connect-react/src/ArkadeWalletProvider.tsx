import {
    createContext,
    useState,
    useCallback,
    useMemo,
    useEffect,
    useRef,
    type ReactNode,
} from "react";
import { Wallet, Ramps, TxType, type ArkTransaction, type WalletBalance } from "@arkade-os/sdk";
import {
    createSwapClient,
    IndexedDbAssetSwapRepository,
    quoteIdOfSwapId,
    type Outcome,
    type SwapClient,
} from "@arkade-os/swap";
import { ArkadeWallet } from "@arkade-os/sats-connect";
import type {
    ArkadeWalletProviderConfig,
    ArkadeWalletContextType,
    WalletInfo,
    Balance,
    Transaction,
} from "./types";

const ArkadeWalletContext = createContext<ArkadeWalletContextType<string> | undefined>(undefined);

interface LightningSession {
    client: SwapClient;
    repository: IndexedDbAssetSwapRepository;
    /** Resolves when the provider closes this session. */
    closed: Promise<void>;
    close: () => void;
}

/** Every figure from one SDK reading: `total` already holds boarding, so nothing is added to it. */
export const toBalance = (bal: WalletBalance, vtxos: unknown[]): Balance => ({
    total: bal.total,
    onchain: bal.boarding.total,
    offchain: bal.available,
    settled: bal.settled,
    preconfirmed: bal.preconfirmed,
    recoverable: bal.recoverable,
    vtxoList: vtxos.map((vtxo: any) => ({
        id: vtxo.txid ? `${vtxo.txid}:${vtxo.vout}` : vtxo.id,
        amount: Number(vtxo.value || vtxo.amount),
        expiry: vtxo.expiry?.median || 0,
        status: vtxo.virtualStatus?.state || "pending",
    })),
});

export const toTransaction = (tx: ArkTransaction): Transaction => ({
    txid: tx.key.arkTxid || tx.key.boardingTxid || tx.key.commitmentTxid || "",
    amount: Number(tx.amount),
    type: tx.type === TxType.TxSent ? "send" : "receive",
    timestamp: tx.createdAt,
    layer: tx.tag === "boarding" || tx.tag === "exit" ? "onchain" : "offchain",
    status: tx.settled ? "settled" : "pending",
});

/** A refresh after an operation that went through: its failure is reported, never thrown, so the
 * caller still gets the result and does not send again. */
export async function refreshAfter(
    refresh: () => Promise<unknown>,
    report: (message: string) => void,
): Promise<void> {
    try {
        await refresh();
    } catch (err: any) {
        report(`Done, but the balance did not refresh: ${err?.message ?? String(err)}`);
    }
}

const PAY_ENDS: readonly Outcome[] = ["paid", "refunding", "refunded", "failed", "needs_recovery"];
const RECEIVE_ENDS: readonly Outcome[] = ["claimed", "lapsed", "failed", "needs_recovery"];

/** The swap's first outcome in `ends`. `onUpdate` replays synchronously, before `off` is set. */
const outcomeIn = (client: SwapClient, swapId: string, ends: readonly Outcome[]) =>
    new Promise<Outcome>((resolve) => {
        let off: (() => void) | undefined;
        let done = false;
        off = client.onUpdate(({ swap, outcome }) => {
            if (done || swap.id !== swapId || !ends.includes(outcome)) return;
            done = true;
            off?.();
            resolve(outcome);
        });
        if (done) off();
    });

/** The swap's first outcome in `ends`, or `undefined` once `closed` settles first. */
export const outcomeUntil = (
    client: SwapClient,
    swapId: string,
    ends: readonly Outcome[],
    closed: Promise<void>,
): Promise<Outcome | undefined> =>
    Promise.race([outcomeIn(client, swapId, ends), closed.then(() => undefined)]);

/** Reports how a receive ends, unless the session that issued it has closed since. */
export const followReceive = (
    client: SwapClient,
    swapId: string,
    isLive: () => boolean,
    onClaimed: () => Promise<void> | void,
    onFailed: (message: string) => void,
): Promise<void> =>
    outcomeIn(client, swapId, RECEIVE_ENDS)
        .then(async (outcome) => {
            if (!isLive()) return;
            if (outcome === "claimed") await onClaimed();
            else onFailed(`Lightning receive ${outcome}`);
        })
        .catch((err) => {
            if (isLive()) onFailed(err?.message || "Failed to claim swap");
        });

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
    const lightningRef = useRef<LightningSession | null>(null);
    // A connect publishes only while it is the newest; disconnect and network switch bump it too.
    const connectAttempt = useRef(0);
    // Only the newest balance read publishes; a disconnect drops any read still in flight.
    const balanceRead = useRef(0);
    const autoConnectTried = useRef(false);

    const closeLightning = useCallback(() => {
        const session = lightningRef.current;
        lightningRef.current = null;
        session?.close();
        void session?.client[Symbol.asyncDispose]();
    }, []);

    useEffect(() => closeLightning, [closeLightning]);

    const currentNetworkConfig = useMemo(
        () => networks[currentNetwork],
        [networks, currentNetwork],
    );

    const fetchBalance = useCallback(async (arkWalletInstance: ArkadeWallet): Promise<Balance> => {
        const read = ++balanceRead.current;
        const [bal, vtxos] = await Promise.all([
            arkWalletInstance.getBalance(),
            arkWalletInstance.getVtxos(),
        ]);
        const balanceData = toBalance(bal, vtxos);
        if (read === balanceRead.current) setBalance(balanceData);
        return balanceData;
    }, []);

    const connectWallet = useCallback(
        async (options?: { silent?: boolean }) => {
            const silent = options?.silent ?? false;
            const attempt = ++connectAttempt.current;
            const current = () => attempt === connectAttempt.current;
            setIsConnecting(true);
            if (!silent) {
                setError(null);
            }

            let arkWalletInstance: ArkadeWallet | undefined;
            try {
                const networkConfig = networks[currentNetwork];
                arkWalletInstance = new ArkadeWallet({
                    arkServerUrl: networkConfig.arkServerUrl,
                    esploraUrl: networkConfig.esploraUrl,
                    satsConnectNetwork: networkConfig.satsConnectNetwork,
                    connectMessage,
                });

                const info = await arkWalletInstance.connect();
                if (!current()) {
                    arkWalletInstance.reset();
                    return;
                }
                const walletInstance = arkWalletInstance.getWallet();

                if (!walletInstance) {
                    throw new Error("Failed to initialize Arkade wallet");
                }

                closeLightning();
                if (networkConfig.hasLightning) {
                    // One store per network and key: a drive must not act on another wallet's swaps.
                    const repository = new IndexedDbAssetSwapRepository(
                        `arkade-swaps:${networkConfig.networkName}:${info.userPubKey}`,
                    );
                    const client = createSwapClient({ wallet: walletInstance, repository });
                    let close = () => {};
                    const closed = new Promise<void>((resolve) => {
                        close = resolve;
                    });
                    lightningRef.current = { client, repository, closed, close };
                    // Resumes claiming invoices a previous session issued.
                    client.ready.catch((err) => {
                        if (lightningRef.current?.client !== client) return;
                        console.error("Lightning swap store unavailable", err);
                        setError(`Lightning unavailable: ${err?.message ?? String(err)}`);
                    });
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
                if (!current()) {
                    arkWalletInstance.reset();
                    return;
                }
                if (typeof window !== "undefined") {
                    window.localStorage.setItem(autoConnectKey, "1");
                }
            } catch (err: any) {
                arkWalletInstance?.reset();
                if (!current()) return;
                if (!silent) {
                    setError(err.message || "Failed to connect wallet");
                }
                closeLightning();
                setArkWallet(null);
                setWallet(null);
                setWalletInfo(null);
                setBalance(null);
            } finally {
                if (current()) setIsConnecting(false);
            }
        },
        [currentNetwork, networks, autoConnectKey, connectMessage, closeLightning, fetchBalance],
    );

    const disconnectWallet = useCallback(() => {
        connectAttempt.current++;
        balanceRead.current++;
        closeLightning();
        arkWallet?.reset();
        setArkWallet(null);
        setWallet(null);
        setWalletInfo(null);
        setBalance(null);
        setTransactions([]);
        setError(null);
        setIsConnecting(false);
        if (typeof window !== "undefined") {
            window.localStorage.removeItem(autoConnectKey);
        }
    }, [arkWallet, autoConnectKey, closeLightning]);

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }
        // Once per mount: a declined prompt must not reopen itself.
        if (autoConnectTried.current || wallet || isConnecting) {
            return;
        }
        if (window.localStorage.getItem(autoConnectKey) !== "1") {
            return;
        }
        autoConnectTried.current = true;
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
        [arkWallet, fetchBalance],
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
                await refreshAfter(() => fetchBalance(arkWallet), setError);
                return txid;
            } catch (err: any) {
                setError(err.message || "Failed to send Bitcoin");
                throw err;
            } finally {
                setIsLoading(false);
            }
        },
        [arkWallet, fetchBalance],
    );

    const getTransactionHistory = useCallback(async () => {
        if (!wallet) {
            throw new Error("Wallet not connected");
        }

        setIsLoading(true);
        setError(null);

        try {
            const history = await wallet.getTransactionHistory();
            setTransactions(history.map(toTransaction));
        } catch (err: any) {
            setError(err.message || "Failed to fetch transaction history");
            throw err;
        } finally {
            setIsLoading(false);
        }
    }, [wallet]);

    const lightningSession = useCallback((): LightningSession => {
        if (!wallet) {
            throw new Error("Wallet not connected");
        }
        if (!lightningRef.current) {
            throw new Error(`Lightning not supported on ${currentNetwork} network`);
        }
        return lightningRef.current;
    }, [wallet, currentNetwork]);

    const payLightningInvoice = useCallback(
        async (invoice: string): Promise<string> => {
            const { client, repository, closed } = lightningSession();
            // `pay` also takes Arkade and onchain addresses, which would move funds here.
            if (!/^ln/i.test(invoice)) {
                throw new Error("Not a Lightning invoice");
            }

            setIsLoading(true);
            setError(null);

            try {
                const result = await client.pay(invoice);
                if (result.kind !== "swap") {
                    throw new Error("Not a Lightning invoice");
                }
                const outcome = await outcomeUntil(client, result.swap.id, PAY_ENDS, closed);
                if (outcome === undefined) {
                    throw new Error(
                        "Stopped following this Lightning payment: the wallet disconnected. Reconnect to see how it ended.",
                    );
                }
                if (outcome !== "paid") {
                    throw new Error(`Lightning payment ${outcome}`);
                }
                const record = await repository.getSwapRecord(quoteIdOfSwapId(result.swap.id));

                if (arkWallet) {
                    await refreshAfter(() => fetchBalance(arkWallet), setError);
                }

                return record?.family === "rfq" ? (record.settlementPreimageHex ?? "") : "";
            } catch (err: any) {
                setError(err.message || "Failed to pay Lightning invoice");
                throw err;
            } finally {
                setIsLoading(false);
            }
        },
        [arkWallet, lightningSession, fetchBalance],
    );

    const createLightningInvoice = useCallback(
        async (amount: number, _description?: string): Promise<string> => {
            const { client } = lightningSession();

            setIsLoading(true);
            setError(null);

            try {
                const request = await client.receive({ amount: BigInt(amount), via: "lightning" });

                void followReceive(
                    client,
                    request.id,
                    () => lightningRef.current?.client === client,
                    async () => {
                        if (arkWallet) await fetchBalance(arkWallet);
                    },
                    setError,
                );

                return request.artifact.bolt11;
            } catch (err: any) {
                setError(err.message || "Failed to create Lightning invoice");
                throw err;
            } finally {
                setIsLoading(false);
            }
        },
        [arkWallet, lightningSession, fetchBalance],
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
                await refreshAfter(() => fetchBalance(arkWallet), setError);
            }

            return txid;
        } catch (err: any) {
            setError(err.message || "Failed to onboard funds");
            throw err;
        } finally {
            setIsLoading(false);
        }
    }, [wallet, arkWallet, fetchBalance]);

    const switchNetwork = useCallback(
        async (network: TNetwork) => {
            setCurrentNetwork(network);

            if (wallet || isConnecting) {
                disconnectWallet();
            }
        },
        [wallet, isConnecting, disconnectWallet],
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
