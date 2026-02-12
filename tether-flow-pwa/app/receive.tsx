import React, { useState } from "react";
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    Platform,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "../constants/colors";
import {
    FontFamily,
    FontSize,
    Spacing,
    BorderRadius,
    Shadows,
} from "../constants/theme";
import { Button } from "../components/Button";
import { useWallet } from "../hooks/useWallet";

export default function ReceiveScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { address } = useWallet();
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        try {
            if (Platform.OS === "web" && navigator.clipboard) {
                await navigator.clipboard.writeText(address);
            }
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard might not be available
        }
    };

    const handleShare = async () => {
        if (Platform.OS === "web" && navigator.share) {
            try {
                await navigator.share({
                    title: "Tether Flow Address",
                    text: `Send USDT to: ${address}`,
                });
            } catch {
                // User cancelled or share not supported
            }
        } else {
            handleCopy();
        }
    };

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            <View style={styles.inner}>
                {/* Header */}
                <View style={styles.header}>
                    <TouchableOpacity
                        onPress={() => router.back()}
                        hitSlop={16}
                    >
                        <Ionicons name="close" size={24} color={Colors.text} />
                    </TouchableOpacity>
                    <Text style={styles.headerTitle}>Receive USDT</Text>
                    <View style={{ width: 24 }} />
                </View>

                <View style={styles.content}>
                    {/* QR Code Area */}
                    <View style={styles.qrCard}>
                        <View style={styles.qrContainer}>
                            {/* QR Code placeholder - uses a grid pattern to simulate QR */}
                            <View style={styles.qrPlaceholder}>
                                <View style={styles.qrInner}>
                                    <Ionicons
                                        name="qr-code"
                                        size={160}
                                        color={Colors.text}
                                    />
                                </View>
                            </View>
                        </View>

                        <Text style={styles.instructionText}>
                            Scan this QR code to send USDT to this wallet
                        </Text>
                    </View>

                    {/* Address */}
                    <View style={styles.addressSection}>
                        <Text style={styles.addressLabel}>Wallet Address</Text>
                        <TouchableOpacity
                            style={styles.addressContainer}
                            onPress={handleCopy}
                            activeOpacity={0.7}
                        >
                            <Text
                                style={styles.addressText}
                                numberOfLines={2}
                            >
                                {address}
                            </Text>
                            <View style={styles.copyIcon}>
                                <Ionicons
                                    name={
                                        copied
                                            ? "checkmark"
                                            : "copy-outline"
                                    }
                                    size={20}
                                    color={
                                        copied
                                            ? Colors.success
                                            : Colors.primary
                                    }
                                />
                            </View>
                        </TouchableOpacity>
                        {copied && (
                            <Text style={styles.copiedText}>
                                Copied to clipboard!
                            </Text>
                        )}
                    </View>

                    {/* Actions */}
                    <View style={styles.actions}>
                        <Button
                            title="Copy Address"
                            onPress={handleCopy}
                            variant="primary"
                            size="lg"
                            icon={
                                <Ionicons
                                    name="copy-outline"
                                    size={20}
                                    color={Colors.textInverse}
                                />
                            }
                            style={{ flex: 1 } as any}
                        />
                        <Button
                            title="Share"
                            onPress={handleShare}
                            variant="outline"
                            size="lg"
                            icon={
                                <Ionicons
                                    name="share-outline"
                                    size={20}
                                    color={Colors.primary}
                                />
                            }
                            style={{ flex: 1 } as any}
                        />
                    </View>
                </View>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: Colors.background,
    },
    inner: {
        flex: 1,
        maxWidth: 480,
        width: "100%",
        alignSelf: "center",
    },
    header: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: Spacing.lg,
        paddingVertical: Spacing.md,
    },
    headerTitle: {
        fontFamily: FontFamily.bold,
        fontSize: FontSize.lg,
        color: Colors.text,
    },
    content: {
        flex: 1,
        paddingHorizontal: Spacing.lg,
        paddingTop: Spacing.lg,
    },
    qrCard: {
        backgroundColor: Colors.surface,
        borderRadius: BorderRadius.xl,
        padding: Spacing.lg,
        alignItems: "center",
        ...Shadows.md,
    },
    qrContainer: {
        padding: Spacing.md,
        backgroundColor: Colors.surface,
        borderRadius: BorderRadius.lg,
    },
    qrPlaceholder: {
        width: 200,
        height: 200,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: Colors.surface,
        borderRadius: BorderRadius.md,
    },
    qrInner: {
        alignItems: "center",
        justifyContent: "center",
    },
    instructionText: {
        fontFamily: FontFamily.regular,
        fontSize: FontSize.sm,
        color: Colors.textSecondary,
        textAlign: "center",
        marginTop: Spacing.md,
        lineHeight: 20,
    },
    addressSection: {
        marginTop: Spacing.lg,
    },
    addressLabel: {
        fontFamily: FontFamily.semiBold,
        fontSize: FontSize.sm,
        color: Colors.textSecondary,
        marginBottom: Spacing.sm,
    },
    addressContainer: {
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: Colors.surface,
        borderRadius: BorderRadius.lg,
        padding: Spacing.md,
        borderWidth: 1,
        borderColor: Colors.border,
        gap: Spacing.sm,
    },
    addressText: {
        flex: 1,
        fontFamily: FontFamily.medium,
        fontSize: FontSize.sm,
        color: Colors.text,
        lineHeight: 20,
    },
    copyIcon: {
        padding: Spacing.xs,
    },
    copiedText: {
        fontFamily: FontFamily.medium,
        fontSize: FontSize.xs,
        color: Colors.success,
        marginTop: Spacing.xs,
        textAlign: "center",
    },
    actions: {
        flexDirection: "row",
        gap: Spacing.md,
        marginTop: Spacing.xl,
    },
});
