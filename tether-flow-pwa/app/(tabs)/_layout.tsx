import React from "react";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Platform, StyleSheet } from "react-native";
import { Colors } from "../../constants/colors";
import { FontFamily, FontSize } from "../../constants/theme";

export default function TabLayout() {
    return (
        <Tabs
            screenOptions={{
                headerShown: false,
                tabBarActiveTintColor: Colors.primary,
                tabBarInactiveTintColor: Colors.textTertiary,
                tabBarLabelStyle: styles.tabLabel,
                tabBarStyle: styles.tabBar,
                tabBarItemStyle: styles.tabItem,
            }}
        >
            <Tabs.Screen
                name="index"
                options={{
                    title: "Wallet",
                    tabBarIcon: ({ color, size }) => (
                        <Ionicons
                            name="wallet-outline"
                            size={size}
                            color={color}
                        />
                    ),
                }}
            />
            <Tabs.Screen
                name="earn"
                options={{
                    title: "Earn",
                    tabBarIcon: ({ color, size }) => (
                        <Ionicons
                            name="trending-up-outline"
                            size={size}
                            color={color}
                        />
                    ),
                }}
            />
            <Tabs.Screen
                name="trade"
                options={{
                    title: "Trade",
                    tabBarIcon: ({ color, size }) => (
                        <Ionicons
                            name="swap-horizontal-outline"
                            size={size}
                            color={color}
                        />
                    ),
                }}
            />
            <Tabs.Screen
                name="bank"
                options={{
                    title: "Bank",
                    tabBarIcon: ({ color, size }) => (
                        <Ionicons
                            name="business-outline"
                            size={size}
                            color={color}
                        />
                    ),
                }}
            />
        </Tabs>
    );
}

const styles = StyleSheet.create({
    tabBar: {
        backgroundColor: Colors.surface,
        borderTopColor: Colors.borderLight,
        borderTopWidth: 1,
        height: Platform.OS === "web" ? 64 : 84,
        paddingBottom: Platform.OS === "web" ? 8 : 28,
        paddingTop: 8,
        elevation: 0,
        shadowOpacity: 0,
    },
    tabLabel: {
        fontFamily: FontFamily.semiBold,
        fontSize: FontSize.xs,
    },
    tabItem: {
        gap: 2,
    },
});
