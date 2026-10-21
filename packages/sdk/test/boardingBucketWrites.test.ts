import { describe, expect, it, vi } from "vitest";
import { Wallet } from "../src/wallet/wallet";

const utxo = (fill: string) => ({
    txid: fill.repeat(32),
    vout: 0,
    value: 5_000,
    status: { confirmed: true },
});

describe("updateDbAfterSettle boarding writes", () => {
    it("keeps both removals when two settles finish together", async () => {
        const [a, b, c] = ["aa", "bb", "cc"].map(utxo);
        let stored = [a, b, c];
        const thisArg = {
            walletRepository: {
                saveVtxos: vi.fn(),
                getUtxosPage: async () => {
                    const items = [...stored];
                    await new Promise((r) => setTimeout(r, 5));
                    return { items };
                },
                deleteUtxos: async () => {
                    stored = [];
                },
                saveUtxos: async (_address: string, utxos: typeof stored) => {
                    stored = [...stored, ...utxos];
                },
            },
            getContractManager: async () => ({
                annotateVtxos: async () => [],
                getContracts: async () => [],
            }),
            boardingTapscript: { onchainAddress: () => "bcrt1qboarding" },
            network: { bech32: "bcrt" },
        };
        const settle = (input: ReturnType<typeof utxo>) =>
            (Wallet.prototype as any).updateDbAfterSettle.call(thisArg, [input], "commitment");

        await Promise.all([settle(a), settle(b)]);

        expect(stored.map((u) => u.txid)).toEqual([c.txid]);
    });
});
