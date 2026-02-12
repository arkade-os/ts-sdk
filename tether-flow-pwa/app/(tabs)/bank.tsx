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
import { ComingSoonBadge } from "../../components/ComingSoon";

interface RampOption {
    icon: keyof typeof Ionicons.glyphMap;
    title: string;
    description: string;
    features: string[];
    color: string;
}

const ON_RAMP: RampOption = {
    icon: "arrow-down-circle-outline",
    title: "Buy USDT",
    description:
        "Purchase USDT directly from your bank account with instant settlement.",
    features: [
        "Bank transfer (ACH/SEPA)",
        "Debit card support",
        "Instant delivery",
        "Low fees",
    ],
    color: Colors.success,
};

const OFF_RAMP: RampOption = {
    icon: "arrow-up-circle-outline",
    title: "Cash Out",
    description:
        "Convert your USDT back to local currency and withdraw to your bank account.",
    features: [
        "Direct bank withdrawal",
        "Competitive rates",
        "Fast processing",
        "No hidden fees",
    ],
    color: Colors.info,
};

export default function BankScreen() {
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
                    <Text style={styles.title}>Bank</Text>
                    <ComingSoonBadge />
                </View>
                <Text style={styles.subtitle}>
                    Connect your bank account to buy and sell USDT
                </Text>
            </View>

            {/* Hero Section */}
            <View style={styles.heroCard}>
                <View style={styles.heroIconRow}>
                    <View
                        style={[
                            styles.heroIcon,
                            { backgroundColor: Colors.primaryBg },
                        ]}
                    >
                        <Ionicons
                            name="business"
                            size={24}
                            color={Colors.primary}
                        />
                    </View>
                    <View style={styles.heroArrows}>
                        <Ionicons
                            name="arrow-forward"
                            size={16}
                            color={Colors.textTertiary}
                        />
                        <Ionicons
                            name="arrow-back"
                            size={16}
                            color={Colors.textTertiary}
                        />
                    </View>
                    <View
                        style={[
                            styles.heroIcon,
                            { backgroundColor: Colors.primaryBg },
                        ]}
                    >
                        <Text style={styles.heroTether}>₮</Text>
                    </View>
                </View>
                <Text style={styles.heroTitle}>
                    Bank ↔ USDT
                </Text>
                <Text style={styles.heroDescription}>
                    Seamlessly move money between your bank account and your
                    Tether Flow wallet. On-ramp and off-ramp with ease.
                </Text>
            </View>

            {/* On-Ramp Card */}
            <View style={styles.rampSection}>
                <RampCard option={ON_RAMP} />
            </View>

            {/* Off-Ramp Card */}
            <View style={styles.rampSection}>
                <RampCard option={OFF_RAMP} />
            </View>

            {/* Security Note */}
            <View style={styles.securityCard}>
                <View style={styles.securityHeader}>
                    <Ionicons
                        name="shield-checkmark"
                        size={24}
                        color={Colors.primary}
                    />
                    <Text style={styles.securityTitle}>
                        Secure & Compliant
                    </Text>
                </View>
                <View style={styles.securityFeatures}>
                    <View style={styles.securityFeature}>
                        <Ionicons
                            name="checkmark"
                            size={16}
                            color={Colors.primary}
                        />
                        <Text style={styles.securityText}>
                            Bank-grade encryption
                        </Text>
                    </View>
                    <View style={styles.securityFeature}>
                        <Ionicons
                            name="checkmark"
                            size={16}
                            color={Colors.primary}
                        />
                        <Text style={styles.securityText}>
                            KYC/AML compliant
                        </Text>
                    </View>
                    <View style={styles.securityFeature}>
                        <Ionicons
                            name="checkmark"
                            size={16}
                            color={Colors.primary}
                        />
                        <Text style={styles.securityText}>
                            Licensed money transmitter
                        </Text>
                    </View>
                </View>
            </View>

            {/* Notify */}
            <View style={styles.notifyCard}>
                <Ionicons
                    name="notifications-outline"
                    size={24}
                    color={Colors.primary}
                />
                <View style={styles.notifyContent}>
                    <Text style={styles.notifyTitle}>Get Notified</Text>
                    <Text style={styles.notifyDescription}>
                        Bank integration is coming soon. We'll notify you when
                        it's ready.
                    </Text>
                </View>
            </View>
        </ScrollView>
    );
}

function RampCard({ option }: { option: RampOption }) {
    return (
        <View style={styles.rampCard}>
            <View style={styles.rampHeader}>
                <View
                    style={[
                        styles.rampIcon,
                        { backgroundColor: option.color + "15" },
                    ]}
                >
                    <Ionicons
                        name={option.icon}
                        size={28}
                        color={option.color}
                    />
                </View>
                <View style={styles.rampTitleRow}>
                    <Text style={styles.rampTitle}>{option.title}</Text>
                    <ComingSoonBadge compact />
                </View>
            </View>
            <Text style={styles.rampDescription}>{option.description}</Text>
            <View style={styles.rampFeatures}>
                {option.features.map((feature, i) => (
                    <View key={i} style={styles.rampFeature}>
                        <Ionicons
                            name="checkmark-circle"
                            size={16}
                            color={option.color}
                        />
                        <Text style={styles.rampFeatureText}>{feature}</Text>
                    </View>
                ))}
            </View>
        </View>
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
    heroCard: {
        backgroundColor: Colors.surface,
        borderRadius: BorderRadius.xl,
        padding: Spacing.lg,
        marginHorizontal: Spacing.md,
        marginBottom: Spacing.lg,
        alignItems: "center",
        ...Shadows.md,
    },
    heroIconRow: {
        flexDirection: "row",
        alignItems: "center",
        gap: Spacing.md,
        marginBottom: Spacing.md,
    },
    heroIcon: {
        width: 56,
        height: 56,
        borderRadius: BorderRadius.full,
        alignItems: "center",
        justifyContent: "center",
    },
    heroArrows: {
        gap: 2,
    },
    heroTether: {
        fontFamily: FontFamily.extraBold,
        fontSize: 28,
        color: Colors.primary,
    },
    heroTitle: {
        fontFamily: FontFamily.bold,
        fontSize: FontSize.xl,
        color: Colors.text,
        marginBottom: Spacing.sm,
    },
    heroDescription: {
        fontFamily: FontFamily.regular,
        fontSize: FontSize.sm,
        color: Colors.textSecondary,
        textAlign: "center",
        lineHeight: 20,
    },
    rampSection: {
        paddingHorizontal: Spacing.md,
        marginBottom: Spacing.md,
    },
    rampCard: {
        backgroundColor: Colors.surface,
        borderRadius: BorderRadius.xl,
        padding: Spacing.lg,
        ...Shadows.sm,
    },
    rampHeader: {
        flexDirection: "row",
        alignItems: "center",
        gap: Spacing.md,
        marginBottom: Spacing.md,
    },
    rampIcon: {
        width: 52,
        height: 52,
        borderRadius: BorderRadius.lg,
        alignItems: "center",
        justifyContent: "center",
    },
    rampTitleRow: {
        flex: 1,
        flexDirection: "row",
        alignItems: "center",
        gap: Spacing.sm,
    },
    rampTitle: {
        fontFamily: FontFamily.bold,
        fontSize: FontSize.lg,
        color: Colors.text,
    },
    rampDescription: {
        fontFamily: FontFamily.regular,
        fontSize: FontSize.sm,
        color: Colors.textSecondary,
        lineHeight: 20,
        marginBottom: Spacing.md,
    },
    rampFeatures: {
        gap: Spacing.sm,
    },
    rampFeature: {
        flexDirection: "row",
        alignItems: "center",
        gap: Spacing.sm,
    },
    rampFeatureText: {
        fontFamily: FontFamily.medium,
        fontSize: FontSize.sm,
        color: Colors.text,
    },
    securityCard: {
        backgroundColor: Colors.surface,
        borderRadius: BorderRadius.xl,
        padding: Spacing.lg,
        marginHorizontal: Spacing.md,
        marginBottom: Spacing.lg,
        ...Shadows.sm,
    },
    securityHeader: {
        flexDirection: "row",
        alignItems: "center",
        gap: Spacing.sm,
        marginBottom: Spacing.md,
    },
    securityTitle: {
        fontFamily: FontFamily.bold,
        fontSize: FontSize.lg,
        color: Colors.text,
    },
    securityFeatures: {
        gap: Spacing.sm,
    },
    securityFeature: {
        flexDirection: "row",
        alignItems: "center",
        gap: Spacing.sm,
    },
    securityText: {
        fontFamily: FontFamily.medium,
        fontSize: FontSize.sm,
        color: Colors.textSecondary,
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
