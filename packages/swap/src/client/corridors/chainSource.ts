/**
 * The onchain corridor's default {@link ChainSource}.
 *
 * `ChainSource` has shipped since the onchain corridor did and nothing has ever
 * implemented it: its own doc assigns the esplora-backed one to the caller, and
 * the only implementations in the tree are scripted test fakes. §6's
 * "Arkade-provided chain source" is that gap, and this closes it.
 *
 * Built from an esplora base URL rather than from the wallet's provider,
 * because there is no such thing to reach: `onchainProvider` is a field of
 * `BaseWalletConfig` and of the concrete `Wallet`, never of `IWallet` /
 * `IReadonlyWallet` — core states the rule at `vtxo-manager.ts` — and every
 * swap entry point takes the interface. So the URL is what the override
 * replaces, and its default is `ESPLORA_URL[network]` off the same live info
 * read every corridor makes.
 *
 * Three of the four methods adapt core's `OnchainProvider`. The fourth does
 * not, and the difference is a *contract* gap rather than a missing endpoint:
 * `getMtp` must answer median-time-past, `OnchainProvider.getChainTip` promises
 * no more than "block time", and the two shipped implementations disagree —
 * Esplora answers `tip[0].mediantime`, Electrum answers the header's nTime. A
 * source that forwarded `getChainTip().time` would therefore be right on one
 * backend and wrong on the other, and being wrong here is not a rounding error:
 * `classifyOnchainHtlc` returns `refundable` once MTP reaches the HTLC's
 * locktime, `nextOnchainAction` turns that into `claim_window_closed`, and an
 * MTP that runs high abandons a still-live L1 claim. So the tip is read off
 * `/blocks` here, where `mediantime` is named explicitly.
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
 * A {@link ChainSource} over an arbitrary L1 backend.
 *
 * Separate from {@link esploraChainSource} so the adapter's logic — the
 * confirmations arithmetic, the script-to-address encode, the missing-spender
 * fallback — is exercisable without a server, and so a caller with its own
 * `OnchainProvider` can reuse it.
 */
export const chainSourceOver = (
    backend: ChainSourceBackend,
    network: AddressParams,
): ChainSource => {
    /**
     * The spender of an outpoint when `/outspends` did not name it.
     *
     * Some deployments answer `{spent: true}` with no `txid` —
     * `mempool.arkade.sh`, which is `ESPLORA_URL.bitcoin` — so the spend is
     * recovered the way core recovers a boarding output's: scan the spent
     * output's own address history for the transaction whose vin names this
     * outpoint. The address is derived from the funding transaction rather than
     * passed in, because `getSpendingTx` is handed an outpoint and nothing else.
     */
    const spenderFromVins = async (txid: string, vout: number): Promise<string | undefined> => {
        let address: string;
        try {
            const funding = btc.RawTx.decode(await backend.provider.getRawTransaction(txid));
            const output = funding.outputs[vout];
            if (!output?.script) return undefined;
            address = addressOfScript(output.script, network);
        } catch {
            return undefined;
        }
        for (const tx of await backend.provider.getTransactions(address)) {
            // `vin` is optional on the interface: the electrum provider omits
            // inputs entirely, in which case this fallback simply finds nothing.
            if ((tx.vin ?? []).some((input) => input.txid === txid && input.vout === vout)) {
                return tx.txid;
            }
        }
        return undefined;
    };

    return {
        async getScriptUtxos(pkScript: Uint8Array): Promise<ChainUtxo[]> {
            // `getCoins` is address-keyed where this is script-keyed, and the
            // encode is why the adapter needs a network at all.
            const address = addressOfScript(pkScript, network);
            const [coins, tip] = await Promise.all([
                backend.provider.getCoins(address),
                backend.tip(),
            ]);
            return coins.map((coin) => ({
                txid: coin.txid,
                vout: coin.vout,
                // `Coin.value` is `number` sats; the HTLC's is `bigint`.
                amount: BigInt(coin.value),
                // `Coin` carries a height, never a depth, so the tip is the
                // second half of the answer. A confirmed coin is one deep, not
                // zero — the block it landed in counts.
                confirmations:
                    coin.status.confirmed && coin.status.block_height !== undefined
                        ? Math.max(0, tip.height - coin.status.block_height + 1)
                        : 0,
            }));
        },

        async getSpendingTx(txid: string, vout: number): Promise<{ txHex: string } | null> {
            const outspends = await backend.provider.getTxOutspends(txid);
            const outspend = outspends[vout];
            if (!outspend?.spent) return null;
            // `||`, not `??`: the electrum provider uses `txid: ""` as its
            // unspent sentinel, and an empty string is not a spender either.
            const spender = outspend.txid || (await spenderFromVins(txid, vout));
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
 * Tip height and median-time-past off Esplora's `/blocks`.
 *
 * `/blocks` rather than `/blocks/tip`, for the reason core already records:
 * the latter is not part of the Esplora spec — electrs serves it as an alias,
 * a strict backend like mempool answers an empty array.
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
        // Fail rather than substitute: a tip time standing in for MTP is the
        // exact substitution this function exists to prevent.
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
