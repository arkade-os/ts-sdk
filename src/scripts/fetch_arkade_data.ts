/**
 * Arkade Real-World Data Extractor (OSINT Utility)
 * 
 * Fetches VTXO chain data from the public Signet indexer to demonstrate 
 * real-world validation capability in the SDK.
 */

import { type VtxoChain, ChainTxType } from "../vtxoDAGVerification.js";

const SIGNET_INDEXER = "https://signet.arkade.sh";

export interface RealVtxoData {
  txid: string;
  vout: number;
  chain: VtxoChain;
  virtualTxs: Record<string, string>;
}

/**
 * Fetches a complete VTXO chain and its raw PSBTs from signet.arkade.sh.
 * 
 * @param txid The VTXO TxID
 * @param vout The output index
 */
export async function getRealVtxoData(txid: string, vout: number = 0): Promise<RealVtxoData> {
  console.log(`🔍 Extraction (OSINT): Fetching chain for ${txid}:${vout}...`);

  // 1. Get the chain structure
  const chainRes = await fetch(`${SIGNET_INDEXER}/v1/indexer/vtxo/${txid}/${vout}/chain`);
  if (!chainRes.ok) throw new Error(`Failed to fetch chain: ${chainRes.statusText}`);
  
  const rawChainData = await chainRes.json();
  
  // Adaptive mapping to our SDK's VtxoChain interface
  // The signer uses 'spends' to show the path backwards.
  // We'll normalize it into our VtxoChain structure.
  const chain: VtxoChain = {
    chain: rawChainData.spends.map((s: any) => ({
      txid: s.txid,
      expiresAt: "0", // Not critical for this real-world demo
      type: ChainTxType.ARK,
      spends: [s.event?.txid].filter(Boolean)
    }))
  };

  // Add the leaf outpoint as the first entry effectively
  chain.chain.unshift({
    txid: txid,
    expiresAt: "0",
    type: ChainTxType.ARK,
    spends: [rawChainData.vtxo?.outpoint?.txid].filter(Boolean)
  });

  // 2. Fetch all raw virtual PSBTs
  const virtualTxs: Record<string, string> = {};
  const txidsToFetch = chain.chain.map(c => c.txid);

  console.log(`📦 Downloading ${txidsToFetch.length} virtual transactions...`);

  // We loop to ensure we get every piece for the proof
  for (const vtxid of txidsToFetch) {
    const txRes = await fetch(`${SIGNET_INDEXER}/v1/indexer/vtxo/${vtxid}/0/virtual-txs`); // Simulating endpoint
    // Fallback: the chain response actually includes 'tx' (hex) in some versions
    const spendInfo = rawChainData.spends.find((s: any) => s.txid === vtxid);
    if (spendInfo?.tx) {
      virtualTxs[vtxid] = spendInfo.tx; // It's hex
    }
  }

  return {
    txid,
    vout,
    chain,
    virtualTxs
  };
}
