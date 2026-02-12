import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "../constants/colors";
import {
    FontFamily,
    FontSize,
    Spacing,
    BorderRadius,
} from "../constants/theme";

interface ComingSoonBadgeProps {
    compact?: boolean;
}

export function ComingSoonBadge({ compact }: ComingSoonBadgeProps) {
    return (
        <View style={[styles.badge, compact && styles.badgeCompact]}>
            <Text style={[styles.badgeText, compact && styles.badgeTextCompact]}>
                Coming Soon
            </Text>
        </View>
    );
}

interface ComingSoonCardProps {
    icon: keyof typeof Ionicons.glyphMap;
    title: string;
    description: string;
}

export function ComingSoonCard({ icon, title, description }: ComingSoonCardProps) {
    return (
        <View style={styles.card}>
            <View style={styles.cardIcon}>
                <Ionicons name={icon} size={24} color={Colors.textTertiary} />
            </View>
            <View style={styles.cardContent}>
                <View style={styles.cardHeader}>
                    <Text style={styles.cardTitle}>{title}</Text>
                    <ComingSoonBadge compact />
                </View>
                <Text style={styles.cardDescription}>{description}</Text>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    badge: {
        backgroundColor: Colors.primaryBg,
        paddingHorizontal: Spacing.md,
        paddingVertical: Spacing.xs,
        borderRadius: BorderRadius.full,
    },
    badgeCompact: {
        paddingHorizontal: Spacing.sm,
        paddingVertical: 2,
    },
    badgeText: {
        fontFamily: FontFamily.semiBold,
        fontSize: FontSize.sm,
        color: Colors.primary,
    },
    badgeTextCompact: {
        fontSize: FontSize.xs,
    },
    card: {
        flexDirection: "row",
        backgroundColor: Colors.surface,
        borderRadius: BorderRadius.lg,
        padding: Spacing.md,
        gap: Spacing.md,
        borderWidth: 1,
        borderColor: Colors.borderLight,
    },
    cardIcon: {
        width: 48,
        height: 48,
        borderRadius: BorderRadius.md,
        backgroundColor: Colors.comingSoon,
        alignItems: "center",
        justifyContent: "center",
    },
    cardContent: {
        flex: 1,
    },
    cardHeader: {
        flexDirection: "row",
        alignItems: "center",
        gap: Spacing.sm,
        marginBottom: 4,
    },
    cardTitle: {
        fontFamily: FontFamily.semiBold,
        fontSize: FontSize.md,
        color: Colors.text,
    },
    cardDescription: {
        fontFamily: FontFamily.regular,
        fontSize: FontSize.sm,
        color: Colors.textSecondary,
        lineHeight: 18,
    },
});
