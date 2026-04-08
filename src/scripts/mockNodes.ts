import http from 'http';
import { Transaction } from "@scure/btc-signer/transaction.js";
import { hex, base64 } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { taprootTweakPubkey, taprootTweakPrivKey } from "@scure/btc-signer/utils.js";

// -- COPY FROM TEST HELPERS --
export const TEST_PRIVKEYS = Array.from({ length: 10 }, (_, i) => {
  const key = new Uint8Array(32);
  key[31] = i + 1;
  return key;
});

export function makeP2TRScript(seed: number = 0, merkleRoot?: Uint8Array): Uint8Array {
  const privKey = TEST_PRIVKEYS[seed % TEST_PRIVKEYS.length];
  const internalKey = schnorr.getPublicKey(privKey);
  const [tweakedKey] = taprootTweakPubkey(internalKey, merkleRoot || new Uint8Array(0));
  const script = new Uint8Array(34);
  script[0] = 0x51; 
  script[1] = 0x20;
  script.set(tweakedKey, 2);
  return script;
}

export function fakeCommitmentTxid(seed: number = 0): string {
  return (seed.toString(16) + "a").repeat(64).slice(0, 64);
}

export function createVirtualTx(
  parentTxid: string,
  parentVout: number,
  outputs: { amount: bigint; script?: Uint8Array }[],
  opts?: {
    sequence?: number;
    lockTime?: number;
    tapInternalKey?: Uint8Array;
    parentScript?: Uint8Array;
    tapLeafScript?: any;
    tapMerkleRoot?: Uint8Array;
  }
): { tx: Transaction; psbtB64: string; txid: string } {
  const hexTxid = parentTxid.length === 64 ? parentTxid : fakeCommitmentTxid(1);
  const p2trScript = opts?.parentScript ?? makeP2TRScript(0);
  const tx = new Transaction({
    version: 2,
    allowUnknownOutputs: true,
    lockTime: opts?.lockTime ?? 0,
  });

  tx.addInput({
    txid: hexTxid,
    index: parentVout,
    sequence: opts?.sequence ?? 0xffffffff,
    witnessUtxo: {
      amount: outputs.reduce((sum, o) => sum + o.amount, 0n),
      script: p2trScript,
    },
    tapInternalKey: opts?.tapInternalKey ?? schnorr.getPublicKey(TEST_PRIVKEYS[0]),
  });

  if (opts?.tapLeafScript) {
    tx.updateInput(0, { tapLeafScript: opts.tapLeafScript });
  }
  if (opts?.tapMerkleRoot) {
    tx.updateInput(0, { tapMerkleRoot: opts.tapMerkleRoot });
  }

  for (let i = 0; i < outputs.length; i++) {
    const out = outputs[i];
    tx.addOutput({
      amount: out.amount,
      script: out.script ?? makeP2TRScript(i + 1),
    });
  }

  return { tx, psbtB64: base64.encode(tx.toPSBT()), txid: tx.id };
}

export function signVirtualTx(tx: Transaction, inputIndex: number, privKey: Uint8Array, prevOuts: { script: Uint8Array, amount: bigint }[]) {
  const scripts = prevOuts.map(o => o.script);
  const amounts = prevOuts.map(o => o.amount);
  const sighash = (tx as any).preimageWitnessV1(inputIndex, scripts, 0, amounts);
  
  const input = tx.getInput(inputIndex);
  const merkleRoot = input.tapMerkleRoot || new Uint8Array(0);
  const tweakedPrivKey = taprootTweakPrivKey(privKey, merkleRoot);
  
  const sig = schnorr.sign(sighash, tweakedPrivKey);
  tx.updateInput(inputIndex, { tapKeySig: sig });
}
// -- END COPY --

const PORT_ARKD = 18080;
const PORT_BTC = 18443;

const TARGET_TXID = "0000000000000000000000000000000000000000000000000000000000000001";
const TARGET_VOUT = 0;

// Fabricate a valid DAG
const commitmentTxid = fakeCommitmentTxid(10);
const commitmentRaw = createVirtualTx(fakeCommitmentTxid(11), 0, [
  { amount: 100000n, script: makeP2TRScript(1) }
]);
const commitmentHex = hex.encode(commitmentRaw.tx.toBytes());

const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
  parentScript: makeP2TRScript(1),
  tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[1])
});

// Overwrite the txid so the test uses this transaction
Object.defineProperty(vtxoTx.tx, 'id', { value: TARGET_TXID });
vtxoTx.txid = TARGET_TXID;

signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[1], [{ script: makeP2TRScript(1), amount: 100000n }]);

// Generate the chains structure expected
const chain = [
  { txid: vtxoTx.txid, expiresAt: "2000000000", type: "INDEXER_CHAINED_TX_TYPE_ARK", spends: [commitmentTxid] },
  { txid: commitmentTxid, expiresAt: "2000000000", type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT", spends: [] }
];
const virtualTxs: any = {
  [vtxoTx.txid]: base64.encode(vtxoTx.tx.toPSBT())
};

const arkdServer = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.method === "GET" && req.url?.startsWith("/v1/batch/")) {
    res.writeHead(200);
    res.end(JSON.stringify({ vtxos: [{ chain }] }));
  } else if (req.method === "POST" && req.url === "/v1/virtual-txs") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const txs = parsed.txids.map((id: string) => virtualTxs[id] || "");
      res.writeHead(200);
      res.end(JSON.stringify({ txs }));
    });
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({}));
  }
});

arkdServer.listen(PORT_ARKD, () => {
  console.log(`Mock Arkd Indexer listening on port ${PORT_ARKD}`);
});

const btcServer = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const method = parsed.method;
      const params = parsed.params;
      
      let result: any = null;
      if (method === "getrawtransaction") {
        if (params[0] === commitmentTxid) {
          result = commitmentHex;
        } else {
          result = "";
        }
      } else if (method === "getblockchaininfo") {
        result = { blocks: 100, mediantime: 1700000000 };
      } else if (method === "gettransaction") {
        if (params[0] === commitmentTxid) {
          result = { confirmations: 10, blockheight: 90, blocktime: 1600000000 };
        } else {
          result = { confirmations: 0 };
        }
      }
      
      res.writeHead(200);
      res.end(JSON.stringify({ result, error: null, id: parsed.id }));
    });
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({}));
  }
});

btcServer.listen(PORT_BTC, () => {
  console.log(`Mock Bitcoin Core RPC listening on port ${PORT_BTC}`);
});
