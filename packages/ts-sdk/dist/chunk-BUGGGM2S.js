import { VtxoScript, MultisigTapscript, CSVMultisigTapscript, ConditionMultisigTapscript, CLTVMultisigTapscript, ConditionCSVMultisigTapscript, timelockToSequence, sequenceToTimelock } from './chunk-HAYJZIA4.js';
import { hex } from '@scure/base';
import { networks, expand } from '@bitcoinerlab/descriptors-scure';
import { Script } from '@scure/btc-signer';

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
var DefaultVtxo;
((DefaultVtxo2) => {
  class Script2 extends VtxoScript {
    /** Create the default virtual output script with one forfeit path and one exit path. */
    constructor(options) {
      const { pubKey, serverPubKey, csvTimelock = Script2.DEFAULT_TIMELOCK } = options;
      const forfeitScript = MultisigTapscript.encode({
        pubkeys: [pubKey, serverPubKey]
      }).script;
      const exitScript = CSVMultisigTapscript.encode({
        timelock: csvTimelock,
        pubkeys: [pubKey]
      }).script;
      super([forfeitScript, exitScript]);
      this.options = options;
      this.forfeitScript = hex.encode(forfeitScript);
      this.exitScript = hex.encode(exitScript);
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
})(DefaultVtxo || (DefaultVtxo = {}));
function isMainnetDescriptor(descriptor) {
  return !descriptor.includes("tpub");
}
function descriptorIsOurs(candidate, ourDescriptor, ourXOnlyPubkey) {
  if (!isDescriptor(candidate)) return false;
  try {
    const candidateInfo = expand({
      descriptor: candidate,
      network: isMainnetDescriptor(candidate) ? networks.bitcoin : networks.testnet
    }).expansionMap?.["@0"];
    if (!candidateInfo) return false;
    if (candidateInfo.bip32) {
      const ourBip32 = expand({
        descriptor: ourDescriptor,
        network: isMainnetDescriptor(ourDescriptor) ? networks.bitcoin : networks.testnet
      }).expansionMap?.["@0"]?.bip32;
      if (!ourBip32) return false;
      return ourBip32.toBase58() === candidateInfo.bip32.toBase58();
    }
    if (candidateInfo.pubkey) {
      const candidatePub = candidateInfo.pubkey.length === 33 ? candidateInfo.pubkey.subarray(1) : candidateInfo.pubkey;
      if (candidatePub.length !== ourXOnlyPubkey.length) return false;
      return hex.encode(candidatePub) === hex.encode(ourXOnlyPubkey);
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
  const network = isMainnetDescriptor(descriptor) ? networks.bitcoin : networks.testnet;
  const expansion = expand({ descriptor, network });
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
  return hex.encode(key.pubkey);
}
function deriveDescriptorLeafPubKey(descriptor) {
  const network = isMainnetDescriptor(descriptor) ? networks.bitcoin : networks.testnet;
  let expansion;
  try {
    expansion = expand({ descriptor, network });
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
  const timelock = sequenceToTimelock(sequence);
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
  return hex.decode(extractPubKey(normalizeToDescriptor(value)));
}
var DefaultContractHandler = {
  type: "default",
  createScript(params) {
    const typed = this.deserializeParams(params);
    return new DefaultVtxo.Script(typed);
  },
  serializeParams(params) {
    return {
      pubKey: hex.encode(params.pubKey),
      serverPubKey: hex.encode(params.serverPubKey),
      csvTimelock: timelockToSequence(params.csvTimelock).toString()
    };
  },
  deserializeParams(params) {
    const csvTimelock = params.csvTimelock ? sequenceToTimelock(Number(params.csvTimelock)) : DefaultVtxo.Script.DEFAULT_TIMELOCK;
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
      const script = new DefaultVtxo.Script({
        pubKey,
        serverPubKey: deps.serverPubKey,
        csvTimelock
      });
      const scriptHex = hex.encode(script.pkScript);
      const { vtxos } = await deps.indexerProvider.getVtxos({
        scripts: [scriptHex]
      });
      if (vtxos.length === 0) continue;
      out.push({
        type: "default",
        params: {
          pubKey: hex.encode(pubKey),
          serverPubKey: hex.encode(deps.serverPubKey),
          csvTimelock: timelockToSequence(csvTimelock).toString()
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
var DelegateVtxo;
((DelegateVtxo2) => {
  class Script2 extends VtxoScript {
    /** Create a delegated virtual output script with forfeit, exit, and delegate paths. */
    constructor(options) {
      const defaultVtxo = new DefaultVtxo.Script(options);
      const { delegatePubKey, pubKey, serverPubKey } = options;
      const delegateScript = MultisigTapscript.encode({
        pubkeys: [pubKey, delegatePubKey, serverPubKey]
      }).script;
      super([...defaultVtxo.scripts, delegateScript]);
      this.options = options;
      this.defaultVtxo = defaultVtxo;
      this.delegateScript = hex.encode(delegateScript);
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
})(DelegateVtxo || (DelegateVtxo = {}));

// src/contracts/handlers/delegate.ts
var DelegateContractHandler = {
  type: "delegate",
  createScript(params) {
    const typed = this.deserializeParams(params);
    return new DelegateVtxo.Script(typed);
  },
  serializeParams(params) {
    return {
      pubKey: hex.encode(params.pubKey),
      serverPubKey: hex.encode(params.serverPubKey),
      delegatePubKey: hex.encode(params.delegatePubKey),
      csvTimelock: timelockToSequence(params.csvTimelock).toString()
    };
  },
  deserializeParams(params) {
    const csvTimelock = params.csvTimelock ? sequenceToTimelock(Number(params.csvTimelock)) : DefaultVtxo.Script.DEFAULT_TIMELOCK;
    return {
      pubKey: hex.decode(params.pubKey),
      serverPubKey: hex.decode(params.serverPubKey),
      delegatePubKey: hex.decode(params.delegatePubKey),
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
      const script = new DelegateVtxo.Script({
        pubKey,
        serverPubKey: deps.serverPubKey,
        delegatePubKey: deps.delegatePubKey,
        csvTimelock
      });
      const scriptHex = hex.encode(script.pkScript);
      const { vtxos } = await deps.indexerProvider.getVtxos({
        scripts: [scriptHex]
      });
      if (vtxos.length === 0) continue;
      out.push({
        type: "delegate",
        params: {
          pubKey: hex.encode(pubKey),
          serverPubKey: hex.encode(deps.serverPubKey),
          delegatePubKey: hex.encode(deps.delegatePubKey),
          csvTimelock: timelockToSequence(csvTimelock).toString()
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
var VHTLC;
((VHTLC2) => {
  class Script2 extends VtxoScript {
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
      const claimScript = ConditionMultisigTapscript.encode({
        conditionScript,
        pubkeys: [receiver, server]
      }).script;
      const refundScript = MultisigTapscript.encode({
        pubkeys: [sender, receiver, server]
      }).script;
      const refundWithoutReceiverScript = CLTVMultisigTapscript.encode({
        absoluteTimelock: refundLocktime,
        pubkeys: [sender, server]
      }).script;
      const unilateralClaimScript = ConditionCSVMultisigTapscript.encode({
        conditionScript,
        timelock: unilateralClaimDelay,
        pubkeys: [receiver]
      }).script;
      const unilateralRefundScript = CSVMultisigTapscript.encode({
        timelock: unilateralRefundDelay,
        pubkeys: [sender, receiver]
      }).script;
      const unilateralRefundWithoutReceiverScript = CSVMultisigTapscript.encode({
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
      this.claimScript = hex.encode(claimScript);
      this.refundScript = hex.encode(refundScript);
      this.refundWithoutReceiverScript = hex.encode(refundWithoutReceiverScript);
      this.unilateralClaimScript = hex.encode(unilateralClaimScript);
      this.unilateralRefundScript = hex.encode(unilateralRefundScript);
      this.unilateralRefundWithoutReceiverScript = hex.encode(
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
})(VHTLC || (VHTLC = {}));
function preimageConditionScript(preimageHash) {
  return Script.encode(["HASH160", preimageHash, "EQUAL"]);
}

// src/contracts/handlers/vhtlc.ts
var VHTLCContractHandler = {
  type: "vhtlc",
  createScript(params) {
    const typed = this.deserializeParams(params);
    return new VHTLC.Script(typed);
  },
  serializeParams(params) {
    return {
      sender: hex.encode(params.sender),
      receiver: hex.encode(params.receiver),
      server: hex.encode(params.server),
      hash: hex.encode(params.preimageHash),
      refundLocktime: params.refundLocktime.toString(),
      claimDelay: timelockToSequence(params.unilateralClaimDelay).toString(),
      refundDelay: timelockToSequence(params.unilateralRefundDelay).toString(),
      refundNoReceiverDelay: timelockToSequence(
        params.unilateralRefundWithoutReceiverDelay
      ).toString()
    };
  },
  deserializeParams(params) {
    return {
      sender: hex.decode(params.sender),
      receiver: hex.decode(params.receiver),
      server: hex.decode(params.server),
      preimageHash: hex.decode(params.hash),
      refundLocktime: BigInt(params.refundLocktime),
      unilateralClaimDelay: sequenceToTimelock(Number(params.claimDelay)),
      unilateralRefundDelay: sequenceToTimelock(Number(params.refundDelay)),
      unilateralRefundWithoutReceiverDelay: sequenceToTimelock(
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
          extraWitness: [hex.decode(preimage)]
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
        extraWitness: [hex.decode(preimage)],
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
          extraWitness: [hex.decode(preimage)]
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
          extraWitness: [hex.decode(preimage)],
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
          extraWitness: [hex.decode(preimage)]
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
          extraWitness: [hex.decode(preimage)],
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

export { DefaultContractHandler, DefaultVtxo, DelegateContractHandler, DelegateVtxo, VHTLC, VHTLCContractHandler, WALLET_RECEIVE_SOURCE, contractHandlers, deriveDescriptorLeafPubKey, descriptorIsOurs, isMainnetDescriptor };
//# sourceMappingURL=chunk-BUGGGM2S.js.map
//# sourceMappingURL=chunk-BUGGGM2S.js.map