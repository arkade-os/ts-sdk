import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "../constants/colors";
import {
    FontFamily,
    FontSize,
    Spacing,
    BorderRadius,
    Shadows,
} from "../constants/theme";
import { TetherBalance } from "../services/wallet";

interface BalanceCardProps {
    balance: TetherBalance;
    onSend: () => void;
    onReceive: () => void;
}

export function BalanceCard({ balance, onSend, onReceive }: BalanceCardProps) {
    return (
        <View style={styles.container}>
            <View style={styles.balanceSection}>
                <Text style={styles.label}>Total Balance</Text>
                <Text style={styles.amount}>
                    ${balance.total.toLocaleString("en-US", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                    })}
                </Text>
                <Text style={styles.currency}>USDT</Text>
            </View>

            {balance.locked > 0 && (
                <View style={styles.breakdown}>
                    <View style={styles.breakdownItem}>
                        <Text style={styles.breakdownLabel}>Available</Text>
                        <Text style={styles.breakdownValue}>
                            ${balance.available.toFixed(2)}
                        </Text>
                    </View>
                    <View style={styles.breakdownDivider} />
                    <View style={styles.breakdownItem}>
                        <Text style={styles.breakdownLabel}>Locked</Text>
                        <Text style={styles.breakdownValue}>
                            ${balance.locked.toFixed(2)}
                        </Text>
                    </View>
                </View>
            )}

            <View style={styles.actions}>
                <TouchableOpacity
                    style={styles.actionButton}
                    onPress={onSend}
                    activeOpacity={0.8}
                >
                    <View style={styles.actionIcon}>
                        <Ionicons
                            name="arrow-up"
                            size={22}
                            color={Colors.textInverse}
                        />
                    </View>
                    <Text style={styles.actionText}>Send</Text>
                </TouchableOpacity>

                <TouchableOpacity
                    style={styles.actionButton}
                    onPress={onReceive}
                    activeOpacity={0.8}
                >
                    <View style={styles.actionIcon}>
                        <Ionicons
                            name="arrow-down"
                            size={22}
                            color={Colors.textInverse}
                        />
                    </View>
                    <Text style={styles.actionText}>Receive</Text>
                </TouchableOpacity>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        backgroundColor: Colors.surface,
        borderRadius: BorderRadius.xl,
        padding: Spacing.lg,
        marginHorizontal: Spacing.md,
        ...Shadows.md,
    },
    balanceSection: {
        alignItems: "center",
        paddingVertical: Spacing.md,
    },
    label: {
        fontFamily: FontFamily.medium,
        fontSize: FontSize.sm,
        color: Colors.textSecondary,
        marginBottom: Spacing.xs,
    },
    amount: {
        fontFamily: FontFamily.extraBold,
        fontSize: FontSize.hero,
        color: Colors.text,
        letterSpacing: -1,
    },
    currency: {
        fontFamily: FontFamily.semiBold,
        fontSize: FontSize.sm,
        color: Colors.primary,
        marginTop: Spacing.xs,
        letterSpacing: 1.5,
    },
    breakdown: {
        flexDirection: "row",
        backgroundColor: Colors.background,
        borderRadius: BorderRadius.md,
        padding: Spacing.md,
        marginTop: Spacing.md,
        gap: Spacing.md,
    },
    breakdownItem: {
        flex: 1,
        alignItems: "center",
    },
    breakdownLabel: {
        fontFamily: FontFamily.regular,
        fontSize: FontSize.xs,
        color: Colors.textSecondary,
    },
    breakdownValue: {
        fontFamily: FontFamily.semiBold,
        fontSize: FontSize.md,
        color: Colors.text,
        marginTop: 2,
    },
    breakdownDivider: {
        width: 1,
        backgroundColor: Colors.border,
    },
    actions: {
        flexDirection: "row",
        gap: Spacing.md,
        marginTop: Spacing.lg,
    },
    actionButton: {
        flex: 1,
        alignItems: "center",
        gap: Spacing.sm,
    },
    actionIcon: {
        width: 52,
        height: 52,
        borderRadius: BorderRadius.full,
        backgroundColor: Colors.primary,
        alignItems: "center",
        justifyContent: "center",
    },
    actionText: {
        fontFamily: FontFamily.semiBold,
        fontSize: FontSize.sm,
        color: Colors.text,
    },
});
