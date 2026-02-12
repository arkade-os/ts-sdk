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

interface EmptyStateProps {
    icon: keyof typeof Ionicons.glyphMap;
    title: string;
    description: string;
    children?: React.ReactNode;
}

export function EmptyState({
    icon,
    title,
    description,
    children,
}: EmptyStateProps) {
    return (
        <View style={styles.container}>
            <View style={styles.iconContainer}>
                <Ionicons name={icon} size={48} color={Colors.primaryLight} />
            </View>
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.description}>{description}</Text>
            {children && <View style={styles.action}>{children}</View>}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: Spacing.xl,
        paddingVertical: Spacing.xxl,
    },
    iconContainer: {
        width: 96,
        height: 96,
        borderRadius: BorderRadius.full,
        backgroundColor: Colors.primaryBg,
        alignItems: "center",
        justifyContent: "center",
        marginBottom: Spacing.lg,
    },
    title: {
        fontFamily: FontFamily.bold,
        fontSize: FontSize.xl,
        color: Colors.text,
        textAlign: "center",
        marginBottom: Spacing.sm,
    },
    description: {
        fontFamily: FontFamily.regular,
        fontSize: FontSize.md,
        color: Colors.textSecondary,
        textAlign: "center",
        lineHeight: 22,
        maxWidth: 280,
    },
    action: {
        marginTop: Spacing.lg,
    },
});
