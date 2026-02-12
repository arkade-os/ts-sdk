import React from "react";
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "../../constants/colors";
import {
    FontFamily,
    FontSize,
    Spacing,
    BorderRadius,
    Shadows,
} from "../../constants/theme";
import { ComingSoonBadge, ComingSoonCard } from "../../components/ComingSoon";
import { EmptyState } from "../../components/EmptyState";

interface AssetPreview {
    symbol: string;
    name: string;
    icon: keyof typeof Ionicons.glyphMap;
    color: string;
    description: string;
}

const ASSETS: AssetPreview[] = [
    {
        symbol: "XAUT",
        name: "Tether Gold",
        icon: "diamond-outline",
        color: "#D4A853",
        description: "Digital gold backed by physical reserves",
    },
    {
        symbol: "BTC",
        name: "Bitcoin",
        icon: "logo-bitcoin",
        color: "#F7931A",
        description: "The original cryptocurrency",
    },
];

export default function TradeScreen() {
    const insets = useSafeAreaInsets();

    return (
        <ScrollView
            style={styles.container}
            contentContainerStyle={[
                styles.content,
                { paddingTop: Math.max(insets.top, Spacing.md) + Spacing.md },
            ]}
            showsVerticalScrollIndicator={false}
        >
            {/* Header */}
            <View style={styles.header}>
                <View style={styles.headerRow}>
                    <Text style={styles.title}>Trade</Text>
                    <ComingSoonBadge />
                </View>
                <Text style={styles.subtitle}>
                    Swap USDT for other assets instantly
                </Text>
            </View>

            {/* Preview Card */}
            <View style={styles.previewCard}>
                <View style={styles.previewHeader}>
                    <Ionicons
                        name="swap-horizontal"
                        size={28}
                        color={Colors.primary}
                    />
                    <Text style={styles.previewTitle}>
                        Instant Asset Swaps
                    </Text>
                </View>
                <Text style={styles.previewDescription}>
                    Trade your USDT for other Arkade assets with instant
                    settlement and minimal fees. All trades happen on the Ark
                    protocol for maximum speed and privacy.
                </Text>
            </View>

            {/* Assets List */}
            <View style={styles.assetsSection}>
                <Text style={styles.sectionTitle}>Available Assets</Text>

                <View style={styles.assetsList}>
                    {ASSETS.map((asset) => (
                        <View key={asset.symbol} style={styles.assetCard}>
                            <View
                                style={[
                                    styles.assetIcon,
                                    { backgroundColor: asset.color + "18" },
                                ]}
                            >
                                <Ionicons
                                    name={asset.icon}
                                    size={24}
                                    color={asset.color}
                                />
                            </View>
                            <View style={styles.assetInfo}>
                                <View style={styles.assetNameRow}>
                                    <Text style={styles.assetSymbol}>
                                        {asset.symbol}
                                    </Text>
                                    <ComingSoonBadge compact />
                                </View>
                                <Text style={styles.assetName}>
                                    {asset.name}
                                </Text>
                                <Text style={styles.assetDescription}>
                                    {asset.description}
                                </Text>
                            </View>
                        </View>
                    ))}
                </View>
            </View>

            {/* Trade Preview */}
            <View style={styles.tradePreview}>
                <Text style={styles.sectionTitle}>How It Works</Text>
                <View style={styles.stepsList}>
                    <View style={styles.step}>
                        <View style={styles.stepNumber}>
                            <Text style={styles.stepNumberText}>1</Text>
                        </View>
                        <View style={styles.stepContent}>
                            <Text style={styles.stepTitle}>
                                Choose an asset
                            </Text>
                            <Text style={styles.stepDescription}>
                                Select the asset you want to trade for
                            </Text>
                        </View>
                    </View>
                    <View style={styles.stepConnector} />
                    <View style={styles.step}>
                        <View style={styles.stepNumber}>
                            <Text style={styles.stepNumberText}>2</Text>
                        </View>
                        <View style={styles.stepContent}>
                            <Text style={styles.stepTitle}>
                                Enter amount
                            </Text>
                            <Text style={styles.stepDescription}>
                                Specify how much USDT you want to swap
                            </Text>
                        </View>
                    </View>
                    <View style={styles.stepConnector} />
                    <View style={styles.step}>
                        <View style={styles.stepNumber}>
                            <Text style={styles.stepNumberText}>3</Text>
                        </View>
                        <View style={styles.stepContent}>
                            <Text style={styles.stepTitle}>
                                Instant settlement
                            </Text>
                            <Text style={styles.stepDescription}>
                                Your trade settles instantly on the Ark protocol
                            </Text>
                        </View>
                    </View>
                </View>
            </View>

            {/* Notify Section */}
            <View style={styles.notifyCard}>
                <Ionicons
                    name="notifications-outline"
                    size={24}
                    color={Colors.primary}
                />
                <View style={styles.notifyContent}>
                    <Text style={styles.notifyTitle}>Get Notified</Text>
                    <Text style={styles.notifyDescription}>
                        Trading will be available soon. Stay tuned for updates.
                    </Text>
                </View>
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
        paddingHorizontal: Spacing.lg,
        marginBottom: Spacing.lg,
    },
    headerRow: {
        flexDirection: "row",
        alignItems: "center",
        gap: Spacing.md,
    },
    title: {
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
    previewCard: {
        backgroundColor: Colors.surface,
        borderRadius: BorderRadius.xl,
        padding: Spacing.lg,
        marginHorizontal: Spacing.md,
        marginBottom: Spacing.lg,
        ...Shadows.sm,
    },
    previewHeader: {
        flexDirection: "row",
        alignItems: "center",
        gap: Spacing.md,
        marginBottom: Spacing.md,
    },
    previewTitle: {
        fontFamily: FontFamily.bold,
        fontSize: FontSize.lg,
        color: Colors.text,
    },
    previewDescription: {
        fontFamily: FontFamily.regular,
        fontSize: FontSize.sm,
        color: Colors.textSecondary,
        lineHeight: 20,
    },
    assetsSection: {
        paddingHorizontal: Spacing.md,
        marginBottom: Spacing.lg,
    },
    sectionTitle: {
        fontFamily: FontFamily.bold,
        fontSize: FontSize.lg,
        color: Colors.text,
        marginBottom: Spacing.md,
        paddingHorizontal: Spacing.sm,
    },
    assetsList: {
        gap: Spacing.md,
    },
    assetCard: {
        flexDirection: "row",
        backgroundColor: Colors.surface,
        borderRadius: BorderRadius.xl,
        padding: Spacing.md,
        gap: Spacing.md,
        ...Shadows.sm,
    },
    assetIcon: {
        width: 52,
        height: 52,
        borderRadius: BorderRadius.lg,
        alignItems: "center",
        justifyContent: "center",
    },
    assetInfo: {
        flex: 1,
    },
    assetNameRow: {
        flexDirection: "row",
        alignItems: "center",
        gap: Spacing.sm,
    },
    assetSymbol: {
        fontFamily: FontFamily.bold,
        fontSize: FontSize.lg,
        color: Colors.text,
    },
    assetName: {
        fontFamily: FontFamily.medium,
        fontSize: FontSize.sm,
        color: Colors.textSecondary,
        marginTop: 1,
    },
    assetDescription: {
        fontFamily: FontFamily.regular,
        fontSize: FontSize.xs,
        color: Colors.textTertiary,
        marginTop: 4,
    },
    tradePreview: {
        paddingHorizontal: Spacing.md,
        marginBottom: Spacing.lg,
    },
    stepsList: {
        backgroundColor: Colors.surface,
        borderRadius: BorderRadius.xl,
        padding: Spacing.lg,
        ...Shadows.sm,
    },
    step: {
        flexDirection: "row",
        gap: Spacing.md,
        alignItems: "flex-start",
    },
    stepNumber: {
        width: 32,
        height: 32,
        borderRadius: BorderRadius.full,
        backgroundColor: Colors.primaryBg,
        alignItems: "center",
        justifyContent: "center",
    },
    stepNumberText: {
        fontFamily: FontFamily.bold,
        fontSize: FontSize.sm,
        color: Colors.primary,
    },
    stepContent: {
        flex: 1,
        paddingTop: 4,
    },
    stepTitle: {
        fontFamily: FontFamily.semiBold,
        fontSize: FontSize.md,
        color: Colors.text,
    },
    stepDescription: {
        fontFamily: FontFamily.regular,
        fontSize: FontSize.sm,
        color: Colors.textSecondary,
        marginTop: 2,
    },
    stepConnector: {
        width: 2,
        height: 16,
        backgroundColor: Colors.primaryMuted,
        marginLeft: 15,
        marginVertical: 4,
    },
    notifyCard: {
        flexDirection: "row",
        backgroundColor: Colors.primaryBg,
        borderRadius: BorderRadius.xl,
        padding: Spacing.lg,
        marginHorizontal: Spacing.md,
        gap: Spacing.md,
        alignItems: "center",
    },
    notifyContent: {
        flex: 1,
    },
    notifyTitle: {
        fontFamily: FontFamily.semiBold,
        fontSize: FontSize.md,
        color: Colors.primary,
    },
    notifyDescription: {
        fontFamily: FontFamily.regular,
        fontSize: FontSize.sm,
        color: Colors.primaryDark,
        marginTop: 2,
    },
});
