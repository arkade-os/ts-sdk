/**
 * The onchain corridor's default {@link ChainSource}.
 *
 * Built from an esplora URL, not the wallet's provider: `onchainProvider` exists only on the
 * concrete `Wallet`, never on `IWallet`, which every swap entry point takes. The default URL is
 * `ESPLORA_URL[network]`.
 *
 * `getMtp` does not forward `OnchainProvider.getChainTip().time`: that promises only "block time",
 * and Esplora answers `mediantime` while Electrum answers the header's nTime. An MTP that runs high
 * makes `classifyOnchainHtlc` report `refundable` early and abandons a still-live L1 claim, so the
 * tip is read off `/blocks`, where `mediantime` is explicit.
 */
import { hex } from "@scure/base";
import * as btc from "@scure/btc-signer";
import { EsploraProvider, type OnchainProvider } from "@arkade-os/sdk";
import type { ChainSource, ChainUtxo } from "../../onchainHtlc";

/** The chain tip, as the two reads that need it want it. */
export interface L1Tip {
    height: number;
    /** Median-time-past, unix seconds. */
    mtp: number;
}

/** What the adapter reads L1 through: core's provider, plus the one fact its
 * interface does not promise. */
export interface ChainSourceBackend {
    provider: OnchainProvider;
    tip(): Promise<L1Tip>;
}

/** The address parameters an output script is encoded under. Structural, so
 * core's `Network` and `L1_NETWORKS`' entries both satisfy it directly. */
export type AddressParams = typeof btc.NETWORK;

const addressOfScript = (script: Uint8Array, network: AddressParams): string =>
    btc.Address(network).encode(btc.OutScript.decode(script));

/**
 * A {@link ChainSource} over an arbitrary L1 backend, so a caller with its own `OnchainProvider`
 * can reuse the adapter logic, and tests can run it without a server.
 */
export const chainSourceOver = (
    backend: ChainSourceBackend,
    network: AddressParams,
): ChainSource => {
    /**
     * The spender of an outpoint when `/outspends` did not name it: some deployments
     * (`mempool.arkade.sh`, i.e. `ESPLORA_URL.bitcoin`) answer `{spent: true}` with no `txid`, so
     * scan the output's address history for the vin naming this outpoint. This is why
     * `getSpendingTx` takes `pkScript`.
     */
    const spenderFromVins = async (
        txid: string,
        vout: number,
        pkScript: Uint8Array,
    ): Promise<string | undefined> => {
        let address: string;
        try {
            address = addressOfScript(pkScript, network);
        } catch {
            return undefined;
        }
        for (const tx of await backend.provider.getTransactions(address)) {
            // The electrum provider omits `vin` entirely; the fallback then finds nothing.
            if ((tx.vin ?? []).some((input) => input.txid === txid && input.vout === vout)) {
                return tx.txid;
            }
        }
        return undefined;
    };

    return {
        async getScriptUtxos(pkScript: Uint8Array): Promise<ChainUtxo[]> {
            const address = addressOfScript(pkScript, network);
            const [coins, tip] = await Promise.all([
                backend.provider.getCoins(address),
                backend.tip(),
            ]);
            return coins.map((coin) => ({
                txid: coin.txid,
                vout: coin.vout,
                amount: BigInt(coin.value),
                // A confirmed coin is one deep, not zero: its own block counts.
                confirmations:
                    coin.status.confirmed && coin.status.block_height !== undefined
                        ? Math.max(0, tip.height - coin.status.block_height + 1)
                        : 0,
            }));
        },

        async getSpendingTx(
            txid: string,
            vout: number,
            pkScript: Uint8Array,
        ): Promise<{ txHex: string } | null> {
            const outspends = await backend.provider.getTxOutspends(txid);
            const outspend = outspends[vout];
            if (!outspend?.spent) return null;
            // `||`, not `??`: the electrum provider uses `txid: ""` as its unspent sentinel.
            const spender = outspend.txid || (await spenderFromVins(txid, vout, pkScript));
            if (!spender) return null;
            return { txHex: hex.encode(await backend.provider.getRawTransaction(spender)) };
        },

        broadcast(txHex: string): Promise<string> {
            return backend.provider.broadcastTransaction(txHex);
        },

        async getMtp(): Promise<number> {
            return (await backend.tip()).mtp;
        },
    };
};

/**
 * Tip height and median-time-past off Esplora's `/blocks`. Not `/blocks/tip`: that is not in the
 * Esplora spec (electrs aliases it, mempool answers an empty array).
 */
export const esploraTip = async (esploraUrl: string, fetchImpl?: typeof fetch): Promise<L1Tip> => {
    const response = await (fetchImpl ?? fetch)(`${esploraUrl}/blocks`);
    if (!response.ok) {
        throw new Error(`failed to read the chain tip: ${response.status} ${response.statusText}`);
    }
    const blocks: unknown = await response.json();
    const tip = Array.isArray(blocks)
        ? (blocks[0] as Record<string, unknown> | undefined)
        : undefined;
    if (
        !tip ||
        typeof tip.height !== "number" ||
        typeof tip.mediantime !== "number" ||
        !(tip.mediantime > 0)
    ) {
        // Never substitute tip time for MTP; that is what this function exists to prevent.
        throw new Error(`esplora returned no usable chain tip for ${esploraUrl}`);
    }
    return { height: tip.height, mtp: tip.mediantime };
};

/** The default: core's Esplora provider at `esploraUrl`, with the tip read off
 * `/blocks` beside it. */
export const esploraChainSource = (input: {
    /** Esplora REST base — the corridor's override, or `ESPLORA_URL[network]`. */
    esploraUrl: string;
    /** Address parameters for the script-to-address encode. */
    network: AddressParams;
    /** For hosts without a global `fetch`, and for tests. Only the `/blocks`
     * read takes it: core's provider carries its own fetch wrapper. */
    fetchImpl?: typeof fetch;
}): ChainSource =>
    chainSourceOver(
        {
            provider: new EsploraProvider(input.esploraUrl),
            tip: () => esploraTip(input.esploraUrl, input.fetchImpl),
        },
        input.network,
    );
