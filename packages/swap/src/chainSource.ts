/**
 * {@link ChainSource} over the SDK's own {@link OnchainProvider}, rather than a
 * second onchain interface per consumer. Outputs are looked up by ADDRESS:
 * esplora's `/scripthash/:hash/utxo` takes a byte-reversed hash, and the wrong
 * endianness returns an empty list rather than an error — indistinguishable
 * from "not funded yet", so the bug surfaces as a claim window that expired.
 */
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import type { OnchainProvider } from "@arkade-os/sdk";
import type { ChainSource, ChainUtxo, OnchainNetwork } from "./onchainHtlc";
import { L1_NETWORKS } from "./onchainHtlc";

/** `network` is `requestOnchainSend`'s `l1Network`, and only decodes scripts to
 *  addresses — the provider decides which chain is read, so mismatching the two
 *  yields addresses it knows nothing about rather than an error. */
export const chainSourceFrom = (
    provider: OnchainProvider,
    network: OnchainNetwork,
): ChainSource => ({
    async getScriptUtxos(pkScript: Uint8Array): Promise<ChainUtxo[]> {
        const address = btc.Address(L1_NETWORKS[network]).encode(btc.OutScript.decode(pkScript));
        const [coins, tip] = await Promise.all([
            provider.getCoins(address),
            provider.getChainTip(),
        ]);
        return coins.map((coin) => ({
            txid: coin.txid,
            vout: coin.vout,
            amount: BigInt(coin.value),
            // Zero, not one: calling a mempool output "1 deep" would let a
            // 1-confirmation policy claim against a replaceable transaction.
            confirmations:
                coin.status.confirmed && typeof coin.status.block_height === "number"
                    ? Math.max(0, tip.height - coin.status.block_height + 1)
                    : 0,
        }));
    },

    async getSpendingTx(txid: string, vout: number): Promise<{ txHex: string } | null> {
        const outspends = await provider.getTxOutspends(txid);
        const outspend = outspends[vout];
        // Some deployments omit the spender txid even when `spent` is true; the
        // only caller reads P out of the spend and retries.
        if (!outspend?.spent || !outspend.txid) return null;
        const raw = await provider.getRawTransaction(outspend.txid);
        return { txHex: hex.encode(raw) };
    },

    broadcast(txHex: string): Promise<string> {
        return provider.broadcastTransaction(txHex);
    },

    async getMtp(): Promise<number> {
        return (await provider.getChainTip()).time;
    },
});
