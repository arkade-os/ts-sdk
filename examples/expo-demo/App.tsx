// Polyfill crypto.getRandomValues for React Native/Expo (required for MuSig2 settlements)
import * as Crypto from "expo-crypto";
global.crypto = {
    ...global.crypto,
    getRandomValues: Crypto.getRandomValues,
} as any;

import React, { useState, useEffect, useRef } from "react";
import {
    View,
    Text,
    ScrollView,
    StyleSheet,
    TouchableOpacity,
    Modal,
    Pressable,
    TextInput,
    ActivityIndicator,
    Button,
    Animated,
} from "react-native";
import { ExpoArkProvider } from "../../src/providers/expoArk";
import { ExpoIndexerProvider } from "../../src/providers/expoIndexer";
import { ArkTransaction, WalletBalance, TxType } from "../../src/wallet";
import { Wallet } from "../../src/wallet/wallet";
import { SingleKey } from "../../src/identity/singleKey";
import { DefaultVtxo } from "../../src/script/default";
import * as bip39 from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import { hex } from "@scure/base";
import * as Clipboard from "expo-clipboard";

const MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SERVER_URL = "https://localhost:7070";

type LogEntry = {
    timestamp: string;
    type: "info" | "error" | "event";
    message: string;
};

/**
 * Helper to create unique transaction key from ArkTransaction.
 *
 * Multiple VTXOs can share the same txid (different vouts/outpoints),
 * but ArkTransaction only stores txids without vout indices.
 * To ensure uniqueness for React keys, we combine:
 * - All available txids (arkTxid, commitmentTxid, boardingTxid)
 * - Transaction metadata (timestamp, amount, type)
 *
 * This creates a composite key that uniquely identifies each transaction
 * even when multiple VTXOs from the same transaction are aggregated.
 */
const getTxUniqueKey = (tx: ArkTransaction, index: number): string => {
    const parts = [
        tx.key.arkTxid,
        tx.key.commitmentTxid,
        tx.key.boardingTxid,
        tx.createdAt.toString(),
        tx.amount.toString(),
        tx.type,
    ].filter(Boolean);

    return parts.join("-") || `tx-${index}`;
};

export default function App() {
    const [activeTab, setActiveTab] = useState<"wallet" | "doctor">("wallet");
    const [wallet, setWallet] = useState<Wallet | null>(null);
    const [balance, setBalance] = useState<WalletBalance | null>(null);
    const [transactions, setTransactions] = useState<ArkTransaction[]>([]);
    const [address, setAddress] = useState<string>("");
    const [loading, setLoading] = useState(false);
    const [initError, setInitError] = useState<string | null>(null);
    const [sendModalVisible, setSendModalVisible] = useState(false);
    const [sendAmount, setSendAmount] = useState("");
    const [sendAddress, setSendAddress] = useState("");
    const [customAmount, setCustomAmount] = useState("");
    const [showCustomInput, setShowCustomInput] = useState(false);
    const [isSubscribed, setIsSubscribed] = useState(false);
    const [subscriptionId, setSubscriptionId] = useState<string | null>(null);
    const subscriptionAbortRef = useRef<AbortController | null>(null);
    const [newTxIndices, setNewTxIndices] = useState<Set<string>>(new Set());
    const shakeAnimations = useRef<Map<string, Animated.Value>>(new Map());
    const animationTimeoutRefs = useRef<Set<NodeJS.Timeout>>(new Set());

    // Doctor tab state
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [arkUrl, setArkUrl] = useState(SERVER_URL);
    const [indexerUrl, setIndexerUrl] = useState(SERVER_URL);
    const [isStreaming, setIsStreaming] = useState(false);
    const abortControllerRef = useRef<AbortController | null>(null);

    // Initialize wallet
    useEffect(() => {
        initializeWallet();
    }, []);

    const initializeWallet = async () => {
        try {
            setLoading(true);
            setInitError(null);

            // Create identity from mnemonic
            const seed = bip39.mnemonicToSeedSync(MNEMONIC);
            const hdKey = HDKey.fromMasterSeed(seed);
            const derived = hdKey.derive("m/86'/0'/0'/0/0");

            if (!derived.privateKey) {
                throw new Error("Failed to derive private key");
            }

            const identity = SingleKey.fromPrivateKey(derived.privateKey);

            // Create wallet with Expo provider instances
            const walletInstance = await Wallet.create({
                identity,
                arkProvider: new ExpoArkProvider(SERVER_URL),
                indexerProvider: new ExpoIndexerProvider(SERVER_URL),
            });

            setWallet(walletInstance);

            // Load wallet data
            await loadWalletData(walletInstance);
            addLog("info", "Wallet initialized successfully");
        } catch (error) {
            const errorMsg =
                error instanceof Error ? error.message : String(error);
            console.error("Failed to initialize wallet:", error);
            setInitError(errorMsg);
            addLog("error", `Failed to initialize wallet: ${errorMsg}`);
        } finally {
            setLoading(false);
        }
    };

    const loadWalletData = async (
        walletInstance: Wallet,
        fromSubscription: boolean = false
    ) => {
        try {
            const [addr, bal, txs] = await Promise.all([
                walletInstance.getAddress(),
                walletInstance.getBalance(),
                walletInstance.getTransactionHistory(),
            ]);

            setAddress(addr);
            setBalance(bal);

            const newTxs = txs.slice(0, 5); // Last 5 transactions

            // If this is from a subscription, detect new transactions
            if (fromSubscription) {
                const oldTxIds = new Set(
                    transactions.map((tx, i) => getTxUniqueKey(tx, i))
                );
                const newTxIds = new Set<string>();

                newTxs.forEach((tx, index) => {
                    const txKey = getTxUniqueKey(tx, index);
                    if (!oldTxIds.has(txKey)) {
                        newTxIds.add(txKey);
                        // Initialize shake animation for new transaction
                        if (!shakeAnimations.current.has(txKey)) {
                            shakeAnimations.current.set(
                                txKey,
                                new Animated.Value(0)
                            );
                        }
                        // Trigger shake animation
                        const shakeAnim = shakeAnimations.current.get(txKey)!;
                        Animated.sequence([
                            Animated.timing(shakeAnim, {
                                toValue: 10,
                                duration: 50,
                                useNativeDriver: true,
                            }),
                            Animated.timing(shakeAnim, {
                                toValue: -10,
                                duration: 50,
                                useNativeDriver: true,
                            }),
                            Animated.timing(shakeAnim, {
                                toValue: 10,
                                duration: 50,
                                useNativeDriver: true,
                            }),
                            Animated.timing(shakeAnim, {
                                toValue: -10,
                                duration: 50,
                                useNativeDriver: true,
                            }),
                            Animated.timing(shakeAnim, {
                                toValue: 0,
                                duration: 50,
                                useNativeDriver: true,
                            }),
                        ]).start(() => {
                            // Clear the animation after it's done
                            const timeoutId = setTimeout(() => {
                                setNewTxIndices((prev) => {
                                    const updated = new Set(prev);
                                    updated.delete(txKey);
                                    return updated;
                                });
                                animationTimeoutRefs.current.delete(timeoutId);
                            }, 2000);
                            animationTimeoutRefs.current.add(timeoutId);
                        });
                    }
                });

                setNewTxIndices(newTxIds);
            }

            setTransactions(newTxs);
        } catch (error) {
            console.error("Failed to load wallet data:", error);
            addLog(
                "error",
                `Failed to load wallet data: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    };

    const handleRefresh = async () => {
        if (!wallet) return;
        setLoading(true);
        await loadWalletData(wallet);
        setLoading(false);
    };

    const copyAddress = async () => {
        await Clipboard.setStringAsync(address);
        alert("Address copied to clipboard!");
    };

    const ellipseAddress = (addr: string) => {
        if (addr.length < 16) return addr;
        return `${addr.slice(0, 8)}...${addr.slice(-8)}`;
    };

    const formatSats = (sats: number) => {
        return sats.toLocaleString();
    };

    const formatDate = (timestamp: number) => {
        if (timestamp === 0) return "Pending";
        return new Date(timestamp).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    };

    const handleSendPreset = (amount: string) => {
        setSendAmount(amount);
        setShowCustomInput(false);
    };

    const handleCustomAmount = () => {
        setShowCustomInput(true);
        setSendAmount("");
    };

    const handleSend = async () => {
        if (!wallet || !sendAddress || (!sendAmount && !customAmount)) {
            alert("Please fill in all fields");
            return;
        }

        const amount = parseInt(showCustomInput ? customAmount : sendAmount);
        if (isNaN(amount) || amount <= 0) {
            alert("Invalid amount");
            return;
        }

        try {
            setLoading(true);
            await wallet.sendBitcoin({
                address: sendAddress,
                amount,
            });

            alert("Transaction sent successfully!");
            setSendModalVisible(false);
            setSendAddress("");
            setSendAmount("");
            setCustomAmount("");
            setShowCustomInput(false);

            // Refresh wallet data
            await loadWalletData(wallet);
        } catch (error) {
            alert(
                `Failed to send: ${error instanceof Error ? error.message : String(error)}`
            );
        } finally {
            setLoading(false);
        }
    };

    // Doctor tab functions
    const serializeForLog = (obj: any): string => {
        return JSON.stringify(
            obj,
            (key, value) =>
                typeof value === "bigint" ? value.toString() : value,
            2
        );
    };

    const addLog = (type: LogEntry["type"], message: string) => {
        const timestamp = new Date().toLocaleTimeString();
        setLogs((prev) => [...prev, { timestamp, type, message }]);
    };

    const testArkInfo = async () => {
        try {
            addLog("info", "Testing ArkProvider.getInfo()...");
            const provider = new ExpoArkProvider(arkUrl);
            const info = await provider.getInfo();
            addLog("info", `Server info: ${serializeForLog(info)}`);
        } catch (error) {
            addLog(
                "error",
                `Error: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    };

    const startEventStream = async () => {
        if (isStreaming) {
            addLog("info", "Already streaming...");
            return;
        }

        try {
            setIsStreaming(true);
            addLog("info", "Starting event stream...");

            const provider = new ExpoArkProvider(arkUrl);
            abortControllerRef.current = new AbortController();

            // Subscribe to all settlement events
            const stream = provider.getEventStream(
                abortControllerRef.current.signal,
                [] // empty topics = all events
            );

            for await (const event of stream) {
                addLog(
                    "event",
                    `Event: ${event.type} - ${serializeForLog(event)}`
                );
            }

            addLog("info", "Event stream ended");
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
                addLog("info", "Event stream stopped");
            } else {
                addLog(
                    "error",
                    `Stream error: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        } finally {
            setIsStreaming(false);
            abortControllerRef.current = null;
        }
    };

    const stopEventStream = () => {
        if (abortControllerRef.current) {
            addLog("info", "Stopping event stream...");
            abortControllerRef.current.abort();
        }
    };

    const testIndexerVtxos = async () => {
        try {
            addLog("info", "Testing IndexerProvider...");
            const provider = new ExpoIndexerProvider(indexerUrl);

            addLog("info", "--- Generating script from mnemonic ---");
            const mnemonic = MNEMONIC;
            addLog(
                "info",
                `Mnemonic: ${mnemonic.split(" ").slice(0, 3).join(" ")}...`
            );

            // Convert mnemonic to seed and derive key
            const seed = bip39.mnemonicToSeedSync(mnemonic);
            const hdKey = HDKey.fromMasterSeed(seed);
            const path = "m/86'/0'/0'/0/0";
            const derived = hdKey.derive(path);

            if (!derived.privateKey) {
                throw new Error("Failed to derive private key");
            }

            const alice = SingleKey.fromPrivateKey(derived.privateKey);
            const alicePubKey = await alice.xOnlyPublicKey();

            // Fetch server public key
            const arkProvider = new ExpoArkProvider(arkUrl);
            const arkInfo = await arkProvider.getInfo();
            const serverPubKey = hex.decode(arkInfo.signerPubkey).slice(1); // Remove 02/03 prefix

            // Generate DefaultVtxo script
            const vtxoScript = new DefaultVtxo.Script({
                pubKey: alicePubKey,
                serverPubKey: serverPubKey,
                csvTimelock: {
                    value: BigInt(arkInfo.unilateralExitDelay),
                    type: "seconds",
                },
            });

            const generatedScript = hex.encode(vtxoScript.pkScript);
            const generatedAddress = vtxoScript.address("tark", serverPubKey);
            addLog("info", `VTXO Address: ${generatedAddress.encode()}`);
            addLog(
                "info",
                `Structure: (alice + server) | (alice after ${arkInfo.unilateralExitDelay / 3600n} hours)`
            );

            // Query the generated script
            const generatedVtxos = await provider.getVtxos({
                scripts: [generatedScript],
                pageSize: 10,
            });
            addLog(
                "info",
                `Generated script has ${generatedVtxos.vtxos.length} VTXOs`
            );
        } catch (error) {
            const errorMsg =
                error instanceof Error ? error.message : String(error);
            addLog("error", `Error: ${errorMsg}`);
        }
    };

    const clearLogs = () => {
        setLogs([]);
    };

    const settlePreconfirmed = async () => {
        if (!wallet) {
            addLog("error", "Wallet not initialized");
            return;
        }

        try {
            addLog("info", "Fetching VTXOs...");
            const vtxos = await wallet.getVtxos();

            addLog(
                "info",
                `Found ${vtxos.length} VTXOs, total amount: ${vtxos.reduce((sum, v) => sum + v.value, 0)} sats`
            );
            addLog("info", "Starting settlement...");

            const txid = await wallet.settle(undefined, (event) => {
                addLog("event", `Settlement event: ${event.type}`);
            });

            addLog("info", `Settlement successful! Txid: ${txid}`);

            // Refresh wallet data
            await loadWalletData(wallet);
        } catch (error) {
            const errorMsg =
                error instanceof Error ? error.message : String(error);
            addLog("error", `Settlement failed: ${errorMsg}`);
        }
    };

    const toggleSubscription = async () => {
        if (!wallet) return;

        if (isSubscribed) {
            // Unsubscribe
            if (subscriptionAbortRef.current) {
                subscriptionAbortRef.current.abort();
                subscriptionAbortRef.current = null;
            }
            if (subscriptionId) {
                try {
                    await wallet.indexerProvider.unsubscribeForScripts(
                        subscriptionId
                    );
                    addLog("info", "Unsubscribed from address notifications");
                } catch (error) {
                    addLog(
                        "error",
                        `Failed to unsubscribe: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }
            setIsSubscribed(false);
            setSubscriptionId(null);
        } else {
            // Subscribe
            try {
                addLog("info", "Subscribing to address notifications...");
                const script = hex.encode(wallet.offchainTapscript.pkScript);
                const subId = await wallet.indexerProvider.subscribeForScripts([
                    script,
                ]);
                setSubscriptionId(subId);
                addLog("info", `Subscribed with ID: ${subId}`);

                // Start streaming
                subscriptionAbortRef.current = new AbortController();
                setIsSubscribed(true);

                // Listen to notifications
                (async () => {
                    try {
                        for await (const event of wallet.indexerProvider.getSubscription(
                            subId,
                            subscriptionAbortRef.current!.signal
                        )) {
                            addLog(
                                "event",
                                `New VTXOs: ${event.newVtxos.length}, Spent: ${event.spentVtxos.length}, Swept: ${event.sweptVtxos.length}`
                            );

                            // Refresh wallet data when we get updates
                            if (
                                event.newVtxos.length > 0 ||
                                event.spentVtxos.length > 0
                            ) {
                                await loadWalletData(wallet, true);
                            }
                        }
                    } catch (error) {
                        if (
                            error instanceof Error &&
                            error.name === "AbortError"
                        ) {
                            addLog("info", "Subscription stream stopped");
                        } else {
                            addLog(
                                "error",
                                `Subscription error: ${error instanceof Error ? error.message : String(error)}`
                            );
                        }
                    }
                })();
            } catch (error) {
                addLog(
                    "error",
                    `Failed to subscribe: ${error instanceof Error ? error.message : String(error)}`
                );
                setIsSubscribed(false);
            }
        }
    };

    // Cleanup stale animation Map entries when transactions change
    useEffect(() => {
        const currentTxIds = new Set(
            transactions.map((tx, i) => getTxUniqueKey(tx, i))
        );

        // Remove animations for transactions no longer in the list
        shakeAnimations.current.forEach((animation, txKey) => {
            if (!currentTxIds.has(txKey)) {
                animation.stopAnimation();
                shakeAnimations.current.delete(txKey);
            }
        });
    }, [transactions]);

    useEffect(() => {
        return () => {
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
            if (subscriptionAbortRef.current) {
                subscriptionAbortRef.current.abort();
            }
            // Clear all animation timeouts
            animationTimeoutRefs.current.forEach((timeoutId) => {
                clearTimeout(timeoutId);
            });
            animationTimeoutRefs.current.clear();
            // Stop and clear all animations
            shakeAnimations.current.forEach((animation) => {
                animation.stopAnimation();
            });
            shakeAnimations.current.clear();
        };
    }, []);

    if (loading && !wallet && !initError) {
        return (
            <View style={[styles.container, styles.centered]}>
                <ActivityIndicator size="large" color="#4CAF50" />
                <Text style={styles.loadingText}>Initializing wallet...</Text>
            </View>
        );
    }

    if (initError) {
        return (
            <View style={[styles.container, styles.centered]}>
                <Text style={styles.errorTitle}>Failed to Initialize</Text>
                <Text style={styles.errorText}>{initError}</Text>
                <TouchableOpacity
                    style={styles.retryButton}
                    onPress={initializeWallet}
                >
                    <Text style={styles.retryButtonText}>Retry</Text>
                </TouchableOpacity>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            {/* Tab Bar */}
            <View style={styles.tabBar}>
                <TouchableOpacity
                    style={[
                        styles.tab,
                        activeTab === "wallet" && styles.activeTab,
                    ]}
                    onPress={() => setActiveTab("wallet")}
                >
                    <Text
                        style={[
                            styles.tabText,
                            activeTab === "wallet" && styles.activeTabText,
                        ]}
                    >
                        Wallet
                    </Text>
                </TouchableOpacity>
                <TouchableOpacity
                    style={[
                        styles.tab,
                        activeTab === "doctor" && styles.activeTab,
                    ]}
                    onPress={() => setActiveTab("doctor")}
                >
                    <Text
                        style={[
                            styles.tabText,
                            activeTab === "doctor" && styles.activeTabText,
                        ]}
                    >
                        Doctor
                    </Text>
                </TouchableOpacity>
            </View>

            {/* Wallet Tab */}
            {activeTab === "wallet" && (
                <ScrollView>
                    {/* Header */}
                    <View style={styles.header}>
                        <Text style={styles.title}>Ark Wallet</Text>
                        <TouchableOpacity
                            onPress={handleRefresh}
                            disabled={loading}
                        >
                            <Text style={styles.refreshButton}>
                                {loading ? "⟳" : "↻"}
                            </Text>
                        </TouchableOpacity>
                    </View>

                    {/* Address Section */}
                    <View style={styles.card}>
                        <Text style={styles.sectionTitle}>Address</Text>
                        <View style={styles.addressContainer}>
                            <Text style={styles.address}>
                                {ellipseAddress(address)}
                            </Text>
                            <TouchableOpacity
                                onPress={copyAddress}
                                style={styles.copyButton}
                            >
                                <Text style={styles.copyButtonText}>
                                    📋 Copy
                                </Text>
                            </TouchableOpacity>
                        </View>
                    </View>

                    {/* Balance Section */}
                    <View style={styles.card}>
                        <Text style={styles.sectionTitle}>Balance</Text>
                        <View style={styles.balanceRow}>
                            <View style={styles.balanceItem}>
                                <Text style={styles.balanceLabel}>
                                    Available
                                </Text>
                                <Text style={styles.balanceAmount}>
                                    {balance
                                        ? formatSats(balance.available)
                                        : "0"}{" "}
                                    sats
                                </Text>
                            </View>
                            <View style={styles.balanceItem}>
                                <Text style={styles.balanceLabel}>Total</Text>
                                <Text style={styles.balanceAmount}>
                                    {balance ? formatSats(balance.total) : "0"}{" "}
                                    sats
                                </Text>
                            </View>
                        </View>
                        {balance && balance.preconfirmed > 0 && (
                            <Text style={styles.balanceNote}>
                                Preconfirmed: {formatSats(balance.preconfirmed)}{" "}
                                sats
                            </Text>
                        )}
                    </View>

                    {/* Action Buttons */}
                    <View style={styles.actionButtons}>
                        <TouchableOpacity
                            style={[styles.actionButton, styles.sendButton]}
                            onPress={() => setSendModalVisible(true)}
                        >
                            <Text style={styles.actionButtonText}>Send</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[
                                styles.actionButton,
                                isSubscribed
                                    ? styles.subscribedButton
                                    : styles.subscribeButton,
                            ]}
                            onPress={toggleSubscription}
                        >
                            <Text style={styles.actionButtonText}>
                                {isSubscribed
                                    ? "🔔 Subscribed"
                                    : "🔕 Subscribe"}
                            </Text>
                        </TouchableOpacity>
                    </View>

                    {/* Transactions Section */}
                    <View style={styles.card}>
                        <Text style={styles.sectionTitle}>
                            Recent Transactions
                        </Text>
                        {transactions.length === 0 ? (
                            <Text style={styles.emptyText}>
                                No transactions yet
                            </Text>
                        ) : (
                            transactions.map((tx, index) => {
                                // Create unique key from all transaction identifiers
                                const txKey = getTxUniqueKey(tx, index);
                                const isNew = newTxIndices.has(txKey);
                                const shakeAnim =
                                    shakeAnimations.current.get(txKey);

                                const animatedStyle =
                                    isNew && shakeAnim
                                        ? {
                                              transform: [
                                                  { translateX: shakeAnim },
                                              ],
                                          }
                                        : {};

                                return (
                                    <Animated.View
                                        key={txKey}
                                        style={[styles.txItem, animatedStyle]}
                                    >
                                        <View style={styles.txLeft}>
                                            <Text
                                                style={[
                                                    styles.txType,
                                                    tx.type ===
                                                    TxType.TxReceived
                                                        ? styles.txReceived
                                                        : styles.txSent,
                                                ]}
                                            >
                                                {tx.type === TxType.TxReceived
                                                    ? "↓ Received"
                                                    : "↑ Sent"}
                                            </Text>
                                            <Text style={styles.txDate}>
                                                {formatDate(tx.createdAt)}
                                            </Text>
                                            {!tx.settled && (
                                                <Text style={styles.txPending}>
                                                    Preconfirmed
                                                </Text>
                                            )}
                                        </View>
                                        <Text
                                            style={[
                                                styles.txAmount,
                                                tx.type === TxType.TxReceived
                                                    ? styles.txReceived
                                                    : styles.txSent,
                                            ]}
                                        >
                                            {tx.type === TxType.TxReceived
                                                ? "+"
                                                : "-"}
                                            {formatSats(tx.amount)}
                                        </Text>
                                    </Animated.View>
                                );
                            })
                        )}
                    </View>
                </ScrollView>
            )}

            {/* Doctor Tab */}
            {activeTab === "doctor" && (
                <View style={styles.doctorContainer}>
                    <View style={styles.configSection}>
                        <Text style={styles.label}>Ark Server URL:</Text>
                        <TextInput
                            style={styles.input}
                            value={arkUrl}
                            onChangeText={setArkUrl}
                            placeholder="Ark server URL"
                        />

                        <Text style={styles.label}>Indexer URL:</Text>
                        <TextInput
                            style={styles.input}
                            value={indexerUrl}
                            onChangeText={setIndexerUrl}
                            placeholder="Indexer URL"
                        />
                    </View>

                    <View style={styles.buttonRow}>
                        <Button title="Test Ark Info" onPress={testArkInfo} />
                        <Button
                            title="Test Indexer"
                            onPress={testIndexerVtxos}
                        />
                        <Button
                            title={isStreaming ? "Stop Stream" : "Start Stream"}
                            onPress={
                                isStreaming ? stopEventStream : startEventStream
                            }
                            color={isStreaming ? "#ff6b6b" : "#4CAF50"}
                        />
                        <Button
                            title="Clear Logs"
                            onPress={clearLogs}
                            color="#757575"
                        />
                    </View>

                    <View style={styles.buttonRow}>
                        <Button
                            title="Settle Preconfirmed"
                            onPress={settlePreconfirmed}
                            color="#FF9800"
                        />
                    </View>

                    <View style={styles.logContainer}>
                        <Text style={styles.logTitle}>Logs:</Text>
                        <ScrollView style={styles.logScroll}>
                            {logs.map((log, index) => (
                                <View key={index} style={styles.logEntry}>
                                    <Text
                                        style={[
                                            styles.logText,
                                            styles[`log_${log.type}`],
                                        ]}
                                    >
                                        [{log.timestamp}]{" "}
                                        {log.type.toUpperCase()}: {log.message}
                                    </Text>
                                </View>
                            ))}
                        </ScrollView>
                    </View>
                </View>
            )}

            {/* Send Modal */}
            <Modal
                visible={sendModalVisible}
                transparent={true}
                animationType="slide"
                onRequestClose={() => setSendModalVisible(false)}
            >
                <View style={styles.modalOverlay}>
                    <View style={styles.modalContent}>
                        <Text style={styles.modalTitle}>Send Bitcoin</Text>

                        <Text style={styles.inputLabel}>Recipient Address</Text>
                        <TextInput
                            style={styles.input}
                            value={sendAddress}
                            onChangeText={setSendAddress}
                            placeholder="ark1..."
                            placeholderTextColor="#999"
                        />

                        <Text style={styles.inputLabel}>Amount (sats)</Text>

                        {/* Preset Amounts */}
                        <View style={styles.amountGrid}>
                            <TouchableOpacity
                                style={[
                                    styles.amountButton,
                                    sendAmount === "1000" &&
                                        styles.amountButtonActive,
                                ]}
                                onPress={() => handleSendPreset("1000")}
                            >
                                <Text style={styles.amountButtonText}>
                                    1,000
                                </Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={[
                                    styles.amountButton,
                                    sendAmount === "5000" &&
                                        styles.amountButtonActive,
                                ]}
                                onPress={() => handleSendPreset("5000")}
                            >
                                <Text style={styles.amountButtonText}>
                                    5,000
                                </Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={[
                                    styles.amountButton,
                                    sendAmount === "10000" &&
                                        styles.amountButtonActive,
                                ]}
                                onPress={() => handleSendPreset("10000")}
                            >
                                <Text style={styles.amountButtonText}>
                                    10,000
                                </Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={[
                                    styles.amountButton,
                                    showCustomInput &&
                                        styles.amountButtonActive,
                                ]}
                                onPress={handleCustomAmount}
                            >
                                <Text style={styles.amountButtonText}>
                                    Custom
                                </Text>
                            </TouchableOpacity>
                        </View>

                        {/* Custom Amount Input */}
                        {showCustomInput && (
                            <TextInput
                                style={[styles.input, styles.customAmountInput]}
                                value={customAmount}
                                onChangeText={setCustomAmount}
                                placeholder="Enter amount"
                                placeholderTextColor="#999"
                                keyboardType="numeric"
                            />
                        )}

                        {/* Action Buttons */}
                        <View style={styles.modalButtons}>
                            <Pressable
                                style={[
                                    styles.modalButton,
                                    styles.cancelButton,
                                ]}
                                onPress={() => {
                                    setSendModalVisible(false);
                                    setSendAddress("");
                                    setSendAmount("");
                                    setCustomAmount("");
                                    setShowCustomInput(false);
                                }}
                            >
                                <Text style={styles.cancelButtonText}>
                                    Cancel
                                </Text>
                            </Pressable>
                            <Pressable
                                style={[
                                    styles.modalButton,
                                    styles.confirmButton,
                                ]}
                                onPress={handleSend}
                                disabled={loading}
                            >
                                {loading ? (
                                    <ActivityIndicator color="white" />
                                ) : (
                                    <Text style={styles.confirmButtonText}>
                                        Send
                                    </Text>
                                )}
                            </Pressable>
                        </View>
                    </View>
                </View>
            </Modal>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: "#f5f5f5",
    },
    centered: {
        justifyContent: "center",
        alignItems: "center",
    },
    loadingText: {
        marginTop: 16,
        fontSize: 16,
        color: "#666",
    },
    errorTitle: {
        fontSize: 20,
        fontWeight: "bold",
        color: "#f44336",
        marginBottom: 12,
    },
    errorText: {
        fontSize: 14,
        color: "#666",
        textAlign: "center",
        marginBottom: 20,
        paddingHorizontal: 20,
    },
    retryButton: {
        backgroundColor: "#4CAF50",
        paddingHorizontal: 24,
        paddingVertical: 12,
        borderRadius: 8,
    },
    retryButtonText: {
        color: "white",
        fontSize: 16,
        fontWeight: "600",
    },
    tabBar: {
        flexDirection: "row",
        backgroundColor: "white",
        borderBottomWidth: 1,
        borderBottomColor: "#ddd",
        paddingTop: 50,
    },
    tab: {
        flex: 1,
        paddingVertical: 16,
        alignItems: "center",
    },
    activeTab: {
        borderBottomWidth: 3,
        borderBottomColor: "#4CAF50",
    },
    tabText: {
        fontSize: 16,
        fontWeight: "600",
        color: "#666",
    },
    activeTabText: {
        color: "#4CAF50",
    },
    header: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        padding: 20,
        paddingTop: 30,
        backgroundColor: "#4CAF50",
    },
    title: {
        fontSize: 28,
        fontWeight: "bold",
        color: "white",
    },
    refreshButton: {
        fontSize: 28,
        color: "white",
    },
    card: {
        backgroundColor: "white",
        margin: 16,
        padding: 16,
        borderRadius: 12,
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
        elevation: 3,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: "600",
        marginBottom: 12,
        color: "#333",
    },
    addressContainer: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
    },
    address: {
        fontSize: 16,
        fontFamily: "monospace",
        color: "#666",
        flex: 1,
    },
    copyButton: {
        backgroundColor: "#4CAF50",
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 8,
        marginLeft: 8,
    },
    copyButtonText: {
        color: "white",
        fontWeight: "600",
        fontSize: 14,
    },
    balanceRow: {
        flexDirection: "row",
        justifyContent: "space-between",
    },
    balanceItem: {
        flex: 1,
    },
    balanceLabel: {
        fontSize: 14,
        color: "#666",
        marginBottom: 4,
    },
    balanceAmount: {
        fontSize: 20,
        fontWeight: "bold",
        color: "#333",
    },
    balanceNote: {
        marginTop: 12,
        fontSize: 12,
        color: "#999",
        fontStyle: "italic",
    },
    actionButtons: {
        flexDirection: "row",
        marginHorizontal: 16,
        gap: 8,
        marginBottom: 8,
    },
    actionButton: {
        flex: 1,
        padding: 16,
        borderRadius: 12,
        alignItems: "center",
    },
    sendButton: {
        backgroundColor: "#4CAF50",
    },
    subscribeButton: {
        backgroundColor: "#2196F3",
    },
    subscribedButton: {
        backgroundColor: "#FF9800",
    },
    actionButtonText: {
        color: "white",
        fontSize: 16,
        fontWeight: "bold",
    },
    emptyText: {
        textAlign: "center",
        color: "#999",
        fontSize: 14,
        paddingVertical: 20,
    },
    txItem: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: "#f0f0f0",
    },
    txLeft: {
        flex: 1,
    },
    txType: {
        fontSize: 16,
        fontWeight: "600",
        marginBottom: 4,
    },
    txReceived: {
        color: "#4CAF50",
    },
    txSent: {
        color: "#f44336",
    },
    txDate: {
        fontSize: 12,
        color: "#999",
    },
    txPending: {
        fontSize: 11,
        color: "#FF9800",
        fontStyle: "italic",
        marginTop: 2,
    },
    txAmount: {
        fontSize: 16,
        fontWeight: "bold",
        fontFamily: "monospace",
    },
    doctorContainer: {
        flex: 1,
        padding: 20,
    },
    configSection: {
        marginBottom: 20,
        backgroundColor: "white",
        padding: 15,
        borderRadius: 8,
    },
    label: {
        fontSize: 14,
        fontWeight: "600",
        marginBottom: 5,
        marginTop: 10,
    },
    input: {
        borderWidth: 1,
        borderColor: "#ddd",
        borderRadius: 8,
        padding: 12,
        fontSize: 16,
        backgroundColor: "white",
    },
    buttonRow: {
        flexDirection: "row",
        justifyContent: "space-around",
        marginBottom: 20,
        gap: 10,
    },
    logContainer: {
        flex: 1,
        backgroundColor: "white",
        borderRadius: 8,
        padding: 15,
    },
    logTitle: {
        fontSize: 18,
        fontWeight: "bold",
        marginBottom: 10,
    },
    logScroll: {
        flex: 1,
    },
    logEntry: {
        marginBottom: 8,
        paddingBottom: 8,
        borderBottomWidth: 1,
        borderBottomColor: "#eee",
    },
    logText: {
        fontSize: 12,
        fontFamily: "monospace",
    },
    log_info: {
        color: "#2196F3",
    },
    log_error: {
        color: "#f44336",
    },
    log_event: {
        color: "#4CAF50",
        fontWeight: "600",
    },
    modalOverlay: {
        flex: 1,
        backgroundColor: "rgba(0, 0, 0, 0.5)",
        justifyContent: "flex-end",
    },
    modalContent: {
        backgroundColor: "white",
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        padding: 20,
        minHeight: 400,
    },
    modalTitle: {
        fontSize: 24,
        fontWeight: "bold",
        marginBottom: 20,
        textAlign: "center",
    },
    inputLabel: {
        fontSize: 14,
        fontWeight: "600",
        marginBottom: 8,
        marginTop: 12,
        color: "#333",
    },
    amountGrid: {
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 8,
        marginBottom: 8,
    },
    amountButton: {
        flex: 1,
        minWidth: "22%",
        backgroundColor: "#f0f0f0",
        padding: 12,
        borderRadius: 8,
        alignItems: "center",
    },
    amountButtonActive: {
        backgroundColor: "#4CAF50",
    },
    amountButtonText: {
        fontSize: 14,
        fontWeight: "600",
        color: "#333",
    },
    customAmountInput: {
        marginTop: 8,
    },
    modalButtons: {
        flexDirection: "row",
        gap: 12,
        marginTop: 24,
    },
    modalButton: {
        flex: 1,
        padding: 16,
        borderRadius: 8,
        alignItems: "center",
    },
    cancelButton: {
        backgroundColor: "#f0f0f0",
    },
    cancelButtonText: {
        color: "#666",
        fontSize: 16,
        fontWeight: "600",
    },
    confirmButton: {
        backgroundColor: "#4CAF50",
    },
    confirmButtonText: {
        color: "white",
        fontSize: 16,
        fontWeight: "600",
    },
});
