'use strict';

var bip68 = require('bip68');
var utils_js = require('@scure/btc-signer/utils.js');
var base = require('@scure/base');
var script_js = require('@scure/btc-signer/script.js');
var btcSigner = require('@scure/btc-signer');
var payment_js = require('@scure/btc-signer/payment.js');
var psbt_js = require('@scure/btc-signer/psbt.js');

function _interopNamespace(e) {
  if (e && e.__esModule) return e;
  var n = Object.create(null);
  if (e) {
    Object.keys(e).forEach(function (k) {
      if (k !== 'default') {
        var d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: function () { return e[k]; }
        });
      }
    });
  }
  n.default = e;
  return Object.freeze(n);
}

var bip68__namespace = /*#__PURE__*/_interopNamespace(bip68);

// src/utils/timelock.ts
function timelockToSequence(timelock) {
  return bip68__namespace.encode(
    timelock.type === "blocks" ? { blocks: Number(timelock.value) } : { seconds: Number(timelock.value) }
  );
}
function sequenceToTimelock(sequence) {
  const decoded = bip68__namespace.decode(sequence);
  if ("blocks" in decoded && decoded.blocks !== void 0) {
    return { type: "blocks", value: BigInt(decoded.blocks) };
  }
  if ("seconds" in decoded && decoded.seconds !== void 0) {
    return { type: "seconds", value: BigInt(decoded.seconds) };
  }
  throw new Error(`Invalid BIP68 sequence: ${sequence}`);
}
var getNetwork = (network) => {
  return networks[network];
};
var networks = {
  bitcoin: withArkPrefix(utils_js.NETWORK, "ark"),
  testnet: withArkPrefix(utils_js.TEST_NETWORK, "tark"),
  signet: withArkPrefix(utils_js.TEST_NETWORK, "tark"),
  mutinynet: withArkPrefix(utils_js.TEST_NETWORK, "tark"),
  regtest: withArkPrefix(
    {
      ...utils_js.TEST_NETWORK,
      bech32: "bcrt",
      pubKeyHash: 111,
      scriptHash: 196
    },
    "tark"
  )
};
function withArkPrefix(network, prefix) {
  return {
    ...network,
    hrp: prefix
  };
}
var DEFAULT_ARKADE_SERVER_URL = "https://arkade.computer";
var DEFAULT_NETWORK = networks.bitcoin;
var DEFAULT_NETWORK_NAME = "bitcoin";
var ArkAddress = class _ArkAddress {
  /**
   * Create an Arkade address from its server public key, Taproot output key, and prefix.
   *
   * @param serverPubKey - 32-byte Arkade server public key
   * @param vtxoTaprootKey - 32-byte Taproot output key (a.k.a. tweaked public key)
   * @param hrp - Bech32 human-readable prefix
   * @param version - Address version byte
   * @defaultValue `version = 0`
   * @throws Error if either public key is not 32 bytes long
   */
  constructor(serverPubKey, vtxoTaprootKey, hrp = DEFAULT_NETWORK.hrp, version = 0) {
    this.serverPubKey = serverPubKey;
    this.vtxoTaprootKey = vtxoTaprootKey;
    this.hrp = hrp;
    this.version = version;
    if (serverPubKey.length !== 32) {
      throw new Error(
        "Invalid server public key length, expected 32 bytes, got " + serverPubKey.length
      );
    }
    if (vtxoTaprootKey.length !== 32) {
      throw new Error(
        "Invalid vtxo taproot public key length, expected 32 bytes, got " + vtxoTaprootKey.length
      );
    }
  }
  /**
   * Decode an Arkade address from its bech32m string form.
   *
   * @param address - Bech32m-encoded Arkade address
   * @returns Decoded Arkade address
   * @throws Error if the address is malformed or has an invalid payload length
   * @see encode
   */
  static decode(address) {
    const decoded = base.bech32m.decodeUnsafe(address, 1023);
    if (!decoded) {
      throw new Error("Invalid address");
    }
    const data = new Uint8Array(base.bech32m.fromWords(decoded.words));
    if (data.length !== 1 + 32 + 32) {
      throw new Error("Invalid data length, expected 65 bytes, got " + data.length);
    }
    const version = data[0];
    const serverPubKey = data.slice(1, 33);
    const vtxoTaprootPubKey = data.slice(33, 65);
    return new _ArkAddress(serverPubKey, vtxoTaprootPubKey, decoded.prefix, version);
  }
  /**
   * Encode the address to its bech32m string form.
   *
   * @returns Bech32m-encoded Arkade address
   * @see decode
   */
  encode() {
    const data = new Uint8Array(1 + 32 + 32);
    data[0] = this.version;
    data.set(this.serverPubKey, 1);
    data.set(this.vtxoTaprootKey, 33);
    const words = base.bech32m.toWords(data);
    return base.bech32m.encode(this.hrp, words, 1023);
  }
  /** ScriptPubKey used to send non-dust funds to the address. */
  get pkScript() {
    return script_js.Script.encode(["OP_1", this.vtxoTaprootKey]);
  }
  /** ScriptPubKey used to send sub-dust funds to the address. */
  get subdustPkScript() {
    return script_js.Script.encode(["RETURN", this.vtxoTaprootKey]);
  }
};
var MinimalScriptNum = btcSigner.ScriptNum(void 0, true);
function decodeTapscript(script) {
  const types = [
    exports.MultisigTapscript,
    exports.CSVMultisigTapscript,
    exports.ConditionCSVMultisigTapscript,
    exports.ConditionMultisigTapscript,
    exports.CLTVMultisigTapscript
  ];
  for (const type of types) {
    try {
      return type.decode(script);
    } catch (error) {
      continue;
    }
  }
  throw new Error(`Failed to decode: script ${base.hex.encode(script)} is not a valid tapscript`);
}
exports.MultisigTapscript = void 0;
((MultisigTapscript2) => {
  ((MultisigType2) => {
    MultisigType2[MultisigType2["CHECKSIG"] = 0] = "CHECKSIG";
    MultisigType2[MultisigType2["CHECKSIGADD"] = 1] = "CHECKSIGADD";
  })(MultisigTapscript2.MultisigType || (MultisigTapscript2.MultisigType = {}));
  function encode2(params) {
    if (params.pubkeys.length === 0) {
      throw new Error("At least 1 pubkey is required");
    }
    for (const pubkey of params.pubkeys) {
      if (pubkey.length !== 32) {
        throw new Error(`Invalid pubkey length: expected 32, got ${pubkey.length}`);
      }
    }
    if (!params.type) {
      params.type = 0 /* CHECKSIG */;
    }
    if (params.type === 1 /* CHECKSIGADD */) {
      return {
        type: "multisig" /* Multisig */,
        params,
        script: btcSigner.p2tr_ms(params.pubkeys.length, params.pubkeys).script
      };
    }
    const asm = [];
    for (let i = 0; i < params.pubkeys.length; i++) {
      asm.push(params.pubkeys[i]);
      if (i < params.pubkeys.length - 1) {
        asm.push("CHECKSIGVERIFY");
      } else {
        asm.push("CHECKSIG");
      }
    }
    return {
      type: "multisig" /* Multisig */,
      params,
      script: btcSigner.Script.encode(asm)
    };
  }
  MultisigTapscript2.encode = encode2;
  function decode2(script) {
    if (script.length === 0) {
      throw new Error("Failed to decode: script is empty");
    }
    try {
      return decodeChecksigAdd(script);
    } catch (error) {
      try {
        return decodeChecksig(script);
      } catch (error2) {
        throw new Error(
          `Failed to decode script: ${error2 instanceof Error ? error2.message : String(error2)}`
        );
      }
    }
  }
  MultisigTapscript2.decode = decode2;
  function decodeChecksigAdd(script) {
    const asm = btcSigner.Script.decode(script);
    const pubkeys = [];
    let foundNumEqual = false;
    for (let i = 0; i < asm.length; i++) {
      const op = asm[i];
      if (typeof op !== "string" && typeof op !== "number") {
        if (op.length !== 32) {
          throw new Error(`Invalid pubkey length: expected 32, got ${op.length}`);
        }
        pubkeys.push(op);
        if (i + 1 >= asm.length || asm[i + 1] !== "CHECKSIGADD" && asm[i + 1] !== "CHECKSIG") {
          throw new Error("Expected CHECKSIGADD or CHECKSIG after pubkey");
        }
        i++;
        continue;
      }
      if (i === asm.length - 1) {
        if (op !== "NUMEQUAL") {
          throw new Error("Expected NUMEQUAL at end of script");
        }
        foundNumEqual = true;
      }
    }
    if (!foundNumEqual) {
      throw new Error("Missing NUMEQUAL operation");
    }
    if (pubkeys.length === 0) {
      throw new Error("Invalid script: must have at least 1 pubkey");
    }
    const reconstructed = encode2({
      pubkeys,
      type: 1 /* CHECKSIGADD */
    });
    if (base.hex.encode(reconstructed.script) !== base.hex.encode(script)) {
      throw new Error("Invalid script format: script reconstruction mismatch");
    }
    return {
      type: "multisig" /* Multisig */,
      params: { pubkeys, type: 1 /* CHECKSIGADD */ },
      script
    };
  }
  function decodeChecksig(script) {
    const asm = btcSigner.Script.decode(script);
    const pubkeys = [];
    for (let i = 0; i < asm.length; i++) {
      const op = asm[i];
      if (typeof op !== "string" && typeof op !== "number") {
        if (op.length !== 32) {
          throw new Error(`Invalid pubkey length: expected 32, got ${op.length}`);
        }
        pubkeys.push(op);
        if (i + 1 >= asm.length) {
          throw new Error("Unexpected end of script");
        }
        const nextOp = asm[i + 1];
        if (nextOp !== "CHECKSIGVERIFY" && nextOp !== "CHECKSIG") {
          throw new Error("Expected CHECKSIGVERIFY or CHECKSIG after pubkey");
        }
        if (i === asm.length - 2 && nextOp !== "CHECKSIG") {
          throw new Error("Last operation must be CHECKSIG");
        }
        i++;
        continue;
      }
    }
    if (pubkeys.length === 0) {
      throw new Error("Invalid script: must have at least 1 pubkey");
    }
    const reconstructed = encode2({ pubkeys, type: 0 /* CHECKSIG */ });
    if (base.hex.encode(reconstructed.script) !== base.hex.encode(script)) {
      throw new Error("Invalid script format: script reconstruction mismatch");
    }
    return {
      type: "multisig" /* Multisig */,
      params: { pubkeys, type: 0 /* CHECKSIG */ },
      script
    };
  }
  function is(tapscript) {
    return tapscript.type === "multisig" /* Multisig */;
  }
  MultisigTapscript2.is = is;
})(exports.MultisigTapscript || (exports.MultisigTapscript = {}));
exports.CSVMultisigTapscript = void 0;
((CSVMultisigTapscript2) => {
  function encode2(params) {
    for (const pubkey of params.pubkeys) {
      if (pubkey.length !== 32) {
        throw new Error(`Invalid pubkey length: expected 32, got ${pubkey.length}`);
      }
    }
    const sequence = MinimalScriptNum.encode(BigInt(timelockToSequence(params.timelock)));
    const asm = [
      sequence.length === 1 ? sequence[0] : sequence,
      "CHECKSEQUENCEVERIFY",
      "DROP"
    ];
    const multisigScript = exports.MultisigTapscript.encode(params);
    const script = new Uint8Array([...btcSigner.Script.encode(asm), ...multisigScript.script]);
    return {
      type: "csv-multisig" /* CSVMultisig */,
      params,
      script
    };
  }
  CSVMultisigTapscript2.encode = encode2;
  function decode2(script) {
    if (script.length === 0) {
      throw new Error("Failed to decode: script is empty");
    }
    const isValid = isScriptValid(script);
    if (isValid instanceof Error) {
      throw isValid;
    }
    const asm = btcSigner.Script.decode(script);
    const sequence = asm[0];
    const multisigScript = new Uint8Array(btcSigner.Script.encode(asm.slice(3)));
    let multisig;
    try {
      multisig = exports.MultisigTapscript.decode(multisigScript);
    } catch (error) {
      throw new Error(
        `Invalid multisig script: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    let sequenceNum;
    if (typeof sequence === "number") {
      sequenceNum = sequence;
    } else {
      sequenceNum = Number(MinimalScriptNum.decode(sequence));
    }
    const timelock = sequenceToTimelock(sequenceNum);
    const reconstructed = encode2({
      timelock,
      ...multisig.params
    });
    if (base.hex.encode(reconstructed.script) !== base.hex.encode(script)) {
      throw new Error("Invalid script format: script reconstruction mismatch");
    }
    return {
      type: "csv-multisig" /* CSVMultisig */,
      params: {
        timelock,
        ...multisig.params
      },
      script
    };
  }
  CSVMultisigTapscript2.decode = decode2;
  function is(tapscript) {
    return tapscript.type === "csv-multisig" /* CSVMultisig */;
  }
  CSVMultisigTapscript2.is = is;
  function isScriptValid(script) {
    const asm = btcSigner.Script.decode(script);
    if (asm.length < 3) {
      return new Error(`Invalid script: too short (expected at least 3)`);
    }
    const sequence = asm[0];
    if (typeof sequence === "string") {
      return new Error("Invalid script: expected sequence number");
    }
    if (asm[1] !== "CHECKSEQUENCEVERIFY" || asm[2] !== "DROP") {
      return new Error("Invalid script: expected CHECKSEQUENCEVERIFY DROP");
    }
    return true;
  }
  CSVMultisigTapscript2.isScriptValid = isScriptValid;
})(exports.CSVMultisigTapscript || (exports.CSVMultisigTapscript = {}));
exports.ConditionCSVMultisigTapscript = void 0;
((ConditionCSVMultisigTapscript2) => {
  function encode2(params) {
    const script = new Uint8Array([
      ...params.conditionScript,
      ...btcSigner.Script.encode(["VERIFY"]),
      ...exports.CSVMultisigTapscript.encode(params).script
    ]);
    return {
      type: "condition-csv-multisig" /* ConditionCSVMultisig */,
      params,
      script
    };
  }
  ConditionCSVMultisigTapscript2.encode = encode2;
  function decode2(script) {
    if (script.length === 0) {
      throw new Error("Failed to decode: script is empty");
    }
    const isValid = isScriptValid(script);
    if (isValid instanceof Error) {
      throw isValid;
    }
    const asm = btcSigner.Script.decode(script);
    let verifyIndex = getVerifyIndex(asm);
    if (verifyIndex === -1) {
      throw Error("Invalid script: missing VERIFY operation");
    }
    const conditionScript = new Uint8Array(btcSigner.Script.encode(asm.slice(0, verifyIndex)));
    const csvMultisigScript = new Uint8Array(btcSigner.Script.encode(asm.slice(verifyIndex + 1)));
    let csvMultisig;
    try {
      csvMultisig = exports.CSVMultisigTapscript.decode(csvMultisigScript);
    } catch (error) {
      throw new Error(
        `Invalid CSV multisig script: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const reconstructed = encode2({
      conditionScript,
      ...csvMultisig.params
    });
    if (base.hex.encode(reconstructed.script) !== base.hex.encode(script)) {
      throw new Error("Invalid script format: script reconstruction mismatch");
    }
    return {
      type: "condition-csv-multisig" /* ConditionCSVMultisig */,
      params: {
        conditionScript,
        ...csvMultisig.params
      },
      script
    };
  }
  ConditionCSVMultisigTapscript2.decode = decode2;
  function is(tapscript) {
    return tapscript.type === "condition-csv-multisig" /* ConditionCSVMultisig */;
  }
  ConditionCSVMultisigTapscript2.is = is;
  function getVerifyIndex(asm) {
    let verifyIndex = -1;
    for (let i = asm.length - 1; i >= 0; i--) {
      if (asm[i] === "VERIFY") {
        verifyIndex = i;
        return verifyIndex;
      }
    }
    return verifyIndex;
  }
  function isScriptValid(script) {
    const asm = btcSigner.Script.decode(script);
    if (asm.length < 1) {
      return new Error(`Invalid script: too short (expected at least 1)`);
    }
    let verifyIndex = getVerifyIndex(asm);
    if (verifyIndex === -1) {
      return new Error("Invalid script: missing VERIFY operation");
    }
    return true;
  }
  ConditionCSVMultisigTapscript2.isScriptValid = isScriptValid;
})(exports.ConditionCSVMultisigTapscript || (exports.ConditionCSVMultisigTapscript = {}));
exports.ConditionMultisigTapscript = void 0;
((ConditionMultisigTapscript2) => {
  function encode2(params) {
    const script = new Uint8Array([
      ...params.conditionScript,
      ...btcSigner.Script.encode(["VERIFY"]),
      ...exports.MultisigTapscript.encode(params).script
    ]);
    return {
      type: "condition-multisig" /* ConditionMultisig */,
      params,
      script
    };
  }
  ConditionMultisigTapscript2.encode = encode2;
  function decode2(script) {
    if (script.length === 0) {
      throw new Error("Failed to decode: script is empty");
    }
    const isValid = isScriptValid(script);
    if (isValid instanceof Error) {
      throw isValid;
    }
    const asm = btcSigner.Script.decode(script);
    let verifyIndex = getVerifyIndex(asm);
    if (verifyIndex === -1) {
      throw Error("Invalid script: missing VERIFY operation");
    }
    const conditionScript = new Uint8Array(btcSigner.Script.encode(asm.slice(0, verifyIndex)));
    const multisigScript = new Uint8Array(btcSigner.Script.encode(asm.slice(verifyIndex + 1)));
    let multisig;
    try {
      multisig = exports.MultisigTapscript.decode(multisigScript);
    } catch (error) {
      throw new Error(
        `Invalid multisig script: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const reconstructed = encode2({
      conditionScript,
      ...multisig.params
    });
    if (base.hex.encode(reconstructed.script) !== base.hex.encode(script)) {
      throw new Error("Invalid script format: script reconstruction mismatch");
    }
    return {
      type: "condition-multisig" /* ConditionMultisig */,
      params: {
        conditionScript,
        ...multisig.params
      },
      script
    };
  }
  ConditionMultisigTapscript2.decode = decode2;
  function is(tapscript) {
    return tapscript.type === "condition-multisig" /* ConditionMultisig */;
  }
  ConditionMultisigTapscript2.is = is;
  function getVerifyIndex(asm) {
    let verifyIndex = -1;
    for (let i = asm.length - 1; i >= 0; i--) {
      if (asm[i] === "VERIFY") {
        verifyIndex = i;
        return verifyIndex;
      }
    }
    return verifyIndex;
  }
  function isScriptValid(script) {
    const asm = btcSigner.Script.decode(script);
    if (asm.length < 1) {
      return new Error(`Invalid script: too short (expected at least 1)`);
    }
    let verifyIndex = getVerifyIndex(asm);
    if (verifyIndex === -1) {
      return new Error("Invalid script: missing VERIFY operation");
    }
    return true;
  }
  ConditionMultisigTapscript2.isScriptValid = isScriptValid;
})(exports.ConditionMultisigTapscript || (exports.ConditionMultisigTapscript = {}));
exports.CLTVMultisigTapscript = void 0;
((CLTVMultisigTapscript2) => {
  function encode2(params) {
    const locktime = MinimalScriptNum.encode(params.absoluteTimelock);
    const asm = [
      locktime.length === 1 ? locktime[0] : locktime,
      "CHECKLOCKTIMEVERIFY",
      "DROP"
    ];
    const timelockedScript = btcSigner.Script.encode(asm);
    const script = new Uint8Array([
      ...timelockedScript,
      ...exports.MultisigTapscript.encode(params).script
    ]);
    return {
      type: "cltv-multisig" /* CLTVMultisig */,
      params,
      script
    };
  }
  CLTVMultisigTapscript2.encode = encode2;
  function decode2(script) {
    if (script.length === 0) {
      throw new Error("Failed to decode: script is empty");
    }
    const isValid = isScriptValid(script);
    if (isValid instanceof Error) {
      throw isValid;
    }
    const asm = btcSigner.Script.decode(script);
    const locktime = asm[0];
    if (typeof locktime === "string") {
      throw new Error("Invalid script: expected locktime number");
    }
    if (asm[1] !== "CHECKLOCKTIMEVERIFY" || asm[2] !== "DROP") {
      throw new Error("Invalid script: expected CHECKLOCKTIMEVERIFY DROP");
    }
    const multisigScript = new Uint8Array(btcSigner.Script.encode(asm.slice(3)));
    let multisig;
    try {
      multisig = exports.MultisigTapscript.decode(multisigScript);
    } catch (error) {
      throw new Error(
        `Invalid multisig script: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    let absoluteTimelock;
    if (typeof locktime === "number") {
      absoluteTimelock = BigInt(locktime);
    } else {
      absoluteTimelock = MinimalScriptNum.decode(locktime);
    }
    const reconstructed = encode2({
      absoluteTimelock,
      ...multisig.params
    });
    if (base.hex.encode(reconstructed.script) !== base.hex.encode(script)) {
      throw new Error("Invalid script format: script reconstruction mismatch");
    }
    return {
      type: "cltv-multisig" /* CLTVMultisig */,
      params: {
        absoluteTimelock,
        ...multisig.params
      },
      script
    };
  }
  CLTVMultisigTapscript2.decode = decode2;
  function is(tapscript) {
    return tapscript.type === "cltv-multisig" /* CLTVMultisig */;
  }
  CLTVMultisigTapscript2.is = is;
  function isScriptValid(script) {
    const asm = btcSigner.Script.decode(script);
    if (asm.length < 3) {
      return new Error(`Invalid script: too short (expected at least 3)`);
    }
    const locktime = asm[0];
    if (typeof locktime === "string") {
      return new Error("Invalid script: expected locktime as number or bytes");
    }
    if (asm[1] !== "CHECKLOCKTIMEVERIFY" || asm[2] !== "DROP") {
      return new Error("Invalid script: expected CHECKLOCKTIMEVERIFY DROP");
    }
    return true;
  }
  CLTVMultisigTapscript2.isScriptValid = isScriptValid;
})(exports.CLTVMultisigTapscript || (exports.CLTVMultisigTapscript = {}));
var TapTreeCoder = psbt_js.PSBTOutput.tapTree[2];
function scriptFromTapLeafScript(leaf) {
  return leaf[1].subarray(0, leaf[1].length - 1);
}
var VtxoScript = class _VtxoScript {
  /**
   * Create a virtual output script from its tapleaf scripts.
   *
   * @param scripts - Raw tapscript bytes for each leaf
   * @throws Error if the provided leaves cannot produce a valid Taproot tree
   */
  constructor(scripts) {
    this.scripts = scripts;
    const list = scripts.length % 2 !== 0 ? scripts.slice().reverse() : scripts;
    const tapTree = btcSigner.taprootListToTree(
      list.map((script) => ({
        script,
        leafVersion: payment_js.TAP_LEAF_VERSION
      }))
    );
    const payment = btcSigner.p2tr(btcSigner.TAPROOT_UNSPENDABLE_KEY, tapTree, void 0, true);
    if (!payment.tapLeafScript || payment.tapLeafScript.length !== scripts.length) {
      throw new Error("invalid scripts");
    }
    this.leaves = payment.tapLeafScript;
    this.tweakedPublicKey = payment.tweakedPubkey;
    this.pkScript = payment.script;
  }
  leaves;
  tweakedPublicKey;
  pkScript;
  /**
   * Decode a virtual output script from an encoded TapTree.
   *
   * @param tapTree - Encoded TapTree bytes
   * @returns Decoded virtual output script
   * @throws Error if the TapTree cannot be decoded into a valid script set
   * @see encode
   */
  static decode(tapTree) {
    const leaves = TapTreeCoder.decode(tapTree);
    const scripts = leaves.map((leaf) => leaf.script);
    return new _VtxoScript(scripts);
  }
  /**
   * Encode the virtual output script to a TapTree byte representation.
   *
   * @returns Encoded TapTree bytes
   * @see decode
   */
  encode() {
    const tapTree = TapTreeCoder.encode(
      this.scripts.map((script) => ({
        depth: 1,
        version: payment_js.TAP_LEAF_VERSION,
        script
      }))
    );
    return tapTree;
  }
  /**
   * Build the Arkade address corresponding to this virtual output script.
   *
   * @param prefix - Bech32 human-readable prefix
   * @param serverPubKey - 32-byte Arkade server public key
   * @returns Arkade address for this script
   * @see ArkAddress
   */
  address(prefix = DEFAULT_NETWORK.hrp, serverPubKey) {
    return new ArkAddress(serverPubKey, this.tweakedPublicKey, prefix);
  }
  /**
   * Build the Taproot onchain address corresponding to this virtual output script.
   *
   * @param network - Bitcoin network descriptor
   * @returns Taproot onchain address
   * @see address
   */
  onchainAddress(network = DEFAULT_NETWORK) {
    return btcSigner.Address(network).encode({
      type: "tr",
      pubkey: this.tweakedPublicKey
    });
  }
  /**
   * Look up a tapleaf script by its hex-encoded tapscript body.
   *
   * @param scriptHex - Hex-encoded tapscript body without the leaf version byte
   * @returns Matching tapleaf script
   * @throws Error if no matching leaf exists
   */
  findLeaf(scriptHex) {
    const leaf = this.leaves.find(
      (leaf2) => base.hex.encode(scriptFromTapLeafScript(leaf2)) === scriptHex
    );
    if (!leaf) {
      throw new Error(`leaf '${scriptHex}' not found`);
    }
    return leaf;
  }
  /**
   * Return all unilateral exit paths embedded in the virtual output script.
   *
   * @returns CSV-based exit paths found in the leaves
   * @see getSequence
   */
  exitPaths() {
    const paths = [];
    for (const leaf of this.leaves) {
      try {
        const script = scriptFromTapLeafScript(leaf);
        if (exports.CSVMultisigTapscript.isScriptValid(script) === true) {
          const tapScript = exports.CSVMultisigTapscript.decode(script);
          paths.push(tapScript);
        } else if (exports.ConditionCSVMultisigTapscript.isScriptValid(script) === true) {
          const tapScript = exports.ConditionCSVMultisigTapscript.decode(script);
          paths.push(tapScript);
        }
      } catch (e) {
        console.debug("Failed to decode script", e);
      }
    }
    return paths;
  }
};
function getSequence(tapLeafScript) {
  let sequence = void 0;
  try {
    const scriptWithLeafVersion = tapLeafScript[1];
    const script = scriptWithLeafVersion.subarray(0, scriptWithLeafVersion.length - 1);
    try {
      const params = exports.CSVMultisigTapscript.decode(script).params;
      sequence = timelockToSequence(params.timelock);
    } catch {
      const params = exports.CLTVMultisigTapscript.decode(script).params;
      sequence = Number(params.absoluteTimelock);
    }
  } catch {
  }
  return sequence;
}

exports.ArkAddress = ArkAddress;
exports.DEFAULT_ARKADE_SERVER_URL = DEFAULT_ARKADE_SERVER_URL;
exports.DEFAULT_NETWORK = DEFAULT_NETWORK;
exports.DEFAULT_NETWORK_NAME = DEFAULT_NETWORK_NAME;
exports.TapTreeCoder = TapTreeCoder;
exports.VtxoScript = VtxoScript;
exports.decodeTapscript = decodeTapscript;
exports.getNetwork = getNetwork;
exports.getSequence = getSequence;
exports.networks = networks;
exports.scriptFromTapLeafScript = scriptFromTapLeafScript;
exports.sequenceToTimelock = sequenceToTimelock;
exports.timelockToSequence = timelockToSequence;
//# sourceMappingURL=chunk-4QHMS5XH.cjs.map
//# sourceMappingURL=chunk-4QHMS5XH.cjs.map