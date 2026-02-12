import React, { useState } from "react";
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    TouchableOpacity,
    TextInput,
    Modal,
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
import { useWallet, useEarn } from "../../hooks/useWallet";
import { EmptyState } from "../../components/EmptyState";
import { Button } from "../../components/Button";

export default function EarnScreen() {
    const insets = useSafeAreaInsets();
    const { balance } = useWallet();
    const { lockups, totalLocked, totalEarned, createLockup } = useEarn();
    const [showLockupModal, setShowLockupModal] = useState(false);
    const [lockupAmount, setLockupAmount] = useState("");

    const handleCreateLockup = async () => {
        const amount = parseFloat(lockupAmount);
        if (amount > 0 && amount <= balance.available) {
            await createLockup(amount);
            setShowLockupModal(false);
            setLockupAmount("");
        }
    };

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
                <Text style={styles.title}>Earn</Text>
                <Text style={styles.subtitle}>
                    Lock up USDT and earn weekly yield
                </Text>
            </View>

            {/* Stats Cards */}
            <View style={styles.statsRow}>
                <View style={styles.statCard}>
                    <View style={styles.statIconContainer}>
                        <Ionicons
                            name="lock-closed"
                            size={20}
                            color={Colors.primary}
                        />
                    </View>
                    <Text style={styles.statValue}>
                        ${totalLocked.toFixed(2)}
                    </Text>
                    <Text style={styles.statLabel}>Total Locked</Text>
                </View>
                <View style={styles.statCard}>
                    <View
                        style={[
                            styles.statIconContainer,
                            { backgroundColor: "#ECFDF5" },
                        ]}
                    >
                        <Ionicons
                            name="trending-up"
                            size={20}
                            color={Colors.success}
                        />
                    </View>
                    <Text style={styles.statValue}>
                        ${totalEarned.toFixed(2)}
                    </Text>
                    <Text style={styles.statLabel}>Total Earned</Text>
                </View>
            </View>

            {/* Yield Info */}
            <View style={styles.yieldCard}>
                <View style={styles.yieldHeader}>
                    <Text style={styles.yieldTitle}>Current Yield</Text>
                    <View style={styles.yieldBadge}>
                        <Text style={styles.yieldBadgeText}>5.0% APY</Text>
                    </View>
                </View>
                <Text style={styles.yieldDescription}>
                    Yield is distributed weekly every Monday. Lock up your USDT
                    to start earning. Minimum lockup period is 7 days.
                </Text>
                <View style={styles.yieldFeatures}>
                    <View style={styles.yieldFeature}>
                        <Ionicons
                            name="checkmark-circle"
                            size={18}
                            color={Colors.primary}
                        />
                        <Text style={styles.yieldFeatureText}>
                            Weekly payouts
                        </Text>
                    </View>
                    <View style={styles.yieldFeature}>
                        <Ionicons
                            name="checkmark-circle"
                            size={18}
                            color={Colors.primary}
                        />
                        <Text style={styles.yieldFeatureText}>
                            No minimum amount
                        </Text>
                    </View>
                    <View style={styles.yieldFeature}>
                        <Ionicons
                            name="checkmark-circle"
                            size={18}
                            color={Colors.primary}
                        />
                        <Text style={styles.yieldFeatureText}>
                            Unlock anytime after 7 days
                        </Text>
                    </View>
                </View>
            </View>

            {/* Active Positions */}
            <View style={styles.positionsSection}>
                <View style={styles.positionsHeader}>
                    <Text style={styles.sectionTitle}>Active Positions</Text>
                    <Button
                        title="Lock Up"
                        onPress={() => setShowLockupModal(true)}
                        variant="primary"
                        size="sm"
                        icon={
                            <Ionicons
                                name="add"
                                size={18}
                                color={Colors.textInverse}
                            />
                        }
                    />
                </View>

                {lockups.length === 0 ? (
                    <View style={styles.emptyCard}>
                        <EmptyState
                            icon="leaf-outline"
                            title="Start earning yield"
                            description="Lock up your USDT to earn 5% APY with weekly payouts directly to your wallet"
                        >
                            <Button
                                title="Create Lockup"
                                onPress={() => setShowLockupModal(true)}
                                variant="primary"
                                size="md"
                            />
                        </EmptyState>
                    </View>
                ) : (
                    <View style={styles.positionsList}>
                        {lockups.map((lockup) => (
                            <View key={lockup.id} style={styles.positionCard}>
                                <View style={styles.positionHeader}>
                                    <Text style={styles.positionAmount}>
                                        ${lockup.amount.toFixed(2)}
                                    </Text>
                                    <View
                                        style={[
                                            styles.statusBadge,
                                            lockup.status === "active"
                                                ? styles.statusActive
                                                : styles.statusUnlocking,
                                        ]}
                                    >
                                        <Text style={styles.statusText}>
                                            {lockup.status === "active"
                                                ? "Active"
                                                : "Unlocking"}
                                        </Text>
                                    </View>
                                </View>
                                <View style={styles.positionDetails}>
                                    <View style={styles.positionDetail}>
                                        <Text style={styles.detailLabel}>
                                            Earned
                                        </Text>
                                        <Text style={styles.detailValue}>
                                            ${lockup.earned.toFixed(2)}
                                        </Text>
                                    </View>
                                    <View style={styles.positionDetail}>
                                        <Text style={styles.detailLabel}>
                                            Next payout
                                        </Text>
                                        <Text style={styles.detailValue}>
                                            {lockup.nextYieldDate.toLocaleDateString()}
                                        </Text>
                                    </View>
                                    <View style={styles.positionDetail}>
                                        <Text style={styles.detailLabel}>
                                            Rate
                                        </Text>
                                        <Text style={styles.detailValue}>
                                            {(lockup.yieldRate * 100).toFixed(1)}%
                                        </Text>
                                    </View>
                                </View>
                            </View>
                        ))}
                    </View>
                )}
            </View>

            {/* Lockup Modal */}
            <Modal
                visible={showLockupModal}
                transparent
                animationType="fade"
                onRequestClose={() => setShowLockupModal(false)}
            >
                <View style={styles.modalOverlay}>
                    <View style={styles.modalContent}>
                        <View style={styles.modalHeader}>
                            <Text style={styles.modalTitle}>
                                Lock Up USDT
                            </Text>
                            <TouchableOpacity
                                onPress={() => setShowLockupModal(false)}
                                hitSlop={16}
                            >
                                <Ionicons
                                    name="close"
                                    size={24}
                                    color={Colors.text}
                                />
                            </TouchableOpacity>
                        </View>

                        <Text style={styles.modalSubtitle}>
                            Enter the amount you want to lock up
                        </Text>

                        <View style={styles.modalInputContainer}>
                            <Text style={styles.modalDollar}>$</Text>
                            <TextInput
                                style={styles.modalInput}
                                value={lockupAmount}
                                onChangeText={setLockupAmount}
                                placeholder="0.00"
                                placeholderTextColor={Colors.textTertiary}
                                keyboardType="decimal-pad"
                                autoFocus
                            />
                        </View>

                        <Text style={styles.modalAvailable}>
                            Available: ${balance.available.toFixed(2)} USDT
                        </Text>

                        <View style={styles.modalEstimate}>
                            <Ionicons
                                name="information-circle-outline"
                                size={16}
                                color={Colors.primary}
                            />
                            <Text style={styles.modalEstimateText}>
                                Estimated weekly yield: $
                                {(
                                    (parseFloat(lockupAmount) || 0) *
                                    0.05 / 52
                                ).toFixed(4)}
                            </Text>
                        </View>

                        <View style={styles.modalActions}>
                            <Button
                                title="Cancel"
                                onPress={() => setShowLockupModal(false)}
                                variant="outline"
                                size="lg"
                                style={{ flex: 1 } as any}
                            />
                            <Button
                                title="Lock Up"
                                onPress={handleCreateLockup}
                                variant="primary"
                                size="lg"
                                disabled={
                                    !lockupAmount ||
                                    parseFloat(lockupAmount) <= 0 ||
                                    parseFloat(lockupAmount) >
                                        balance.available
                                }
                                style={{ flex: 1 } as any}
                            />
                        </View>
                    </View>
                </View>
            </Modal>
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
    statsRow: {
        flexDirection: "row",
        paddingHorizontal: Spacing.md,
        gap: Spacing.md,
        marginBottom: Spacing.lg,
    },
    statCard: {
        flex: 1,
        backgroundColor: Colors.surface,
        borderRadius: BorderRadius.xl,
        padding: Spacing.md,
        ...Shadows.sm,
    },
    statIconContainer: {
        width: 36,
        height: 36,
        borderRadius: BorderRadius.md,
        backgroundColor: Colors.primaryBg,
        alignItems: "center",
        justifyContent: "center",
        marginBottom: Spacing.sm,
    },
    statValue: {
        fontFamily: FontFamily.bold,
        fontSize: FontSize.xl,
        color: Colors.text,
    },
    statLabel: {
        fontFamily: FontFamily.regular,
        fontSize: FontSize.xs,
        color: Colors.textSecondary,
        marginTop: 2,
    },
    yieldCard: {
        backgroundColor: Colors.surface,
        borderRadius: BorderRadius.xl,
        padding: Spacing.lg,
        marginHorizontal: Spacing.md,
        marginBottom: Spacing.lg,
        ...Shadows.sm,
    },
    yieldHeader: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: Spacing.sm,
    },
    yieldTitle: {
        fontFamily: FontFamily.bold,
        fontSize: FontSize.lg,
        color: Colors.text,
    },
    yieldBadge: {
        backgroundColor: Colors.primaryBg,
        paddingHorizontal: Spacing.md,
        paddingVertical: Spacing.xs,
        borderRadius: BorderRadius.full,
    },
    yieldBadgeText: {
        fontFamily: FontFamily.bold,
        fontSize: FontSize.sm,
        color: Colors.primary,
    },
    yieldDescription: {
        fontFamily: FontFamily.regular,
        fontSize: FontSize.sm,
        color: Colors.textSecondary,
        lineHeight: 20,
        marginBottom: Spacing.md,
    },
    yieldFeatures: {
        gap: Spacing.sm,
    },
    yieldFeature: {
        flexDirection: "row",
        alignItems: "center",
        gap: Spacing.sm,
    },
    yieldFeatureText: {
        fontFamily: FontFamily.medium,
        fontSize: FontSize.sm,
        color: Colors.text,
    },
    positionsSection: {
        paddingHorizontal: Spacing.md,
    },
    positionsHeader: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: Spacing.md,
        paddingHorizontal: Spacing.sm,
    },
    sectionTitle: {
        fontFamily: FontFamily.bold,
        fontSize: FontSize.lg,
        color: Colors.text,
    },
    emptyCard: {
        backgroundColor: Colors.surface,
        borderRadius: BorderRadius.xl,
        ...Shadows.sm,
    },
    positionsList: {
        gap: Spacing.md,
    },
    positionCard: {
        backgroundColor: Colors.surface,
        borderRadius: BorderRadius.xl,
        padding: Spacing.md,
        ...Shadows.sm,
    },
    positionHeader: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: Spacing.md,
    },
    positionAmount: {
        fontFamily: FontFamily.bold,
        fontSize: FontSize.xl,
        color: Colors.text,
    },
    statusBadge: {
        paddingHorizontal: Spacing.sm,
        paddingVertical: 2,
        borderRadius: BorderRadius.full,
    },
    statusActive: {
        backgroundColor: "#ECFDF5",
    },
    statusUnlocking: {
        backgroundColor: "#FEF3C7",
    },
    statusText: {
        fontFamily: FontFamily.semiBold,
        fontSize: FontSize.xs,
        color: Colors.text,
    },
    positionDetails: {
        flexDirection: "row",
        gap: Spacing.md,
    },
    positionDetail: {
        flex: 1,
    },
    detailLabel: {
        fontFamily: FontFamily.regular,
        fontSize: FontSize.xs,
        color: Colors.textSecondary,
    },
    detailValue: {
        fontFamily: FontFamily.semiBold,
        fontSize: FontSize.sm,
        color: Colors.text,
        marginTop: 2,
    },
    // Modal
    modalOverlay: {
        flex: 1,
        backgroundColor: Colors.overlay,
        justifyContent: "center",
        alignItems: "center",
        padding: Spacing.lg,
    },
    modalContent: {
        backgroundColor: Colors.surface,
        borderRadius: BorderRadius.xl,
        padding: Spacing.lg,
        width: "100%",
        maxWidth: 400,
    },
    modalHeader: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: Spacing.md,
    },
    modalTitle: {
        fontFamily: FontFamily.bold,
        fontSize: FontSize.xl,
        color: Colors.text,
    },
    modalSubtitle: {
        fontFamily: FontFamily.regular,
        fontSize: FontSize.sm,
        color: Colors.textSecondary,
        marginBottom: Spacing.lg,
    },
    modalInputContainer: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        paddingVertical: Spacing.lg,
    },
    modalDollar: {
        fontFamily: FontFamily.bold,
        fontSize: FontSize.hero,
        color: Colors.textTertiary,
        marginRight: Spacing.xs,
    },
    modalInput: {
        fontFamily: FontFamily.extraBold,
        fontSize: FontSize.hero,
        color: Colors.text,
        minWidth: 80,
        textAlign: "center",
        outlineStyle: "none" as any,
    },
    modalAvailable: {
        fontFamily: FontFamily.regular,
        fontSize: FontSize.sm,
        color: Colors.textSecondary,
        textAlign: "center",
        marginBottom: Spacing.md,
    },
    modalEstimate: {
        flexDirection: "row",
        alignItems: "center",
        gap: Spacing.xs,
        backgroundColor: Colors.primaryBg,
        padding: Spacing.md,
        borderRadius: BorderRadius.md,
        marginBottom: Spacing.lg,
    },
    modalEstimateText: {
        fontFamily: FontFamily.medium,
        fontSize: FontSize.sm,
        color: Colors.primary,
    },
    modalActions: {
        flexDirection: "row",
        gap: Spacing.md,
    },
});
