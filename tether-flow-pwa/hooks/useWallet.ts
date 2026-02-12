import { useState, useEffect, useCallback } from "react";
import {
    walletService,
    TetherBalance,
    TetherTransaction,
    LockupPosition,
} from "../services/wallet";

export function useWallet() {
    const [balance, setBalance] = useState<TetherBalance>({
        available: 0,
        locked: 0,
        total: 0,
    });
    const [transactions, setTransactions] = useState<TetherTransaction[]>([]);
    const [loading, setLoading] = useState(true);
    const [address, setAddress] = useState<string>("");
    const [initialized, setInitialized] = useState(false);

    const refresh = useCallback(async () => {
        try {
            const [bal, txs, addr] = await Promise.all([
                walletService.getBalance(),
                walletService.getTransactions(),
                walletService.getAddress(),
            ]);
            setBalance(bal);
            setTransactions(txs);
            setAddress(addr);
        } catch (err) {
            console.error("Failed to refresh wallet:", err);
        }
    }, []);

    useEffect(() => {
        async function init() {
            try {
                await walletService.initialize();
                setInitialized(true);
                await refresh();
            } catch (err) {
                console.error("Failed to initialize wallet:", err);
            } finally {
                setLoading(false);
            }
        }
        init();
    }, [refresh]);

    const send = useCallback(
        async (toAddress: string, amount: number) => {
            const txId = await walletService.send(toAddress, amount);
            await refresh();
            return txId;
        },
        [refresh]
    );

    return {
        balance,
        transactions,
        loading,
        address,
        initialized,
        refresh,
        send,
    };
}

export function useEarn() {
    const [lockups, setLockups] = useState<LockupPosition[]>([]);
    const [loading, setLoading] = useState(true);
    const [totalLocked, setTotalLocked] = useState(0);
    const [totalEarned, setTotalEarned] = useState(0);

    const refresh = useCallback(async () => {
        try {
            const positions = await walletService.getLockups();
            setLockups(positions);
            setTotalLocked(
                positions
                    .filter((p) => p.status === "active")
                    .reduce((sum, p) => sum + p.amount, 0)
            );
            setTotalEarned(positions.reduce((sum, p) => sum + p.earned, 0));
        } catch (err) {
            console.error("Failed to refresh earn:", err);
        }
    }, []);

    useEffect(() => {
        async function init() {
            await refresh();
            setLoading(false);
        }
        init();
    }, [refresh]);

    const createLockup = useCallback(
        async (amount: number) => {
            await walletService.createLockup(amount);
            await refresh();
        },
        [refresh]
    );

    const unlock = useCallback(
        async (lockupId: string) => {
            await walletService.unlockPosition(lockupId);
            await refresh();
        },
        [refresh]
    );

    return {
        lockups,
        loading,
        totalLocked,
        totalEarned,
        refresh,
        createLockup,
        unlock,
    };
}
