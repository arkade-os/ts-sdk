import type { IWallet } from ".";

export interface WalletRestoreHook {
    id: string;
    restore(wallet: IWallet): Promise<void>;
}

const restoreHooks = new WeakMap<IWallet, WalletRestoreHook[]>();

export function registerWalletRestoreHook(wallet: IWallet, hook: WalletRestoreHook): () => void {
    const hooks = restoreHooks.get(wallet) ?? [];
    const entry = { ...hook };
    const existing = hooks.findIndex(({ id }) => id === hook.id);
    if (existing === -1) hooks.push(entry);
    else hooks[existing] = entry;
    restoreHooks.set(wallet, hooks);

    return () => {
        const current = restoreHooks.get(wallet);
        if (!current) return;
        const index = current.indexOf(entry);
        if (index === -1) return;
        current.splice(index, 1);
        if (current.length === 0) restoreHooks.delete(wallet);
    };
}

/** @internal */
export async function runWalletRestoreHooks(wallet: IWallet): Promise<void> {
    const snapshot = [...(restoreHooks.get(wallet) ?? [])];
    const errors: unknown[] = [];
    for (const hook of snapshot) {
        try {
            await hook.restore(wallet);
        } catch (error) {
            errors.push(error);
        }
    }
    if (errors.length > 0) {
        throw new AggregateError(errors, "Wallet restore hooks failed");
    }
}
