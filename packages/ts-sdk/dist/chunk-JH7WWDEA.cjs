'use strict';

var chunk4QHMS5XH_cjs = require('./chunk-4QHMS5XH.cjs');
var base = require('@scure/base');
var descriptorsScure = require('@bitcoinerlab/descriptors-scure');
var btcSigner = require('@scure/btc-signer');

// src/contracts/handlers/registry.ts
var ContractHandlerRegistry = class {
  handlers = /* @__PURE__ */ new Map();
  /**
   * Register a contract handler.
   *
   * @param handler - The handler to register
   * @throws If a handler for this type is already registered
   */
  register(handler) {
    if (this.handlers.has(handler.type)) {
      throw new Error(`Contract handler for type '${handler.type}' is already registered`);
    }
    this.handlers.set(handler.type, handler);
  }
  /**
   * Get a handler by type.
   *
   * @param type - The contract type
   * @returns The handler, or undefined if not found
   */
  get(type) {
    return this.handlers.get(type);
  }
  /**
   * Get a handler by type, throwing if not found.
   *
   * @param type - The contract type
   * @returns The handler
   * @throws If no handler is registered for this type
   */
  getOrThrow(type) {
    const handler = this.get(type);
    if (!handler) {
      throw new Error(`No contract handler registered for type '${type}'`);
    }
    return handler;
  }
  /**
   * Check if a handler is registered.
   *
   * @param type - The contract type
   */
  has(type) {
    return this.handlers.has(type);
  }
  /**
   * Get all registered types.
   */
  getRegisteredTypes() {
    return Array.from(this.handlers.keys());
  }
  /**
   * Unregister a handler (mainly for testing).
   */
  unregister(type) {
    return this.handlers.delete(type);
  }
  /**
   * Clear all handlers (mainly for testing).
   */
  clear() {
    this.handlers.clear();
  }
};
var contractHandlers = new ContractHandlerRegistry();
exports.DefaultVtxo = void 0;
((DefaultVtxo2) => {
  class Script2 extends chunk4QHMS5XH_cjs.VtxoScript {
    /** Create the default virtual output script with one forfeit path and one exit path. */
    constructor(options) {
      const { pubKey, serverPubKey, csvTimelock = Script2.DEFAULT_TIMELOCK } = options;
      const forfeitScript = chunk4QHMS5XH_cjs.MultisigTapscript.encode({
        pubkeys: [pubKey, serverPubKey]
      }).script;
      const exitScript = chunk4QHMS5XH_cjs.CSVMultisigTapscript.encode({
        timelock: csvTimelock,
        pubkeys: [pubKey]
      }).script;
      super([forfeitScript, exitScript]);
      this.options = options;
      this.forfeitScript = base.hex.encode(forfeitScript);
      this.exitScript = base.hex.encode(exitScript);
    }
    static DEFAULT_TIMELOCK = {
      value: 144n,
      type: "blocks"
    };
    // 1 day in blocks
    forfeitScript;
    exitScript;
    /** Return the forfeit tapleaf script. */
    forfeit() {
      return this.findLeaf(this.forfeitScript);
    }
    /** Return the unilateral exit tapleaf script. */
    exit() {
      return this.findLeaf(this.exitScript);
    }
  }
  DefaultVtxo2.Script = Script2;
})(exports.DefaultVtxo || (exports.DefaultVtxo = {}));
function isMainnetDescriptor(descriptor) {
  return !descriptor.includes("tpub");
}
function descriptorIsOurs(candidate, ourDescriptor, ourXOnlyPubkey) {
  if (!isDescriptor(candidate)) return false;
  try {
    const candidateInfo = descriptorsScure.expand({
      descriptor: candidate,
      network: isMainnetDescriptor(candidate) ? descriptorsScure.networks.bitcoin : descriptorsScure.networks.testnet
    }).expansionMap?.["@0"];
    if (!candidateInfo) return false;
    if (candidateInfo.bip32) {
      const ourBip32 = descriptorsScure.expand({
        descriptor: ourDescriptor,
        network: isMainnetDescriptor(ourDescriptor) ? descriptorsScure.networks.bitcoin : descriptorsScure.networks.testnet
      }).expansionMap?.["@0"]?.bip32;
      if (!ourBip32) return false;
      return ourBip32.toBase58() === candidateInfo.bip32.toBase58();
    }
    if (candidateInfo.pubkey) {
      const candidatePub = candidateInfo.pubkey.length === 33 ? candidateInfo.pubkey.subarray(1) : candidateInfo.pubkey;
      if (candidatePub.length !== ourXOnlyPubkey.length) return false;
      return base.hex.encode(candidatePub) === base.hex.encode(ourXOnlyPubkey);
    }
    return false;
  } catch {
    return false;
  }
}
function isDescriptor(value) {
  if (typeof value !== "string") return false;
  if (!value.startsWith("tr(") || !value.endsWith(")")) return false;
  return value.length > "tr()".length;
}
function normalizeToDescriptor(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("normalizeToDescriptor: expected a non-empty string value");
  }
  if (isDescriptor(value)) {
    return value;
  }
  return `tr(${value})`;
}
function extractPubKey(descriptor) {
  if (!isDescriptor(descriptor)) {
    return descriptor;
  }
  const network = isMainnetDescriptor(descriptor) ? descriptorsScure.networks.bitcoin : descriptorsScure.networks.testnet;
  const expansion = descriptorsScure.expand({ descriptor, network });
  if (!expansion.expansionMap) {
    throw new Error("Cannot extract pubkey from descriptor: expansion failed.");
  }
  const key = expansion.expansionMap["@0"];
  if (key?.bip32) {
    throw new Error(
      "Cannot extract pubkey from HD descriptor without derivation. Use DescriptorProvider to derive the key from the xpub."
    );
  }
  if (!key?.pubkey) {
    throw new Error("Cannot extract pubkey from descriptor: no key found.");
  }
  return base.hex.encode(key.pubkey);
}
function deriveDescriptorLeafPubKey(descriptor) {
  const network = isMainnetDescriptor(descriptor) ? descriptorsScure.networks.bitcoin : descriptorsScure.networks.testnet;
  let expansion;
  try {
    expansion = descriptorsScure.expand({ descriptor, network });
  } catch (e) {
    throw new Error(
      `Cannot derive leaf pubkey from descriptor (length=${descriptor.length}): ensure it is materialized (no wildcard) and parsable.`,
      { cause: e }
    );
  }
  const key = expansion.expansionMap?.["@0"];
  if (!key?.pubkey) {
    throw new Error(
      `Cannot derive leaf pubkey from descriptor (length=${descriptor.length}): parsed but no '@0' pubkey in the expansion map.`
    );
  }
  return key.pubkey;
}

// src/contracts/handlers/helpers.ts
function extractRawPubKey(value) {
  if (!isDescriptor(value)) {
    return value.toLowerCase();
  }
  try {
    return extractPubKey(value).toLowerCase();
  } catch {
    return void 0;
  }
}
function resolveRole(contract, context) {
  if (context.role === "sender" || context.role === "receiver") {
    return context.role;
  }
  const senderKey = contract.params.sender ? extractRawPubKey(contract.params.sender) : void 0;
  const receiverKey = contract.params.receiver ? extractRawPubKey(contract.params.receiver) : void 0;
  const matchRole = (rawWalletKey) => {
    if (!rawWalletKey) return void 0;
    if (senderKey && rawWalletKey === senderKey) {
      return "sender";
    }
    if (receiverKey && rawWalletKey === receiverKey) {
      return "receiver";
    }
    return void 0;
  };
  if (context.walletDescriptor) {
    const walletDescriptorKey = extractRawPubKey(context.walletDescriptor);
    const matchedRole = matchRole(walletDescriptorKey);
    if (matchedRole) {
      return matchedRole;
    }
    if (!walletDescriptorKey && context.walletPubKey) {
      return matchRole(extractRawPubKey(context.walletPubKey));
    }
    return void 0;
  }
  if (context.walletPubKey) {
    return matchRole(extractRawPubKey(context.walletPubKey));
  }
  return void 0;
}
var CLTV_HEIGHT_THRESHOLD = 500000000n;
function isCltvSatisfied(context, locktime) {
  if (locktime < CLTV_HEIGHT_THRESHOLD) {
    if (context.blockHeight === void 0) return false;
    return BigInt(context.blockHeight) >= locktime;
  }
  const currentTimeSec = BigInt(Math.floor(context.currentTime / 1e3));
  return currentTimeSec >= locktime;
}
function isCsvSpendable(context, sequence) {
  if (sequence === void 0) return true;
  if (!context.vtxo) return false;
  const timelock = chunk4QHMS5XH_cjs.sequenceToTimelock(sequence);
  if (timelock.type === "blocks") {
    if (context.blockHeight === void 0 || context.vtxo.status.block_height === void 0) {
      return false;
    }
    return context.blockHeight - context.vtxo.status.block_height >= Number(timelock.value);
  }
  if (timelock.type === "seconds") {
    const blockTime = context.vtxo.status.block_time;
    if (blockTime === void 0) return false;
    return context.currentTime / 1e3 - blockTime >= Number(timelock.value);
  }
  return false;
}

// src/contracts/metadata.ts
var WALLET_RECEIVE_SOURCE = "wallet-receive";

// src/contracts/handlers/default.ts
function extractPubKeyBytes(value) {
  return base.hex.decode(extractPubKey(normalizeToDescriptor(value)));
}
var DefaultContractHandler = {
  type: "default",
  createScript(params) {
    const typed = this.deserializeParams(params);
    return new exports.DefaultVtxo.Script(typed);
  },
  serializeParams(params) {
    return {
      pubKey: base.hex.encode(params.pubKey),
      serverPubKey: base.hex.encode(params.serverPubKey),
      csvTimelock: chunk4QHMS5XH_cjs.timelockToSequence(params.csvTimelock).toString()
    };
  },
  deserializeParams(params) {
    const csvTimelock = params.csvTimelock ? chunk4QHMS5XH_cjs.sequenceToTimelock(Number(params.csvTimelock)) : exports.DefaultVtxo.Script.DEFAULT_TIMELOCK;
    return {
      pubKey: extractPubKeyBytes(params.pubKey),
      serverPubKey: extractPubKeyBytes(params.serverPubKey),
      csvTimelock
    };
  },
  selectPath(script, contract, context) {
    if (context.collaborative) {
      return { leaf: script.forfeit() };
    }
    const sequence = contract.params.csvTimelock ? Number(contract.params.csvTimelock) : void 0;
    if (!isCsvSpendable(context, sequence)) {
      return null;
    }
    return {
      leaf: script.exit(),
      sequence
    };
  },
  getAllSpendingPaths(script, contract, context) {
    const paths = [];
    if (context.collaborative) {
      paths.push({ leaf: script.forfeit() });
    }
    const exitPath = { leaf: script.exit() };
    if (contract.params.csvTimelock) {
      exitPath.sequence = Number(contract.params.csvTimelock);
    }
    paths.push(exitPath);
    return paths;
  },
  getSpendablePaths(script, contract, context) {
    const paths = [];
    if (context.collaborative) {
      paths.push({ leaf: script.forfeit() });
    }
    const exitSequence = contract.params.csvTimelock ? Number(contract.params.csvTimelock) : void 0;
    if (isCsvSpendable(context, exitSequence)) {
      const exitPath = { leaf: script.exit() };
      if (exitSequence !== void 0) {
        exitPath.sequence = exitSequence;
      }
      paths.push(exitPath);
    }
    return paths;
  },
  async discoverAt(index, descriptor, deps) {
    const pubKey = deriveDescriptorLeafPubKey(descriptor);
    const out = [];
    for (const csvTimelock of deps.csvTimelocks) {
      const script = new exports.DefaultVtxo.Script({
        pubKey,
        serverPubKey: deps.serverPubKey,
        csvTimelock
      });
      const scriptHex = base.hex.encode(script.pkScript);
      const { vtxos } = await deps.indexerProvider.getVtxos({
        scripts: [scriptHex]
      });
      if (vtxos.length === 0) continue;
      out.push({
        type: "default",
        params: {
          pubKey: base.hex.encode(pubKey),
          serverPubKey: base.hex.encode(deps.serverPubKey),
          csvTimelock: chunk4QHMS5XH_cjs.timelockToSequence(csvTimelock).toString()
        },
        script: scriptHex,
        address: script.address(deps.network.hrp, deps.serverPubKey).encode(),
        ...index > 0 ? {
          metadata: {
            source: WALLET_RECEIVE_SOURCE,
            signingDescriptor: descriptor
          }
        } : {}
      });
    }
    return out;
  }
};
exports.DelegateVtxo = void 0;
((DelegateVtxo2) => {
  class Script2 extends chunk4QHMS5XH_cjs.VtxoScript {
    /** Create a delegated virtual output script with forfeit, exit, and delegate paths. */
    constructor(options) {
      const defaultVtxo = new exports.DefaultVtxo.Script(options);
      const { delegatePubKey, pubKey, serverPubKey } = options;
      const delegateScript = chunk4QHMS5XH_cjs.MultisigTapscript.encode({
        pubkeys: [pubKey, delegatePubKey, serverPubKey]
      }).script;
      super([...defaultVtxo.scripts, delegateScript]);
      this.options = options;
      this.defaultVtxo = defaultVtxo;
      this.delegateScript = base.hex.encode(delegateScript);
    }
    defaultVtxo;
    delegateScript;
    /** Return the forfeit tapleaf script. */
    forfeit() {
      return this.findLeaf(this.defaultVtxo.forfeitScript);
    }
    /** Return the unilateral exit tapleaf script. */
    exit() {
      return this.findLeaf(this.defaultVtxo.exitScript);
    }
    /** Return the delegate tapleaf script. */
    delegate() {
      return this.findLeaf(this.delegateScript);
    }
  }
  DelegateVtxo2.Script = Script2;
})(exports.DelegateVtxo || (exports.DelegateVtxo = {}));

// src/contracts/handlers/delegate.ts
var DelegateContractHandler = {
  type: "delegate",
  createScript(params) {
    const typed = this.deserializeParams(params);
    return new exports.DelegateVtxo.Script(typed);
  },
  serializeParams(params) {
    return {
      pubKey: base.hex.encode(params.pubKey),
      serverPubKey: base.hex.encode(params.serverPubKey),
      delegatePubKey: base.hex.encode(params.delegatePubKey),
      csvTimelock: chunk4QHMS5XH_cjs.timelockToSequence(params.csvTimelock).toString()
    };
  },
  deserializeParams(params) {
    const csvTimelock = params.csvTimelock ? chunk4QHMS5XH_cjs.sequenceToTimelock(Number(params.csvTimelock)) : exports.DefaultVtxo.Script.DEFAULT_TIMELOCK;
    return {
      pubKey: base.hex.decode(params.pubKey),
      serverPubKey: base.hex.decode(params.serverPubKey),
      delegatePubKey: base.hex.decode(params.delegatePubKey),
      csvTimelock
    };
  },
  selectPath(script, contract, context) {
    if (context.collaborative) {
      return { leaf: script.forfeit() };
    }
    const sequence = contract.params.csvTimelock ? Number(contract.params.csvTimelock) : void 0;
    if (!isCsvSpendable(context, sequence)) {
      return null;
    }
    return {
      leaf: script.exit(),
      sequence
    };
  },
  getAllSpendingPaths(script, contract, context) {
    const paths = [];
    if (context.collaborative) {
      paths.push({ leaf: script.forfeit() });
    }
    const exitPath = { leaf: script.exit() };
    if (contract.params.csvTimelock) {
      exitPath.sequence = Number(contract.params.csvTimelock);
    }
    paths.push(exitPath);
    if (context.collaborative) {
      paths.push({ leaf: script.delegate() });
    }
    return paths;
  },
  getSpendablePaths(script, contract, context) {
    const paths = [];
    if (context.collaborative) {
      paths.push({ leaf: script.forfeit() });
    }
    const exitSequence = contract.params.csvTimelock ? Number(contract.params.csvTimelock) : void 0;
    if (isCsvSpendable(context, exitSequence)) {
      const exitPath = { leaf: script.exit() };
      if (exitSequence !== void 0) {
        exitPath.sequence = exitSequence;
      }
      paths.push(exitPath);
    }
    return paths;
  },
  async discoverAt(index, descriptor, deps) {
    if (!deps.delegatePubKey) return [];
    const pubKey = deriveDescriptorLeafPubKey(descriptor);
    const out = [];
    for (const csvTimelock of deps.csvTimelocks) {
      const script = new exports.DelegateVtxo.Script({
        pubKey,
        serverPubKey: deps.serverPubKey,
        delegatePubKey: deps.delegatePubKey,
        csvTimelock
      });
      const scriptHex = base.hex.encode(script.pkScript);
      const { vtxos } = await deps.indexerProvider.getVtxos({
        scripts: [scriptHex]
      });
      if (vtxos.length === 0) continue;
      out.push({
        type: "delegate",
        params: {
          pubKey: base.hex.encode(pubKey),
          serverPubKey: base.hex.encode(deps.serverPubKey),
          delegatePubKey: base.hex.encode(deps.delegatePubKey),
          csvTimelock: chunk4QHMS5XH_cjs.timelockToSequence(csvTimelock).toString()
        },
        script: scriptHex,
        address: script.address(deps.network.hrp, deps.serverPubKey).encode(),
        ...index > 0 ? {
          metadata: {
            source: WALLET_RECEIVE_SOURCE,
            signingDescriptor: descriptor
          }
        } : {}
      });
    }
    return out;
  }
};
exports.VHTLC = void 0;
((VHTLC2) => {
  class Script2 extends chunk4QHMS5XH_cjs.VtxoScript {
    /** Create a VHTLC script from the supplied participant keys, hash, and timelocks. */
    constructor(options) {
      validateOptions(options);
      const {
        sender,
        receiver,
        server,
        preimageHash,
        refundLocktime,
        unilateralClaimDelay,
        unilateralRefundDelay,
        unilateralRefundWithoutReceiverDelay
      } = options;
      const conditionScript = preimageConditionScript(preimageHash);
      const claimScript = chunk4QHMS5XH_cjs.ConditionMultisigTapscript.encode({
        conditionScript,
        pubkeys: [receiver, server]
      }).script;
      const refundScript = chunk4QHMS5XH_cjs.MultisigTapscript.encode({
        pubkeys: [sender, receiver, server]
      }).script;
      const refundWithoutReceiverScript = chunk4QHMS5XH_cjs.CLTVMultisigTapscript.encode({
        absoluteTimelock: refundLocktime,
        pubkeys: [sender, server]
      }).script;
      const unilateralClaimScript = chunk4QHMS5XH_cjs.ConditionCSVMultisigTapscript.encode({
        conditionScript,
        timelock: unilateralClaimDelay,
        pubkeys: [receiver]
      }).script;
      const unilateralRefundScript = chunk4QHMS5XH_cjs.CSVMultisigTapscript.encode({
        timelock: unilateralRefundDelay,
        pubkeys: [sender, receiver]
      }).script;
      const unilateralRefundWithoutReceiverScript = chunk4QHMS5XH_cjs.CSVMultisigTapscript.encode({
        timelock: unilateralRefundWithoutReceiverDelay,
        pubkeys: [sender]
      }).script;
      super([
        claimScript,
        refundScript,
        refundWithoutReceiverScript,
        unilateralClaimScript,
        unilateralRefundScript,
        unilateralRefundWithoutReceiverScript
      ]);
      this.options = options;
      this.claimScript = base.hex.encode(claimScript);
      this.refundScript = base.hex.encode(refundScript);
      this.refundWithoutReceiverScript = base.hex.encode(refundWithoutReceiverScript);
      this.unilateralClaimScript = base.hex.encode(unilateralClaimScript);
      this.unilateralRefundScript = base.hex.encode(unilateralRefundScript);
      this.unilateralRefundWithoutReceiverScript = base.hex.encode(
        unilateralRefundWithoutReceiverScript
      );
    }
    claimScript;
    refundScript;
    refundWithoutReceiverScript;
    unilateralClaimScript;
    unilateralRefundScript;
    unilateralRefundWithoutReceiverScript;
    /** Return the collaborative claim tapleaf script. */
    claim() {
      return this.findLeaf(this.claimScript);
    }
    /** Return the collaborative refund tapleaf script. */
    refund() {
      return this.findLeaf(this.refundScript);
    }
    /** Return the refund-without-receiver tapleaf script. */
    refundWithoutReceiver() {
      return this.findLeaf(this.refundWithoutReceiverScript);
    }
    /** Return the unilateral claim tapleaf script. */
    unilateralClaim() {
      return this.findLeaf(this.unilateralClaimScript);
    }
    /** Return the unilateral refund tapleaf script. */
    unilateralRefund() {
      return this.findLeaf(this.unilateralRefundScript);
    }
    /** Return the unilateral refund-without-receiver tapleaf script. */
    unilateralRefundWithoutReceiver() {
      return this.findLeaf(this.unilateralRefundWithoutReceiverScript);
    }
  }
  VHTLC2.Script = Script2;
  function validateOptions(options) {
    const {
      sender,
      receiver,
      server,
      preimageHash,
      refundLocktime,
      unilateralClaimDelay,
      unilateralRefundDelay,
      unilateralRefundWithoutReceiverDelay
    } = options;
    if (!preimageHash || preimageHash.length !== 20) {
      throw new Error("preimage hash must be 20 bytes");
    }
    if (!receiver || receiver.length !== 32) {
      throw new Error("Invalid public key length (receiver)");
    }
    if (!sender || sender.length !== 32) {
      throw new Error("Invalid public key length (sender)");
    }
    if (!server || server.length !== 32) {
      throw new Error("Invalid public key length (server)");
    }
    if (typeof refundLocktime !== "bigint" || refundLocktime <= 0n) {
      throw new Error("refund locktime must be greater than 0");
    }
    if (!unilateralClaimDelay || typeof unilateralClaimDelay.value !== "bigint" || unilateralClaimDelay.value <= 0n) {
      throw new Error("unilateral claim delay must greater than 0");
    }
    if (unilateralClaimDelay.type === "seconds" && unilateralClaimDelay.value % 512n !== 0n) {
      throw new Error("seconds timelock must be multiple of 512");
    }
    if (unilateralClaimDelay.type === "seconds" && unilateralClaimDelay.value < 512n) {
      throw new Error("seconds timelock must be greater or equal to 512");
    }
    if (!unilateralRefundDelay || typeof unilateralRefundDelay.value !== "bigint" || unilateralRefundDelay.value <= 0n) {
      throw new Error("unilateral refund delay must greater than 0");
    }
    if (unilateralRefundDelay.type === "seconds" && unilateralRefundDelay.value % 512n !== 0n) {
      throw new Error("seconds timelock must be multiple of 512");
    }
    if (unilateralRefundDelay.type === "seconds" && unilateralRefundDelay.value < 512n) {
      throw new Error("seconds timelock must be greater or equal to 512");
    }
    if (!unilateralRefundWithoutReceiverDelay || typeof unilateralRefundWithoutReceiverDelay.value !== "bigint" || unilateralRefundWithoutReceiverDelay.value <= 0n) {
      throw new Error("unilateral refund without receiver delay must greater than 0");
    }
    if (unilateralRefundWithoutReceiverDelay.type === "seconds" && unilateralRefundWithoutReceiverDelay.value % 512n !== 0n) {
      throw new Error("seconds timelock must be multiple of 512");
    }
    if (unilateralRefundWithoutReceiverDelay.type === "seconds" && unilateralRefundWithoutReceiverDelay.value < 512n) {
      throw new Error("seconds timelock must be greater or equal to 512");
    }
  }
})(exports.VHTLC || (exports.VHTLC = {}));
function preimageConditionScript(preimageHash) {
  return btcSigner.Script.encode(["HASH160", preimageHash, "EQUAL"]);
}

// src/contracts/handlers/vhtlc.ts
var VHTLCContractHandler = {
  type: "vhtlc",
  createScript(params) {
    const typed = this.deserializeParams(params);
    return new exports.VHTLC.Script(typed);
  },
  serializeParams(params) {
    return {
      sender: base.hex.encode(params.sender),
      receiver: base.hex.encode(params.receiver),
      server: base.hex.encode(params.server),
      hash: base.hex.encode(params.preimageHash),
      refundLocktime: params.refundLocktime.toString(),
      claimDelay: chunk4QHMS5XH_cjs.timelockToSequence(params.unilateralClaimDelay).toString(),
      refundDelay: chunk4QHMS5XH_cjs.timelockToSequence(params.unilateralRefundDelay).toString(),
      refundNoReceiverDelay: chunk4QHMS5XH_cjs.timelockToSequence(
        params.unilateralRefundWithoutReceiverDelay
      ).toString()
    };
  },
  deserializeParams(params) {
    return {
      sender: base.hex.decode(params.sender),
      receiver: base.hex.decode(params.receiver),
      server: base.hex.decode(params.server),
      preimageHash: base.hex.decode(params.hash),
      refundLocktime: BigInt(params.refundLocktime),
      unilateralClaimDelay: chunk4QHMS5XH_cjs.sequenceToTimelock(Number(params.claimDelay)),
      unilateralRefundDelay: chunk4QHMS5XH_cjs.sequenceToTimelock(Number(params.refundDelay)),
      unilateralRefundWithoutReceiverDelay: chunk4QHMS5XH_cjs.sequenceToTimelock(
        Number(params.refundNoReceiverDelay)
      )
    };
  },
  /**
   * Select spending path based on context.
   *
   * Role is determined from `context.role` or by matching
   * `context.walletDescriptor` (preferred) / `context.walletPubKey`
   * against sender/receiver in contract params.
   */
  selectPath(script, contract, context) {
    const role = resolveRole(contract, context);
    const preimage = contract.params?.preimage;
    const refundLocktime = BigInt(contract.params.refundLocktime);
    if (!role) {
      return null;
    }
    if (context.collaborative) {
      if (role === "receiver" && preimage) {
        return {
          leaf: script.claim(),
          extraWitness: [base.hex.decode(preimage)]
        };
      }
      if (role === "sender" && isCltvSatisfied(context, refundLocktime)) {
        return {
          leaf: script.refundWithoutReceiver()
        };
      }
      return null;
    }
    if (role === "receiver" && preimage) {
      const sequence = Number(contract.params.claimDelay);
      if (!isCsvSpendable(context, sequence)) return null;
      return {
        leaf: script.unilateralClaim(),
        extraWitness: [base.hex.decode(preimage)],
        sequence
      };
    }
    if (role === "sender") {
      const sequence = Number(contract.params.refundNoReceiverDelay);
      if (!isCsvSpendable(context, sequence)) return null;
      return {
        leaf: script.unilateralRefundWithoutReceiver(),
        sequence
      };
    }
    return null;
  },
  /**
   * Get all possible spending paths (no timelock checks).
   *
   * Role is determined from `context.role` or by matching
   * `context.walletDescriptor` (preferred) / `context.walletPubKey`
   * against sender/receiver in contract params.
   */
  getAllSpendingPaths(script, contract, context) {
    const role = resolveRole(contract, context);
    const paths = [];
    if (!role) {
      return paths;
    }
    const preimage = contract.params?.preimage;
    if (context.collaborative) {
      if (role === "receiver" && preimage) {
        paths.push({
          leaf: script.claim(),
          extraWitness: [base.hex.decode(preimage)]
        });
      }
      if (role === "sender") {
        paths.push({
          leaf: script.refundWithoutReceiver()
        });
      }
    } else {
      if (role === "receiver" && preimage) {
        const sequence = Number(contract.params.claimDelay);
        paths.push({
          leaf: script.unilateralClaim(),
          extraWitness: [base.hex.decode(preimage)],
          sequence
        });
      }
      if (role === "sender") {
        const sequence = Number(contract.params.refundNoReceiverDelay);
        paths.push({
          leaf: script.unilateralRefundWithoutReceiver(),
          sequence
        });
      }
    }
    return paths;
  },
  getSpendablePaths(script, contract, context) {
    const role = resolveRole(contract, context);
    const paths = [];
    if (!role) {
      return paths;
    }
    const preimage = contract.params?.preimage;
    const refundLocktime = BigInt(contract.params.refundLocktime);
    if (context.collaborative) {
      if (role === "receiver" && preimage) {
        paths.push({
          leaf: script.claim(),
          extraWitness: [base.hex.decode(preimage)]
        });
      }
      if (role === "sender" && isCltvSatisfied(context, refundLocktime)) {
        paths.push({
          leaf: script.refundWithoutReceiver()
        });
      }
      return paths;
    }
    if (role === "receiver" && preimage) {
      const sequence = Number(contract.params.claimDelay);
      if (isCsvSpendable(context, sequence)) {
        paths.push({
          leaf: script.unilateralClaim(),
          extraWitness: [base.hex.decode(preimage)],
          sequence
        });
      }
    }
    if (role === "sender") {
      const sequence = Number(contract.params.refundNoReceiverDelay);
      if (isCsvSpendable(context, sequence)) {
        paths.push({
          leaf: script.unilateralRefundWithoutReceiver(),
          sequence
        });
      }
    }
    return paths;
  }
};

// src/contracts/handlers/index.ts
contractHandlers.register(DefaultContractHandler);
contractHandlers.register(DelegateContractHandler);
contractHandlers.register(VHTLCContractHandler);

exports.DefaultContractHandler = DefaultContractHandler;
exports.DelegateContractHandler = DelegateContractHandler;
exports.VHTLCContractHandler = VHTLCContractHandler;
exports.WALLET_RECEIVE_SOURCE = WALLET_RECEIVE_SOURCE;
exports.contractHandlers = contractHandlers;
exports.deriveDescriptorLeafPubKey = deriveDescriptorLeafPubKey;
exports.descriptorIsOurs = descriptorIsOurs;
exports.isMainnetDescriptor = isMainnetDescriptor;
//# sourceMappingURL=chunk-JH7WWDEA.cjs.map
//# sourceMappingURL=chunk-JH7WWDEA.cjs.map