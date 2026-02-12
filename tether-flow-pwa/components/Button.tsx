import React from "react";
import {
    TouchableOpacity,
    Text,
    StyleSheet,
    ActivityIndicator,
    ViewStyle,
    TextStyle,
} from "react-native";
import { Colors } from "../constants/colors";
import { FontFamily, FontSize, Spacing, BorderRadius } from "../constants/theme";

interface ButtonProps {
    title: string;
    onPress: () => void;
    variant?: "primary" | "secondary" | "outline" | "ghost";
    size?: "sm" | "md" | "lg";
    loading?: boolean;
    disabled?: boolean;
    icon?: React.ReactNode;
    style?: ViewStyle;
}

export function Button({
    title,
    onPress,
    variant = "primary",
    size = "md",
    loading = false,
    disabled = false,
    icon,
    style,
}: ButtonProps) {
    const buttonStyles: ViewStyle[] = [
        styles.base,
        styles[`${variant}Button`],
        styles[`${size}Size`],
        disabled && styles.disabled,
        style as ViewStyle,
    ].filter(Boolean) as ViewStyle[];

    const textStyles: TextStyle[] = [
        styles.baseText,
        styles[`${variant}Text`],
        styles[`${size}Text`],
    ].filter(Boolean) as TextStyle[];

    return (
        <TouchableOpacity
            style={buttonStyles}
            onPress={onPress}
            disabled={disabled || loading}
            activeOpacity={0.8}
        >
            {loading ? (
                <ActivityIndicator
                    color={
                        variant === "primary"
                            ? Colors.textInverse
                            : Colors.primary
                    }
                    size="small"
                />
            ) : (
                <>
                    {icon}
                    <Text style={textStyles}>{title}</Text>
                </>
            )}
        </TouchableOpacity>
    );
}

const styles = StyleSheet.create({
    base: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: Spacing.sm,
    },
    disabled: {
        opacity: 0.5,
    },

    // Variants
    primaryButton: {
        backgroundColor: Colors.primary,
        borderRadius: BorderRadius.lg,
    },
    secondaryButton: {
        backgroundColor: Colors.primaryBg,
        borderRadius: BorderRadius.lg,
    },
    outlineButton: {
        backgroundColor: "transparent",
        borderRadius: BorderRadius.lg,
        borderWidth: 1.5,
        borderColor: Colors.primary,
    },
    ghostButton: {
        backgroundColor: "transparent",
        borderRadius: BorderRadius.lg,
    },

    // Sizes
    smSize: {
        paddingHorizontal: Spacing.md,
        paddingVertical: Spacing.sm,
        minHeight: 36,
    },
    mdSize: {
        paddingHorizontal: Spacing.lg,
        paddingVertical: Spacing.md,
        minHeight: 48,
    },
    lgSize: {
        paddingHorizontal: Spacing.xl,
        paddingVertical: 18,
        minHeight: 56,
    },

    // Text
    baseText: {
        fontFamily: FontFamily.semiBold,
    },
    primaryText: {
        color: Colors.textInverse,
    },
    secondaryText: {
        color: Colors.primary,
    },
    outlineText: {
        color: Colors.primary,
    },
    ghostText: {
        color: Colors.primary,
    },
    smText: {
        fontSize: FontSize.sm,
    },
    mdText: {
        fontSize: FontSize.md,
    },
    lgText: {
        fontSize: FontSize.lg,
    },
});
