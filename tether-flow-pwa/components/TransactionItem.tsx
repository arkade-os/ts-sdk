import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "../constants/colors";
import {
    FontFamily,
    FontSize,
    Spacing,
    BorderRadius,
} from "../constants/theme";
import { TetherTransaction } from "../services/wallet";

interface TransactionItemProps {
    transaction: TetherTransaction;
    onPress?: () => void;
}

export function TransactionItem({ transaction, onPress }: TransactionItemProps) {
    const isSent = transaction.type === "sent";
    const iconName = isSent ? "arrow-up" : "arrow-down";
    const iconColor = isSent ? Colors.sent : Colors.received;
    const iconBg = isSent ? "#FEF2F2" : "#ECFDF5";
    const sign = isSent ? "-" : "+";
    const amountColor = isSent ? Colors.sent : Colors.received;

    const truncatedAddress =
        transaction.address.slice(0, 8) +
        "..." +
        transaction.address.slice(-6);

    const timeStr = formatTime(transaction.timestamp);

    return (
        <TouchableOpacity
            style={styles.container}
            onPress={onPress}
            activeOpacity={0.7}
        >
            <View style={[styles.iconContainer, { backgroundColor: iconBg }]}>
                <Ionicons name={iconName} size={20} color={iconColor} />
            </View>
            <View style={styles.details}>
                <Text style={styles.type}>
                    {isSent ? "Sent" : "Received"}
                </Text>
                <Text style={styles.address}>{truncatedAddress}</Text>
            </View>
            <View style={styles.amountContainer}>
                <Text style={[styles.amount, { color: amountColor }]}>
                    {sign}${transaction.amount.toFixed(2)}
                </Text>
                <Text style={styles.time}>{timeStr}</Text>
            </View>
        </TouchableOpacity>
    );
}

function formatTime(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);

    if (diffMin < 1) return "Just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHr < 24) return `${diffHr}h ago`;
    if (diffDay < 7) return `${diffDay}d ago`;
    return date.toLocaleDateString();
}

const styles = StyleSheet.create({
    container: {
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: Spacing.md,
        paddingHorizontal: Spacing.md,
        gap: Spacing.md,
    },
    iconContainer: {
        width: 44,
        height: 44,
        borderRadius: BorderRadius.full,
        alignItems: "center",
        justifyContent: "center",
    },
    details: {
        flex: 1,
    },
    type: {
        fontFamily: FontFamily.semiBold,
        fontSize: FontSize.md,
        color: Colors.text,
    },
    address: {
        fontFamily: FontFamily.regular,
        fontSize: FontSize.sm,
        color: Colors.textSecondary,
        marginTop: 2,
    },
    amountContainer: {
        alignItems: "flex-end",
    },
    amount: {
        fontFamily: FontFamily.bold,
        fontSize: FontSize.md,
    },
    time: {
        fontFamily: FontFamily.regular,
        fontSize: FontSize.xs,
        color: Colors.textTertiary,
        marginTop: 2,
    },
});
