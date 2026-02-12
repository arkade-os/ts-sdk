import React from "react";
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    RefreshControl,
    Platform,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Colors } from "../../constants/colors";
import {
    FontFamily,
    FontSize,
    Spacing,
    BorderRadius,
    Shadows,
} from "../../constants/theme";
import { useWallet } from "../../hooks/useWallet";
import { BalanceCard } from "../../components/BalanceCard";
import { TransactionItem } from "../../components/TransactionItem";
import { EmptyState } from "../../components/EmptyState";

export default function WalletScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { balance, transactions, loading, refresh } = useWallet();
    const [refreshing, setRefreshing] = React.useState(false);

    const onRefresh = async () => {
        setRefreshing(true);
        await refresh();
        setRefreshing(false);
    };

    return (
        <ScrollView
            style={styles.container}
            contentContainerStyle={[
                styles.content,
                { paddingTop: Math.max(insets.top, Spacing.md) + Spacing.md },
            ]}
            refreshControl={
                <RefreshControl
                    refreshing={refreshing}
                    onRefresh={onRefresh}
                    tintColor={Colors.primary}
                    colors={[Colors.primary]}
                />
            }
            showsVerticalScrollIndicator={false}
        >
            {/* Header */}
            <View style={styles.header}>
                <View>
                    <Text style={styles.greeting}>Tether Flow</Text>
                    <Text style={styles.subtitle}>Your USDT wallet</Text>
                </View>
                <View style={styles.logoContainer}>
                    <Text style={styles.logo}>₮</Text>
                </View>
            </View>

            {/* Balance Card */}
            <BalanceCard
                balance={balance}
                onSend={() => router.push("/send")}
                onReceive={() => router.push("/receive")}
            />

            {/* Transactions */}
            <View style={styles.transactionsSection}>
                <Text style={styles.sectionTitle}>Recent Activity</Text>

                {transactions.length === 0 ? (
                    <View style={styles.emptyCard}>
                        <EmptyState
                            icon="receipt-outline"
                            title="No transactions yet"
                            description="Send or receive USDT to see your transaction history here"
                        />
                    </View>
                ) : (
                    <View style={styles.transactionsList}>
                        {transactions.map((tx) => (
                            <TransactionItem
                                key={tx.id}
                                transaction={tx}
                            />
                        ))}
                    </View>
                )}
            </View>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: Colors.background,
    },
    content: {
        paddingBottom: Spacing.xxl,
        ...(Platform.OS === "web"
            ? { maxWidth: 480, alignSelf: "center" as const, width: "100%" as any }
            : {}),
    },
    header: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: Spacing.lg,
        marginBottom: Spacing.lg,
    },
    greeting: {
        fontFamily: FontFamily.bold,
        fontSize: FontSize.xxl,
        color: Colors.text,
    },
    subtitle: {
        fontFamily: FontFamily.regular,
        fontSize: FontSize.sm,
        color: Colors.textSecondary,
        marginTop: 2,
    },
    logoContainer: {
        width: 44,
        height: 44,
        borderRadius: BorderRadius.full,
        backgroundColor: Colors.primary,
        alignItems: "center",
        justifyContent: "center",
    },
    logo: {
        fontFamily: FontFamily.extraBold,
        fontSize: 24,
        color: Colors.textInverse,
    },
    transactionsSection: {
        marginTop: Spacing.xl,
        paddingHorizontal: Spacing.md,
    },
    sectionTitle: {
        fontFamily: FontFamily.bold,
        fontSize: FontSize.lg,
        color: Colors.text,
        marginBottom: Spacing.md,
        paddingHorizontal: Spacing.sm,
    },
    emptyCard: {
        backgroundColor: Colors.surface,
        borderRadius: BorderRadius.xl,
        ...Shadows.sm,
    },
    transactionsList: {
        backgroundColor: Colors.surface,
        borderRadius: BorderRadius.xl,
        overflow: "hidden",
        ...Shadows.sm,
    },
});
