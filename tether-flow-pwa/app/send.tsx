import React, { useState } from "react";
import {
    View,
    Text,
    TextInput,
    StyleSheet,
    TouchableOpacity,
    KeyboardAvoidingView,
    Platform,
    Alert,
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

export default function SendScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { balance, send } = useWallet();
    const [address, setAddress] = useState("");
    const [amount, setAmount] = useState("");
    const [sending, setSending] = useState(false);
    const [step, setStep] = useState<"form" | "confirm" | "success">("form");
    const [txId, setTxId] = useState("");

    const parsedAmount = parseFloat(amount) || 0;
    const isValid = address.length > 10 && parsedAmount > 0 && parsedAmount <= balance.available;

    const handleSend = async () => {
        if (step === "form") {
            setStep("confirm");
            return;
        }

        setSending(true);
        try {
            const id = await send(address, parsedAmount);
            setTxId(id);
            setStep("success");
        } catch (err) {
            if (Platform.OS === "web") {
                alert("Failed to send. Please try again.");
            } else {
                Alert.alert("Error", "Failed to send. Please try again.");
            }
        } finally {
            setSending(false);
        }
    };

    if (step === "success") {
        return (
            <View
                style={[
                    styles.container,
                    styles.centered,
                    { paddingTop: insets.top },
                ]}
            >
                <View style={styles.successIcon}>
                    <Ionicons
                        name="checkmark-circle"
                        size={80}
                        color={Colors.primary}
                    />
                </View>
                <Text style={styles.successTitle}>Sent!</Text>
                <Text style={styles.successAmount}>
                    ${parsedAmount.toFixed(2)} USDT
                </Text>
                <Text style={styles.successSubtitle}>
                    Transaction submitted successfully
                </Text>
                <View style={styles.successAction}>
                    <Button
                        title="Done"
                        onPress={() => router.back()}
                        size="lg"
                    />
                </View>
            </View>
        );
    }

    return (
        <KeyboardAvoidingView
            style={[styles.container, { paddingTop: insets.top }]}
            behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
            <View style={styles.inner}>
                {/* Header */}
                <View style={styles.header}>
                    <TouchableOpacity
                        onPress={() =>
                            step === "confirm"
                                ? setStep("form")
                                : router.back()
                        }
                        hitSlop={16}
                    >
                        <Ionicons
                            name={
                                step === "confirm"
                                    ? "arrow-back"
                                    : "close"
                            }
                            size={24}
                            color={Colors.text}
                        />
                    </TouchableOpacity>
                    <Text style={styles.headerTitle}>
                        {step === "confirm" ? "Confirm" : "Send USDT"}
                    </Text>
                    <View style={{ width: 24 }} />
                </View>

                {step === "form" ? (
                    <View style={styles.form}>
                        {/* Amount Input */}
                        <View style={styles.amountSection}>
                            <Text style={styles.dollarSign}>$</Text>
                            <TextInput
                                style={styles.amountInput}
                                value={amount}
                                onChangeText={setAmount}
                                placeholder="0.00"
                                placeholderTextColor={Colors.textTertiary}
                                keyboardType="decimal-pad"
                                autoFocus
                            />
                        </View>
                        <Text style={styles.availableText}>
                            Available: ${balance.available.toFixed(2)} USDT
                        </Text>

                        {/* Recipient */}
                        <View style={styles.inputGroup}>
                            <Text style={styles.inputLabel}>Recipient</Text>
                            <View style={styles.inputContainer}>
                                <TextInput
                                    style={styles.textInput}
                                    value={address}
                                    onChangeText={setAddress}
                                    placeholder="Enter wallet address"
                                    placeholderTextColor={Colors.textTertiary}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                />
                                <TouchableOpacity style={styles.pasteButton}>
                                    <Ionicons
                                        name="clipboard-outline"
                                        size={20}
                                        color={Colors.primary}
                                    />
                                </TouchableOpacity>
                            </View>
                        </View>
                    </View>
                ) : (
                    <View style={styles.confirmSection}>
                        <View style={styles.confirmCard}>
                            <View style={styles.confirmRow}>
                                <Text style={styles.confirmLabel}>Amount</Text>
                                <Text style={styles.confirmValue}>
                                    ${parsedAmount.toFixed(2)} USDT
                                </Text>
                            </View>
                            <View style={styles.confirmDivider} />
                            <View style={styles.confirmRow}>
                                <Text style={styles.confirmLabel}>To</Text>
                                <Text
                                    style={styles.confirmAddress}
                                    numberOfLines={1}
                                >
                                    {address.slice(0, 12)}...{address.slice(-8)}
                                </Text>
                            </View>
                            <View style={styles.confirmDivider} />
                            <View style={styles.confirmRow}>
                                <Text style={styles.confirmLabel}>
                                    Network Fee
                                </Text>
                                <Text style={styles.confirmValue}>
                                    ~$0.01
                                </Text>
                            </View>
                        </View>
                    </View>
                )}

                {/* Bottom Action */}
                <View
                    style={[
                        styles.bottomAction,
                        { paddingBottom: Math.max(insets.bottom, Spacing.lg) },
                    ]}
                >
                    <Button
                        title={
                            step === "confirm"
                                ? `Send $${parsedAmount.toFixed(2)}`
                                : "Continue"
                        }
                        onPress={handleSend}
                        size="lg"
                        disabled={!isValid}
                        loading={sending}
                        style={{ width: "100%" } as any}
                    />
                </View>
            </View>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: Colors.background,
    },
    centered: {
        alignItems: "center",
        justifyContent: "center",
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
    form: {
        flex: 1,
        paddingHorizontal: Spacing.lg,
    },
    amountSection: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        paddingVertical: Spacing.xxl,
    },
    dollarSign: {
        fontFamily: FontFamily.bold,
        fontSize: FontSize.hero,
        color: Colors.textTertiary,
        marginRight: Spacing.xs,
    },
    amountInput: {
        fontFamily: FontFamily.extraBold,
        fontSize: FontSize.hero,
        color: Colors.text,
        minWidth: 100,
        textAlign: "center",
        outlineStyle: "none" as any,
    },
    availableText: {
        fontFamily: FontFamily.regular,
        fontSize: FontSize.sm,
        color: Colors.textSecondary,
        textAlign: "center",
        marginBottom: Spacing.xl,
    },
    inputGroup: {
        marginBottom: Spacing.lg,
    },
    inputLabel: {
        fontFamily: FontFamily.semiBold,
        fontSize: FontSize.sm,
        color: Colors.textSecondary,
        marginBottom: Spacing.sm,
    },
    inputContainer: {
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: Colors.surface,
        borderRadius: BorderRadius.lg,
        borderWidth: 1,
        borderColor: Colors.border,
        paddingHorizontal: Spacing.md,
    },
    textInput: {
        flex: 1,
        fontFamily: FontFamily.regular,
        fontSize: FontSize.md,
        color: Colors.text,
        paddingVertical: Spacing.md,
        outlineStyle: "none" as any,
    },
    pasteButton: {
        padding: Spacing.sm,
    },
    confirmSection: {
        flex: 1,
        paddingHorizontal: Spacing.lg,
        paddingTop: Spacing.lg,
    },
    confirmCard: {
        backgroundColor: Colors.surface,
        borderRadius: BorderRadius.xl,
        padding: Spacing.lg,
        ...Shadows.sm,
    },
    confirmRow: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        paddingVertical: Spacing.md,
    },
    confirmLabel: {
        fontFamily: FontFamily.regular,
        fontSize: FontSize.md,
        color: Colors.textSecondary,
    },
    confirmValue: {
        fontFamily: FontFamily.semiBold,
        fontSize: FontSize.md,
        color: Colors.text,
    },
    confirmAddress: {
        fontFamily: FontFamily.medium,
        fontSize: FontSize.sm,
        color: Colors.text,
        maxWidth: 180,
    },
    confirmDivider: {
        height: 1,
        backgroundColor: Colors.borderLight,
    },
    bottomAction: {
        paddingHorizontal: Spacing.lg,
        paddingTop: Spacing.md,
    },
    successIcon: {
        marginBottom: Spacing.lg,
    },
    successTitle: {
        fontFamily: FontFamily.bold,
        fontSize: FontSize.xxl,
        color: Colors.text,
    },
    successAmount: {
        fontFamily: FontFamily.extraBold,
        fontSize: FontSize.xl,
        color: Colors.primary,
        marginTop: Spacing.sm,
    },
    successSubtitle: {
        fontFamily: FontFamily.regular,
        fontSize: FontSize.md,
        color: Colors.textSecondary,
        marginTop: Spacing.sm,
    },
    successAction: {
        marginTop: Spacing.xxl,
        width: 200,
    },
});
