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

const addressOf = (pkScript: Uint8Array, network: OnchainNetwork): string =>
    btc.Address(L1_NETWORKS[network]).encode(btc.OutScript.decode(pkScript));

/** `network` is `requestOnchainSend`'s `l1Network`, and only decodes scripts to
 *  addresses — the provider decides which chain is read, so mismatching the two
 *  yields addresses it knows nothing about rather than an error. */
export const chainSourceFrom = (
    provider: OnchainProvider,
    network: OnchainNetwork,
): ChainSource => {
    const spenderFromHistory = async (
        txid: string,
        vout: number,
        pkScript: Uint8Array,
    ): Promise<string | undefined> => {
        const txs = await provider.getTransactions(addressOf(pkScript, network));
        return txs.find((tx) => tx.vin?.some((i) => i.txid === txid && i.vout === vout))?.txid;
    };

    return {
        async getScriptUtxos(pkScript: Uint8Array): Promise<ChainUtxo[]> {
            const address = addressOf(pkScript, network);
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

        async getSpendingTx(
            txid: string,
            vout: number,
            pkScript: Uint8Array,
        ): Promise<{ txHex: string } | null> {
            const outspends = await provider.getTxOutspends(txid);
            const outspend = outspends[vout];
            if (!outspend?.spent) return null;
            // `||`: some deployments omit the txid, electrum sends `""` when
            // unspent. Null here would read a CLAIMED htlc as unfunded.
            const spender = outspend.txid || (await spenderFromHistory(txid, vout, pkScript));
            if (!spender) return null;
            const raw = await provider.getRawTransaction(spender);
            return { txHex: hex.encode(raw) };
        },

        broadcast(txHex: string): Promise<string> {
            return provider.broadcastTransaction(txHex);
        },

        async getMtp(): Promise<number> {
            return (await provider.getChainTip()).time;
        },
    };
};
