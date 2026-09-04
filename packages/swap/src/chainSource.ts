/**
 * {@link ChainSource} over the SDK's own {@link OnchainProvider}.
 *
 * `onchainHtlc.ts` keeps the package backend-free — it derives the HTLC,
 * decides when a fill is claimable, and builds the claim, but every read and
 * the broadcast belong to the caller. That left every consumer writing its own
 * esplora client, and the Arkade wallet's is two hundred lines that already
 * exist in `@arkade-os/sdk` as `EsploraProvider` / `ElectrumOnchainProvider`.
 * This is the adapter between the two, so a consumer that already has a
 * provider configured for its network has a `ChainSource` for free.
 *
 * Deliberately an adapter over the existing interface rather than a second
 * onchain interface: the SDK's provider is the one a wallet already builds, it
 * ships two implementations, and its `ESPLORA_URL` / `ELECTRUM_WS_URL` tables
 * already resolve a network to an endpoint.
 *
 * Two mappings are not one-to-one, and both are the kind of mistake that shows
 * up as a lost claim rather than as an error:
 *
 * **Outputs are looked up by ADDRESS.** `getScriptUtxos` is handed a `pkScript`
 * and the provider is keyed by address, so the script is decoded. Esplora does
 * expose `/scripthash/:hash/utxo`, but that hash is byte-reversed by convention
 * and the wrong endianness returns an empty list rather than an error — and an
 * empty list is exactly what "not funded yet" looks like, so the mistake would
 * surface as a claim window that quietly expired. Decoding costs one pure call
 * and cannot fail silently.
 *
 * **Median-time-past, not the tip's timestamp.** Consensus matures a
 * seconds-typed `OP_CHECKLOCKTIMEVERIFY` against MTP — the median of the last
 * eleven block timestamps — which lags the tip by roughly an hour. Comparing a
 * locktime against the tip header's own time would call a leaf mature before
 * the network does, and `classifyOnchainHtlc` would report `refundable` while
 * the claim was in fact still open. `OnchainProvider.getChainTip().time` is
 * specified as MTP for exactly this reason; see its remarks.
 */
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import type { OnchainProvider } from "@arkade-os/sdk";
import type { ChainSource, ChainUtxo, OnchainNetwork } from "./onchainHtlc";
import { L1_NETWORKS } from "./onchainHtlc";

/**
 * A {@link ChainSource} backed by `provider`.
 *
 * `network` is the Bitcoin L1 network the HTLC was derived for — the
 * `l1Network` that `requestOnchainSend` returns, not the Arkade network name.
 * It only decodes scripts to addresses; the provider is what actually decides
 * which chain is read, so pointing a mainnet provider at `"regtest"` here
 * yields addresses the provider knows nothing about rather than an error.
 */
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
            // An unconfirmed output is zero confirmations, not one: this is the
            // exact depth `minConfirmations` is compared against, and calling a
            // mempool output "1 deep" would let a 1-confirmation policy claim
            // against a transaction that can still be replaced.
            confirmations:
                coin.status.confirmed && typeof coin.status.block_height === "number"
                    ? Math.max(0, tip.height - coin.status.block_height + 1)
                    : 0,
        }));
    },

    async getSpendingTx(txid: string, vout: number): Promise<{ txHex: string } | null> {
        const outspends = await provider.getTxOutspends(txid);
        const outspend = outspends[vout];
        // `txid` is optional on the interface — some esplora deployments omit
        // the spender from `/outspends` even when `spent` is true. Nothing can
        // be fetched without it, and reporting "no spend" is the honest answer:
        // the only caller reads P out of the spend, and retries.
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
