'use strict';

var chunk4QHMS5XH_cjs = require('./chunk-4QHMS5XH.cjs');
var chunk5BLDMQED_cjs = require('./chunk-5BLDMQED.cjs');
var btcSigner = require('@scure/btc-signer');
var secp256k1_js = require('@noble/curves/secp256k1.js');
var base = require('@scure/base');
var utils_js = require('@scure/btc-signer/utils.js');

var Transaction = class extends btcSigner.Transaction {
  static ARK_TX_OPTS = {
    allowUnknown: true,
    allowUnknownOutputs: true,
    allowUnknownInputs: true
  };
  constructor(opts) {
    super(withArkOpts(opts));
  }
  static fromPSBT(psbt_, opts) {
    return btcSigner.Transaction.fromPSBT(psbt_, withArkOpts(opts));
  }
  static fromRaw(raw, opts) {
    return btcSigner.Transaction.fromRaw(raw, withArkOpts(opts));
  }
};
function withArkOpts(opts) {
  return { ...Transaction.ARK_TX_OPTS, ...opts };
}
var ArkPsbtFieldKey = /* @__PURE__ */ ((ArkPsbtFieldKey2) => {
  ArkPsbtFieldKey2["VtxoTaprootTree"] = "taptree";
  ArkPsbtFieldKey2["VtxoTreeExpiry"] = "expiry";
  ArkPsbtFieldKey2["Cosigner"] = "cosigner";
  ArkPsbtFieldKey2["ConditionWitness"] = "condition";
  ArkPsbtFieldKey2["PrevArkTx"] = "prevarktx";
  ArkPsbtFieldKey2["PrevoutTx"] = "prevouttx";
  return ArkPsbtFieldKey2;
})(ArkPsbtFieldKey || {});
var ArkPsbtFieldKeyType = 222;
function setArkPsbtField(tx, inputIndex, coder, value) {
  tx.updateInput(inputIndex, {
    unknown: [...tx.getInput(inputIndex)?.unknown ?? [], coder.encode(value)]
  });
}
function getArkPsbtFields(tx, inputIndex, coder) {
  const unknown = tx.getInput(inputIndex)?.unknown ?? [];
  const fields = [];
  for (const u of unknown) {
    const v = coder.decode(u);
    if (v !== null) fields.push(v);
  }
  return fields;
}
var VtxoTaprootTree = {
  key: "taptree" /* VtxoTaprootTree */,
  encode: (value) => [
    {
      type: ArkPsbtFieldKeyType,
      key: encodedPsbtFieldKey["taptree" /* VtxoTaprootTree */]
    },
    value
  ],
  decode: (value) => nullIfCatch(() => {
    if (!checkKeyMatch(value[0], "taptree" /* VtxoTaprootTree */)) return null;
    return value[1];
  })
};
var ConditionWitness = {
  key: "condition" /* ConditionWitness */,
  encode: (value) => [
    {
      type: ArkPsbtFieldKeyType,
      key: encodedPsbtFieldKey["condition" /* ConditionWitness */]
    },
    btcSigner.RawWitness.encode(value)
  ],
  decode: (value) => nullIfCatch(() => {
    if (!checkKeyMatch(value[0], "condition" /* ConditionWitness */)) return null;
    return btcSigner.RawWitness.decode(value[1]);
  })
};
var PrevArkTxField = {
  key: "prevarktx" /* PrevArkTx */,
  encode: (value) => [
    {
      type: ArkPsbtFieldKeyType,
      key: encodedPsbtFieldKey["prevarktx" /* PrevArkTx */]
    },
    value
  ],
  decode: (value) => nullIfCatch(() => {
    if (!checkKeyMatch(value[0], "prevarktx" /* PrevArkTx */)) return null;
    return value[1];
  })
};
var PrevoutTxField = {
  key: "prevouttx" /* PrevoutTx */,
  encode: (value) => [
    {
      type: ArkPsbtFieldKeyType,
      key: encodedPsbtFieldKey["prevouttx" /* PrevoutTx */]
    },
    value
  ],
  decode: (value) => nullIfCatch(() => {
    if (!checkKeyMatch(value[0], "prevouttx" /* PrevoutTx */)) return null;
    return value[1];
  })
};
var CosignerPublicKey = {
  key: "cosigner" /* Cosigner */,
  encode: (value) => [
    {
      type: ArkPsbtFieldKeyType,
      key: new Uint8Array([...encodedPsbtFieldKey["cosigner" /* Cosigner */], value.index])
    },
    value.key
  ],
  decode: (unknown) => nullIfCatch(() => {
    if (!checkKeyMatch(unknown[0], "cosigner" /* Cosigner */, true)) return null;
    return {
      index: unknown[0].key[unknown[0].key.length - 1],
      key: unknown[1]
    };
  })
};
var VtxoTreeExpiry = {
  key: "expiry" /* VtxoTreeExpiry */,
  encode: (value) => [
    {
      type: ArkPsbtFieldKeyType,
      key: encodedPsbtFieldKey["expiry" /* VtxoTreeExpiry */]
    },
    btcSigner.ScriptNum(6, true).encode(value.value === 0n ? 0n : value.value)
  ],
  decode: (unknown) => nullIfCatch(() => {
    if (!checkKeyMatch(unknown[0], "expiry" /* VtxoTreeExpiry */)) return null;
    const v = btcSigner.ScriptNum(6, true).decode(unknown[1]);
    if (!v) return null;
    return chunk4QHMS5XH_cjs.sequenceToTimelock(Number(v));
  })
};
var encodedPsbtFieldKey = Object.fromEntries(
  Object.values(ArkPsbtFieldKey).map((key) => [key, new TextEncoder().encode(key)])
);
var nullIfCatch = (fn) => {
  try {
    return fn();
  } catch {
    return null;
  }
};
function checkKeyMatch(key, arkPsbtFieldKey, prefixOnly = false) {
  if (key.type !== ArkPsbtFieldKeyType) return false;
  const expected = encodedPsbtFieldKey[arkPsbtFieldKey];
  if (key.key.length < expected.length) return false;
  if (!prefixOnly && key.key.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (key.key[i] !== expected[i]) return false;
  }
  return true;
}

// src/providers/errors.ts
var ArkError = class extends Error {
  constructor(code, message, name, metadata) {
    super(message);
    this.code = code;
    this.message = message;
    this.name = name;
    this.metadata = metadata;
  }
};
function maybeArkError(error) {
  try {
    if (!(error instanceof Error)) return void 0;
    const decoded = JSON.parse(error.message);
    if (!("details" in decoded)) return void 0;
    if (!Array.isArray(decoded.details)) return void 0;
    for (const details of decoded.details) {
      if (!("@type" in details)) continue;
      const type = details["@type"];
      if (type !== "type.googleapis.com/ark.v1.ErrorDetails") continue;
      if (!("code" in details)) continue;
      const code = details.code;
      if (!("message" in details)) continue;
      const message = details.message;
      if (!("name" in details)) continue;
      const name = details.name;
      let metadata;
      if ("metadata" in details && isMetadata(details.metadata)) {
        metadata = details.metadata;
      }
      return new ArkError(code, message, name, metadata);
    }
    return void 0;
  } catch (e) {
    return void 0;
  }
}
function isMetadata(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
exports.Intent = void 0;
((Intent2) => {
  function create(message, ins, outputs = []) {
    if (typeof message !== "string") {
      message = encodeMessage(message);
    }
    if (ins.length == 0) throw new Error("intent proof requires at least one input");
    const inputs = ins.map(prepareCoinAsIntentProofInput);
    if (!validateInputs(inputs)) ;
    if (!validateOutputs(outputs)) ;
    const toSpend = craftToSpendTx(message, inputs[0].witnessUtxo.script);
    return craftToSignTx(toSpend, inputs, outputs);
  }
  Intent2.create = create;
  function fee(proof) {
    let sumOfInputs = 0n;
    for (let i = 0; i < proof.inputsLength; i++) {
      const input = proof.getInput(i);
      if (input.witnessUtxo === void 0)
        throw new Error("intent proof input requires witness utxo");
      sumOfInputs += input.witnessUtxo.amount;
    }
    let sumOfOutputs = 0n;
    for (let i = 0; i < proof.outputsLength; i++) {
      const output = proof.getOutput(i);
      if (output.amount === void 0) throw new Error("intent proof output requires amount");
      sumOfOutputs += output.amount;
    }
    if (sumOfOutputs > sumOfInputs) {
      throw new Error(
        `intent proof output amount is greater than input amount: ${sumOfOutputs} > ${sumOfInputs}`
      );
    }
    return Number(sumOfInputs - sumOfOutputs);
  }
  Intent2.fee = fee;
  function encodeMessage(message) {
    switch (message.type) {
      case "register":
        return JSON.stringify({
          type: "register",
          onchain_output_indexes: message.onchain_output_indexes,
          valid_at: message.valid_at,
          expire_at: message.expire_at,
          cosigners_public_keys: message.cosigners_public_keys
        });
      case "delete":
        return JSON.stringify({
          type: "delete",
          expire_at: message.expire_at
        });
      case "get-pending-tx":
        return JSON.stringify({
          type: "get-pending-tx",
          expire_at: message.expire_at
        });
    }
  }
  Intent2.encodeMessage = encodeMessage;
})(exports.Intent || (exports.Intent = {}));
var OP_RETURN_EMPTY_PKSCRIPT = new Uint8Array([btcSigner.OP.RETURN]);
var ZERO_32 = new Uint8Array(32).fill(0);
var MAX_INDEX = 4294967295;
var TAG_INTENT_PROOF = "ark-intent-proof-message";
function validateInput(input) {
  if (input.index === void 0) throw new Error("intent proof input requires index");
  if (input.txid === void 0) throw new Error("intent proof input requires txid");
  if (input.witnessUtxo === void 0)
    throw new Error("intent proof input requires witness utxo");
  return true;
}
function validateInputs(inputs) {
  inputs.forEach(validateInput);
  return true;
}
function validateOutput(output) {
  if (output.amount === void 0) throw new Error("intent proof output requires amount");
  if (output.script === void 0) throw new Error("intent proof output requires script");
  return true;
}
function validateOutputs(outputs) {
  outputs.forEach(validateOutput);
  return true;
}
function craftToSpendTx(message, pkScript, tag = TAG_INTENT_PROOF) {
  const messageHash = hashMessage(message, tag);
  const tx = new Transaction({
    version: 0
  });
  tx.addInput({
    txid: ZERO_32,
    // zero hash
    index: MAX_INDEX,
    sequence: 0
  });
  tx.addOutput({
    amount: 0n,
    script: pkScript
  });
  tx.updateInput(0, {
    finalScriptSig: btcSigner.Script.encode(["OP_0", messageHash])
  });
  return tx;
}
function craftToSignTx(toSpend, inputs, outputs) {
  const firstInput = inputs[0];
  const tx = new Transaction({
    version: 2,
    lockTime: 0
  });
  tx.addInput({
    ...firstInput,
    txid: toSpend.id,
    index: 0,
    witnessUtxo: {
      script: firstInput.witnessUtxo.script,
      amount: 0n
    },
    sighashType: btcSigner.SigHash.ALL
  });
  for (const [i, input] of inputs.entries()) {
    tx.addInput({
      ...input,
      sighashType: btcSigner.SigHash.ALL
    });
    if (input.unknown?.length) {
      tx.updateInput(i + 1, {
        unknown: input.unknown
      });
    }
  }
  if (outputs.length === 0) {
    outputs = [
      {
        amount: 0n,
        script: OP_RETURN_EMPTY_PKSCRIPT
      }
    ];
  }
  for (const output of outputs) {
    tx.addOutput({
      amount: output.amount,
      script: output.script
    });
  }
  return tx;
}
function hashMessage(message, tag = TAG_INTENT_PROOF) {
  return secp256k1_js.schnorr.utils.taggedHash(tag, new TextEncoder().encode(message));
}
function prepareCoinAsIntentProofInput(coin) {
  if (!("tapTree" in coin)) {
    return coin;
  }
  const vtxoScript = chunk4QHMS5XH_cjs.VtxoScript.decode(coin.tapTree);
  const sequence = chunk4QHMS5XH_cjs.getSequence(coin.intentTapLeafScript);
  const unknown = [VtxoTaprootTree.encode(coin.tapTree)];
  if (coin.extraWitness) {
    unknown.push(ConditionWitness.encode(coin.extraWitness));
  }
  return {
    txid: base.hex.decode(coin.txid),
    index: coin.vout,
    witnessUtxo: {
      amount: BigInt(coin.value),
      script: vtxoScript.pkScript
    },
    sequence,
    tapLeafScript: [coin.intentTapLeafScript],
    unknown
  };
}

// src/providers/utils.ts
function createAbortError() {
  const error = new Error("EventSource closed");
  error.name = "AbortError";
  return error;
}
function eventSourceIterator(eventSource) {
  const messageQueue = [];
  const errorQueue = [];
  let messageResolve = null;
  let errorResolve = null;
  let closed = false;
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    eventSource.removeEventListener("message", messageHandler);
    eventSource.removeEventListener("error", errorHandler);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    messageQueue.length = 0;
    errorQueue.length = 0;
    eventSource.close();
    cleanup();
    if (errorResolve) {
      const reject = errorResolve;
      messageResolve = null;
      errorResolve = null;
      reject(createAbortError());
    }
  };
  const messageHandler = (event) => {
    if (closed) return;
    if (messageResolve) {
      const resolve = messageResolve;
      messageResolve = null;
      errorResolve = null;
      resolve(event);
    } else {
      messageQueue.push(event);
    }
  };
  const errorHandler = () => {
    if (closed) return;
    const error = new Error("EventSource error");
    error.name = "EventSourceError";
    if (errorResolve) {
      const reject = errorResolve;
      messageResolve = null;
      errorResolve = null;
      reject(error);
    } else {
      errorQueue.push(error);
    }
  };
  eventSource.addEventListener("message", messageHandler);
  eventSource.addEventListener("error", errorHandler);
  const gen = (async function* () {
    try {
      while (!closed) {
        if (messageQueue.length > 0) {
          yield messageQueue.shift();
          continue;
        }
        if (errorQueue.length > 0) {
          const error = errorQueue.shift();
          throw error;
        }
        const result = await new Promise((resolve, reject) => {
          messageResolve = resolve;
          errorResolve = reject;
        }).finally(() => {
          messageResolve = null;
          errorResolve = null;
        });
        if (!closed && result) {
          yield result;
        }
      }
    } finally {
      closed = true;
      cleanup();
      eventSource.close();
    }
  })();
  const origReturn = gen.return.bind(gen);
  const managed = gen;
  managed.close = close;
  managed.return = (value) => {
    close();
    return origReturn(value);
  };
  return managed;
}
function isEventSourceError(error) {
  return error instanceof Error && error.name === "EventSourceError";
}

// src/providers/ark.ts
var SettlementEventType = /* @__PURE__ */ ((SettlementEventType2) => {
  SettlementEventType2["BatchStarted"] = "batch_started";
  SettlementEventType2["BatchFinalization"] = "batch_finalization";
  SettlementEventType2["BatchFinalized"] = "batch_finalized";
  SettlementEventType2["BatchFailed"] = "batch_failed";
  SettlementEventType2["TreeSigningStarted"] = "tree_signing_started";
  SettlementEventType2["TreeNonces"] = "tree_nonces";
  SettlementEventType2["TreeTx"] = "tree_tx";
  SettlementEventType2["TreeSignature"] = "tree_signature";
  SettlementEventType2["StreamStarted"] = "stream_started";
  return SettlementEventType2;
})(SettlementEventType || {});
var RestArkProvider = class {
  constructor(serverUrl = chunk4QHMS5XH_cjs.DEFAULT_ARKADE_SERVER_URL) {
    this.serverUrl = serverUrl;
  }
  async getInfo() {
    const url = `${this.serverUrl}/v1/info`;
    const response = await fetch(url);
    if (!response.ok) {
      const errorText = await response.text();
      handleError(errorText, `Failed to get server info: ${response.statusText}`);
    }
    const fromServer = await response.json();
    return {
      boardingExitDelay: BigInt(fromServer.boardingExitDelay ?? 0),
      checkpointTapscript: fromServer.checkpointTapscript ?? "",
      deprecatedSigners: fromServer.deprecatedSigners?.map((signer) => ({
        cutoffDate: BigInt(signer.cutoffDate ?? 0),
        pubkey: signer.pubkey ?? ""
      })) ?? [],
      digest: fromServer.digest ?? "",
      dust: BigInt(fromServer.dust ?? 0),
      fees: {
        intentFee: fromServer.fees?.intentFee ?? {},
        txFeeRate: fromServer?.fees?.txFeeRate ?? ""
      },
      forfeitAddress: fromServer.forfeitAddress ?? "",
      forfeitPubkey: fromServer.forfeitPubkey ?? "",
      network: fromServer.network ?? "",
      scheduledSession: "scheduledSession" in fromServer && fromServer.scheduledSession != null ? {
        duration: BigInt(fromServer.scheduledSession.duration ?? 0),
        nextStartTime: BigInt(fromServer.scheduledSession.nextStartTime ?? 0),
        nextEndTime: BigInt(fromServer.scheduledSession.nextEndTime ?? 0),
        period: BigInt(fromServer.scheduledSession.period ?? 0),
        fees: fromServer.scheduledSession.fees ?? {}
      } : void 0,
      serviceStatus: fromServer.serviceStatus ?? {},
      sessionDuration: BigInt(fromServer.sessionDuration ?? 0),
      signerPubkey: fromServer.signerPubkey ?? "",
      unilateralExitDelay: BigInt(fromServer.unilateralExitDelay ?? 0),
      utxoMaxAmount: BigInt(fromServer.utxoMaxAmount ?? -1),
      utxoMinAmount: BigInt(fromServer.utxoMinAmount ?? 0),
      version: fromServer.version ?? "",
      vtxoMaxAmount: BigInt(fromServer.vtxoMaxAmount ?? -1),
      vtxoMinAmount: BigInt(fromServer.vtxoMinAmount ?? 0)
    };
  }
  async submitTx(signedArkTx, checkpointTxs) {
    const url = `${this.serverUrl}/v1/tx/submit`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        signedArkTx,
        checkpointTxs
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      handleError(errorText, `Failed to submit virtual transaction: ${errorText}`);
    }
    const data = await response.json();
    return {
      arkTxid: data.arkTxid,
      finalArkTx: data.finalArkTx,
      signedCheckpointTxs: data.signedCheckpointTxs
    };
  }
  async finalizeTx(arkTxid, finalCheckpointTxs) {
    const url = `${this.serverUrl}/v1/tx/finalize`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        arkTxid,
        finalCheckpointTxs
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      handleError(errorText, `Failed to finalize offchain transaction: ${errorText}`);
    }
  }
  async registerIntent(intent) {
    const url = `${this.serverUrl}/v1/batch/registerIntent`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        intent: {
          proof: intent.proof,
          message: exports.Intent.encodeMessage(intent.message)
        }
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      handleError(errorText, `Failed to register intent: ${errorText}`);
    }
    const data = await response.json();
    return data.intentId;
  }
  async deleteIntent(intent) {
    const url = `${this.serverUrl}/v1/batch/deleteIntent`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        intent: {
          proof: intent.proof,
          message: exports.Intent.encodeMessage(intent.message)
        }
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      handleError(errorText, `Failed to delete intent: ${errorText}`);
    }
  }
  async confirmRegistration(intentId) {
    const url = `${this.serverUrl}/v1/batch/ack`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        intentId
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      handleError(errorText, `Failed to confirm registration: ${errorText}`);
    }
  }
  async submitTreeNonces(batchId, pubkey, nonces) {
    const url = `${this.serverUrl}/v1/batch/tree/submitNonces`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        batchId,
        pubkey,
        treeNonces: encodeMusig2Nonces(nonces)
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      handleError(errorText, `Failed to submit tree nonces: ${errorText}`);
    }
  }
  async submitTreeSignatures(batchId, pubkey, signatures) {
    const url = `${this.serverUrl}/v1/batch/tree/submitSignatures`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        batchId,
        pubkey,
        treeSignatures: encodeMusig2Signatures(signatures)
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      handleError(errorText, `Failed to submit tree signatures: ${errorText}`);
    }
  }
  async submitSignedForfeitTxs(signedForfeitTxs, signedCommitmentTx) {
    const url = `${this.serverUrl}/v1/batch/submitForfeitTxs`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        signedForfeitTxs,
        signedCommitmentTx
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      handleError(errorText, `Failed to submit forfeit transactions: ${response.statusText}`);
    }
  }
  getEventStream(signal, topics) {
    const url = `${this.serverUrl}/v1/batch/events`;
    const queryParams = topics.length > 0 ? `?${topics.map((topic) => `topics=${encodeURIComponent(topic)}`).join("&")}` : "";
    let iterator = null;
    const closeIterator = () => iterator?.close();
    const self = this;
    const gen = (async function* () {
      const abortHandler = closeIterator;
      signal?.addEventListener("abort", abortHandler);
      try {
        while (!signal?.aborted) {
          const currentIterator = eventSourceIterator(new EventSource(url + queryParams));
          iterator = currentIterator;
          try {
            for await (const event of currentIterator) {
              if (signal?.aborted) break;
              try {
                const data = JSON.parse(event.data);
                const settlementEvent = self.parseSettlementEvent(data);
                if (settlementEvent) {
                  yield settlementEvent;
                }
              } catch (err) {
                console.error("Failed to parse event:", err);
                throw err;
              }
            }
          } catch (error) {
            if (signal?.aborted || error instanceof Error && error.name === "AbortError") {
              break;
            }
            if (isFetchTimeoutError(error)) {
              console.debug("Timeout error ignored");
              continue;
            }
            if (isEventSourceError(error)) {
              throw error;
            }
            console.error("Event stream error:", error);
            throw error;
          } finally {
            currentIterator.close();
            iterator = null;
          }
        }
      } finally {
        signal?.removeEventListener("abort", abortHandler);
        closeIterator();
      }
    })();
    const origReturn = gen.return.bind(gen);
    gen.return = (value) => {
      closeIterator();
      return origReturn(value);
    };
    return gen;
  }
  getTransactionsStream(signal) {
    const url = `${this.serverUrl}/v1/txs`;
    let iterator = null;
    const closeIterator = () => iterator?.close();
    const self = this;
    const gen = (async function* () {
      const abortHandler = closeIterator;
      signal?.addEventListener("abort", abortHandler);
      try {
        while (!signal?.aborted) {
          try {
            const currentIterator = eventSourceIterator(new EventSource(url));
            iterator = currentIterator;
            for await (const event of currentIterator) {
              if (signal?.aborted) break;
              try {
                const data = JSON.parse(event.data);
                const txNotification = self.parseTransactionNotification(data);
                if (txNotification) {
                  yield txNotification;
                }
              } catch (err) {
                console.error("Failed to parse transaction notification:", err);
                throw err;
              }
            }
          } catch (error) {
            if (signal?.aborted || error instanceof Error && error.name === "AbortError") {
              break;
            }
            if (isFetchTimeoutError(error)) {
              console.debug("Timeout error ignored");
              continue;
            }
            if (isEventSourceError(error)) {
              throw error;
            }
            console.error("Transaction stream error:", error);
            throw error;
          } finally {
            closeIterator();
            iterator = null;
          }
        }
      } finally {
        signal?.removeEventListener("abort", abortHandler);
        closeIterator();
      }
    })();
    const origReturn = gen.return.bind(gen);
    gen.return = (value) => {
      closeIterator();
      return origReturn(value);
    };
    return gen;
  }
  async getPendingTxs(intent) {
    const url = `${this.serverUrl}/v1/tx/pending`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        intent: {
          proof: intent.proof,
          message: exports.Intent.encodeMessage(intent.message)
        }
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      handleError(errorText, `Failed to get pending transactions: ${errorText}`);
    }
    const data = await response.json();
    return data.pendingTxs;
  }
  parseSettlementEvent(data) {
    if (data.batchStarted) {
      return {
        type: "batch_started" /* BatchStarted */,
        id: data.batchStarted.id,
        intentIdHashes: data.batchStarted.intentIdHashes,
        batchExpiry: BigInt(data.batchStarted.batchExpiry)
      };
    }
    if (data.batchFinalization) {
      return {
        type: "batch_finalization" /* BatchFinalization */,
        id: data.batchFinalization.id,
        commitmentTx: data.batchFinalization.commitmentTx
      };
    }
    if (data.batchFinalized) {
      return {
        type: "batch_finalized" /* BatchFinalized */,
        id: data.batchFinalized.id,
        commitmentTxid: data.batchFinalized.commitmentTxid
      };
    }
    if (data.batchFailed) {
      return {
        type: "batch_failed" /* BatchFailed */,
        id: data.batchFailed.id,
        reason: data.batchFailed.reason
      };
    }
    if (data.treeSigningStarted) {
      return {
        type: "tree_signing_started" /* TreeSigningStarted */,
        id: data.treeSigningStarted.id,
        cosignersPublicKeys: data.treeSigningStarted.cosignersPubkeys,
        unsignedCommitmentTx: data.treeSigningStarted.unsignedCommitmentTx
      };
    }
    if (data.treeNoncesAggregated) {
      return null;
    }
    if (data.treeNonces) {
      return {
        type: "tree_nonces" /* TreeNonces */,
        id: data.treeNonces.id,
        topic: data.treeNonces.topic,
        txid: data.treeNonces.txid,
        nonces: decodeMusig2Nonces(data.treeNonces.nonces)
        // pubkey -> public nonce
      };
    }
    if (data.treeTx) {
      const children = Object.fromEntries(
        Object.entries(data.treeTx.children).map(([outputIndex, txid]) => {
          return [parseInt(outputIndex), txid];
        })
      );
      return {
        type: "tree_tx" /* TreeTx */,
        id: data.treeTx.id,
        topic: data.treeTx.topic,
        batchIndex: data.treeTx.batchIndex,
        chunk: {
          txid: data.treeTx.txid,
          tx: data.treeTx.tx,
          children
        }
      };
    }
    if (data.treeSignature) {
      return {
        type: "tree_signature" /* TreeSignature */,
        id: data.treeSignature.id,
        topic: data.treeSignature.topic,
        batchIndex: data.treeSignature.batchIndex,
        txid: data.treeSignature.txid,
        signature: data.treeSignature.signature
      };
    }
    if (data.streamStarted) {
      return {
        type: "stream_started" /* StreamStarted */,
        id: data.streamStarted.id
      };
    }
    if (data.heartbeat) {
      return null;
    }
    console.warn("Unknown event type:", data);
    return null;
  }
  parseTransactionNotification(data) {
    if (data.commitmentTx) {
      return {
        commitmentTx: {
          txid: data.commitmentTx.txid,
          tx: data.commitmentTx.tx,
          spentVtxos: data.commitmentTx.spentVtxos.map(mapVtxo),
          spendableVtxos: data.commitmentTx.spendableVtxos.map(mapVtxo),
          checkpointTxs: data.commitmentTx.checkpointTxs
        }
      };
    }
    if (data.arkTx) {
      return {
        arkTx: {
          txid: data.arkTx.txid,
          tx: data.arkTx.tx,
          spentVtxos: data.arkTx.spentVtxos.map(mapVtxo),
          spendableVtxos: data.arkTx.spendableVtxos.map(mapVtxo),
          checkpointTxs: data.arkTx.checkpointTxs
        }
      };
    }
    if (data.heartbeat) {
      return null;
    }
    console.warn("Unknown transaction notification type:", data);
    return null;
  }
};
function encodeMusig2Nonces(nonces) {
  const noncesObject = {};
  for (const [txid, nonce] of nonces) {
    noncesObject[txid] = base.hex.encode(nonce.pubNonce);
  }
  return noncesObject;
}
function encodeMusig2Signatures(signatures) {
  const sigObject = {};
  for (const [txid, sig] of signatures) {
    sigObject[txid] = base.hex.encode(sig.encode());
  }
  return sigObject;
}
function decodeMusig2Nonces(noncesObject) {
  return new Map(
    Object.entries(noncesObject).map(([txid, nonce]) => {
      if (typeof nonce !== "string") {
        throw new Error("invalid nonce");
      }
      return [txid, { pubNonce: base.hex.decode(nonce) }];
    })
  );
}
function isFetchTimeoutError(err) {
  const checkError = (error) => {
    if (!(error instanceof Error)) return false;
    const isCloudflare524 = error.name === "TypeError" && error.message === "Failed to fetch";
    return isCloudflare524 || error.name === "HeadersTimeoutError" || error.name === "BodyTimeoutError" || error.code === "UND_ERR_HEADERS_TIMEOUT" || error.code === "UND_ERR_BODY_TIMEOUT";
  };
  return checkError(err) || checkError(err.cause);
}
function mapVtxo(vtxo) {
  return {
    outpoint: {
      txid: vtxo.outpoint.txid,
      vout: vtxo.outpoint.vout
    },
    amount: vtxo.amount,
    script: vtxo.script,
    createdAt: vtxo.createdAt,
    expiresAt: vtxo.expiresAt,
    commitmentTxids: vtxo.commitmentTxids,
    isPreconfirmed: vtxo.isPreconfirmed,
    isSwept: vtxo.isSwept,
    isUnrolled: vtxo.isUnrolled,
    isSpent: vtxo.isSpent,
    spentBy: vtxo.spentBy,
    settledBy: vtxo.settledBy,
    arkTxid: vtxo.arkTxid
  };
}
function handleError(errorText, defaultMessage) {
  const error = new Error(errorText);
  const arkError = maybeArkError(error);
  throw arkError ?? new Error(defaultMessage);
}

// src/extension/asset/index.ts
var asset_exports = {};
chunk5BLDMQED_cjs.__export(asset_exports, {
  AssetGroup: () => AssetGroup,
  AssetId: () => AssetId,
  AssetInput: () => AssetInput,
  AssetInputType: () => AssetInputType,
  AssetInputs: () => AssetInputs,
  AssetOutput: () => AssetOutput,
  AssetOutputs: () => AssetOutputs,
  AssetRef: () => AssetRef,
  AssetRefType: () => AssetRefType,
  Metadata: () => Metadata,
  MetadataList: () => MetadataList,
  Packet: () => Packet
});

// src/extension/asset/types.ts
var TX_HASH_SIZE = 32;
var ASSET_ID_SIZE = 34;
var AssetInputType = /* @__PURE__ */ ((AssetInputType2) => {
  AssetInputType2[AssetInputType2["Unspecified"] = 0] = "Unspecified";
  AssetInputType2[AssetInputType2["Local"] = 1] = "Local";
  AssetInputType2[AssetInputType2["Intent"] = 2] = "Intent";
  return AssetInputType2;
})(AssetInputType || {});
var AssetRefType = /* @__PURE__ */ ((AssetRefType2) => {
  AssetRefType2[AssetRefType2["Unspecified"] = 0] = "Unspecified";
  AssetRefType2[AssetRefType2["ByID"] = 1] = "ByID";
  AssetRefType2[AssetRefType2["ByGroup"] = 2] = "ByGroup";
  return AssetRefType2;
})(AssetRefType || {});
var MASK_ASSET_ID = 1;
var MASK_CONTROL_ASSET = 2;
var MASK_METADATA = 4;

// src/extension/utils.ts
var BufferWriter = class {
  buffer = [];
  write(data) {
    for (const byte of data) {
      this.buffer.push(byte);
    }
  }
  writeByte(byte) {
    this.buffer.push(byte & 255);
  }
  writeUint16LE(value) {
    const buf = new Uint8Array(2);
    new DataView(buf.buffer).setUint16(0, value, true);
    this.write(buf);
  }
  writeVarUint(value) {
    if (typeof value === "number") {
      if (!Number.isInteger(value) || value < 0) {
        throw new RangeError("writeVarUint: value must be a non-negative integer");
      }
    } else if (value < 0n) {
      throw new RangeError("writeVarUint: value must be a non-negative integer");
    }
    const val = typeof value === "number" ? BigInt(value) : value;
    const bytes = [];
    let remaining = val;
    do {
      let byte = Number(remaining & 0x7fn);
      remaining >>= 7n;
      if (remaining > 0n) {
        byte |= 128;
      }
      bytes.push(byte);
    } while (remaining > 0n);
    this.write(new Uint8Array(bytes));
  }
  writeVarSlice(data) {
    this.writeVarUint(data.length);
    this.write(data);
  }
  writeCompactSize(value) {
    if (value < 253) {
      this.writeByte(value);
    } else if (value <= 65535) {
      this.writeByte(253);
      this.writeUint16LE(value);
    } else if (value <= 4294967295) {
      this.writeByte(254);
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, value, true);
      this.write(b);
    } else {
      throw new Error("CompactSize value too large");
    }
  }
  writeCompactSlice(data) {
    this.writeCompactSize(data.length);
    this.write(data);
  }
  toBytes() {
    return new Uint8Array(this.buffer);
  }
};
var BufferReader = class {
  view;
  offset = 0;
  constructor(data) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  remaining() {
    return this.view.byteLength - this.offset;
  }
  readByte() {
    if (this.offset >= this.view.byteLength) {
      throw new Error("unexpected end of buffer");
    }
    return this.view.getUint8(this.offset++);
  }
  readSlice(size) {
    if (this.offset + size > this.view.byteLength) {
      throw new Error("unexpected end of buffer");
    }
    const result = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, size);
    this.offset += size;
    return result;
  }
  readUint16LE() {
    if (this.offset + 2 > this.view.byteLength) {
      throw new Error("unexpected end of buffer");
    }
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }
  readVarUint() {
    let result = 0n;
    let shift = 0n;
    let byte;
    do {
      if (this.offset >= this.view.byteLength) {
        throw new Error("unexpected end of buffer");
      }
      byte = this.view.getUint8(this.offset++);
      result |= BigInt(byte & 127) << shift;
      shift += 7n;
    } while (byte & 128);
    return result;
  }
  readVarSlice() {
    const length = Number(this.readVarUint());
    return this.readSlice(length);
  }
  readCompactSize() {
    const first = this.readByte();
    if (first < 253) return first;
    if (first === 253) return this.readUint16LE();
    if (first === 254) {
      const b = this.readSlice(4);
      return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true);
    }
    throw new Error("CompactSize 8-byte values not supported");
  }
  readCompactSlice() {
    const length = this.readCompactSize();
    return this.readSlice(length);
  }
};

// src/extension/asset/utils.ts
function isZeroBytes(bytes) {
  return bytes.every((byte) => byte === 0);
}

// src/extension/asset/assetId.ts
var AssetId = class _AssetId {
  constructor(txid, groupIndex) {
    this.txid = txid;
    this.groupIndex = groupIndex;
  }
  /**
   * Create an asset id from a genesis transaction id and group index.
   *
   * @param txid - Hex-encoded genesis transaction id
   * @param groupIndex - Asset group index within the genesis transaction
   * @returns A validated asset id
   * @throws Error if the txid is missing, malformed, or not 32 bytes long
   * @see fromString
   */
  static create(txid, groupIndex) {
    if (!txid) {
      throw new Error("missing txid");
    }
    let buf;
    try {
      buf = base.hex.decode(txid);
    } catch {
      throw new Error("invalid txid format, must be hex");
    }
    if (buf.length !== TX_HASH_SIZE) {
      throw new Error(
        `invalid txid length: got ${buf.length} bytes, want ${TX_HASH_SIZE} bytes`
      );
    }
    const assetId = new _AssetId(buf, groupIndex);
    assetId.validate();
    return assetId;
  }
  /**
   * Decode an asset id from its hex string representation.
   *
   * @param s - Hex-encoded asset id
   * @returns Decoded asset id
   * @throws Error if the string is not valid hex or does not encode a valid asset id
   * @see toString
   */
  static fromString(s) {
    let buf;
    try {
      buf = base.hex.decode(s);
    } catch {
      throw new Error("invalid asset id format, must be hex");
    }
    return _AssetId.fromBytes(buf);
  }
  /**
   * Decode an asset id from its serialized bytes.
   *
   * @param buf - Serialized asset id bytes
   * @returns Decoded asset id
   * @throws Error if the buffer length is invalid
   */
  static fromBytes(buf) {
    if (!buf || buf.length === 0) {
      throw new Error("missing asset id");
    }
    if (buf.length !== ASSET_ID_SIZE) {
      throw new Error(
        `invalid asset id length: got ${buf.length} bytes, want ${ASSET_ID_SIZE} bytes`
      );
    }
    const reader = new BufferReader(buf);
    return _AssetId.fromReader(reader);
  }
  /**
   * Serialize the asset id to raw bytes.
   *
   * @returns Serialized asset id bytes
   * @see fromBytes
   */
  serialize() {
    const writer = new BufferWriter();
    this.serializeTo(writer);
    return writer.toBytes();
  }
  /**
   * Encode the asset id to a hex string.
   *
   * @returns Hex-encoded asset id
   * @see fromString
   */
  toString() {
    return base.hex.encode(this.serialize());
  }
  /**
   * Validate the asset id fields.
   *
   * @throws Error if the txid is empty or the group index is out of range
   */
  validate() {
    if (isZeroBytes(this.txid)) {
      throw new Error("empty txid");
    }
    if (!Number.isInteger(this.groupIndex) || this.groupIndex < 0 || this.groupIndex > 65535) {
      throw new Error(`invalid group index: ${this.groupIndex}, must be in range [0, 65535]`);
    }
  }
  /**
   * Decode an asset id from a binary reader.
   *
   * @param reader - Reader positioned at an asset id
   * @returns Decoded asset id
   * @throws Error if the reader does not contain enough bytes
   */
  static fromReader(reader) {
    if (reader.remaining() < ASSET_ID_SIZE) {
      throw new Error(
        `invalid asset id length: got ${reader.remaining()}, want ${ASSET_ID_SIZE}`
      );
    }
    const txid = reader.readSlice(TX_HASH_SIZE);
    const index = reader.readUint16LE();
    const assetId = new _AssetId(txid, index);
    assetId.validate();
    return assetId;
  }
  /**
   * Serialize the asset id into an existing binary writer.
   *
   * @param writer - Writer to append the asset id to
   * @see serialize
   */
  serializeTo(writer) {
    writer.write(this.txid);
    writer.writeUint16LE(this.groupIndex);
  }
};
var AssetRef = class _AssetRef {
  constructor(ref) {
    this.ref = ref;
  }
  /** Reference type discriminator. */
  get type() {
    return this.ref.type;
  }
  /**
   * Create an asset reference that points to a specific asset id.
   *
   * @param assetId - Asset id referenced by this pointer
   * @returns Asset reference by id
   * @see fromGroupIndex
   */
  static fromId(assetId) {
    return new _AssetRef({ type: 1 /* ByID */, assetId });
  }
  /**
   * Create an asset reference that points to another asset group by index.
   *
   * @param groupIndex - Zero-based asset group index in the packet
   * @returns Asset reference by group index
   * @see fromId
   */
  static fromGroupIndex(groupIndex) {
    return new _AssetRef({ type: 2 /* ByGroup */, groupIndex });
  }
  /**
   * Decode an asset reference from its hex string form.
   *
   * @param s - Hex-encoded asset reference
   * @returns Decoded asset reference
   * @throws Error if the string is not valid hex or does not encode a valid asset reference
   * @see toString
   */
  static fromString(s) {
    let buf;
    try {
      buf = base.hex.decode(s);
    } catch {
      throw new Error("invalid asset ref format, must be hex");
    }
    return _AssetRef.fromBytes(buf);
  }
  /**
   * Decode an asset reference from its serialized bytes.
   *
   * @param buf - Serialized asset reference bytes
   * @returns Decoded asset reference
   * @throws Error if the buffer is empty or malformed
   */
  static fromBytes(buf) {
    if (!buf || buf.length === 0) {
      throw new Error("missing asset ref");
    }
    const reader = new BufferReader(buf);
    return _AssetRef.fromReader(reader);
  }
  /**
   * Serialize the asset reference to raw bytes.
   *
   * @returns Serialized asset reference bytes
   * @see fromBytes
   */
  serialize() {
    const writer = new BufferWriter();
    this.serializeTo(writer);
    return writer.toBytes();
  }
  /**
   * Encode the asset reference to a hex string.
   *
   * @returns Hex-encoded asset reference
   * @see fromString
   */
  toString() {
    return base.hex.encode(this.serialize());
  }
  /**
   * Decode an asset reference from a binary reader.
   *
   * @param reader - Reader positioned at an asset reference
   * @returns Decoded asset reference
   * @throws Error if the type is unknown or the reader does not contain enough bytes
   */
  static fromReader(reader) {
    const type = reader.readByte();
    let ref;
    switch (type) {
      case 1 /* ByID */: {
        const assetId = AssetId.fromReader(reader);
        ref = new _AssetRef({ type: 1 /* ByID */, assetId });
        break;
      }
      case 2 /* ByGroup */: {
        if (reader.remaining() < 2) {
          throw new Error("invalid asset ref length");
        }
        const groupIndex = reader.readUint16LE();
        ref = new _AssetRef({ type: 2 /* ByGroup */, groupIndex });
        break;
      }
      case 0 /* Unspecified */:
        throw new Error("asset ref type unspecified");
      default:
        throw new Error(`asset ref type unknown ${type}`);
    }
    return ref;
  }
  /**
   * Serialize the asset reference into an existing binary writer.
   *
   * @param writer - Writer to append the asset reference to
   * @see serialize
   */
  serializeTo(writer) {
    writer.writeByte(this.ref.type);
    switch (this.ref.type) {
      case 1 /* ByID */:
        this.ref.assetId.serializeTo(writer);
        break;
      case 2 /* ByGroup */:
        writer.writeUint16LE(this.ref.groupIndex);
        break;
    }
  }
};
var AssetInput = class _AssetInput {
  constructor(input) {
    this.input = input;
  }
  /** Gets the transaction input index for an asset input, e.g. 0 */
  get vin() {
    return this.input.vin;
  }
  /** Gets the amount for an input (in most cases, 330 sats) */
  get amount() {
    return this.input.amount;
  }
  /** Create a local asset input that points at a transaction input index. */
  static create(vin, amount) {
    const input = new _AssetInput({
      type: 1 /* Local */,
      vin,
      amount: typeof amount === "number" ? BigInt(amount) : amount
    });
    input.validate();
    return input;
  }
  /** Create an intent-backed asset input referencing an external intent transaction. */
  static createIntent(txid, vin, amount) {
    if (!txid || txid.length === 0) {
      throw new Error("missing input intent txid");
    }
    let buf;
    try {
      buf = base.hex.decode(txid);
    } catch {
      throw new Error("invalid input intent txid format, must be hex");
    }
    if (buf.length !== TX_HASH_SIZE) {
      throw new Error("invalid input intent txid length");
    }
    const input = new _AssetInput({
      type: 2 /* Intent */,
      txid: buf,
      vin,
      amount: typeof amount === "number" ? BigInt(amount) : amount
    });
    input.validate();
    return input;
  }
  /** Decode an asset input from its hex string form. */
  static fromString(s) {
    let buf;
    try {
      buf = base.hex.decode(s);
    } catch {
      throw new Error("invalid format, must be hex");
    }
    return _AssetInput.fromBytes(buf);
  }
  /** Decode an asset input from its serialized bytes. */
  static fromBytes(buf) {
    const reader = new BufferReader(buf);
    return _AssetInput.fromReader(reader);
  }
  /** Serialize the asset input to raw bytes. */
  serialize() {
    const writer = new BufferWriter();
    this.serializeTo(writer);
    return writer.toBytes();
  }
  /** Encode the asset input to a hex string. */
  toString() {
    return base.hex.encode(this.serialize());
  }
  /** Validate the asset input fields. */
  validate() {
    switch (this.input.type) {
      case 1 /* Local */:
        break;
      case 2 /* Intent */:
        if (isZeroBytes(this.input.txid)) {
          throw new Error("missing input intent txid");
        }
        break;
    }
  }
  /** Decode an asset input from a buffer reader. */
  static fromReader(reader) {
    const type = reader.readByte();
    let input;
    switch (type) {
      case 1 /* Local */: {
        const vin = reader.readUint16LE();
        const amount = reader.readVarUint();
        input = new _AssetInput({
          type: 1 /* Local */,
          vin,
          amount
        });
        break;
      }
      case 2 /* Intent */: {
        if (reader.remaining() < TX_HASH_SIZE) {
          throw new Error("invalid input intent txid length");
        }
        const txid = reader.readSlice(TX_HASH_SIZE);
        const vin = reader.readUint16LE();
        const amount = reader.readVarUint();
        input = new _AssetInput({
          type: 2 /* Intent */,
          txid: new Uint8Array(txid),
          vin,
          amount
        });
        break;
      }
      case 0 /* Unspecified */:
        throw new Error("asset input type unspecified");
      default:
        throw new Error(`asset input type ${type} unknown`);
    }
    input.validate();
    return input;
  }
  /** Serialize the asset input into an existing buffer writer. */
  serializeTo(writer) {
    writer.writeByte(this.input.type);
    if (this.input.type === 2 /* Intent */) {
      writer.write(this.input.txid);
    }
    writer.writeUint16LE(this.input.vin);
    writer.writeVarUint(this.input.amount);
  }
};
var AssetInputs = class _AssetInputs {
  constructor(inputs) {
    this.inputs = inputs;
  }
  /** Create a validated list of asset inputs. */
  static create(inputs) {
    const list = new _AssetInputs(inputs);
    list.validate();
    return list;
  }
  /** Decode an asset input list from its hex string form. */
  static fromString(s) {
    if (!s || s.length === 0) {
      throw new Error("missing asset inputs");
    }
    let buf;
    try {
      buf = base.hex.decode(s);
    } catch {
      throw new Error("invalid asset inputs format, must be hex");
    }
    const reader = new BufferReader(buf);
    return _AssetInputs.fromReader(reader);
  }
  /** Serialize the asset input list to raw bytes. */
  serialize() {
    const writer = new BufferWriter();
    this.serializeTo(writer);
    return writer.toBytes();
  }
  /** Encode the asset input list to a hex string. */
  toString() {
    return base.hex.encode(this.serialize());
  }
  /** Validate the asset input list. */
  validate() {
    const seen = /* @__PURE__ */ new Set();
    let listType = 0 /* Unspecified */;
    for (const assetInput of this.inputs) {
      assetInput.validate();
      if (listType === 0 /* Unspecified */) {
        listType = assetInput.input.type;
      } else if (listType !== assetInput.input.type) {
        throw new Error("all inputs must be of the same type");
      }
      if (assetInput.input.type === 1 /* Local */) {
        if (seen.has(assetInput.input.vin)) {
          throw new Error(`duplicated input vin ${assetInput.input.vin}`);
        }
        seen.add(assetInput.input.vin);
        continue;
      }
    }
  }
  /** Decode an asset input list from a buffer reader. */
  static fromReader(reader) {
    const count = Number(reader.readVarUint());
    const inputs = [];
    for (let i = 0; i < count; i++) {
      inputs.push(AssetInput.fromReader(reader));
    }
    return _AssetInputs.create(inputs);
  }
  /** Serialize the asset input list into an existing buffer writer. */
  serializeTo(writer) {
    writer.writeVarUint(this.inputs.length);
    for (const input of this.inputs) {
      input.serializeTo(writer);
    }
  }
};
var AssetOutput = class _AssetOutput {
  constructor(vout, amount) {
    this.vout = vout;
    this.amount = amount;
  }
  // 0x01 means local output, there is only 1 local output type currently
  // however we serialize it for future upgrades
  static TYPE_LOCAL = 1;
  /** Create a local asset output referencing a transaction output index. */
  static create(vout, amount) {
    const output = new _AssetOutput(vout, typeof amount === "number" ? BigInt(amount) : amount);
    output.validate();
    return output;
  }
  /** Decode an asset output from its hex string form. */
  static fromString(s) {
    let buf;
    try {
      buf = base.hex.decode(s);
    } catch {
      throw new Error("invalid asset output format, must be hex");
    }
    return _AssetOutput.fromBytes(buf);
  }
  /** Decode an asset output from its serialized bytes. */
  static fromBytes(buf) {
    if (!buf || buf.length === 0) {
      throw new Error("missing asset output");
    }
    const reader = new BufferReader(buf);
    const output = _AssetOutput.fromReader(reader);
    output.validate();
    return output;
  }
  /** Serialize the asset output to raw bytes. */
  serialize() {
    const writer = new BufferWriter();
    this.serializeTo(writer);
    return writer.toBytes();
  }
  /** Encode the asset output to a hex string. */
  toString() {
    return base.hex.encode(this.serialize());
  }
  /** Validate the asset output fields. */
  validate() {
    if (!Number.isInteger(this.vout) || this.vout < 0 || this.vout > 65535) {
      throw new Error("asset output vout must be an integer in range [0, 65535]");
    }
    if (this.amount <= 0n) {
      throw new Error("asset output amount must be greater than 0");
    }
  }
  /** Decode an asset output from a buffer reader. */
  static fromReader(reader) {
    if (reader.remaining() < 2) {
      throw new Error("invalid asset output vout length");
    }
    const type = reader.readByte();
    if (type !== _AssetOutput.TYPE_LOCAL) {
      if (type === 0) {
        throw new Error("output type unspecified");
      }
      throw new Error("unknown asset output type");
    }
    let vout;
    try {
      vout = reader.readUint16LE();
    } catch {
      throw new Error("invalid asset output vout length");
    }
    const amount = reader.readVarUint();
    return new _AssetOutput(vout, amount);
  }
  /** Serialize the asset output into an existing buffer writer. */
  serializeTo(writer) {
    writer.writeByte(1);
    writer.writeUint16LE(this.vout);
    writer.writeVarUint(this.amount);
  }
};
var AssetOutputs = class _AssetOutputs {
  constructor(outputs) {
    this.outputs = outputs;
  }
  /** Create a validated list of asset outputs. */
  static create(outputs) {
    const list = new _AssetOutputs(outputs);
    list.validate();
    return list;
  }
  /** Decode an asset output list from its hex string form. */
  static fromString(s) {
    if (!s || s.length === 0) {
      throw new Error("missing asset outputs");
    }
    let buf;
    try {
      buf = base.hex.decode(s);
    } catch {
      throw new Error("invalid asset outputs format, must be hex");
    }
    const reader = new BufferReader(buf);
    return _AssetOutputs.fromReader(reader);
  }
  /** Serialize the asset output list to raw bytes. */
  serialize() {
    const writer = new BufferWriter();
    this.serializeTo(writer);
    return writer.toBytes();
  }
  /** Encode the asset output list to a hex string. */
  toString() {
    return base.hex.encode(this.serialize());
  }
  /** Validate the asset output list. */
  validate() {
    const seen = /* @__PURE__ */ new Set();
    for (const output of this.outputs) {
      output.validate();
      if (seen.has(output.vout)) {
        throw new Error(`duplicated output vout ${output.vout}`);
      }
      seen.add(output.vout);
    }
  }
  /** Decode an asset output list from a buffer reader. */
  static fromReader(reader) {
    const count = Number(reader.readVarUint());
    if (count === 0) {
      return new _AssetOutputs([]);
    }
    const outputs = [];
    for (let i = 0; i < count; i++) {
      outputs.push(AssetOutput.fromReader(reader));
    }
    const result = new _AssetOutputs(outputs);
    result.validate();
    return result;
  }
  /** Serialize the asset output list into an existing buffer writer. */
  serializeTo(writer) {
    this.validate();
    writer.writeVarUint(this.outputs.length);
    for (const output of this.outputs) {
      output.serializeTo(writer);
    }
  }
};
var Metadata = class _Metadata {
  constructor(key, value) {
    this.key = key;
    this.value = value;
  }
  /** Create a metadata entry from raw key and value bytes. */
  static create(key, value) {
    const md = new _Metadata(key, value);
    md.validate();
    return md;
  }
  /** Decode metadata from its hex string form. */
  static fromString(s) {
    let buf;
    try {
      buf = base.hex.decode(s);
    } catch {
      throw new Error("invalid metadata format, must be hex");
    }
    return _Metadata.fromBytes(buf);
  }
  /** Decode metadata from its serialized bytes. */
  static fromBytes(buf) {
    if (!buf || buf.length === 0) {
      throw new Error("missing metadata");
    }
    const reader = new BufferReader(buf);
    return _Metadata.fromReader(reader);
  }
  /** Serialize metadata to raw bytes. */
  serialize() {
    const writer = new BufferWriter();
    this.serializeTo(writer);
    return writer.toBytes();
  }
  /** Encode metadata to a hex string. */
  toString() {
    return base.hex.encode(this.serialize());
  }
  get keyString() {
    return new TextDecoder().decode(this.key);
  }
  get valueString() {
    return new TextDecoder().decode(this.value);
  }
  /** Validate the metadata key and value. */
  validate() {
    if (this.key.length === 0) {
      throw new Error("missing metadata key");
    }
    if (this.value.length === 0) {
      throw new Error("missing metadata value");
    }
  }
  /** Decode metadata from a buffer reader. */
  static fromReader(reader) {
    let key;
    let value;
    try {
      key = reader.readVarSlice();
    } catch {
      throw new Error("invalid metadata length");
    }
    try {
      value = reader.readVarSlice();
    } catch {
      throw new Error("invalid metadata length");
    }
    const md = new _Metadata(key, value);
    md.validate();
    return md;
  }
  /** Serialize metadata into an existing buffer writer. */
  serializeTo(writer) {
    writer.writeVarSlice(this.key);
    writer.writeVarSlice(this.value);
  }
};
var MetadataList = class _MetadataList {
  constructor(items) {
    this.items = items;
  }
  static ARK_LEAF_TAG = "ArkadeAssetLeaf";
  static ARK_BRANCH_TAG = "ArkadeAssetBranch";
  static ARK_LEAF_VERSION = 0;
  /** Create a metadata list from its hex string form. */
  static fromString(s) {
    let buf;
    try {
      buf = base.hex.decode(s);
    } catch {
      throw new Error("invalid metadata list format");
    }
    return _MetadataList.fromBytes(buf);
  }
  /** Decode a metadata list from its serialized bytes. */
  static fromBytes(buf) {
    if (!buf || buf.length === 0) {
      throw new Error("missing metadata list");
    }
    const reader = new BufferReader(buf);
    return _MetadataList.fromReader(reader);
  }
  /** Decode a metadata list from a buffer reader. */
  static fromReader(reader) {
    const count = Number(reader.readVarUint());
    const items = Array.from({ length: count }, () => Metadata.fromReader(reader));
    return new _MetadataList(items);
  }
  /** Serialize the metadata list into an existing buffer writer. */
  serializeTo(writer) {
    writer.writeVarUint(this.items.length);
    for (const item of this) {
      item.serializeTo(writer);
    }
  }
  /** Serialize the metadata list to raw bytes. */
  serialize() {
    const writer = new BufferWriter();
    this.serializeTo(writer);
    return writer.toBytes();
  }
  /** Iterate through metadata entries in insertion order. */
  [Symbol.iterator]() {
    return this.items[Symbol.iterator]();
  }
  get length() {
    return this.items.length;
  }
  /** Compute the tagged Merkle root for the metadata list. */
  hash() {
    if (this.items.length === 0) throw new Error("missing metadata list");
    const levels = buildMetadataMerkleTree(this.items);
    return levels[levels.length - 1][0];
  }
};
function computeMetadataLeafHash(md) {
  const writer = new BufferWriter();
  writer.writeByte(MetadataList.ARK_LEAF_VERSION);
  writer.writeVarSlice(md.key);
  writer.writeVarSlice(md.value);
  return secp256k1_js.schnorr.utils.taggedHash(MetadataList.ARK_LEAF_TAG, writer.toBytes());
}
function computeMetadataBranchHash(a, b) {
  const [smaller, larger] = utils_js.compareBytes(a, b) === -1 ? [a, b] : [b, a];
  return secp256k1_js.schnorr.utils.taggedHash(MetadataList.ARK_BRANCH_TAG, smaller, larger);
}
function buildMetadataMerkleTree(leaves) {
  if (leaves.length === 0) return [];
  const leafHashes = leaves.map(computeMetadataLeafHash);
  const levels = [leafHashes];
  let current = leafHashes;
  while (current.length > 1) {
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 < current.length) {
        next.push(computeMetadataBranchHash(current[i], current[i + 1]));
      } else {
        next.push(current[i]);
      }
    }
    levels.push(next);
    current = next;
  }
  return levels;
}
var AssetGroup = class _AssetGroup {
  /** @see create */
  constructor(assetId, controlAsset, inputs, outputs, metadata) {
    this.assetId = assetId;
    this.controlAsset = controlAsset;
    this.inputs = inputs;
    this.outputs = outputs;
    this.metadataList = new MetadataList(metadata);
  }
  metadataList;
  /**
   * Create and validate an asset group.
   *
   * @param assetId - Asset id for this group, or `null` for fresh issuance
   * @param controlAsset - Optional control asset reference for (re) issuance
   * @param inputs - Asset inputs in the group
   * @param outputs - Asset outputs in the group
   * @param metadata - Metadata entries associated with the group
   * @returns A validated asset group
   * @throws Error if the group fails validation
   * @see validate
   */
  static create(assetId, controlAsset, inputs, outputs, metadata) {
    const ag = new _AssetGroup(assetId, controlAsset, inputs, outputs, metadata);
    ag.validate();
    return ag;
  }
  /**
   * Decode an asset group from its hex string form.
   *
   * @param s - Hex-encoded asset group
   * @returns Decoded asset group
   * @throws Error if the string is not valid hex or does not encode a valid asset group
   * @see toString
   */
  static fromString(s) {
    let buf;
    try {
      buf = base.hex.decode(s);
    } catch {
      throw new Error("invalid format, must be hex");
    }
    return _AssetGroup.fromBytes(buf);
  }
  /**
   * Decode an asset group from its serialized bytes.
   *
   * @param buf - Serialized asset group bytes
   * @returns Decoded asset group
   * @throws Error if the buffer is empty or malformed
   */
  static fromBytes(buf) {
    if (!buf || buf.length === 0) {
      throw new Error("missing asset group");
    }
    const reader = new BufferReader(buf);
    return _AssetGroup.fromReader(reader);
  }
  /**
   * Return true when the group represents an issuance.
   *
   * @returns `true` when the group has no asset id
   */
  isIssuance() {
    return this.assetId === null;
  }
  /**
   * Return true when the group represents a reissuance.
   *
   * @returns `true` when the group has an asset id and outputs exceed local inputs
   * @remarks
   * Only local inputs contribute to the comparison; intent-backed inputs contribute `0` here.
   */
  isReissuance() {
    const sumReducer = (s, { amount }) => s + amount;
    const sumOutputs = this.outputs.reduce(sumReducer, 0n);
    const sumInputs = this.inputs.map((i) => ({
      amount: i.input.type === 1 /* Local */ ? i.input.amount : 0n
    })).reduce(sumReducer, 0n);
    return !this.isIssuance() && sumInputs < sumOutputs;
  }
  /**
   * Serialize the asset group to raw bytes.
   *
   * @returns Serialized asset group bytes
   * @see fromBytes
   */
  serialize() {
    this.validate();
    const writer = new BufferWriter();
    this.serializeTo(writer);
    return writer.toBytes();
  }
  /**
   * Validate the asset group and its child structures.
   *
   * @throws Error if the group is empty or violates issuance invariants
   */
  validate() {
    if (this.inputs.length === 0 && this.outputs.length === 0) {
      throw new Error("empty asset group");
    }
    if (this.isIssuance()) {
      if (this.inputs.length !== 0) {
        throw new Error("issuance must have no inputs");
      }
    } else {
      if (this.controlAsset !== null) {
        throw new Error("only issuance can have a control asset");
      }
    }
  }
  /**
   * Convert the group into its batch-leaf representation for the given intent txid.
   *
   * @param intentTxid - Intent transaction id used to build the leaf input reference
   * @returns Batch-leaf asset group
   * @see AssetInput.createIntent
   */
  toBatchLeafAssetGroup(intentTxid) {
    const leafInput = AssetInput.createIntent(base.hex.encode(intentTxid), 0, 0);
    return new _AssetGroup(
      this.assetId,
      this.controlAsset,
      [leafInput],
      this.outputs,
      this.metadataList.items
    );
  }
  /**
   * Encode the asset group to a hex string.
   *
   * @returns Hex-encoded asset group
   * @see fromString
   */
  toString() {
    return base.hex.encode(this.serialize());
  }
  /**
   * Decode an asset group from a binary reader.
   *
   * @param reader - Reader positioned at an asset group
   * @returns Decoded asset group
   * @throws Error if the encoded group is malformed
   */
  static fromReader(reader) {
    const presence = reader.readByte();
    let assetId = null;
    let controlAsset = null;
    let metadata = [];
    if (presence & MASK_ASSET_ID) {
      assetId = AssetId.fromReader(reader);
    }
    if (presence & MASK_CONTROL_ASSET) {
      controlAsset = AssetRef.fromReader(reader);
    }
    if (presence & MASK_METADATA) {
      metadata = MetadataList.fromReader(reader).items;
    }
    const inputs = AssetInputs.fromReader(reader);
    const outputs = AssetOutputs.fromReader(reader);
    const ag = new _AssetGroup(assetId, controlAsset, inputs.inputs, outputs.outputs, metadata);
    ag.validate();
    return ag;
  }
  /**
   * Serialize the asset group into an existing binary writer.
   *
   * @param writer - Writer to append the asset group to
   */
  serializeTo(writer) {
    let presence = 0;
    if (this.assetId !== null) {
      presence |= MASK_ASSET_ID;
    }
    if (this.controlAsset !== null) {
      presence |= MASK_CONTROL_ASSET;
    }
    if (this.metadataList.length > 0) {
      presence |= MASK_METADATA;
    }
    writer.writeByte(presence);
    if (presence & MASK_ASSET_ID) {
      this.assetId.serializeTo(writer);
    }
    if (presence & MASK_CONTROL_ASSET) {
      this.controlAsset.serializeTo(writer);
    }
    if (presence & MASK_METADATA) {
      this.metadataList.serializeTo(writer);
    }
    writer.writeVarUint(this.inputs.length);
    for (const input of this.inputs) {
      input.serializeTo(writer);
    }
    writer.writeVarUint(this.outputs.length);
    for (const output of this.outputs) {
      output.serializeTo(writer);
    }
  }
};
var Packet = class _Packet {
  constructor(groups) {
    this.groups = groups;
  }
  /** PACKET_TYPE is the 1-byte TLV type tag used in the Extension envelope. */
  static PACKET_TYPE = 0;
  /** Create a validated asset packet from a list of asset groups. */
  static create(groups) {
    const p = new _Packet(groups);
    p.validate();
    return p;
  }
  /**
   * fromBytes parses a Packet from raw bytes.
   */
  static fromBytes(buf) {
    return _Packet.fromReader(new BufferReader(buf));
  }
  /**
   * fromString parses a Packet from a raw hex string (not an OP_RETURN script).
   */
  static fromString(s) {
    if (!s) {
      throw new Error("missing packet data");
    }
    let buf;
    try {
      buf = base.hex.decode(s);
    } catch {
      throw new Error("invalid packet format, must be hex");
    }
    return _Packet.fromBytes(buf);
  }
  /**
   * type returns the TLV packet type tag. Implements ExtensionPacket interface.
   */
  type() {
    return _Packet.PACKET_TYPE;
  }
  /** Convert the packet into the batch-leaf form for a specific intent transaction id. */
  leafTxPacket(intentTxid) {
    const leafGroups = this.groups.map((group) => group.toBatchLeafAssetGroup(intentTxid));
    return new _Packet(leafGroups);
  }
  /**
   * serialize encodes the packet as raw bytes (varint group count + group data).
   * Does NOT include OP_RETURN, Arkade magic bytes (`ARK`), or TLV type/length; those are
   * added by the Extension module.
   */
  serialize() {
    if (this.groups.length === 0) {
      return new Uint8Array(0);
    }
    const writer = new BufferWriter();
    writer.writeVarUint(this.groups.length);
    for (const group of this.groups) {
      group.serializeTo(writer);
    }
    return writer.toBytes();
  }
  /**
   * toString returns the hex-encoded raw packet bytes.
   */
  toString() {
    return base.hex.encode(this.serialize());
  }
  /** Validate packet structure and cross-group references. */
  validate() {
    if (this.groups.length === 0) {
      throw new Error("missing assets");
    }
    const seenAssetIds = /* @__PURE__ */ new Set();
    for (const group of this.groups) {
      if (group.assetId !== null) {
        const key = group.assetId.toString();
        if (seenAssetIds.has(key)) {
          throw new Error(`duplicate asset group for asset ${key}`);
        }
        seenAssetIds.add(key);
      }
      if (group.controlAsset !== null && group.controlAsset.ref.type === 2 /* ByGroup */ && group.controlAsset.ref.groupIndex >= this.groups.length) {
        throw new Error(
          `invalid control asset group index, ${group.controlAsset.ref.groupIndex} out of range [0, ${this.groups.length - 1}]`
        );
      }
    }
  }
  static fromReader(reader) {
    const count = Number(reader.readVarUint());
    const groups = [];
    for (let i = 0; i < count; i++) {
      groups.push(AssetGroup.fromReader(reader));
    }
    if (reader.remaining() > 0) {
      throw new Error(
        `invalid packet length, left ${reader.remaining()} unknown bytes to read`
      );
    }
    const packet = new _Packet(groups);
    packet.validate();
    return packet;
  }
};
var IndexerTxType = /* @__PURE__ */ ((IndexerTxType2) => {
  IndexerTxType2[IndexerTxType2["INDEXER_TX_TYPE_UNSPECIFIED"] = 0] = "INDEXER_TX_TYPE_UNSPECIFIED";
  IndexerTxType2[IndexerTxType2["INDEXER_TX_TYPE_RECEIVED"] = 1] = "INDEXER_TX_TYPE_RECEIVED";
  IndexerTxType2[IndexerTxType2["INDEXER_TX_TYPE_SENT"] = 2] = "INDEXER_TX_TYPE_SENT";
  return IndexerTxType2;
})(IndexerTxType || {});
var ChainTxType = /* @__PURE__ */ ((ChainTxType2) => {
  ChainTxType2["UNSPECIFIED"] = "INDEXER_CHAINED_TX_TYPE_UNSPECIFIED";
  ChainTxType2["COMMITMENT"] = "INDEXER_CHAINED_TX_TYPE_COMMITMENT";
  ChainTxType2["ARK"] = "INDEXER_CHAINED_TX_TYPE_ARK";
  ChainTxType2["TREE"] = "INDEXER_CHAINED_TX_TYPE_TREE";
  ChainTxType2["CHECKPOINT"] = "INDEXER_CHAINED_TX_TYPE_CHECKPOINT";
  return ChainTxType2;
})(ChainTxType || {});
var RestIndexerProvider = class {
  constructor(serverUrl = chunk4QHMS5XH_cjs.DEFAULT_ARKADE_SERVER_URL) {
    this.serverUrl = serverUrl;
  }
  async getVtxoTree(batchOutpoint, opts) {
    let url = `${this.serverUrl}/v1/indexer/batch/${batchOutpoint.txid}/${batchOutpoint.vout}/tree`;
    const params = new URLSearchParams();
    if (opts) {
      if (opts.pageIndex !== void 0)
        params.append("page.index", opts.pageIndex.toString());
      if (opts.pageSize !== void 0) params.append("page.size", opts.pageSize.toString());
    }
    if (params.toString()) {
      url += "?" + params.toString();
    }
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch vtxo tree: ${res.statusText}`);
    }
    const data = await res.json();
    if (!Response.isVtxoTreeResponse(data)) {
      throw new Error("Invalid vtxo tree data received");
    }
    data.vtxoTree.forEach((tx) => {
      tx.children = Object.fromEntries(
        Object.entries(tx.children).map(([key, value]) => [Number(key), value])
      );
    });
    return data;
  }
  async getVtxoTreeLeaves(batchOutpoint, opts) {
    let url = `${this.serverUrl}/v1/indexer/batch/${batchOutpoint.txid}/${batchOutpoint.vout}/tree/leaves`;
    const params = new URLSearchParams();
    if (opts) {
      if (opts.pageIndex !== void 0)
        params.append("page.index", opts.pageIndex.toString());
      if (opts.pageSize !== void 0) params.append("page.size", opts.pageSize.toString());
    }
    if (params.toString()) {
      url += "?" + params.toString();
    }
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch vtxo tree leaves: ${res.statusText}`);
    }
    const data = await res.json();
    if (!Response.isVtxoTreeLeavesResponse(data)) {
      throw new Error("Invalid vtxos tree leaves data received");
    }
    return data;
  }
  async getBatchSweepTransactions(batchOutpoint) {
    const url = `${this.serverUrl}/v1/indexer/batch/${batchOutpoint.txid}/${batchOutpoint.vout}/sweepTxs`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch batch sweep transactions: ${res.statusText}`);
    }
    const data = await res.json();
    if (!Response.isBatchSweepTransactionsResponse(data)) {
      throw new Error("Invalid batch sweep transactions data received");
    }
    return data;
  }
  async getCommitmentTx(txid) {
    const url = `${this.serverUrl}/v1/indexer/commitmentTx/${txid}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch commitment tx: ${res.statusText}`);
    }
    const data = await res.json();
    if (!Response.isCommitmentTx(data)) {
      throw new Error("Invalid commitment tx data received");
    }
    return data;
  }
  async getCommitmentTxConnectors(txid, opts) {
    let url = `${this.serverUrl}/v1/indexer/commitmentTx/${txid}/connectors`;
    const params = new URLSearchParams();
    if (opts) {
      if (opts.pageIndex !== void 0)
        params.append("page.index", opts.pageIndex.toString());
      if (opts.pageSize !== void 0) params.append("page.size", opts.pageSize.toString());
    }
    if (params.toString()) {
      url += "?" + params.toString();
    }
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch commitment tx connectors: ${res.statusText}`);
    }
    const data = await res.json();
    if (!Response.isConnectorsResponse(data)) {
      throw new Error("Invalid commitment tx connectors data received");
    }
    data.connectors.forEach((tx) => {
      tx.children = Object.fromEntries(
        Object.entries(tx.children).map(([key, value]) => [Number(key), value])
      );
    });
    return data;
  }
  async getCommitmentTxForfeitTxs(txid, opts) {
    let url = `${this.serverUrl}/v1/indexer/commitmentTx/${txid}/forfeitTxs`;
    const params = new URLSearchParams();
    if (opts) {
      if (opts.pageIndex !== void 0)
        params.append("page.index", opts.pageIndex.toString());
      if (opts.pageSize !== void 0) params.append("page.size", opts.pageSize.toString());
    }
    if (params.toString()) {
      url += "?" + params.toString();
    }
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch commitment tx forfeitTxs: ${res.statusText}`);
    }
    const data = await res.json();
    if (!Response.isForfeitTxsResponse(data)) {
      throw new Error("Invalid commitment tx forfeitTxs data received");
    }
    return data;
  }
  getSubscription(subscriptionId, abortSignal) {
    const url = `${this.serverUrl}/v1/indexer/script/subscription/${subscriptionId}`;
    let iterator = null;
    const closeIterator = () => iterator?.close();
    const gen = (async function* () {
      const abortHandler = closeIterator;
      abortSignal?.addEventListener("abort", abortHandler);
      try {
        while (!abortSignal?.aborted) {
          try {
            const currentIterator = eventSourceIterator(new EventSource(url));
            iterator = currentIterator;
            for await (const event of currentIterator) {
              if (abortSignal?.aborted) break;
              try {
                const data = JSON.parse(event.data);
                if (data.event) {
                  yield {
                    txid: data.event.txid,
                    scripts: data.event.scripts || [],
                    newVtxos: (data.event.newVtxos || []).map(convertVtxo),
                    spentVtxos: (data.event.spentVtxos || []).map(convertVtxo),
                    sweptVtxos: (data.event.sweptVtxos || []).map(convertVtxo),
                    tx: data.event.tx,
                    checkpointTxs: data.event.checkpointTxs
                  };
                }
              } catch (err) {
                console.error("Failed to parse subscription event:", err);
                throw err;
              }
            }
          } catch (error) {
            if (abortSignal?.aborted || error instanceof Error && error.name === "AbortError") {
              break;
            }
            if (isFetchTimeoutError(error)) {
              console.debug("Timeout error ignored");
              continue;
            }
            if (isEventSourceError(error)) {
              throw error;
            }
            console.error("Subscription error:", error);
            throw error;
          } finally {
            closeIterator();
            iterator = null;
          }
        }
      } finally {
        abortSignal?.removeEventListener("abort", abortHandler);
        closeIterator();
      }
    })();
    const origReturn = gen.return.bind(gen);
    gen.return = (value) => {
      closeIterator();
      return origReturn(value);
    };
    return gen;
  }
  async getVirtualTxs(txids, opts) {
    let url = `${this.serverUrl}/v1/indexer/virtualTx/${txids.join(",")}`;
    const params = new URLSearchParams();
    if (opts) {
      if (opts.pageIndex !== void 0)
        params.append("page.index", opts.pageIndex.toString());
      if (opts.pageSize !== void 0) params.append("page.size", opts.pageSize.toString());
    }
    if (params.toString()) {
      url += "?" + params.toString();
    }
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch virtual txs: ${res.statusText}`);
    }
    const data = await res.json();
    if (!Response.isVirtualTxsResponse(data)) {
      throw new Error("Invalid virtual txs data received");
    }
    return data;
  }
  async getVtxoChain(vtxoOutpoint, opts) {
    let url = `${this.serverUrl}/v1/indexer/vtxo/${vtxoOutpoint.txid}/${vtxoOutpoint.vout}/chain`;
    const params = new URLSearchParams();
    if (opts) {
      if (opts.pageIndex !== void 0)
        params.append("page.index", opts.pageIndex.toString());
      if (opts.pageSize !== void 0) params.append("page.size", opts.pageSize.toString());
    }
    if (params.toString()) {
      url += "?" + params.toString();
    }
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch vtxo chain: ${res.statusText}`);
    }
    const data = await res.json();
    if (!Response.isVtxoChainResponse(data)) {
      throw new Error("Invalid vtxo chain data received");
    }
    return data;
  }
  async getVtxos(opts) {
    const hasScripts = (opts?.scripts?.length ?? 0) > 0;
    const hasOutpoints = (opts?.outpoints?.length ?? 0) > 0;
    if (hasScripts && hasOutpoints) {
      throw new Error("scripts and outpoints are mutually exclusive options");
    }
    if (!hasScripts && !hasOutpoints) {
      throw new Error("Either scripts or outpoints must be provided");
    }
    const filterCount = [opts?.spendableOnly, opts?.spentOnly, opts?.recoverableOnly].filter(
      Boolean
    ).length;
    if (filterCount > 1) {
      throw new Error(
        "spendableOnly, spentOnly, and recoverableOnly are mutually exclusive options"
      );
    }
    if (opts?.after !== void 0 && opts?.before !== void 0 && opts.after !== 0 && opts.before !== 0 && opts.before <= opts.after) {
      throw new Error("before must be greater than after");
    }
    let url = `${this.serverUrl}/v1/indexer/vtxos`;
    const params = new URLSearchParams();
    if (hasScripts) {
      opts.scripts.forEach((script) => {
        params.append("scripts", script);
      });
    }
    if (hasOutpoints) {
      opts.outpoints.forEach((outpoint) => {
        params.append("outpoints", `${outpoint.txid}:${outpoint.vout}`);
      });
    }
    if (opts) {
      if (opts.spendableOnly !== void 0)
        params.append("spendableOnly", opts.spendableOnly.toString());
      if (opts.spentOnly !== void 0) params.append("spentOnly", opts.spentOnly.toString());
      if (opts.recoverableOnly !== void 0)
        params.append("recoverableOnly", opts.recoverableOnly.toString());
      if (opts.pendingOnly !== void 0)
        params.append("pendingOnly", opts.pendingOnly.toString());
      if (opts.after !== void 0) params.append("after", opts.after.toString());
      if (opts.before !== void 0) params.append("before", opts.before.toString());
      if (opts.pageIndex !== void 0)
        params.append("page.index", opts.pageIndex.toString());
      if (opts.pageSize !== void 0) params.append("page.size", opts.pageSize.toString());
    }
    if (params.toString()) {
      url += "?" + params.toString();
    }
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch vtxos: ${res.statusText}`);
    }
    const data = await res.json();
    if (!Response.isVtxosResponse(data)) {
      throw new Error("Invalid vtxos data received");
    }
    return {
      vtxos: data.vtxos.map(convertVtxo),
      page: data.page
    };
  }
  async getAssetDetails(assetId) {
    const url = `${this.serverUrl}/v1/indexer/asset/${encodeURIComponent(assetId)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch asset details: ${res.statusText}`);
    }
    const data = await res.json();
    if (!Response.isGetAssetResponse(data)) {
      throw new Error("Invalid get asset response");
    }
    const metadata = data.metadata?.length ? parseAssetMetadata(data.metadata) : void 0;
    return {
      assetId: data.assetId ?? assetId,
      supply: BigInt(data.supply ?? 0),
      metadata,
      controlAssetId: data.controlAsset || void 0
    };
  }
  async subscribeForScripts(scripts, subscriptionId) {
    const url = `${this.serverUrl}/v1/indexer/script/subscribe`;
    const res = await fetch(url, {
      headers: {
        "Content-Type": "application/json"
      },
      method: "POST",
      body: JSON.stringify({ scripts, subscriptionId })
    });
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Failed to subscribe to scripts: ${errorText}`);
    }
    const data = await res.json();
    if (!data.subscriptionId) throw new Error(`Subscription ID not found`);
    return data.subscriptionId;
  }
  async unsubscribeForScripts(subscriptionId, scripts) {
    const url = `${this.serverUrl}/v1/indexer/script/unsubscribe`;
    const res = await fetch(url, {
      headers: {
        "Content-Type": "application/json"
      },
      method: "POST",
      body: JSON.stringify({ subscriptionId, scripts })
    });
    if (!res.ok) {
      const errorText = await res.text();
      console.warn(`Failed to unsubscribe to scripts: ${errorText}`);
    }
  }
};
function parseAssetMetadata(metadata) {
  const metadataList = MetadataList.fromString(metadata);
  const out = {};
  const decoder = new TextDecoder();
  for (const { key, value } of metadataList.items) {
    const keyString = decoder.decode(key);
    switch (keyString) {
      case "decimals":
        const n = Number(decoder.decode(value));
        out[keyString] = Number.isFinite(n) ? n : base.hex.encode(value);
        break;
      case "name":
      case "ticker":
      case "icon":
        out[keyString] = decoder.decode(value);
        break;
      default:
        out[keyString] = base.hex.encode(value);
        break;
    }
  }
  return out;
}
function convertVtxo(vtxo) {
  return {
    txid: vtxo.outpoint.txid,
    vout: vtxo.outpoint.vout,
    value: Number(vtxo.amount),
    status: {
      confirmed: !vtxo.isSwept && !vtxo.isPreconfirmed,
      isLeaf: !vtxo.isPreconfirmed
    },
    virtualStatus: {
      state: vtxo.isSwept ? "swept" : vtxo.isPreconfirmed ? "preconfirmed" : "settled",
      commitmentTxIds: vtxo.commitmentTxids,
      batchExpiry: vtxo.expiresAt ? Number(vtxo.expiresAt) * 1e3 : void 0
    },
    spentBy: vtxo.spentBy ?? "",
    settledBy: vtxo.settledBy,
    arkTxId: vtxo.arkTxid,
    createdAt: new Date(Number(vtxo.createdAt) * 1e3),
    isUnrolled: vtxo.isUnrolled,
    isSpent: vtxo.isSpent,
    script: vtxo.script,
    assets: vtxo.assets?.map((a) => ({
      assetId: a.assetId,
      amount: BigInt(a.amount)
    }))
  };
}
var Response;
((Response2) => {
  function isBatchInfo(data) {
    return typeof data === "object" && typeof data.totalOutputAmount === "string" && typeof data.totalOutputVtxos === "number" && typeof data.expiresAt === "string" && typeof data.swept === "boolean";
  }
  function isChain(data) {
    return typeof data === "object" && typeof data.txid === "string" && typeof data.expiresAt === "string" && Object.values(ChainTxType).includes(data.type) && Array.isArray(data.spends) && data.spends.every((spend) => typeof spend === "string");
  }
  function isCommitmentTx(data) {
    return typeof data === "object" && typeof data.startedAt === "string" && typeof data.endedAt === "string" && typeof data.totalInputAmount === "string" && typeof data.totalInputVtxos === "number" && typeof data.totalOutputAmount === "string" && typeof data.totalOutputVtxos === "number" && typeof data.batches === "object" && Object.values(data.batches).every(isBatchInfo);
  }
  Response2.isCommitmentTx = isCommitmentTx;
  function isOutpoint(data) {
    return typeof data === "object" && typeof data.txid === "string" && typeof data.vout === "number";
  }
  Response2.isOutpoint = isOutpoint;
  function isOutpointArray(data) {
    return Array.isArray(data) && data.every(isOutpoint);
  }
  Response2.isOutpointArray = isOutpointArray;
  function isTx(data) {
    return typeof data === "object" && typeof data.txid === "string" && typeof data.children === "object" && Object.values(data.children).every(isTxid) && Object.keys(data.children).every((k) => Number.isInteger(Number(k)));
  }
  function isTxsArray(data) {
    return Array.isArray(data) && data.every(isTx);
  }
  Response2.isTxsArray = isTxsArray;
  function isTxHistoryRecord(data) {
    return typeof data === "object" && typeof data.amount === "string" && typeof data.createdAt === "string" && typeof data.isSettled === "boolean" && typeof data.settledBy === "string" && Object.values(IndexerTxType).includes(data.type) && (!data.commitmentTxid && typeof data.virtualTxid === "string" || typeof data.commitmentTxid === "string" && !data.virtualTxid);
  }
  function isTxHistoryRecordArray(data) {
    return Array.isArray(data) && data.every(isTxHistoryRecord);
  }
  Response2.isTxHistoryRecordArray = isTxHistoryRecordArray;
  function isTxid(data) {
    return typeof data === "string" && data.length === 64;
  }
  function isTxidArray(data) {
    return Array.isArray(data) && data.every(isTxid);
  }
  Response2.isTxidArray = isTxidArray;
  function isVtxoAsset(data) {
    return typeof data === "object" && data !== null && typeof data.assetId === "string" && typeof data.amount === "string";
  }
  function isVtxo(data) {
    return typeof data === "object" && isOutpoint(data.outpoint) && typeof data.createdAt === "string" && (data.expiresAt === null || typeof data.expiresAt === "string") && typeof data.amount === "string" && typeof data.script === "string" && typeof data.isPreconfirmed === "boolean" && typeof data.isSwept === "boolean" && typeof data.isUnrolled === "boolean" && typeof data.isSpent === "boolean" && (!data.spentBy || typeof data.spentBy === "string") && (!data.settledBy || typeof data.settledBy === "string") && (!data.arkTxid || typeof data.arkTxid === "string") && Array.isArray(data.commitmentTxids) && data.commitmentTxids.every(isTxid) && (data.assets === void 0 || Array.isArray(data.assets) && data.assets.every(isVtxoAsset));
  }
  function isPageResponse(data) {
    return typeof data === "object" && typeof data.current === "number" && typeof data.next === "number" && typeof data.total === "number";
  }
  function isVtxoTreeResponse(data) {
    return typeof data === "object" && Array.isArray(data.vtxoTree) && data.vtxoTree.every(isTx) && (!data.page || isPageResponse(data.page));
  }
  Response2.isVtxoTreeResponse = isVtxoTreeResponse;
  function isVtxoTreeLeavesResponse(data) {
    return typeof data === "object" && Array.isArray(data.leaves) && data.leaves.every(isOutpoint) && (!data.page || isPageResponse(data.page));
  }
  Response2.isVtxoTreeLeavesResponse = isVtxoTreeLeavesResponse;
  function isConnectorsResponse(data) {
    return typeof data === "object" && Array.isArray(data.connectors) && data.connectors.every(isTx) && (!data.page || isPageResponse(data.page));
  }
  Response2.isConnectorsResponse = isConnectorsResponse;
  function isForfeitTxsResponse(data) {
    return typeof data === "object" && Array.isArray(data.txids) && data.txids.every(isTxid) && (!data.page || isPageResponse(data.page));
  }
  Response2.isForfeitTxsResponse = isForfeitTxsResponse;
  function isSweptCommitmentTxResponse(data) {
    return typeof data === "object" && Array.isArray(data.sweptBy) && data.sweptBy.every(isTxid);
  }
  Response2.isSweptCommitmentTxResponse = isSweptCommitmentTxResponse;
  function isBatchSweepTransactionsResponse(data) {
    return typeof data === "object" && Array.isArray(data.sweptBy) && data.sweptBy.every(isTxid);
  }
  Response2.isBatchSweepTransactionsResponse = isBatchSweepTransactionsResponse;
  function isVirtualTxsResponse(data) {
    return typeof data === "object" && Array.isArray(data.txs) && data.txs.every((tx) => typeof tx === "string") && (!data.page || isPageResponse(data.page));
  }
  Response2.isVirtualTxsResponse = isVirtualTxsResponse;
  function isVtxoChainResponse(data) {
    return typeof data === "object" && Array.isArray(data.chain) && data.chain.every(isChain) && (!data.page || isPageResponse(data.page));
  }
  Response2.isVtxoChainResponse = isVtxoChainResponse;
  function isVtxosResponse(data) {
    return typeof data === "object" && Array.isArray(data.vtxos) && data.vtxos.every(isVtxo) && (!data.page || isPageResponse(data.page));
  }
  Response2.isVtxosResponse = isVtxosResponse;
  function isGetAssetResponse(data) {
    return typeof data === "object" && data !== null && typeof data.assetId === "string" && typeof data.supply === "string" && (data.controlAsset === void 0 || typeof data.controlAsset === "string") && (data.metadata === void 0 || typeof data.metadata === "string");
  }
  Response2.isGetAssetResponse = isGetAssetResponse;
})(Response || (Response = {}));

exports.ArkError = ArkError;
exports.ArkPsbtFieldKey = ArkPsbtFieldKey;
exports.ArkPsbtFieldKeyType = ArkPsbtFieldKeyType;
exports.AssetGroup = AssetGroup;
exports.AssetId = AssetId;
exports.AssetInput = AssetInput;
exports.AssetOutput = AssetOutput;
exports.AssetRef = AssetRef;
exports.BufferReader = BufferReader;
exports.BufferWriter = BufferWriter;
exports.ChainTxType = ChainTxType;
exports.ConditionWitness = ConditionWitness;
exports.CosignerPublicKey = CosignerPublicKey;
exports.IndexerTxType = IndexerTxType;
exports.Metadata = Metadata;
exports.OP_RETURN_EMPTY_PKSCRIPT = OP_RETURN_EMPTY_PKSCRIPT;
exports.Packet = Packet;
exports.PrevArkTxField = PrevArkTxField;
exports.PrevoutTxField = PrevoutTxField;
exports.RestArkProvider = RestArkProvider;
exports.RestIndexerProvider = RestIndexerProvider;
exports.SettlementEventType = SettlementEventType;
exports.Transaction = Transaction;
exports.VtxoTaprootTree = VtxoTaprootTree;
exports.VtxoTreeExpiry = VtxoTreeExpiry;
exports.asset_exports = asset_exports;
exports.craftToSpendTx = craftToSpendTx;
exports.getArkPsbtFields = getArkPsbtFields;
exports.isEventSourceError = isEventSourceError;
exports.isFetchTimeoutError = isFetchTimeoutError;
exports.maybeArkError = maybeArkError;
exports.setArkPsbtField = setArkPsbtField;
//# sourceMappingURL=chunk-ISZA7V2J.cjs.map
//# sourceMappingURL=chunk-ISZA7V2J.cjs.map