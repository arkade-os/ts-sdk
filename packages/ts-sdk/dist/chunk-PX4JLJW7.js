import { Transaction, craftToSpendTx, OP_RETURN_EMPTY_PKSCRIPT, Intent, getArkPsbtFields, CosignerPublicKey, BufferReader, BufferWriter, Packet, AssetInput, AssetOutput, AssetId, AssetGroup, setArkPsbtField, VtxoTaprootTree, maybeArkError, AssetRef, Metadata, isEventSourceError, RestArkProvider, RestIndexerProvider, ArkError } from './chunk-DODG3PG2.js';
import { isMainnetDescriptor, descriptorIsOurs, contractHandlers, DelegateVtxo, DefaultVtxo, WALLET_RECEIVE_SOURCE, deriveDescriptorLeafPubKey } from './chunk-BUGGGM2S.js';
import { VtxoScript, CSVMultisigTapscript, timelockToSequence, CLTVMultisigTapscript, ConditionMultisigTapscript, ConditionCSVMultisigTapscript, MultisigTapscript, DEFAULT_NETWORK, DEFAULT_NETWORK_NAME, decodeTapscript, scriptFromTapLeafScript, ArkAddress, getSequence, getNetwork, networks as networks$1, DEFAULT_ARKADE_SERVER_URL } from './chunk-HAYJZIA4.js';
import { __export } from './chunk-NSBPE2FW.js';
import { sha256, hash160, sha256x2, concatBytes, randomPrivateKeyBytes, pubECDSA, pubSchnorr, equalBytes as equalBytes$1 } from '@scure/btc-signer/utils.js';
import { SigHash, Script, OP, ScriptNum, OutScript, Address, p2tr, RawWitness, p2wpkh, TaprootControlBlock, DEFAULT_SEQUENCE, Transaction as Transaction$2 } from '@scure/btc-signer';
import { hex, base58, base64 } from '@scure/base';
import * as musig2 from '@scure/btc-signer/musig2.js';
import { equalBytes, bytesToNumberBE } from '@noble/curves/utils.js';
import { signAsync, schnorr as schnorr$1, Point } from '@noble/secp256k1';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { Script as Script$1 } from '@scure/btc-signer/script.js';
import { Transaction as Transaction$1, SigHash as SigHash$1 } from '@scure/btc-signer/transaction.js';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { networks, scriptExpressions, HDKey, expand } from '@bitcoinerlab/descriptors-scure';
import { tapLeafHash } from '@scure/btc-signer/payment.js';
import { Environment } from '@marcbachmann/cel-js';

function generateNonces(publicKey) {
  const nonces = musig2.nonceGen(publicKey);
  return { secNonce: nonces.secret, pubNonce: nonces.public };
}
function aggregateNonces(pubNonces) {
  return musig2.nonceAggregate(pubNonces);
}
function aggregateKeys(publicKeys, sort, options = {}) {
  {
    publicKeys = musig2.sortKeys(publicKeys);
  }
  const { aggPublicKey: preTweakedKey } = musig2.keyAggregate(publicKeys);
  if (!options.taprootTweak) {
    return {
      preTweakedKey: preTweakedKey.toBytes(true),
      finalKey: preTweakedKey.toBytes(true)
    };
  }
  const tweakBytes = schnorr.utils.taggedHash(
    "TapTweak",
    preTweakedKey.toBytes(true).subarray(1),
    options.taprootTweak ?? new Uint8Array(0)
  );
  const { aggPublicKey: finalKey } = musig2.keyAggregate(publicKeys, [tweakBytes], [true]);
  return {
    preTweakedKey: preTweakedKey.toBytes(true),
    finalKey: finalKey.toBytes(true)
  };
}
var PartialSignatureError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "PartialSignatureError";
  }
};
var PartialSig = class _PartialSig {
  constructor(s, R) {
    this.s = s;
    this.R = R;
    if (s.length !== 32) {
      throw new PartialSignatureError("Invalid s length");
    }
    if (R.length !== 33) {
      throw new PartialSignatureError("Invalid R length");
    }
  }
  /**
   * Encodes the partial signature into bytes
   * Returns a 32-byte array containing just the s value
   */
  encode() {
    return new Uint8Array(this.s);
  }
  /**
   * Decodes a partial signature from bytes
   * @param bytes - 32-byte array containing s value
   */
  static decode(bytes) {
    if (bytes.length !== 32) {
      throw new PartialSignatureError("Invalid partial signature length");
    }
    const s = bytesToNumberBE(bytes);
    if (s >= Point.CURVE().n) {
      throw new PartialSignatureError("s value overflows curve order");
    }
    const R = new Uint8Array(33);
    return new _PartialSig(bytes, R);
  }
};
function sign(secNonce, privateKey, combinedNonce, publicKeys, message, options) {
  let tweakBytes;
  if (options?.taprootTweak !== void 0) {
    const { preTweakedKey } = aggregateKeys(
      musig2.sortKeys(publicKeys) );
    tweakBytes = schnorr.utils.taggedHash(
      "TapTweak",
      preTweakedKey.subarray(1),
      options.taprootTweak
    );
  }
  const session = new musig2.Session(
    combinedNonce,
    musig2.sortKeys(publicKeys) ,
    message,
    tweakBytes ? [tweakBytes] : void 0,
    tweakBytes ? [true] : void 0
  );
  const partialSig = session.sign(secNonce, privateKey);
  return PartialSig.decode(partialSig);
}
var ErrMissingVtxoGraph = new Error("missing vtxo graph");
var TreeSignerSession = class _TreeSignerSession {
  constructor(secretKey) {
    this.secretKey = secretKey;
  }
  static NOT_INITIALIZED = new Error("session not initialized, call init method");
  myNonces = null;
  aggregateNonces = null;
  graph = null;
  scriptRoot = null;
  rootSharedOutputAmount = null;
  static random() {
    const secretKey = randomPrivateKeyBytes();
    return new _TreeSignerSession(secretKey);
  }
  async init(tree, scriptRoot, rootInputAmount) {
    this.graph = tree;
    this.scriptRoot = scriptRoot;
    this.rootSharedOutputAmount = rootInputAmount;
  }
  async getPublicKey() {
    return secp256k1.getPublicKey(this.secretKey);
  }
  async getNonces() {
    if (!this.graph) throw ErrMissingVtxoGraph;
    if (!this.myNonces) {
      this.myNonces = this.generateNonces();
    }
    const publicNonces = /* @__PURE__ */ new Map();
    for (const [txid, nonces] of this.myNonces) {
      publicNonces.set(txid, { pubNonce: nonces.pubNonce });
    }
    return publicNonces;
  }
  async aggregatedNonces(txid, noncesByPubkey) {
    if (!this.graph) throw ErrMissingVtxoGraph;
    if (!this.aggregateNonces) {
      this.aggregateNonces = /* @__PURE__ */ new Map();
    }
    if (!this.myNonces) {
      await this.getNonces();
    }
    if (this.aggregateNonces.has(txid)) {
      return {
        hasAllNonces: this.aggregateNonces.size === this.myNonces?.size
      };
    }
    const myNonce = this.myNonces.get(txid);
    if (!myNonce) throw new Error(`missing nonce for txid ${txid}`);
    const myPublicKey = await this.getPublicKey();
    noncesByPubkey.set(hex.encode(myPublicKey.subarray(1)), myNonce);
    const tx = this.graph.find(txid);
    if (!tx) throw new Error(`missing tx for txid ${txid}`);
    const cosigners = getArkPsbtFields(tx.root, 0, CosignerPublicKey).map(
      (c) => hex.encode(c.key.subarray(1))
      // xonly pubkey
    );
    const pubNonces = [];
    for (const cosigner of cosigners) {
      const nonce = noncesByPubkey.get(cosigner);
      if (!nonce) {
        throw new Error(`missing nonce for cosigner ${cosigner}`);
      }
      pubNonces.push(nonce.pubNonce);
    }
    const aggregateNonce = aggregateNonces(pubNonces);
    this.aggregateNonces.set(txid, { pubNonce: aggregateNonce });
    return {
      hasAllNonces: this.aggregateNonces.size === this.myNonces?.size
    };
  }
  async sign() {
    if (!this.graph) throw ErrMissingVtxoGraph;
    if (!this.aggregateNonces) throw new Error("nonces not set");
    if (!this.myNonces) throw new Error("nonces not generated");
    const sigs = /* @__PURE__ */ new Map();
    for (const g of this.graph.iterator()) {
      const sig = this.signPartial(g);
      sigs.set(g.txid, sig);
    }
    return sigs;
  }
  generateNonces() {
    if (!this.graph) throw ErrMissingVtxoGraph;
    const myNonces = /* @__PURE__ */ new Map();
    const publicKey = secp256k1.getPublicKey(this.secretKey);
    for (const g of this.graph.iterator()) {
      const nonces = generateNonces(publicKey);
      myNonces.set(g.txid, nonces);
    }
    return myNonces;
  }
  signPartial(g) {
    if (!this.graph || !this.scriptRoot || !this.rootSharedOutputAmount) {
      throw _TreeSignerSession.NOT_INITIALIZED;
    }
    if (!this.myNonces || !this.aggregateNonces) {
      throw new Error("session not properly initialized");
    }
    const myNonce = this.myNonces.get(g.txid);
    if (!myNonce) throw new Error("missing private nonce");
    const aggNonce = this.aggregateNonces.get(g.txid);
    if (!aggNonce) throw new Error("missing aggregate nonce");
    const prevoutAmounts = [];
    const prevoutScripts = [];
    const cosigners = getArkPsbtFields(g.root, 0, CosignerPublicKey).map((c) => c.key);
    const { finalKey } = aggregateKeys(cosigners, true, {
      taprootTweak: this.scriptRoot
    });
    for (let inputIndex = 0; inputIndex < g.root.inputsLength; inputIndex++) {
      const prevout = getPrevOutput(
        finalKey,
        this.graph,
        this.rootSharedOutputAmount,
        g.root
      );
      prevoutAmounts.push(prevout.amount);
      prevoutScripts.push(prevout.script);
    }
    const message = g.root.preimageWitnessV1(
      0,
      // always first input
      prevoutScripts,
      SigHash$1.DEFAULT,
      prevoutAmounts
    );
    return sign(
      myNonce.secNonce,
      this.secretKey,
      aggNonce.pubNonce,
      cosigners,
      message,
      {
        taprootTweak: this.scriptRoot}
    );
  }
};
function getPrevOutput(finalKey, graph, sharedOutputAmount, tx) {
  const pkScript = Script$1.encode(["OP_1", finalKey.slice(1)]);
  if (tx.id === graph.txid) {
    return {
      amount: sharedOutputAmount,
      script: pkScript
    };
  }
  const parentInput = tx.getInput(0);
  if (!parentInput.txid) throw new Error("missing parent input txid");
  const parentTxid = hex.encode(parentInput.txid);
  const parent = graph.find(parentTxid);
  if (!parent) throw new Error("parent  tx not found");
  if (parentInput.index === void 0) throw new Error("missing input index");
  const parentOutput = parent.root.getOutput(parentInput.index);
  if (!parentOutput) throw new Error("parent output not found");
  if (!parentOutput.amount) throw new Error("parent output amount not found");
  return {
    amount: parentOutput.amount,
    script: pkScript
  };
}
var ALL_SIGHASH = Object.values(SigHash).filter((x) => typeof x === "number");
var SingleKey = class _SingleKey {
  key;
  constructor(key) {
    this.key = key || randomPrivateKeyBytes();
  }
  /** Create a signing identity from raw private key bytes. */
  static fromPrivateKey(privateKey) {
    return new _SingleKey(privateKey);
  }
  /** Create a signing identity from a hex-encoded private key. */
  static fromHex(privateKeyHex) {
    return new _SingleKey(hex.decode(privateKeyHex));
  }
  /** Create a signing identity with a freshly generated random private key. */
  static fromRandomBytes() {
    return new _SingleKey(randomPrivateKeyBytes());
  }
  /**
   * Export the private key as a hex string.
   *
   * @returns The private key as a hex string
   */
  toHex() {
    return hex.encode(this.key);
  }
  async sign(tx, inputIndexes) {
    const txCpy = tx.clone();
    if (!inputIndexes) {
      try {
        if (!txCpy.sign(this.key, ALL_SIGHASH)) {
          throw new Error("Failed to sign transaction");
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("No inputs signed")) ; else {
          throw e;
        }
      }
      return txCpy;
    }
    for (const inputIndex of inputIndexes) {
      if (!txCpy.signIdx(this.key, inputIndex, ALL_SIGHASH)) {
        throw new Error(`Failed to sign input #${inputIndex}`);
      }
    }
    return txCpy;
  }
  compressedPublicKey() {
    return Promise.resolve(pubECDSA(this.key, true));
  }
  xOnlyPublicKey() {
    return Promise.resolve(pubSchnorr(this.key));
  }
  signerSession() {
    return TreeSignerSession.random();
  }
  async signMessage(message, signatureType = "schnorr") {
    if (signatureType === "ecdsa") return signAsync(message, this.key, { prehash: false });
    return schnorr$1.signAsync(message, this.key);
  }
  async toReadonly() {
    return new ReadonlySingleKey(await this.compressedPublicKey());
  }
};
var ReadonlySingleKey = class _ReadonlySingleKey {
  /** Create a readonly identity from a compressed public key. */
  constructor(publicKey) {
    this.publicKey = publicKey;
    if (publicKey.length !== 33) {
      throw new Error("Invalid public key length");
    }
  }
  /**
   * Create a ReadonlySingleKey from a compressed public key.
   *
   * @param publicKey - 33-byte compressed public key (02/03 prefix + 32-byte x coordinate)
   * @returns A new ReadonlySingleKey instance
   * @example
   * ```typescript
   * const pubkey = new Uint8Array(33); // your compressed public key
   * const readonlyKey = ReadonlySingleKey.fromPublicKey(pubkey);
   * ```
   */
  static fromPublicKey(publicKey) {
    return new _ReadonlySingleKey(publicKey);
  }
  xOnlyPublicKey() {
    return Promise.resolve(this.publicKey.slice(1));
  }
  compressedPublicKey() {
    return Promise.resolve(this.publicKey);
  }
};
var ALL_SIGHASH2 = Object.values(SigHash).filter((x) => typeof x === "number");
var seedBytes = /* @__PURE__ */ new WeakMap();
var mnemonicMeta = /* @__PURE__ */ new WeakMap();
var SeedIdentity = class _SeedIdentity {
  derivedKey;
  /**
   * Wildcard account-descriptor template (e.g.
   * `tr([fp/86'/0'/0']xpub/0/*)`). The canonical thing to pass
   * through the system; consumers materialize a concrete descriptor
   * at a specific index themselves (see `HDDescriptorProvider` in
   * the wallet layer for the rotating-counter use case).
   */
  descriptor;
  /**
   * Constructs a SeedIdentity from a 64-byte seed and either a
   * caller-supplied wildcard descriptor (`{ descriptor }`) or the
   * default BIP86 path at the requested network (`{ isMainnet }`).
   * Prefer the {@link fromSeed} factory for symmetry with
   * {@link MnemonicIdentity.fromMnemonic}.
   *
   * Throws on a non-wildcard descriptor, an xpub mismatch with the
   * seed, or a missing derivation path.
   */
  constructor(seed, opts = {}) {
    if (seed.length !== 64) {
      throw new Error("Seed must be 64 bytes");
    }
    let descriptor;
    let network;
    if ("descriptor" in opts && typeof opts.descriptor === "string") {
      descriptor = opts.descriptor;
      network = isMainnetDescriptor(descriptor) ? networks.bitcoin : networks.testnet;
    } else {
      network = opts.isMainnet ?? true ? networks.bitcoin : networks.testnet;
      descriptor = scriptExpressions.trBIP32({
        masterNode: HDKey.fromMasterSeed(seed, network.bip32),
        network,
        account: 0,
        change: 0,
        index: "*"
      });
    }
    let expansion;
    try {
      expansion = expand({ descriptor, network, index: 0 });
    } catch (e) {
      throw new Error(
        `SeedIdentity requires a wildcard descriptor template (must end in "/*)"); ${e instanceof Error ? e.message : String(e)}`
      );
    }
    const keyInfo = expansion.expansionMap?.["@0"];
    seedBytes.set(this, new Uint8Array(seed));
    this.descriptor = descriptor;
    if (!keyInfo?.originPath) {
      throw new Error("Descriptor must include a key origin path");
    }
    const masterNode = HDKey.fromMasterSeed(seed, network.bip32);
    const accountNode = masterNode.derive(`m${keyInfo.originPath}`);
    if (accountNode.publicExtendedKey !== keyInfo.bip32?.toBase58()) {
      throw new Error("xpub mismatch: derived key does not match descriptor");
    }
    if (!keyInfo.path) {
      throw new Error("Descriptor must specify a full derivation path");
    }
    const derivedNode = masterNode.derive(keyInfo.path);
    if (!derivedNode.privateKey) {
      throw new Error("Failed to derive private key");
    }
    this.derivedKey = derivedNode.privateKey;
  }
  /**
   * Creates a SeedIdentity from a raw 64-byte seed.
   *
   * Pass `{ isMainnet }` for default BIP86 derivation, or
   * `{ descriptor }` for a caller-supplied account-descriptor
   * template (the option's value must end with `/*)`).
   *
   * @param seed - 64-byte seed (typically from mnemonicToSeedSync)
   * @param opts - Network selection or descriptor template.
   */
  static fromSeed(seed, opts = {}) {
    return new _SeedIdentity(seed, opts);
  }
  async xOnlyPublicKey() {
    return pubSchnorr(this.derivedKey);
  }
  async compressedPublicKey() {
    return pubECDSA(this.derivedKey, true);
  }
  async sign(tx, inputIndexes) {
    return this.signTxWithKey(tx, this.derivedKey, inputIndexes);
  }
  async signMessage(message, signatureType = "schnorr") {
    return this.signMessageWithKey(this.derivedKey, message, signatureType);
  }
  signerSession() {
    return TreeSignerSession.random();
  }
  /**
   * Converts to a watch-only identity that cannot sign. Carries the
   * template forward, so the readonly side stays HD-capable (can
   * derive descriptors at any index without seed access).
   */
  async toReadonly() {
    return ReadonlyDescriptorIdentity.fromDescriptor(this.descriptor);
  }
  /**
   * Returns true when `descriptor` is derived from this identity's seed.
   * HD descriptors match by account xpub; bare `tr(pubkey)` descriptors
   * match by raw pubkey. See {@link descriptorIsOurs}.
   *
   * @deprecated Prefer `DescriptorProvider.isOurs()` via
   * `HDDescriptorProvider` for rotating HD wallets or
   * `StaticDescriptorProvider` for legacy single-key wallets.
   */
  isOurs(descriptor) {
    return descriptorIsOurs(descriptor, this.descriptor, pubSchnorr(this.derivedKey));
  }
  /**
   * Signs each request with the key derived from its descriptor.
   * Each descriptor must share this identity's seed ({@link isOurs}).
   *
   * @deprecated Prefer `DescriptorProvider.signWithDescriptor()` via
   * `HDDescriptorProvider` or `StaticDescriptorProvider`. Identities keep
   * this method only as backing implementation for descriptor providers.
   */
  async signWithDescriptor(requests) {
    return requests.map((request) => {
      if (!this.isOurs(request.descriptor)) {
        throw new Error(
          `Descriptor ${request.descriptor} does not belong to this identity`
        );
      }
      const key = this.derivePrivateKeyForDescriptor(request.descriptor);
      return this.signTxWithKey(request.tx, key, request.inputIndexes);
    });
  }
  /**
   * Signs a message with the key derived from `descriptor`.
   *
   * @deprecated Prefer `DescriptorProvider.signMessageWithDescriptor()` via
   * `HDDescriptorProvider` or `StaticDescriptorProvider`. Identities keep
   * this method only as backing implementation for descriptor providers.
   */
  async signMessageWithDescriptor(descriptor, message, signatureType = "schnorr") {
    if (!this.isOurs(descriptor)) {
      throw new Error(`Descriptor ${descriptor} does not belong to this identity`);
    }
    const key = this.derivePrivateKeyForDescriptor(descriptor);
    return this.signMessageWithKey(key, message, signatureType);
  }
  // ── internal helpers ─────────────────────────────────────────────
  derivePrivateKeyForDescriptor(descriptor) {
    const network = isMainnetDescriptor(descriptor) ? networks.bitcoin : networks.testnet;
    const expansion = expand({ descriptor, network });
    if (expansion.isRanged) {
      throw new Error(
        "Cannot sign with a wildcard descriptor; derive a concrete index first"
      );
    }
    const keyInfo = expansion.expansionMap?.["@0"];
    if (!keyInfo?.path) {
      throw new Error("Descriptor must specify a full derivation path for signing");
    }
    const seed = seedBytes.get(this);
    if (!seed) {
      throw new Error("Seed bytes not available for descriptor signing");
    }
    const masterNode = HDKey.fromMasterSeed(seed, network.bip32);
    const node = masterNode.derive(keyInfo.path);
    if (!node.privateKey) {
      throw new Error("Failed to derive private key for descriptor");
    }
    return node.privateKey;
  }
  signTxWithKey(tx, key, inputIndexes) {
    const txCpy = tx.clone();
    if (!inputIndexes) {
      try {
        if (!txCpy.sign(key, ALL_SIGHASH2)) {
          throw new Error("Failed to sign transaction");
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("No inputs signed")) ; else {
          throw e;
        }
      }
    } else {
      for (const idx of inputIndexes) {
        if (!txCpy.signIdx(key, idx, ALL_SIGHASH2)) {
          throw new Error(`Failed to sign input #${idx}`);
        }
      }
    }
    return txCpy;
  }
  signMessageWithKey(key, message, signatureType) {
    if (signatureType === "ecdsa") return signAsync(message, key, { prehash: false });
    return schnorr$1.signAsync(message, key);
  }
};
var MnemonicIdentity = class _MnemonicIdentity extends SeedIdentity {
  constructor(phrase, opts) {
    const { passphrase } = opts;
    super(mnemonicToSeedSync(phrase, passphrase), opts);
    mnemonicMeta.set(this, { mnemonic: phrase, passphrase });
  }
  /**
   * Creates a MnemonicIdentity from a BIP39 mnemonic phrase.
   *
   * Pass `{ isMainnet }` for default BIP86 derivation, or
   * `{ descriptor }` for a caller-supplied account-descriptor
   * template (the option's value must end with `/*)`).
   *
   * @param phrase - BIP39 mnemonic phrase (12 or 24 words)
   * @param opts - Network selection or descriptor template, plus optional passphrase
   */
  static fromMnemonic(phrase, opts = {}) {
    if (!validateMnemonic(phrase, wordlist)) {
      throw new Error("Invalid mnemonic");
    }
    return new _MnemonicIdentity(phrase, opts);
  }
};
var ReadonlyDescriptorIdentity = class _ReadonlyDescriptorIdentity {
  /**
   * Index-0 expansion of {@link descriptor}. Both the x-only pubkey
   * (taproot, returned by the library as 32 bytes) and the compressed
   * pubkey (derived through the bip32 node when needed) are read off
   * this on demand — no separate caches.
   */
  indexZero;
  /**
   * Wildcard account-descriptor template (e.g.
   * `tr([fp/86'/0'/0']xpub/0/*)`). HD rotation consumers materialize
   * a concrete descriptor at a specific index themselves.
   */
  descriptor;
  constructor(descriptor) {
    const network = isMainnetDescriptor(descriptor) ? networks.bitcoin : networks.testnet;
    let expansion;
    try {
      expansion = expand({ descriptor, network, index: 0 });
    } catch (e) {
      throw new Error(
        `ReadonlyDescriptorIdentity requires a wildcard descriptor template (must end in "/*)"); ${e instanceof Error ? e.message : String(e)}`
      );
    }
    const keyInfo = expansion.expansionMap?.["@0"];
    if (!keyInfo?.pubkey) {
      throw new Error("Failed to derive public key from descriptor");
    }
    if (!keyInfo.bip32) {
      throw new Error("Cannot determine compressed public key parity from descriptor");
    }
    this.descriptor = descriptor;
    this.indexZero = keyInfo;
  }
  /**
   * Creates a ReadonlyDescriptorIdentity from an account-descriptor
   * *template* (must end with the BIP-32 wildcard suffix `/*)`).
   *
   * @param descriptor - Wildcard-suffixed Taproot template
   *   (`tr([fp/path']xpub.../child/*)`).
   */
  static fromDescriptor(descriptor) {
    return new _ReadonlyDescriptorIdentity(descriptor);
  }
  async xOnlyPublicKey() {
    return this.indexZero.pubkey;
  }
  async compressedPublicKey() {
    const { bip32, keyPath } = this.indexZero;
    if (keyPath) {
      return bip32.derivePath(keyPath.replace(/^\//, "")).publicKey;
    }
    return bip32.publicKey;
  }
  /**
   * Returns true when `descriptor` derives from this identity's xpub.
   * HD descriptors match by account xpub; bare `tr(pubkey)` descriptors
   * fall back to comparing against the index-0 x-only pubkey. See
   * {@link descriptorIsOurs}.
   *
   * @deprecated Prefer `DescriptorProvider.isOurs()` via
   * `HDDescriptorProvider` for rotating HD wallets or
   * `StaticDescriptorProvider` for legacy single-key wallets.
   */
  isOurs(descriptor) {
    return descriptorIsOurs(descriptor, this.descriptor, this.indexZero.pubkey);
  }
};
function serializeSeedOwnedSigningIdentity(identity) {
  if (identity instanceof MnemonicIdentity) {
    const meta = mnemonicMeta.get(identity);
    if (!meta) {
      throw new Error(
        "MnemonicIdentity is missing internal secret state; was it constructed via MnemonicIdentity.fromMnemonic()?"
      );
    }
    const envelope = {
      type: "mnemonic",
      mnemonic: meta.mnemonic,
      descriptor: identity.descriptor
    };
    if (meta.passphrase !== void 0) {
      envelope.passphrase = meta.passphrase;
    }
    return envelope;
  }
  const seed = seedBytes.get(identity);
  if (!seed) {
    throw new Error(
      "SeedIdentity is missing internal secret state; was it constructed via SeedIdentity.fromSeed() or the class constructor?"
    );
  }
  return {
    type: "seed",
    seed: hex.encode(seed),
    descriptor: identity.descriptor
  };
}
function serializeSeedOwnedReadonlyIdentity(identity) {
  return {
    type: "readonly-descriptor",
    descriptor: identity.descriptor
  };
}
function isSigningSerialized(s) {
  return s.type === "single-key" || s.type === "seed" || s.type === "mnemonic";
}
function hasToHex(identity) {
  return typeof identity.toHex === "function";
}
function serializeSigningIdentity(identity) {
  if (identity instanceof SeedIdentity) {
    return serializeSeedOwnedSigningIdentity(identity);
  }
  if (identity instanceof SingleKey) {
    return { type: "single-key", privateKey: identity.toHex() };
  }
  if (hasToHex(identity)) {
    return { type: "single-key", privateKey: identity.toHex() };
  }
  throw new Error("Unsupported signing identity: cannot serialize for service-worker transport");
}
async function serializeReadonlyIdentity(identity) {
  if (identity instanceof SeedIdentity || identity instanceof ReadonlyDescriptorIdentity) {
    return serializeSeedOwnedReadonlyIdentity(identity);
  }
  return {
    type: "readonly-single-key",
    publicKey: hex.encode(await identity.compressedPublicKey())
  };
}
function hydrateIdentity(s) {
  switch (s.type) {
    case "single-key":
      return SingleKey.fromHex(s.privateKey);
    case "readonly-single-key":
      return ReadonlySingleKey.fromPublicKey(hex.decode(s.publicKey));
    case "seed":
      return SeedIdentity.fromSeed(hex.decode(s.seed), {
        descriptor: s.descriptor
      });
    case "mnemonic":
      return MnemonicIdentity.fromMnemonic(s.mnemonic, {
        descriptor: s.descriptor,
        passphrase: s.passphrase
      });
    case "readonly-descriptor":
      return ReadonlyDescriptorIdentity.fromDescriptor(s.descriptor);
    default:
      throw new Error(
        `Unknown serialized identity type: ${String(s.type)}`
      );
  }
}
var warnedLegacyShape = false;
function normalizeSerializedIdentity(shape) {
  if ("type" in shape) {
    assertValidSerializedIdentity(shape);
    return shape;
  }
  if (!warnedLegacyShape) {
    warnedLegacyShape = true;
    console.warn(
      "[ts-sdk] Received legacy serialized identity shape (privateKey/publicKey). Upgrade the page build to the latest @arkade-os/sdk \u2014 this compatibility path will be removed in the next major."
    );
  }
  if ("privateKey" in shape && typeof shape.privateKey === "string") {
    return { type: "single-key", privateKey: shape.privateKey };
  }
  if ("publicKey" in shape && typeof shape.publicKey === "string") {
    return { type: "readonly-single-key", publicKey: shape.publicKey };
  }
  throw new Error("Unrecognized serialized identity shape");
}
function assertValidSerializedIdentity(s) {
  const kind = s.type;
  const bad = (field, expected) => {
    throw new Error(
      `Malformed serialized identity ({ type: ${JSON.stringify(kind)} }): missing or invalid "${field}" (expected ${expected})`
    );
  };
  const asStr = (key) => {
    const v = s[key];
    return typeof v === "string" ? v : bad(key, "string");
  };
  switch (kind) {
    case "single-key":
      asStr("privateKey");
      return;
    case "readonly-single-key":
      asStr("publicKey");
      return;
    case "seed":
      asStr("seed");
      asStr("descriptor");
      return;
    case "mnemonic": {
      asStr("mnemonic");
      asStr("descriptor");
      const passphrase = s.passphrase;
      if (passphrase !== void 0 && typeof passphrase !== "string") {
        bad("passphrase", "string | undefined");
      }
      return;
    }
    case "readonly-descriptor":
      asStr("descriptor");
      return;
    default:
      throw new Error(`Unknown serialized identity type: ${String(kind)}`);
  }
}

// src/identity/hdCapableIdentity.ts
function isHDCapableIdentity(value) {
  if (typeof value !== "object" || value === null) return false;
  const v = value;
  return typeof v.descriptor === "string" && typeof v.isOurs === "function" && typeof v.signWithDescriptor === "function" && typeof v.signMessageWithDescriptor === "function";
}

// src/identity/index.ts
function isBatchSignable(identity) {
  return "signMultiple" in identity && typeof identity.signMultiple === "function";
}

// src/worker/browser/service-worker-manager.ts
var registrations = /* @__PURE__ */ new Map();
var handshakes = /* @__PURE__ */ new WeakSet();
function ensureServiceWorkerSupport() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service workers are not supported in this browser");
  }
}
function debugLog(debug, ...args) {
  if (debug) {
    console.debug(...args);
  }
}
function normalizeOptions(pathOrOptions) {
  if (typeof pathOrOptions === "string") {
    return {
      path: pathOrOptions,
      updateViaCache: "none",
      autoReload: true,
      debug: false,
      activationTimeoutMs: 1e4
    };
  }
  return {
    path: pathOrOptions.path,
    updateViaCache: pathOrOptions.updateViaCache ?? "none",
    autoReload: pathOrOptions.autoReload ?? true,
    onNeedRefresh: pathOrOptions.onNeedRefresh,
    onUpdated: pathOrOptions.onUpdated,
    debug: pathOrOptions.debug ?? false,
    activationTimeoutMs: pathOrOptions.activationTimeoutMs ?? 1e4
  };
}
function sendSkipWaiting(worker, debug) {
  if (!worker) return;
  try {
    worker.postMessage({ type: "SKIP_WAITING" });
    debugLog(debug, "Sent SKIP_WAITING to waiting service worker");
  } catch (error) {
    console.warn("Failed to post SKIP_WAITING to service worker", error);
  }
}
function attachUpdateHandlers(registration, options) {
  if (handshakes.has(registration)) return;
  handshakes.add(registration);
  const { autoReload, onNeedRefresh, onUpdated, activationTimeoutMs, debug } = options;
  let reloadTriggered = false;
  const maybeReload = () => {
    if (reloadTriggered) return;
    reloadTriggered = true;
    debugLog(debug, "Service worker controller change detected");
    onUpdated?.();
    if (autoReload && typeof window !== "undefined" && typeof window.location?.reload === "function") {
      window.location.reload();
    }
  };
  const handleWaiting = (worker) => {
    if (!worker) return;
    onNeedRefresh?.();
    sendSkipWaiting(worker, debug);
    if (activationTimeoutMs > 0 && typeof window !== "undefined") {
      window.setTimeout(() => {
        if (registration.waiting) {
          debugLog(debug, "Waiting worker still pending; re-sending SKIP_WAITING");
          sendSkipWaiting(registration.waiting, debug);
          registration.update().catch(
            () => debugLog(debug, "Service worker update retry failed (timeout path)")
          );
        }
      }, activationTimeoutMs);
    }
  };
  if (registration.waiting) {
    handleWaiting(registration.waiting);
  }
  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener("statechange", () => {
      if (installing.state === "installed") {
        handleWaiting(registration.waiting);
      }
    });
  });
  navigator.serviceWorker.addEventListener("controllerchange", maybeReload, {
    once: true
  });
}
function registerOnce(options) {
  const { path, updateViaCache } = options;
  if (!registrations.has(path)) {
    const registrationPromise = navigator.serviceWorker.register(path, { updateViaCache }).then(async (registration) => {
      try {
        await registration.update();
      } catch (error) {
        console.warn(
          "Service worker update failed; continuing with registration",
          error
        );
      }
      return registration;
    }).catch((error) => {
      registrations.delete(path);
      throw error;
    });
    registrations.set(path, registrationPromise);
  }
  return registrations.get(path).then((registration) => {
    attachUpdateHandlers(registration, options);
    return registration;
  });
}
async function setupServiceWorkerOnce(pathOrOptions) {
  ensureServiceWorkerSupport();
  const options = normalizeOptions(pathOrOptions);
  return registerOnce(options);
}
async function getActiveServiceWorker(path) {
  ensureServiceWorkerSupport();
  const registration = path ? await registerOnce(normalizeOptions(path)) : await navigator.serviceWorker.ready;
  let serviceWorker = registration.active || registration.waiting || registration.installing || navigator.serviceWorker.controller;
  if (!serviceWorker && path) {
    const readyRegistration = await navigator.serviceWorker.ready;
    serviceWorker = readyRegistration.active || readyRegistration.waiting || readyRegistration.installing || navigator.serviceWorker.controller;
  }
  if (!serviceWorker) {
    throw new Error("Service worker not ready yet");
  }
  return serviceWorker;
}

// src/providers/delegate.ts
var RestDelegateProvider = class {
  /**
   * Create a REST delegate provider targeting the given base URL.
   *
   * @param url - Base URL of the remote delegation service.
   */
  constructor(url) {
    this.url = url;
  }
  /**
   * Submit a delegation request to the remote delegation service.
   *
   * @param intent - Signed register intent to delegate
   * @param forfeitTxs - Forfeit transactions associated with the delegation request
   * @param options - Optional delegate behavior flags
   * @throws Error if the remote service rejects the request
   */
  async delegate(intent, forfeitTxs, options) {
    const url = `${this.url}/v1/delegate`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        intent: {
          message: Intent.encodeMessage(intent.message),
          proof: intent.proof
        },
        forfeit_txs: forfeitTxs,
        reject_replace: options?.rejectReplace ?? false
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to delegate: ${errorText}`);
    }
  }
  /**
   * Fetch delegate metadata exposed by the remote delegation service.
   *
   * @returns Delegate identity and fee information
   * @throws Error if the remote service returns invalid data
   */
  async getDelegateInfo() {
    const url = `${this.url}/v1/delegator/info`;
    const response = await fetch(url);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get delegate info: ${errorText}`);
    }
    const data = await response.json();
    if (!isDelegateInfo(data)) {
      throw new Error("Invalid delegate info");
    }
    const delegateAddress = typeof data.delegateAddress === "string" && data.delegateAddress !== "" ? data.delegateAddress : typeof data.delegatorAddress === "string" && data.delegatorAddress !== "" ? data.delegatorAddress : "";
    return { ...data, delegateAddress };
  }
};
var RestDelegatorProvider = RestDelegateProvider;
function isDelegateInfo(data) {
  return !!data && typeof data === "object" && "pubkey" in data && "fee" in data && typeof data.pubkey === "string" && typeof data.fee === "string" && data.pubkey !== "" && data.fee !== "" && (typeof data.delegateAddress === "string" && data.delegateAddress !== "" || typeof data.delegatorAddress === "string" && data.delegatorAddress !== "");
}

// src/providers/onchain.ts
var ESPLORA_URL = {
  bitcoin: "https://mempool.arkade.sh/api",
  testnet: "https://mempool.space/testnet/api",
  signet: "https://mempool.signet.arkade.sh/api",
  mutinynet: "https://mempool.mutinynet.arkade.sh/api",
  regtest: "http://localhost:3000"
};
var EsploraProvider = class {
  constructor(baseUrl = ESPLORA_URL[DEFAULT_NETWORK_NAME], opts) {
    this.baseUrl = baseUrl;
    this.pollingInterval = opts?.pollingInterval ?? 15e3;
    this.forcePolling = opts?.forcePolling ?? false;
  }
  pollingInterval;
  forcePolling;
  async getCoins(address) {
    const response = await fetch(`${this.baseUrl}/address/${address}/utxo`);
    if (!response.ok) {
      throw new Error(`Failed to fetch UTXOs: ${response.statusText}`);
    }
    return response.json();
  }
  async getFeeRate() {
    const response = await fetch(`${this.baseUrl}/fee-estimates`);
    if (!response.ok) {
      throw new Error(`Failed to fetch fee rate: ${response.statusText}`);
    }
    const fees = await response.json();
    return fees["1"] ?? void 0;
  }
  async broadcastTransaction(...txs) {
    switch (txs.length) {
      case 1:
        return this.broadcastTx(txs[0]);
      case 2:
        return this.broadcastPackage(txs[0], txs[1]);
      default:
        throw new Error("Only 1 or 1C1P package can be broadcast");
    }
  }
  async getTxOutspends(txid) {
    const response = await fetch(`${this.baseUrl}/tx/${txid}/outspends`);
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get transaction outspends: ${error}`);
    }
    return response.json();
  }
  async getTransactions(address) {
    const response = await fetch(`${this.baseUrl}/address/${address}/txs`);
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get transactions: ${error}`);
    }
    return response.json();
  }
  async getTxStatus(txid) {
    const txresponse = await fetch(`${this.baseUrl}/tx/${txid}`);
    if (!txresponse.ok) {
      throw new Error(txresponse.statusText);
    }
    const tx = await txresponse.json();
    if (!tx.status.confirmed) {
      return { confirmed: false };
    }
    const response = await fetch(`${this.baseUrl}/tx/${txid}/status`);
    if (!response.ok) {
      throw new Error(`Failed to get transaction status: ${response.statusText}`);
    }
    const data = await response.json();
    if (!data.confirmed) {
      return { confirmed: false };
    }
    return {
      confirmed: data.confirmed,
      blockTime: data.block_time,
      blockHeight: data.block_height
    };
  }
  async watchAddresses(addresses, callback) {
    let intervalId = null;
    const wsUrl = this.baseUrl.replace(/^http(s)?:/, "ws$1:") + "/v1/ws";
    const poll = async () => {
      const getAllTxs = async () => {
        const txArrays = await Promise.all(
          addresses.map((address) => this.getTransactions(address))
        );
        return txArrays.flat();
      };
      const initialTxs = await getAllTxs();
      const txKey2 = (tx) => `${tx.txid}_${tx.status.block_time}`;
      const existingTxs = new Set(initialTxs.map(txKey2));
      intervalId = setInterval(async () => {
        try {
          const currentTxs = await getAllTxs();
          const newTxs = currentTxs.filter((tx) => !existingTxs.has(txKey2(tx)));
          if (newTxs.length > 0) {
            newTxs.forEach((tx) => existingTxs.add(txKey2(tx)));
            callback(newTxs);
          }
        } catch (error) {
          console.error("Error in polling mechanism:", error);
        }
      }, this.pollingInterval);
    };
    let ws = null;
    const stopFunc = () => {
      if (ws) ws.close();
      if (intervalId) clearInterval(intervalId);
    };
    if (this.forcePolling) {
      await poll();
      return stopFunc;
    }
    try {
      ws = new WebSocket(wsUrl);
      ws.addEventListener("open", () => {
        const subscribeMsg = {
          "track-addresses": addresses
        };
        ws.send(JSON.stringify(subscribeMsg));
      });
      ws.addEventListener("message", (event) => {
        try {
          const newTxs = [];
          const message = JSON.parse(event.data.toString());
          if (!message["multi-address-transactions"]) return;
          const aux = message["multi-address-transactions"];
          for (const address in aux) {
            for (const type of ["mempool", "confirmed", "removed"]) {
              if (!aux[address][type]) continue;
              newTxs.push(...aux[address][type].filter(isExplorerTransaction));
            }
          }
          if (newTxs.length > 0) callback(newTxs);
        } catch (error) {
          console.error("Failed to process WebSocket message:", error);
        }
      });
      ws.addEventListener("error", async () => {
        await poll();
      });
    } catch {
      if (intervalId) clearInterval(intervalId);
      await poll();
    }
    return stopFunc;
  }
  async getChainTip() {
    const tipBlocks = await fetch(`${this.baseUrl}/blocks/tip`);
    if (!tipBlocks.ok) {
      throw new Error(`Failed to get chain tip: ${tipBlocks.statusText}`);
    }
    const tip = await tipBlocks.json();
    if (!isValidBlocksTip(tip)) {
      throw new Error(`Invalid chain tip: ${JSON.stringify(tip)}`);
    }
    if (tip.length === 0) {
      throw new Error("No chain tip found");
    }
    const hash = tip[0].id;
    return {
      height: tip[0].height,
      time: tip[0].mediantime,
      hash
    };
  }
  async broadcastPackage(parent, child) {
    const response = await fetch(`${this.baseUrl}/txs/package`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify([parent, child])
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to broadcast package: ${error}`);
    }
    return response.json();
  }
  async broadcastTx(tx) {
    const response = await fetch(`${this.baseUrl}/tx`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain"
      },
      body: tx
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to broadcast transaction: ${error}`);
    }
    return response.text();
  }
};
function isValidBlocksTip(tip) {
  return Array.isArray(tip) && tip.every((t) => {
    return t && typeof t === "object" && typeof t.id === "string" && t.id.length > 0 && typeof t.height === "number" && t.height >= 0 && typeof t.mediantime === "number" && t.mediantime > 0;
  });
}
var isExplorerTransaction = (tx) => {
  return typeof tx.txid === "string" && Array.isArray(tx.vout) && tx.vout.every(
    (vout) => typeof vout.scriptpubkey_address === "string" && typeof vout.value === "number"
  ) && typeof tx.status === "object" && typeof tx.status.confirmed === "boolean";
};
var ANCHOR_VALUE = 0n;
var ANCHOR_PKSCRIPT = new Uint8Array([81, 2, 78, 115]);
var P2A = {
  script: ANCHOR_PKSCRIPT,
  amount: ANCHOR_VALUE
};
var hexP2Ascript = hex.encode(P2A.script);
function findP2AOutput(tx) {
  for (let i = 0; i < tx.outputsLength; i++) {
    const output = tx.getOutput(i);
    if (output.script && hex.encode(output.script) === hexP2Ascript) {
      if (output.amount !== P2A.amount) {
        throw new Error(
          `P2A output has wrong amount, expected ${P2A.amount} got ${output.amount}`
        );
      }
      return {
        txid: tx.id,
        index: i,
        witnessUtxo: P2A
      };
    }
  }
  throw new Error("P2A output not found");
}

// src/forfeit.ts
function buildForfeitTx(inputs, forfeitPkScript, txLocktime) {
  let amount = 0n;
  for (const input of inputs) {
    if (!input.witnessUtxo) {
      throw new Error("input needs witness utxo");
    }
    amount += input.witnessUtxo.amount;
  }
  return buildForfeitTxWithOutput(
    inputs,
    {
      script: forfeitPkScript,
      amount
    },
    txLocktime
  );
}
function buildForfeitTxWithOutput(inputs, output, txLocktime) {
  const tx = new Transaction({
    version: 3,
    lockTime: txLocktime
  });
  for (const input of inputs) {
    tx.addInput(input);
  }
  tx.addOutput(output);
  tx.addOutput(P2A);
  return tx;
}
var ErrInvalidSettlementTxOutputs = new Error("invalid settlement transaction outputs");
var ErrEmptyTree = new Error("empty tree");
var ErrNumberOfInputs = new Error("invalid number of inputs");
var ErrWrongSettlementTxid = new Error("wrong settlement txid");
var ErrInvalidAmount = new Error("invalid amount");
var ErrNoLeaves = new Error("no leaves");
var ErrInvalidTaprootScript = new Error("invalid taproot script");
var ErrInvalidRoundTxOutputs = new Error("invalid round transaction outputs");
var ErrWrongCommitmentTxid = new Error("wrong commitment txid");
var ErrMissingCosignersPublicKeys = new Error("missing cosigners public keys");
var BATCH_OUTPUT_VTXO_INDEX = 0;
var BATCH_OUTPUT_CONNECTORS_INDEX = 1;
function validateConnectorsTxGraph(settlementTxB64, connectorsGraph) {
  connectorsGraph.validate();
  if (connectorsGraph.root.inputsLength !== 1) throw ErrNumberOfInputs;
  const rootInput = connectorsGraph.root.getInput(0);
  const settlementTx = Transaction$1.fromPSBT(base64.decode(settlementTxB64));
  if (settlementTx.outputsLength <= BATCH_OUTPUT_CONNECTORS_INDEX)
    throw ErrInvalidSettlementTxOutputs;
  const expectedRootTxid = settlementTx.id;
  if (!rootInput.txid) throw ErrWrongSettlementTxid;
  if (hex.encode(rootInput.txid) !== expectedRootTxid) throw ErrWrongSettlementTxid;
  if (rootInput.index !== BATCH_OUTPUT_CONNECTORS_INDEX) throw ErrWrongSettlementTxid;
}
function validateVtxoTxGraph(graph, roundTransaction, sweepTapTreeRoot) {
  if (roundTransaction.outputsLength < BATCH_OUTPUT_VTXO_INDEX + 1) {
    throw ErrInvalidRoundTxOutputs;
  }
  const batchOutputAmount = roundTransaction.getOutput(BATCH_OUTPUT_VTXO_INDEX)?.amount;
  if (!batchOutputAmount) {
    throw ErrInvalidRoundTxOutputs;
  }
  if (!graph.root) {
    throw ErrEmptyTree;
  }
  const rootInput = graph.root.getInput(0);
  const commitmentTxid = roundTransaction.id;
  if (!rootInput.txid || hex.encode(rootInput.txid) !== commitmentTxid || rootInput.index !== BATCH_OUTPUT_VTXO_INDEX) {
    throw ErrWrongCommitmentTxid;
  }
  let sumRootValue = 0n;
  for (let i = 0; i < graph.root.outputsLength; i++) {
    const output = graph.root.getOutput(i);
    if (output?.amount) {
      sumRootValue += output.amount;
    }
  }
  if (sumRootValue !== batchOutputAmount) {
    throw ErrInvalidAmount;
  }
  const leaves = graph.leaves();
  if (leaves.length === 0) {
    throw ErrNoLeaves;
  }
  graph.validate();
  for (const g of graph.iterator()) {
    for (const [childIndex, child] of g.children) {
      const parentOutput = g.root.getOutput(childIndex);
      if (!parentOutput?.script) {
        throw new Error(`parent output ${childIndex} not found`);
      }
      const previousScriptKey = parentOutput.script.slice(2);
      if (previousScriptKey.length !== 32) {
        throw new Error(`parent output ${childIndex} has invalid script`);
      }
      const cosigners = getArkPsbtFields(child.root, 0, CosignerPublicKey);
      if (cosigners.length === 0) {
        throw ErrMissingCosignersPublicKeys;
      }
      const cosignerKeys = cosigners.map((c) => c.key);
      const { finalKey } = aggregateKeys(cosignerKeys, true, {
        taprootTweak: sweepTapTreeRoot
      });
      if (!finalKey || hex.encode(finalKey.slice(1)) !== hex.encode(previousScriptKey)) {
        throw ErrInvalidTaprootScript;
      }
    }
  }
}

// src/extension/packet.ts
var UnknownPacket = class {
  constructor(packetType, data) {
    this.packetType = packetType;
    this.data = data;
  }
  type() {
    return this.packetType;
  }
  serialize() {
    return this.data;
  }
};

// src/extension/emulator/packet.ts
var EmulatorPacket = class _EmulatorPacket {
  constructor(entries) {
    this.entries = entries;
  }
  /** PACKET_TYPE is the 1-byte TLV type tag used in the Extension envelope. */
  static PACKET_TYPE = 1;
  static create(entries) {
    if (entries.length === 0) {
      throw new Error("empty emulator packet");
    }
    for (const entry of entries) {
      if (entry.script.length === 0) {
        throw new Error(`empty script for vin ${entry.vin}`);
      }
    }
    const seen = /* @__PURE__ */ new Set();
    for (const entry of entries) {
      if (seen.has(entry.vin)) {
        throw new Error(`duplicate vin ${entry.vin}`);
      }
      seen.add(entry.vin);
    }
    return new _EmulatorPacket(entries);
  }
  static fromBytes(data) {
    const reader = new BufferReader(data);
    const entryCount = reader.readCompactSize();
    const entries = [];
    for (let i = 0; i < entryCount; i++) {
      const vin = reader.readUint16LE();
      const script = reader.readCompactSlice();
      const witness = reader.readCompactSlice();
      entries.push({ vin, script, witness });
    }
    if (reader.remaining() > 0) {
      throw new Error(`unexpected ${reader.remaining()} trailing bytes`);
    }
    return _EmulatorPacket.create(entries);
  }
  type() {
    return _EmulatorPacket.PACKET_TYPE;
  }
  serialize() {
    const writer = new BufferWriter();
    writer.writeCompactSize(this.entries.length);
    for (const entry of this.entries) {
      writer.writeUint16LE(entry.vin);
      writer.writeCompactSlice(entry.script);
      writer.writeCompactSlice(entry.witness ?? new Uint8Array(0));
    }
    return writer.toBytes();
  }
};

// src/extension/index.ts
var ARKADE_MAGIC = new Uint8Array([65, 82, 75]);
var ExtensionNotFoundError = class extends Error {
  constructor() {
    super("no extension output found in transaction");
    this.name = "ExtensionNotFoundError";
  }
};
var Extension = class _Extension {
  constructor(packets) {
    this.packets = packets;
  }
  static create(packets) {
    if (packets.length === 0) {
      throw new Error("missing packets");
    }
    const seen = /* @__PURE__ */ new Set();
    for (const p of packets) {
      if (seen.has(p.type())) {
        throw new Error(`duplicate packet type ${p.type()}`);
      }
      seen.add(p.type());
    }
    return new _Extension(packets);
  }
  /**
   * isExtension returns true if the script is an OP_RETURN whose push data
   * begins with the ARK magic bytes.
   */
  static isExtension(script) {
    try {
      const decoded = Script.decode(script);
      if (decoded.length < 2 || decoded[0] !== "RETURN") return false;
      const data = decoded[1];
      if (!(data instanceof Uint8Array)) return false;
      return data.length >= ARKADE_MAGIC.length && equalBytes$1(data.slice(0, ARKADE_MAGIC.length), ARKADE_MAGIC);
    } catch {
      return false;
    }
  }
  /**
   * fromBytes parses an Extension from a raw OP_RETURN script.
   */
  static fromBytes(script) {
    if (!script || script.length === 0) {
      throw new Error("missing OP_RETURN");
    }
    let decoded;
    try {
      decoded = Script.decode(script);
    } catch {
      throw new Error("expected OP_RETURN");
    }
    if (decoded.length === 0 || decoded[0] !== "RETURN") {
      throw new Error("expected OP_RETURN");
    }
    const dataPushes = decoded.slice(1).filter((x) => x instanceof Uint8Array);
    if (dataPushes.length === 0) {
      throw new Error("missing magic prefix: EOF");
    }
    const payload = new Uint8Array(dataPushes.reduce((acc, d) => acc + d.length, 0));
    let offset = 0;
    for (const d of dataPushes) {
      payload.set(d, offset);
      offset += d.length;
    }
    if (payload.length < ARKADE_MAGIC.length || !equalBytes$1(payload.slice(0, ARKADE_MAGIC.length), ARKADE_MAGIC)) {
      throw new Error(
        `expected magic prefix ${hex.encode(ARKADE_MAGIC)}, got ${hex.encode(payload.slice(0, Math.min(payload.length, ARKADE_MAGIC.length)))}`
      );
    }
    const reader = new BufferReader(payload.slice(ARKADE_MAGIC.length));
    const packets = [];
    while (reader.remaining() > 0) {
      const packetType = reader.readByte();
      let data;
      try {
        data = reader.readVarSlice();
      } catch {
        throw new Error("missing packet data");
      }
      packets.push(parsePacket(packetType, data));
    }
    if (packets.length === 0) {
      throw new Error("missing packets");
    }
    const seen = /* @__PURE__ */ new Set();
    for (const p of packets) {
      if (seen.has(p.type())) {
        throw new Error(`duplicate packet type ${p.type()}`);
      }
      seen.add(p.type());
    }
    return new _Extension(packets);
  }
  /**
   * fromTx searches the transaction outputs for an extension blob and parses it.
   * Throws ExtensionNotFoundError if none is found.
   */
  static fromTx(tx) {
    for (let i = 0; i < tx.outputsLength; i++) {
      const output = tx.getOutput(i);
      if (!output?.script) continue;
      if (_Extension.isExtension(output.script)) {
        return _Extension.fromBytes(output.script);
      }
    }
    throw new ExtensionNotFoundError();
  }
  /**
   * serialize encodes the extension as an OP_RETURN script.
   *
   * Layout: OP_RETURN | <push> | ARK | [type | varint_len | data]...
   */
  serialize() {
    const parts = [ARKADE_MAGIC];
    for (const p of this.packets) {
      const data = p.serialize();
      const typeByte = new Uint8Array([p.type()]);
      const lengthBuf = encodeVarUint(data.length);
      parts.push(typeByte, lengthBuf, data);
    }
    const totalLen = parts.reduce((acc, p) => acc + p.length, 0);
    const payload = new Uint8Array(totalLen);
    let off = 0;
    for (const p of parts) {
      payload.set(p, off);
      off += p.length;
    }
    return buildOpReturnScript(payload);
  }
  /**
   * txOut returns the extension as a zero-value OP_RETURN transaction output.
   */
  txOut() {
    return {
      script: this.serialize(),
      amount: 0n
    };
  }
  /**
   * getAssetPacket returns the embedded Packet, or null if not present.
   */
  getAssetPacket() {
    for (const p of this.packets) {
      if (p instanceof Packet) {
        return p;
      }
    }
    return null;
  }
  /**
   * getEmulatorPacket returns the embedded EmulatorPacket, or null if not present.
   */
  getEmulatorPacket() {
    for (const p of this.packets) {
      if (p instanceof EmulatorPacket) {
        return p;
      }
    }
    return null;
  }
  /**
   * getPacketByType returns the first packet matching the given type tag, or null.
   */
  getPacketByType(packetType) {
    for (const p of this.packets) {
      if (p.type() === packetType) {
        return p;
      }
    }
    return null;
  }
  /**
   * Returns all embedded packets in insertion order. Used when callers need
   * to rebuild an Extension from an existing one (e.g. appending a new packet).
   */
  getPackets() {
    return this.packets;
  }
};
function parsePacket(packetType, data) {
  switch (packetType) {
    case Packet.PACKET_TYPE:
      return Packet.fromBytes(data);
    case EmulatorPacket.PACKET_TYPE:
      return EmulatorPacket.fromBytes(data);
    default:
      return new UnknownPacket(packetType, data);
  }
}
function encodeVarUint(value) {
  const bytes = [];
  let remaining = value;
  do {
    let byte = remaining & 127;
    remaining >>>= 7;
    if (remaining > 0) byte |= 128;
    bytes.push(byte);
  } while (remaining > 0);
  return new Uint8Array(bytes);
}
function buildOpReturnScript(data) {
  const n = data.length;
  let script;
  if (n <= 75) {
    script = new Uint8Array(2 + n);
    script[0] = 106;
    script[1] = n;
    script.set(data, 2);
  } else if (n <= 255) {
    script = new Uint8Array(3 + n);
    script[0] = 106;
    script[1] = 76;
    script[2] = n;
    script.set(data, 3);
  } else if (n <= 65535) {
    script = new Uint8Array(4 + n);
    script[0] = 106;
    script[1] = 77;
    new DataView(script.buffer).setUint16(2, n, true);
    script.set(data, 4);
  } else {
    script = new Uint8Array(6 + n);
    script[0] = 106;
    script[1] = 78;
    new DataView(script.buffer).setUint32(2, n, true);
    script.set(data, 6);
  }
  return script;
}
var ErrOffchainOutputNotFound = (address) => new Error(`offchain send output not found: ${address}`);
var ErrInvalidAssetOutputAmount = (got, want, assetId) => new Error(`invalid asset output amount for ${assetId}: got ${got}, want ${want}`);
var ErrAssetGroupNotFound = (assetId) => new Error(`asset group not found in batch leaf: ${assetId}`);
var ErrAssetOutputNotFound = (assetId, outputIndex) => new Error(`asset output not found in asset group ${assetId} at index ${outputIndex}`);
var ErrInvalidOnchainOutputAmount = (address) => new Error(`invalid onchain output amount: ${address}`);
var ErrInvalidOnchainOutputAssets = (address) => new Error(`onchain output ${address} cannot have assets`);
var ErrOnchainOutputNotFound = (address) => new Error(`onchain output not found: ${address}`);
var ErrInvalidOffchainOutputAmount = (address) => new Error(`invalid offchain output ${address}, missing amount`);
function validateBatchRecipients(commitmentTx, vtxoTreeLeaves, recipients, network) {
  const usedOutputs = /* @__PURE__ */ new Set();
  const usedOnchainOutputs = /* @__PURE__ */ new Set();
  for (const recipient of recipients) {
    let arkAddress;
    try {
      arkAddress = ArkAddress.decode(recipient.address);
    } catch {
      validateOnchainRecipient(commitmentTx, recipient, network, usedOnchainOutputs);
      continue;
    }
    validateOffchainRecipient(vtxoTreeLeaves, arkAddress, recipient, usedOutputs);
  }
}
function validateOnchainRecipient(commitmentTx, recipient, network, usedOutputs) {
  const addr = Address(network).decode(recipient.address);
  const expectedPkScript = OutScript.encode(addr);
  if (!recipient.amount) {
    throw ErrInvalidOnchainOutputAmount(recipient.address);
  }
  if (recipient.assets && recipient.assets.length > 0) {
    throw ErrInvalidOnchainOutputAssets(recipient.address);
  }
  for (let i = 0; i < commitmentTx.outputsLength; i++) {
    if (usedOutputs.has(i)) {
      continue;
    }
    const output = commitmentTx.getOutput(i);
    if (!output?.script || output.script.length === 0) {
      continue;
    }
    if (equalBytes$1(output.script, expectedPkScript)) {
      if (output.amount !== BigInt(recipient.amount)) {
        continue;
      }
      usedOutputs.add(i);
      return;
    }
  }
  throw ErrOnchainOutputNotFound(recipient.address);
}
function validateOffchainRecipient(leaves, arkAddress, recipient, usedOutputs) {
  const expectedPkScript = arkAddress.pkScript;
  if (!recipient.amount) {
    throw ErrInvalidOffchainOutputAmount(recipient.address);
  }
  const expectedAmount = BigInt(recipient.amount);
  let found = false;
  for (let leafIdx = 0; leafIdx < leaves.length; leafIdx++) {
    const leaf = leaves[leafIdx];
    for (let outputIndex = 0; outputIndex < leaf.outputsLength; outputIndex++) {
      const output = leaf.getOutput(outputIndex);
      if (!output?.script || output.script.length === 0) {
        continue;
      }
      if (!equalBytes$1(output.script, expectedPkScript)) {
        continue;
      }
      if (output.amount !== expectedAmount) {
        continue;
      }
      const key = `${leafIdx}:${outputIndex}`;
      if (usedOutputs.has(key)) {
        continue;
      }
      usedOutputs.add(key);
      found = true;
      if (recipient.assets && recipient.assets.length > 0) {
        validateAssetOutputs(leaf, outputIndex, recipient.assets);
      }
      break;
    }
    if (found) {
      break;
    }
  }
  if (!found) {
    throw ErrOffchainOutputNotFound(recipient.address);
  }
}
function validateAssetOutputs(leafTx, outputIndex, expectedAssets) {
  const ext = Extension.fromTx(leafTx);
  const assetPacket = ext.getAssetPacket();
  if (!assetPacket) {
    throw new Error("no asset packet found in extension");
  }
  for (const { assetId, amount } of expectedAssets) {
    validateAssetGroupOutput(assetPacket, outputIndex, assetId, amount);
  }
}
function validateAssetGroupOutput(packet, outputIndex, assetId, expectedAmount) {
  const assetGroup = packet.groups.find((group) => {
    if (group.isIssuance()) return false;
    return group.assetId.toString() === assetId;
  });
  if (!assetGroup) {
    throw ErrAssetGroupNotFound(assetId);
  }
  const assetOutput = assetGroup.outputs.find((output) => output.vout === outputIndex);
  if (!assetOutput) {
    throw ErrAssetOutputNotFound(assetId, outputIndex);
  }
  if (assetOutput.amount !== expectedAmount) {
    throw ErrInvalidAssetOutputAmount(assetOutput.amount, expectedAmount, assetId);
  }
}

// src/wallet/index.ts
var TxType = /* @__PURE__ */ ((TxType2) => {
  TxType2["TxSent"] = "SENT";
  TxType2["TxReceived"] = "RECEIVED";
  return TxType2;
})(TxType || {});
function isSpendable(vtxo) {
  return !vtxo.isSpent;
}
function isRecoverable(vtxo) {
  return vtxo.virtualStatus.state === "swept" && isSpendable(vtxo);
}
function isExpired(vtxo) {
  if (vtxo.virtualStatus.state === "swept") return true;
  const expiry = vtxo.virtualStatus.batchExpiry;
  if (!expiry) return false;
  const expireAt = new Date(expiry);
  if (expireAt.getFullYear() < 2025) return false;
  return expiry <= Date.now();
}
function isSubdust(vtxo, dust) {
  return vtxo.value < dust;
}

// src/wallet/asset.ts
function createAssetPacket(assetInputs, receivers, changeReceiver) {
  const inputsByAssetId = /* @__PURE__ */ new Map();
  for (const [inputIndex, assets] of assetInputs) {
    for (const asset of assets) {
      const existing = inputsByAssetId.get(asset.assetId);
      inputsByAssetId.set(asset.assetId, [
        ...existing ?? [],
        AssetInput.create(inputIndex, asset.amount)
      ]);
    }
  }
  const outputsByAssetId = /* @__PURE__ */ new Map();
  let outputIndex = 0;
  for (const receiver of receivers) {
    if (receiver.assets) {
      for (const asset of receiver.assets) {
        const existing = outputsByAssetId.get(asset.assetId);
        outputsByAssetId.set(asset.assetId, [
          ...existing ?? [],
          AssetOutput.create(outputIndex, asset.amount)
        ]);
      }
    }
    outputIndex++;
  }
  if (changeReceiver?.assets) {
    for (const asset of changeReceiver.assets) {
      const existing = outputsByAssetId.get(asset.assetId);
      outputsByAssetId.set(asset.assetId, [
        ...existing ?? [],
        AssetOutput.create(outputIndex, asset.amount)
      ]);
    }
  }
  const groups = [];
  const allAssetIds = /* @__PURE__ */ new Set([...inputsByAssetId.keys(), ...outputsByAssetId.keys()]);
  for (const assetIdStr of allAssetIds) {
    const inputs = inputsByAssetId.get(assetIdStr);
    const outputs = outputsByAssetId.get(assetIdStr);
    const assetId = AssetId.fromString(assetIdStr);
    const group = AssetGroup.create(assetId, null, inputs ?? [], outputs ?? [], []);
    groups.push(group);
  }
  return Packet.create(groups);
}
function selectCoinsWithAsset(coins, assetId, requiredAmount) {
  const coinsWithAsset = coins.filter((coin) => coin.assets?.some((a) => a.assetId === assetId));
  coinsWithAsset.sort((a, b) => {
    const amountA = a.assets?.find((asset) => asset.assetId === assetId)?.amount ?? 0n;
    const amountB = b.assets?.find((asset) => asset.assetId === assetId)?.amount ?? 0n;
    return amountA < amountB ? -1 : amountA > amountB ? 1 : 0;
  });
  const selected = [];
  let totalAssetAmount = 0n;
  for (const coin of coinsWithAsset) {
    if (totalAssetAmount >= requiredAmount) break;
    selected.push(coin);
    const assetAmount = coin.assets?.find((a) => a.assetId === assetId)?.amount ?? 0n;
    totalAssetAmount += assetAmount;
  }
  if (totalAssetAmount < requiredAmount) {
    throw new Error(
      `Insufficient asset balance: have ${totalAssetAmount}, need ${requiredAmount}`
    );
  }
  return { selected, totalAssetAmount };
}
function selectedCoinsToAssetInputs(selectedCoins) {
  const assetInputs = /* @__PURE__ */ new Map();
  for (let inputIndex = 0; inputIndex < selectedCoins.length; inputIndex++) {
    const coin = selectedCoins[inputIndex];
    if (!coin.assets || coin.assets.length === 0) {
      continue;
    }
    assetInputs.set(inputIndex, coin.assets);
  }
  return assetInputs;
}
function buildOffchainTx(inputs, outputs, serverUnrollScript) {
  const MAX_OP_RETURN = 2;
  let countOpReturn = 0;
  let hasExtensionOutput = false;
  for (const [index, output] of outputs.entries()) {
    if (!output.script) throw new Error(`missing output script ${index}`);
    const isExtension = Extension.isExtension(output.script);
    const isOpReturn = isExtension || Script.decode(output.script)[0] === "RETURN";
    if (isOpReturn) {
      countOpReturn++;
    }
    if (!isExtension) continue;
    if (hasExtensionOutput) throw new Error("multiple extension outputs");
    hasExtensionOutput = true;
  }
  if (countOpReturn > MAX_OP_RETURN) {
    throw new Error(`too many OP_RETURN outputs: ${countOpReturn} > ${MAX_OP_RETURN}`);
  }
  const checkpoints = inputs.map((input) => buildCheckpointTx(input, serverUnrollScript));
  const arkTx = buildVirtualTx(
    checkpoints.map((c) => c.input),
    outputs
  );
  return {
    arkTx,
    checkpoints: checkpoints.map((c) => c.tx)
  };
}
function buildVirtualTx(inputs, outputs) {
  let lockTime = 0n;
  for (const input of inputs) {
    const tapscript = decodeTapscript(scriptFromTapLeafScript(input.tapLeafScript));
    if (CLTVMultisigTapscript.is(tapscript)) {
      if (lockTime !== 0n) {
        if (isSeconds(lockTime) !== isSeconds(tapscript.params.absoluteTimelock)) {
          throw new Error("cannot mix seconds and blocks locktime");
        }
      }
      if (tapscript.params.absoluteTimelock > lockTime) {
        lockTime = tapscript.params.absoluteTimelock;
      }
    }
  }
  const tx = new Transaction({
    version: 3,
    lockTime: Number(lockTime)
  });
  for (const [i, input] of inputs.entries()) {
    tx.addInput({
      txid: input.txid,
      index: input.vout,
      sequence: lockTime ? DEFAULT_SEQUENCE - 1 : void 0,
      witnessUtxo: {
        script: VtxoScript.decode(input.tapTree).pkScript,
        amount: BigInt(input.value)
      },
      tapLeafScript: [input.tapLeafScript]
    });
    setArkPsbtField(tx, i, VtxoTaprootTree, input.tapTree);
  }
  for (const output of outputs) {
    tx.addOutput(output);
  }
  tx.addOutput(P2A);
  return tx;
}
function buildCheckpointTx(vtxo, serverUnrollScript) {
  const collaborativeClosure = decodeTapscript(scriptFromTapLeafScript(vtxo.tapLeafScript));
  const checkpointVtxoScript = new VtxoScript([
    serverUnrollScript.script,
    collaborativeClosure.script
  ]);
  const checkpointTx = buildVirtualTx(
    [vtxo],
    [
      {
        amount: BigInt(vtxo.value),
        script: checkpointVtxoScript.pkScript
      }
    ]
  );
  const collaborativeLeafProof = checkpointVtxoScript.findLeaf(
    hex.encode(collaborativeClosure.script)
  );
  const checkpointInput = {
    txid: checkpointTx.id,
    vout: 0,
    value: vtxo.value,
    tapLeafScript: collaborativeLeafProof,
    tapTree: checkpointVtxoScript.encode()
  };
  return {
    tx: checkpointTx,
    input: checkpointInput
  };
}
var nLocktimeMinSeconds = 500000000n;
function isSeconds(locktime) {
  return locktime >= nLocktimeMinSeconds;
}
function hasBoardingTxExpired(coin, boardingTimelock, chainTipHeight) {
  if (!coin.status.block_time) return false;
  if (boardingTimelock.value === 0n) return true;
  if (boardingTimelock.type === "blocks") {
    if (chainTipHeight === void 0 || !coin.status.block_height) return false;
    return BigInt(chainTipHeight - coin.status.block_height) >= boardingTimelock.value;
  }
  const now = BigInt(Math.floor(Date.now() / 1e3));
  const blockTime = BigInt(Math.floor(coin.status.block_time));
  return blockTime + boardingTimelock.value <= now;
}
function formatSighash(type) {
  return `0x${type.toString(16).padStart(2, "0")}`;
}
function verifyTapscriptSignatures(tx, inputIndex, requiredSigners, excludePubkeys = [], allowedSighashTypes = [SigHash.DEFAULT]) {
  const input = tx.getInput(inputIndex);
  const prevoutScripts = [];
  const prevoutAmounts = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    if (!inp.witnessUtxo) {
      throw new Error(`Input ${i} is missing witnessUtxo`);
    }
    prevoutScripts.push(inp.witnessUtxo.script);
    prevoutAmounts.push(inp.witnessUtxo.amount);
  }
  if (!input.tapScriptSig || input.tapScriptSig.length === 0) {
    throw new Error(`Input ${inputIndex} is missing tapScriptSig`);
  }
  for (const [tapScriptSigData, signature] of input.tapScriptSig) {
    const pubKey = tapScriptSigData.pubKey;
    const pubKeyHex = hex.encode(pubKey);
    if (excludePubkeys.includes(pubKeyHex)) {
      continue;
    }
    const sighashType = signature.length === 65 ? signature[64] : SigHash.DEFAULT;
    const sig = signature.subarray(0, 64);
    if (!allowedSighashTypes.includes(sighashType)) {
      const sighashName = formatSighash(sighashType);
      throw new Error(
        `Unallowed sighash type ${sighashName} for input ${inputIndex}, pubkey ${pubKeyHex}.`
      );
    }
    if (!input.tapLeafScript || input.tapLeafScript.length === 0) {
      throw new Error();
    }
    const leafHash = tapScriptSigData.leafHash;
    const leafHashHex = hex.encode(leafHash);
    let matchingScript;
    let matchingVersion;
    for (const [_, scriptWithVersion] of input.tapLeafScript) {
      const script = scriptWithVersion.subarray(0, -1);
      const version = scriptWithVersion[scriptWithVersion.length - 1];
      const computedLeafHash = tapLeafHash(script, version);
      const computedHex = hex.encode(computedLeafHash);
      if (computedHex === leafHashHex) {
        matchingScript = script;
        matchingVersion = version;
        break;
      }
    }
    if (!matchingScript || matchingVersion === void 0) {
      throw new Error(
        `Input ${inputIndex}: No tapLeafScript found matching leafHash ${hex.encode(leafHash)}`
      );
    }
    const message = tx.preimageWitnessV1(
      inputIndex,
      prevoutScripts,
      sighashType,
      prevoutAmounts,
      void 0,
      matchingScript,
      matchingVersion
    );
    const isValid = schnorr.verify(sig, message, pubKey);
    if (!isValid) {
      throw new Error(`Invalid signature for input ${inputIndex}, pubkey ${pubKeyHex}`);
    }
  }
  const signedPubkeys = input.tapScriptSig.map(([data]) => hex.encode(data.pubKey));
  const requiredNotExcluded = requiredSigners.filter((pk) => !excludePubkeys.includes(pk));
  const missingSigners = requiredNotExcluded.filter((pk) => !signedPubkeys.includes(pk));
  if (missingSigners.length > 0) {
    throw new Error(
      `Missing signatures from: ${missingSigners.map((pk) => pk.slice(0, 16)).join(", ")}...`
    );
  }
}
function combineTapscriptSigs(signedTx, originalTx) {
  if (signedTx.inputsLength !== originalTx.inputsLength) {
    throw new Error(
      `combineTapscriptSigs: input count mismatch (signedTx ${signedTx.inputsLength}, originalTx ${originalTx.inputsLength})`
    );
  }
  for (let i = 0; i < signedTx.inputsLength; i++) {
    const input = originalTx.getInput(i);
    const signedInput = signedTx.getInput(i);
    if (!input.tapScriptSig) {
      throw new Error(`combineTapscriptSigs: originalTx input ${i} has no tapScriptSig`);
    }
    if (!signedInput.tapScriptSig) {
      throw new Error(`combineTapscriptSigs: signedTx input ${i} has no tapScriptSig`);
    }
    originalTx.updateInput(i, {
      tapScriptSig: input.tapScriptSig.concat(signedInput.tapScriptSig)
    });
  }
  return originalTx;
}
function isValidArkAddress(address) {
  try {
    ArkAddress.decode(address);
    return true;
  } catch (e) {
    return false;
  }
}
var getVarIntSize = (n) => {
  if (n < 253) return 1;
  if (n <= 65535) return 3;
  if (n <= 4294967295) return 5;
  return 9;
};
var TxWeightEstimator = class _TxWeightEstimator {
  static P2PKH_SCRIPT_SIG_SIZE = 1 + 73 + 1 + 33;
  static INPUT_SIZE = 32 + 4 + 1 + 4;
  static BASE_CONTROL_BLOCK_SIZE = 1 + 32;
  static OUTPUT_SIZE = 8 + 1;
  static P2WPKH_OUTPUT_SIZE = 1 + 1 + 20;
  static BASE_TX_SIZE = 8 + 2;
  // Version + LockTime
  static WITNESS_HEADER_SIZE = 2;
  // Flag + Marker
  static WITNESS_SCALE_FACTOR = 4;
  static P2TR_OUTPUT_SIZE = 1 + 1 + 32;
  hasWitness;
  inputCount;
  outputCount;
  inputSize;
  inputWitnessSize;
  outputSize;
  constructor(hasWitness, inputCount, outputCount, inputSize, inputWitnessSize, outputSize) {
    this.hasWitness = hasWitness;
    this.inputCount = inputCount;
    this.outputCount = outputCount;
    this.inputSize = inputSize;
    this.inputWitnessSize = inputWitnessSize;
    this.outputSize = outputSize;
  }
  static create() {
    return new _TxWeightEstimator(false, 0, 0, 0, 0, 0);
  }
  addP2AInput() {
    this.inputCount++;
    this.inputSize += _TxWeightEstimator.INPUT_SIZE;
    return this;
  }
  addKeySpendInput(isDefault = true) {
    this.inputCount++;
    this.inputWitnessSize += 64 + 1 + (isDefault ? 0 : 1);
    this.inputSize += _TxWeightEstimator.INPUT_SIZE;
    this.hasWitness = true;
    return this;
  }
  addP2PKHInput() {
    this.inputCount++;
    this.inputWitnessSize++;
    this.inputSize += _TxWeightEstimator.INPUT_SIZE + _TxWeightEstimator.P2PKH_SCRIPT_SIG_SIZE;
    return this;
  }
  addTapscriptInput(leafWitnessSize, leafScriptSize, leafControlBlockSize) {
    const controlBlockWitnessSize = 1 + _TxWeightEstimator.BASE_CONTROL_BLOCK_SIZE + 1 + leafScriptSize + 1 + leafControlBlockSize;
    this.inputCount++;
    this.inputWitnessSize += leafWitnessSize + 1 + controlBlockWitnessSize;
    this.inputSize += _TxWeightEstimator.INPUT_SIZE;
    this.hasWitness = true;
    return this;
  }
  addP2WPKHOutput() {
    this.outputCount++;
    this.outputSize += _TxWeightEstimator.OUTPUT_SIZE + _TxWeightEstimator.P2WPKH_OUTPUT_SIZE;
    return this;
  }
  addP2TROutput() {
    this.outputCount++;
    this.outputSize += _TxWeightEstimator.OUTPUT_SIZE + _TxWeightEstimator.P2TR_OUTPUT_SIZE;
    return this;
  }
  /**
   * Adds an output given a raw script.
   * Cost = 8 bytes (amount) + varint(scriptLen) + scriptLen
   */
  addOutputScript(script) {
    this.outputCount++;
    this.outputSize += 8 + getVarIntSize(script.length) + script.length;
    return this;
  }
  /**
   * Adds an output by decoding the address to get the exact script size.
   */
  addOutputAddress(address, network) {
    const payment = Address(network).decode(address);
    const script = OutScript.encode(payment);
    return this.addOutputScript(script);
  }
  vsize() {
    const inputCount = getVarIntSize(this.inputCount);
    const outputCount = getVarIntSize(this.outputCount);
    const txSizeStripped = _TxWeightEstimator.BASE_TX_SIZE + inputCount + this.inputSize + outputCount + this.outputSize;
    let weight = txSizeStripped * _TxWeightEstimator.WITNESS_SCALE_FACTOR;
    if (this.hasWitness) {
      weight += _TxWeightEstimator.WITNESS_HEADER_SIZE + this.inputWitnessSize;
    }
    return vsize(weight);
  }
};
var vsize = (weight) => {
  const value = BigInt(Math.ceil(weight / TxWeightEstimator.WITNESS_SCALE_FACTOR));
  return {
    value,
    fee: (feeRate) => feeRate * value
  };
};
var AmountVariableName = "amount";
var ExpiryVariableName = "expiry";
var BirthVariableName = "birth";
var WeightVariableName = "weight";
var InputTypeVariableName = "inputType";
var OutputScriptVariableName = "script";
var nowFunction = {
  signature: "now(): double",
  implementation: () => Math.floor(Date.now() / 1e3)
};
var IntentOutputEnv = new Environment().registerVariable(AmountVariableName, "double").registerVariable(OutputScriptVariableName, "string").registerFunction(nowFunction.signature, nowFunction.implementation);
var IntentOffchainInputEnv = new Environment().registerVariable(AmountVariableName, "double").registerVariable(ExpiryVariableName, "double").registerVariable(BirthVariableName, "double").registerVariable(WeightVariableName, "double").registerVariable(InputTypeVariableName, "string").registerFunction(nowFunction.signature, nowFunction.implementation);
var IntentOnchainInputEnv = new Environment().registerVariable(AmountVariableName, "double").registerFunction(nowFunction.signature, nowFunction.implementation);

// src/arkfee/types.ts
var FeeAmount = class _FeeAmount {
  constructor(value) {
    this.value = value;
  }
  static ZERO = new _FeeAmount(0);
  /** Returns the fee amount rounded up to whole satoshis. */
  get satoshis() {
    return this.value ? Math.ceil(this.value) : 0;
  }
  /** Add two fee amounts together. */
  add(other) {
    return new _FeeAmount(this.value + other.value);
  }
};

// src/arkfee/estimator.ts
var Estimator = class {
  /**
   * Creates a new Estimator with the given config
   * @param config - Configuration containing CEL programs for fee calculation
   */
  constructor(config) {
    this.config = config;
    this.intentOffchainInput = config.offchainInput ? parseProgram(config.offchainInput, IntentOffchainInputEnv) : void 0;
    this.intentOnchainInput = config.onchainInput ? parseProgram(config.onchainInput, IntentOnchainInputEnv) : void 0;
    this.intentOffchainOutput = config.offchainOutput ? parseProgram(config.offchainOutput, IntentOutputEnv) : void 0;
    this.intentOnchainOutput = config.onchainOutput ? parseProgram(config.onchainOutput, IntentOutputEnv) : void 0;
  }
  intentOffchainInput;
  intentOnchainInput;
  intentOffchainOutput;
  intentOnchainOutput;
  /**
   * Evaluates the fee for a given vtxo input
   * @param input - The offchain input to evaluate
   * @returns The fee amount for this input
   */
  evalOffchainInput(input) {
    if (!this.intentOffchainInput) {
      return FeeAmount.ZERO;
    }
    const args = inputToArgs(input);
    return new FeeAmount(this.intentOffchainInput.program(args));
  }
  /**
   * Evaluates the fee for a given boarding input
   * @param input - The onchain input to evaluate
   * @returns The fee amount for this input
   */
  evalOnchainInput(input) {
    if (!this.intentOnchainInput) {
      return FeeAmount.ZERO;
    }
    const args = {
      amount: Number(input.amount)
    };
    return new FeeAmount(this.intentOnchainInput.program(args));
  }
  /**
   * Evaluates the fee for a given vtxo output
   * @param output - The output to evaluate
   * @returns The fee amount for this output
   */
  evalOffchainOutput(output) {
    if (!this.intentOffchainOutput) {
      return FeeAmount.ZERO;
    }
    const args = outputToArgs(output);
    return new FeeAmount(this.intentOffchainOutput.program(args));
  }
  /**
   * Evaluates the fee for a given collaborative exit output
   * @param output - The output to evaluate
   * @returns The fee amount for this output
   */
  evalOnchainOutput(output) {
    if (!this.intentOnchainOutput) {
      return FeeAmount.ZERO;
    }
    const args = outputToArgs(output);
    return new FeeAmount(this.intentOnchainOutput.program(args));
  }
  /**
   * Evaluates the fee for a given set of inputs and outputs
   * @param offchainInputs - Array of offchain inputs to evaluate
   * @param onchainInputs - Array of onchain inputs to evaluate
   * @param offchainOutputs - Array of offchain outputs to evaluate
   * @param onchainOutputs - Array of onchain outputs to evaluate
   * @returns The total fee amount
   */
  eval(offchainInputs, onchainInputs, offchainOutputs, onchainOutputs) {
    let fee = FeeAmount.ZERO;
    for (const input of offchainInputs) {
      fee = fee.add(this.evalOffchainInput(input));
    }
    for (const input of onchainInputs) {
      fee = fee.add(this.evalOnchainInput(input));
    }
    for (const output of offchainOutputs) {
      fee = fee.add(this.evalOffchainOutput(output));
    }
    for (const output of onchainOutputs) {
      fee = fee.add(this.evalOnchainOutput(output));
    }
    return fee;
  }
};
function inputToArgs(input) {
  const args = {
    amount: Number(input.amount),
    inputType: input.type,
    weight: input.weight
  };
  if (input.expiry) {
    args.expiry = Math.floor(input.expiry.getTime() / 1e3);
  }
  if (input.birth) {
    args.birth = Math.floor(input.birth.getTime() / 1e3);
  }
  return args;
}
function outputToArgs(output) {
  return {
    amount: Number(output.amount),
    script: output.script
  };
}
function parseProgram(text, env) {
  const program = env.parse(text);
  const checkResult = program.check();
  if (!checkResult.valid) {
    throw new Error(`type check failed: ${checkResult.error?.message ?? "unknown error"}`);
  }
  if (checkResult.type !== "double") {
    throw new Error(`expected return type double, got ${checkResult.type}`);
  }
  return { program, text };
}
var DUST_AMOUNT = 546;
var FALLBACK_WALLET_DUST_AMOUNT = 330n;
function getDustAmount(wallet) {
  return "dustAmount" in wallet ? wallet.dustAmount : FALLBACK_WALLET_DUST_AMOUNT;
}
function extendCoin(wallet, utxo) {
  return {
    ...utxo,
    forfeitTapLeafScript: wallet.boardingTapscript.forfeit(),
    intentTapLeafScript: wallet.boardingTapscript.forfeit(),
    tapTree: wallet.boardingTapscript.encode()
  };
}
function deriveContractTapscripts(contract) {
  const handler = contractHandlers.get(contract.type);
  if (!handler) {
    throw new Error(`No handler for contract type '${contract.type}'`);
  }
  const script = handler.createScript(contract.params);
  return {
    forfeitTapLeafScript: script.forfeit(),
    intentTapLeafScript: script.forfeit(),
    tapTree: script.encode()
  };
}
function cloneTapLeafScript([
  controlBlock,
  script
]) {
  return [
    {
      version: controlBlock.version,
      internalKey: new Uint8Array(controlBlock.internalKey),
      merklePath: controlBlock.merklePath.map((hash) => new Uint8Array(hash))
    },
    new Uint8Array(script)
  ];
}
function cloneContractTapscripts(tapscripts) {
  return {
    forfeitTapLeafScript: cloneTapLeafScript(tapscripts.forfeitTapLeafScript),
    intentTapLeafScript: cloneTapLeafScript(tapscripts.intentTapLeafScript),
    tapTree: new Uint8Array(tapscripts.tapTree)
  };
}
function extendVtxoFromContract(vtxo, contract, cache) {
  if (!cache) {
    return { ...vtxo, ...deriveContractTapscripts(contract) };
  }
  let tapscripts = cache.get(contract.script);
  if (!tapscripts) {
    tapscripts = deriveContractTapscripts(contract);
    cache.set(contract.script, tapscripts);
  }
  return { ...vtxo, ...cloneContractTapscripts(tapscripts) };
}
function extendVirtualCoinForContract(vtxo, contractOrMap, cache) {
  const contract = resolveContract(vtxo, contractOrMap);
  if (!contract) {
    throw new Error(
      "extendVirtualCoinForContract: no contract matched vtxo.script \u2014 callers must resolve the owning contract before annotating"
    );
  }
  return extendVtxoFromContract(vtxo, contract, cache);
}
function isContractMap(value) {
  return typeof value.get === "function";
}
function resolveContract(vtxo, contractOrMap) {
  if (!contractOrMap) return void 0;
  if (isContractMap(contractOrMap)) {
    return contractOrMap.get(vtxo.script);
  }
  return contractOrMap;
}
function getRandomId() {
  const randomValue = crypto.getRandomValues(new Uint8Array(16));
  return hex.encode(randomValue);
}
function validateRecipients(recipients, dustAmount) {
  const validatedRecipients = [];
  for (const recipient of recipients) {
    let address;
    try {
      address = ArkAddress.decode(recipient.address);
    } catch (e) {
      throw new Error(`Invalid Arkade address: ${recipient.address}`);
    }
    const amount = recipient.amount || dustAmount;
    if (amount <= 0) {
      throw new Error("Amount must be positive");
    }
    validatedRecipients.push({
      address: recipient.address,
      assets: recipient.assets ?? [],
      amount,
      script: amount < dustAmount ? address.subdustPkScript : address.pkScript
    });
  }
  return validatedRecipients;
}

// src/wallet/vtxo-manager.ts
function isSweepCapable(wallet) {
  return "boardingTapscript" in wallet && "onchainProvider" in wallet && "arkProvider" in wallet && "network" in wallet;
}
function assertSweepCapable(wallet) {
  if (!isSweepCapable(wallet)) {
    throw new Error(
      "Boarding UTXO sweep requires a Wallet instance with boardingTapscript, onchainProvider, arkProvider, and network"
    );
  }
}
var BOARDING_POLL_LOCK_NAME = "arkade-boarding-poll";
async function runWithCrossInstanceLock(name, fn) {
  const locks = typeof globalThis !== "undefined" && typeof globalThis.navigator !== "undefined" ? globalThis.navigator.locks : void 0;
  if (!locks) {
    await fn();
    return;
  }
  await locks.request(name, { ifAvailable: true, mode: "exclusive" }, async (lock) => {
    if (lock === null) return;
    await fn();
  });
}
var DEFAULT_THRESHOLD_SECONDS = 259200;
var DEFAULT_THRESHOLD_MS = DEFAULT_THRESHOLD_SECONDS * 1e3;
var DEFAULT_RENEWAL_CONFIG = {
  thresholdMs: DEFAULT_THRESHOLD_MS
  // 3 days
};
var DEFAULT_SETTLEMENT_CONFIG = {
  vtxoThreshold: DEFAULT_THRESHOLD_SECONDS,
  boardingUtxoSweep: true,
  pollIntervalMs: 6e4
};
function getRecoverableVtxos(vtxos, dustAmount) {
  return vtxos.filter((vtxo) => {
    if (isRecoverable(vtxo)) {
      return true;
    }
    if (isSpendable(vtxo) && isExpired(vtxo)) {
      return true;
    }
    if (vtxo.virtualStatus.state === "preconfirmed" && isSubdust(vtxo, dustAmount)) {
      return true;
    }
    return false;
  });
}
function getRecoverableWithSubdust(vtxos, dustAmount) {
  const recoverableVtxos = getRecoverableVtxos(vtxos, dustAmount);
  const subdust = [];
  const regular = [];
  for (const vtxo of recoverableVtxos) {
    if (isSubdust(vtxo, dustAmount)) {
      subdust.push(vtxo);
    } else {
      regular.push(vtxo);
    }
  }
  const regularTotal = regular.reduce((sum, vtxo) => sum + BigInt(vtxo.value), 0n);
  const subdustTotal = subdust.reduce((sum, vtxo) => sum + BigInt(vtxo.value), 0n);
  const combinedTotal = regularTotal + subdustTotal;
  const shouldIncludeSubdust = combinedTotal >= dustAmount;
  const vtxosToRecover = shouldIncludeSubdust ? recoverableVtxos : regular;
  const totalAmount = vtxosToRecover.reduce((sum, vtxo) => sum + BigInt(vtxo.value), 0n);
  return {
    vtxosToRecover,
    includesSubdust: shouldIncludeSubdust,
    totalAmount
  };
}
function isVtxoExpiringSoon(vtxo, thresholdMs) {
  const realThresholdMs = thresholdMs <= 100 ? DEFAULT_THRESHOLD_MS : thresholdMs;
  const { batchExpiry } = vtxo.virtualStatus;
  if (!batchExpiry) return false;
  const expireAt = new Date(batchExpiry);
  if (expireAt.getFullYear() < 2025) return false;
  const now = Date.now();
  if (batchExpiry <= now) return false;
  return batchExpiry - now <= realThresholdMs;
}
function getExpiringAndRecoverableVtxos(vtxos, thresholdMs, dustAmount) {
  return vtxos.filter(
    (vtxo) => isVtxoExpiringSoon(vtxo, thresholdMs) || isRecoverable(vtxo) || isSpendable(vtxo) && isExpired(vtxo) || isSubdust(vtxo, dustAmount)
  );
}
var VtxoManager = class _VtxoManager {
  constructor(wallet, renewalConfig, settlementConfig) {
    this.wallet = wallet;
    this.renewalConfig = renewalConfig;
    if (settlementConfig !== void 0) {
      this.settlementConfig = settlementConfig;
    } else if (renewalConfig && renewalConfig.enabled) {
      this.settlementConfig = {
        vtxoThreshold: renewalConfig.thresholdMs ? renewalConfig.thresholdMs / 1e3 : void 0
      };
    } else if (renewalConfig) {
      this.settlementConfig = false;
    } else {
      this.settlementConfig = { ...DEFAULT_SETTLEMENT_CONFIG };
    }
    this.contractEventsSubscriptionReady = this.initializeSubscription().then(
      (subscription) => {
        this.contractEventsSubscription = subscription;
        return subscription;
      }
    );
  }
  settlementConfig;
  contractEventsSubscription;
  contractEventsSubscriptionReady;
  disposePromise;
  pollTimeoutId;
  knownBoardingUtxos = /* @__PURE__ */ new Set();
  sweptBoardingUtxos = /* @__PURE__ */ new Set();
  pollInProgress = false;
  pollDone;
  disposed = false;
  consecutivePollFailures = 0;
  startupPollTimeoutId;
  static MAX_BACKOFF_MS = 5 * 60 * 1e3;
  // 5 minutes
  // Guards against renewal feedback loop: when renewVtxos() settles, the
  // server emits new VTXOs → vtxo_received → renewVtxos() again → infinite loop.
  renewalInProgress = false;
  lastRenewalTimestamp = 0;
  static RENEWAL_COOLDOWN_MS = 3e4;
  // 30 seconds
  // Guards against a retry treadmill on the periodic-settle path: a failing
  // settle would otherwise re-submit identical intents on every 60s poll,
  // producing per-minute DeleteIntent RPCs forever. Mirrors the renewal
  // cooldown but with exponential backoff on consecutive failures, so a
  // persistently broken input eventually drops to the backoff cap instead
  // of hammering the server. Shared across boarding + expiring-VTXO work
  // because they now ride on the same settle intent.
  lastPeriodicSettleTimestamp = 0;
  consecutivePeriodicSettleFailures = 0;
  static PERIODIC_SETTLE_COOLDOWN_MS = 3e4;
  static PERIODIC_SETTLE_MAX_BACKOFF_MS = 5 * 60 * 1e3;
  // Throttle for the VTXO_ALREADY_SPENT -> refreshVtxos() reconciliation.
  // The server's authoritative view says our local cache is stale, so we
  // trigger a full refresh to advance the global sync cursor. Rate-limit
  // to guard against a buggy indexer cycling us into a refresh storm.
  lastVtxoSpentRefreshTimestamp = 0;
  vtxoSpentRefreshPromise;
  static VTXO_SPENT_REFRESH_COOLDOWN_MS = 3e4;
  // ========== Recovery Methods ==========
  /**
   * Recover swept/expired virtual outputs by settling them back to the wallet's Arkade address.
   *
   * This method:
   * 1. Fetches all virtual outputs (including recoverable ones)
   * 2. Filters for swept but still spendable virtual outputs and preconfirmed subdust
   * 3. Includes subdust virtual outputs if the total value >= dust threshold
   * 4. Settles everything back to the wallet's Arkade address
   *
   * Note: Settled virtual outputs with long expiry are NOT recovered to avoid locking liquidity unnecessarily.
   * Only preconfirmed subdust is recovered to consolidate small amounts.
   *
   * @param eventCallback - Optional callback to receive settlement events
   * @returns Settlement transaction ID
   * @throws Error if no recoverable virtual outputs found
   *
   * @example
   * ```typescript
   * const manager = await wallet.getVtxoManager();
   *
   * // Simple recovery
   * const txid = await manager.recoverVtxos();
   *
   * // With event callback
   * const txid = await manager.recoverVtxos((event) => {
   *   console.log('Settlement event:', event.type);
   * });
   * ```
   */
  async recoverVtxos(eventCallback) {
    const allVtxos = await this.wallet.getVtxos({
      withRecoverable: true,
      withUnrolled: false
    });
    const dustAmount = getDustAmount(this.wallet);
    const { vtxosToRecover, totalAmount } = getRecoverableWithSubdust(allVtxos, dustAmount);
    if (vtxosToRecover.length === 0) {
      throw new Error("No recoverable VTXOs found");
    }
    const arkAddress = await this.wallet.getAddress();
    return this.wallet.settle(
      {
        inputs: vtxosToRecover,
        outputs: [
          {
            address: arkAddress,
            amount: totalAmount
          }
        ]
      },
      eventCallback
    );
  }
  /**
   * Get information about recoverable balance without executing recovery.
   *
   * Useful for displaying to users before they decide to recover funds.
   *
   * @returns Object containing recoverable amounts and subdust information
   *
   * @example
   * ```typescript
   * const manager = await wallet.getVtxoManager();
   * const balance = await manager.getRecoverableBalance();
   *
   * if (balance.recoverable > 0n) {
   *   console.log(`You can recover ${balance.recoverable} sats`);
   *   if (balance.includesSubdust) {
   *     console.log(`This includes ${balance.subdust} sats from subdust virtual outputs`);
   *   }
   * }
   * ```
   */
  async getRecoverableBalance() {
    const allVtxos = await this.wallet.getVtxos({
      withRecoverable: true,
      withUnrolled: false
    });
    const dustAmount = getDustAmount(this.wallet);
    const { vtxosToRecover, includesSubdust, totalAmount } = getRecoverableWithSubdust(
      allVtxos,
      dustAmount
    );
    const subdustAmount = vtxosToRecover.filter((v) => BigInt(v.value) < dustAmount).reduce((sum, v) => sum + BigInt(v.value), 0n);
    return {
      recoverable: totalAmount,
      subdust: subdustAmount,
      includesSubdust,
      vtxoCount: vtxosToRecover.length
    };
  }
  // ========== Renewal Methods ==========
  /**
   * Get virtual outputs that are expiring soon based on renewal configuration
   *
   * @param thresholdMs - Optional override for threshold in milliseconds
   * @returns Array of expiring virtual outputs, empty array if renewal is disabled or no virtual outputs expiring
   *
   * @example
   * ```typescript
   * const wallet = await Wallet.create({
   *  identity,
   *  arkProvider: new RestArkProvider(),
   *  settlementConfig: {
   *      vtxoThreshold: 86_400 // 24 hours
   *  },
   * });
   * const manager = await wallet.getVtxoManager();
   * const expiringVtxos = await manager.getExpiringVtxos();
   * if (expiringVtxos.length > 0) {
   *   console.log(`${expiringVtxos.length} virtual outputs expiring soon`);
   * }
   * ```
   */
  async getExpiringVtxos(thresholdMs) {
    if (this.settlementConfig === false && thresholdMs === void 0) {
      return [];
    }
    const vtxos = await this.wallet.getVtxos({ withRecoverable: true });
    let threshold;
    if (thresholdMs !== void 0) {
      threshold = thresholdMs;
    } else if (this.settlementConfig !== false && this.settlementConfig && this.settlementConfig.vtxoThreshold !== void 0) {
      threshold = this.settlementConfig.vtxoThreshold * 1e3;
    } else {
      threshold = this.renewalConfig?.thresholdMs ?? DEFAULT_RENEWAL_CONFIG.thresholdMs;
    }
    return getExpiringAndRecoverableVtxos(vtxos, threshold, getDustAmount(this.wallet));
  }
  /**
   * Renew expiring virtual outputs by settling them back to the wallet's address
   *
   * This method collects all expiring spendable virtual outputs (including recoverable ones) and settles
   * them back to the wallet, effectively refreshing their expiration time. This is the
   * primary way to prevent virtual outputs from expiring.
   *
   * @param eventCallback - Optional callback for settlement events
   * @param options - Optional per-call overrides; see {@link RenewVtxosOptions}
   * @returns Settlement transaction ID
   * @throws Error if no virtual outputs available to renew
   * @throws Error if total amount is below dust threshold
   *
   * @example
   * ```typescript
   * const manager = await wallet.getVtxoManager();
   *
   * // Simple renewal
   * const txid = await manager.renewVtxos();
   *
   * // With event callback
   * const txid = await manager.renewVtxos((event) => {
   *   console.log('Settlement event:', event.type);
   * });
   *
   * // Renew only VTXOs that expire within 6 hours
   * const txid = await manager.renewVtxos(undefined, { thresholdSeconds: 6 * 60 * 60 });
   * ```
   */
  async renewVtxos(eventCallback, options) {
    if (options?.thresholdSeconds !== void 0) {
      const { thresholdSeconds } = options;
      if (typeof thresholdSeconds !== "number" || !Number.isFinite(thresholdSeconds) || thresholdSeconds <= 0) {
        throw new TypeError(
          `Invalid thresholdSeconds: expected a positive finite number, got ${String(thresholdSeconds)}`
        );
      }
    }
    if (this.renewalInProgress) {
      throw new Error("Renewal already in progress");
    }
    this.renewalInProgress = true;
    try {
      let threshold;
      if (options?.thresholdSeconds !== void 0) {
        threshold = options.thresholdSeconds * 1e3;
      } else if (this.settlementConfig !== false && this.settlementConfig?.vtxoThreshold !== void 0) {
        threshold = this.settlementConfig.vtxoThreshold * 1e3;
      } else {
        threshold = DEFAULT_RENEWAL_CONFIG.thresholdMs;
      }
      let vtxos = await this.getExpiringVtxos(threshold);
      if (vtxos.length === 0) {
        throw new Error("No VTXOs available to renew");
      }
      vtxos = await this.revalidateBeforeSettle(vtxos, threshold);
      if (vtxos.length === 0) {
        throw new Error("No VTXOs available to renew");
      }
      const totalAmount = vtxos.reduce((sum, vtxo) => sum + vtxo.value, 0);
      const dustAmount = getDustAmount(this.wallet);
      if (BigInt(totalAmount) < dustAmount) {
        throw new Error(
          `Total amount ${totalAmount} is below dust threshold ${dustAmount}`
        );
      }
      const arkAddress = await this.wallet.getAddress();
      const txid = await this.wallet.settle(
        {
          inputs: vtxos,
          outputs: [
            {
              address: arkAddress,
              amount: BigInt(totalAmount)
            }
          ]
        },
        eventCallback
      );
      return txid;
    } finally {
      this.lastRenewalTimestamp = Date.now();
      this.renewalInProgress = false;
    }
  }
  // ========== Boarding Input Sweep Methods ==========
  /**
   * Get boarding inputs whose timelock has expired.
   *
   * These inputs can no longer be onboarded cooperatively via `settle()` and
   * must be swept back to a fresh boarding address using the unilateral exit path.
   *
   * @returns Array of expired boarding inputs
   *
   * @example
   * ```typescript
   * const manager = await wallet.getVtxoManager();
   * const expired = await manager.getExpiredBoardingUtxos();
   * if (expired.length > 0) {
   *   console.log(`${expired.length} expired boarding inputs to sweep`);
   * }
   * ```
   */
  async getExpiredBoardingUtxos(prefetchedUtxos) {
    const boardingUtxos = prefetchedUtxos ?? await this.wallet.getBoardingUtxos();
    const boardingTimelock = this.getBoardingTimelock();
    let chainTipHeight;
    if (boardingTimelock.type === "blocks") {
      const tip = await this.getOnchainProvider().getChainTip();
      chainTipHeight = tip.height;
    }
    return boardingUtxos.filter(
      (utxo) => hasBoardingTxExpired(utxo, boardingTimelock, chainTipHeight)
    );
  }
  /**
   * Sweep expired boarding inputs back to a fresh boarding address via
   * the unilateral exit path (onchain self-spend).
   *
   * This builds a raw onchain transaction that:
   * - Uses all expired boarding inputs as inputs (spent via the CSV exit script path)
   * - Has a single output to the wallet's boarding address (restarts the timelock)
   * - Batches multiple expired boarding inputs into one transaction
   * - Skips the sweep if the output after fees would be below dust
   *
   * No Arkade server involvement is needed — this is a pure onchain transaction.
   *
   * @returns The broadcast transaction ID
   * @throws Error if no expired boarding inputs are found
   * @throws Error if output after fees is below dust (not economical to sweep)
   * @throws Error if boarding input sweep is not enabled in settlementConfig
   *
   * @example
   * ```typescript
   * const wallet = await Wallet.create({
   *   identity,
   *   arkProvider: new RestArkProvider(),
   *   settlementConfig: {
   *     boardingUtxoSweep: true,
   *   },
   * });
   * const manager = await wallet.getVtxoManager();
   *
   * try {
   *   const txid = await manager.sweepExpiredBoardingUtxos();
   *   console.log('Swept expired boarding inputs:', txid);
   * } catch (e) {
   *   console.log('No sweep needed or not economical');
   * }
   * ```
   */
  async sweepExpiredBoardingUtxos(prefetchedUtxos) {
    const sweepEnabled = this.settlementConfig !== false && (this.settlementConfig?.boardingUtxoSweep ?? DEFAULT_SETTLEMENT_CONFIG.boardingUtxoSweep);
    if (!sweepEnabled) {
      throw new Error("Boarding UTXO sweep is not enabled in settlementConfig");
    }
    const allExpired = await this.getExpiredBoardingUtxos(prefetchedUtxos);
    const expiredUtxos = allExpired.filter(
      (u) => !this.sweptBoardingUtxos.has(`${u.txid}:${u.vout}`)
    );
    if (expiredUtxos.length === 0) {
      throw new Error("No expired boarding UTXOs to sweep");
    }
    const boardingAddress = await this.wallet.getBoardingAddress();
    const feeRate = await this.getOnchainProvider().getFeeRate() ?? 1;
    const exitTapLeafScript = this.getBoardingExitLeaf();
    const sequence = getSequence(exitTapLeafScript);
    const leafScript = exitTapLeafScript[1];
    const leafScriptSize = leafScript.length - 1;
    const controlBlockSize = exitTapLeafScript[0].merklePath.length * 32;
    const leafWitnessSize = 64;
    const estimator = TxWeightEstimator.create();
    for (const _ of expiredUtxos) {
      estimator.addTapscriptInput(leafWitnessSize, leafScriptSize, controlBlockSize);
    }
    estimator.addOutputAddress(boardingAddress, this.getNetwork());
    const fee = Math.ceil(Number(estimator.vsize().value) * feeRate);
    const totalValue = expiredUtxos.reduce((sum, utxo) => sum + BigInt(utxo.value), 0n);
    const outputAmount = totalValue - BigInt(fee);
    const dustAmount = getDustAmount(this.wallet);
    if (outputAmount < dustAmount) {
      throw new Error(
        `Sweep not economical: output ${outputAmount} sats after ${fee} sats fee is below dust (${dustAmount} sats)`
      );
    }
    const tx = new Transaction();
    for (const utxo of expiredUtxos) {
      tx.addInput({
        txid: utxo.txid,
        index: utxo.vout,
        witnessUtxo: {
          script: this.getBoardingOutputScript(),
          amount: BigInt(utxo.value)
        },
        tapLeafScript: [exitTapLeafScript],
        sequence
      });
    }
    tx.addOutputAddress(boardingAddress, outputAmount, this.getNetwork());
    const signedTx = await this.getIdentity().sign(tx);
    signedTx.finalize();
    const txid = await this.getOnchainProvider().broadcastTransaction(signedTx.hex);
    for (const u of expiredUtxos) {
      this.sweptBoardingUtxos.add(`${u.txid}:${u.vout}`);
    }
    this.knownBoardingUtxos.add(`${txid}:0`);
    return txid;
  }
  // ========== Private Helpers ==========
  /** Asserts sweep capability and returns the typed wallet. */
  getSweepWallet() {
    assertSweepCapable(this.wallet);
    return this.wallet;
  }
  /** Decodes the boarding tapscript exit path to extract the CSV timelock. */
  getBoardingTimelock() {
    const wallet = this.getSweepWallet();
    const exitScript = CSVMultisigTapscript.decode(
      hex.decode(wallet.boardingTapscript.exitScript)
    );
    return exitScript.params.timelock;
  }
  /** Returns the TapLeafScript for the boarding tapscript's exit (CSV) path. */
  getBoardingExitLeaf() {
    return this.getSweepWallet().boardingTapscript.exit();
  }
  /** Returns the pkScript (output script) of the boarding tapscript. */
  getBoardingOutputScript() {
    return this.getSweepWallet().boardingTapscript.pkScript;
  }
  /** Returns the onchain provider for fee estimation and broadcasting. */
  getOnchainProvider() {
    return this.getSweepWallet().onchainProvider;
  }
  /** Returns the Ark provider for intent fee and server info lookups. */
  getArkProvider() {
    return this.getSweepWallet().arkProvider;
  }
  /** Returns the Bitcoin network configuration from the wallet. */
  getNetwork() {
    return this.getSweepWallet().network;
  }
  /** Returns the wallet's identity for transaction signing. */
  getIdentity() {
    return this.wallet.identity;
  }
  async initializeSubscription() {
    if (this.settlementConfig === false) {
      return void 0;
    }
    this.startupPollTimeoutId = setTimeout(() => {
      if (this.disposed) return;
      this.startBoardingUtxoPoll();
    }, 1e3);
    try {
      const [delegateManager, contractManager, destination] = await Promise.all([
        this.wallet.getDelegateManager(),
        this.wallet.getContractManager(),
        this.wallet.getAddress()
      ]);
      const stopWatching = contractManager.onContractEvent((event) => {
        if (event.type !== "vtxo_received") {
          return;
        }
        const msSinceLastRenewal = Date.now() - this.lastRenewalTimestamp;
        const shouldRenew = !this.renewalInProgress && msSinceLastRenewal >= _VtxoManager.RENEWAL_COOLDOWN_MS;
        if (shouldRenew) {
          this.renewVtxos().catch((e) => {
            if (e instanceof Error) {
              if (e.message.includes("No VTXOs available to renew")) {
                return;
              }
              if (e.message.includes("is below dust threshold")) {
                return;
              }
              if (e.message.includes("VTXO_ALREADY_REGISTERED") || e.message.includes("duplicated input")) {
                return;
              }
              if (e.message.includes("VTXO_ALREADY_SPENT")) {
                void this.maybeRefreshAfterVtxoSpent(this.extractSpentOutpoint(e));
                return;
              }
            }
            console.error("Error renewing VTXOs:", e);
          });
        }
        if (delegateManager) {
          delegateManager.delegate(event.vtxos, destination).catch((e) => {
            console.error("Error delegating VTXOs:", e);
          });
        }
      });
      return stopWatching;
    } catch (e) {
      console.error("Error renewing VTXOs from VtxoManager", e);
      return void 0;
    }
  }
  /**
   * VTXO_ALREADY_SPENT means the server's authoritative view of VTXO state
   * is ahead of ours — cross-instance race, pre-lock snapshot drift, or an
   * SSE gap left stale data in the local cache. Silent-swallowing
   * guarantees the same error on the next cycle because nothing
   * reconciles the cache.
   *
   * The cursor-derived delta sync filters by `created_at`, so a VTXO that
   * was created before the cursor but spent recently can never be
   * reconciled by `refreshVtxos()`. Use `refreshOutpoints` for surgical
   * recovery: query the indexer for the specific stale outpoint and
   * upsert its authoritative state into the wallet repository.
   *
   * Throttled because the same VTXO can fire repeatedly before the
   * upsert observably propagates through the renewal selector.
   */
  maybeRefreshAfterVtxoSpent(spentOutpoint) {
    if (this.vtxoSpentRefreshPromise) {
      return this.vtxoSpentRefreshPromise;
    }
    const now = Date.now();
    if (now - this.lastVtxoSpentRefreshTimestamp < _VtxoManager.VTXO_SPENT_REFRESH_COOLDOWN_MS) {
      return Promise.resolve();
    }
    this.lastVtxoSpentRefreshTimestamp = now;
    this.vtxoSpentRefreshPromise = (async () => {
      try {
        const contractManager = await this.wallet.getContractManager();
        if (spentOutpoint) {
          await contractManager.refreshOutpoints([spentOutpoint]);
        } else {
          await contractManager.refreshVtxos();
        }
      } catch (e) {
        console.error("Error refreshing VTXOs after VTXO_ALREADY_SPENT:", e);
      } finally {
        this.vtxoSpentRefreshPromise = void 0;
      }
    })();
    return this.vtxoSpentRefreshPromise;
  }
  /**
   * Extract the offending VTXO outpoint from a `VTXO_ALREADY_SPENT` error,
   * if the server attached one in `metadata.vtxo_outpoint`. Returns
   * `undefined` when the error isn't a parsed ArkError, isn't this code,
   * or doesn't carry the metadata.
   */
  extractSpentOutpoint(error) {
    const ark = maybeArkError(error);
    if (!ark || ark.name !== "VTXO_ALREADY_SPENT") return void 0;
    const raw = ark.metadata?.vtxo_outpoint;
    if (typeof raw !== "string") return void 0;
    const [txid, voutStr] = raw.split(":");
    if (!txid || !voutStr) return void 0;
    const vout = Number(voutStr);
    if (!Number.isInteger(vout) || vout < 0) return void 0;
    return { txid, vout };
  }
  /**
   * Reconcile the chosen VTXOs with the indexer's authoritative state
   * before submitting a settle intent. Pulls the canonical record for
   * each candidate outpoint via {@link IContractManager.refreshOutpoints}
   * (which upserts the result into the wallet repository), then
   * re-selects through the standard expiring-vtxo filter so anything
   * the refresh flagged as spent is dropped.
   *
   * Best-effort: a failed refresh just falls back to the original
   * candidates and lets the post-submit `VTXO_ALREADY_SPENT` recovery
   * handle whatever slipped through.
   */
  async revalidateBeforeSettle(candidates, thresholdMs) {
    if (candidates.length === 0) return candidates;
    try {
      const cm = await this.wallet.getContractManager();
      await cm.refreshOutpoints(candidates.map((v) => ({ txid: v.txid, vout: v.vout })));
    } catch (e) {
      console.error("Error pre-validating VTXOs before settle:", e);
      return candidates;
    }
    try {
      const refreshed = await this.getExpiringVtxos(thresholdMs);
      const candidateKeys = new Set(candidates.map((v) => `${v.txid}:${v.vout}`));
      return refreshed.filter((v) => candidateKeys.has(`${v.txid}:${v.vout}`));
    } catch (e) {
      console.error("Error re-selecting VTXOs after pre-validate:", e);
      return candidates;
    }
  }
  /** Computes the next poll delay, applying exponential backoff on failures. */
  getNextPollDelay() {
    if (this.settlementConfig === false) return 0;
    const baseMs = this.settlementConfig.pollIntervalMs ?? DEFAULT_SETTLEMENT_CONFIG.pollIntervalMs;
    if (this.consecutivePollFailures === 0) return baseMs;
    const backoff = Math.min(
      baseMs * Math.pow(2, this.consecutivePollFailures),
      _VtxoManager.MAX_BACKOFF_MS
    );
    return backoff;
  }
  /**
   * Starts a polling loop that:
   * 1. Auto-settles new boarding inputs into Arkade
   * 2. Sweeps expired boarding inputs (when boardingUtxoSweep is enabled)
   *
   * Uses setTimeout chaining (not setInterval) so a slow/blocked poll
   * cannot stack up and the next delay can incorporate backoff.
   */
  startBoardingUtxoPoll() {
    if (this.settlementConfig === false) return;
    this.pollBoardingUtxos();
  }
  schedulePoll() {
    if (this.disposed || this.settlementConfig === false) return;
    const delay = this.getNextPollDelay();
    this.pollTimeoutId = setTimeout(() => this.pollBoardingUtxos(), delay);
  }
  async pollBoardingUtxos() {
    if (!isSweepCapable(this.wallet)) return;
    if (this.disposed) return;
    if (this.pollInProgress) return;
    this.pollInProgress = true;
    let resolve;
    const promise = new Promise((r) => resolve = r);
    this.pollDone = { promise, resolve };
    let hadError = false;
    try {
      await runWithCrossInstanceLock(BOARDING_POLL_LOCK_NAME, async () => {
        const boardingUtxos = await this.wallet.getBoardingUtxos();
        try {
          await this.runPeriodicSettle(boardingUtxos);
        } catch (e) {
          hadError = true;
          console.error("Error during periodic settle:", e);
        }
        const sweepEnabled = this.settlementConfig !== false && (this.settlementConfig?.boardingUtxoSweep ?? DEFAULT_SETTLEMENT_CONFIG.boardingUtxoSweep);
        if (sweepEnabled) {
          try {
            await this.sweepExpiredBoardingUtxos(boardingUtxos);
          } catch (e) {
            if (!(e instanceof Error) || !e.message.includes("No expired boarding UTXOs")) {
              hadError = true;
              console.error("Error auto-sweeping boarding UTXOs:", e);
            }
          }
        }
      });
    } catch (e) {
      hadError = true;
      console.error("Error fetching boarding UTXOs:", e);
    } finally {
      if (hadError) {
        this.consecutivePollFailures++;
      } else {
        this.consecutivePollFailures = 0;
      }
      this.pollInProgress = false;
      this.pollDone.resolve();
      this.pollDone = void 0;
      this.schedulePoll();
    }
  }
  /**
   * Auto-settle new (unexpired) boarding inputs AND near-expiry VTXOs into
   * Arkade in a single intent. Skips boarding UTXOs that are already expired
   * (those are handled by sweep) and those already in-flight (tracked in
   * knownBoardingUtxos). If the event-driven renewal path is currently
   * running, VTXOs are omitted from this cycle to avoid double-spending.
   *
   * Failure bookkeeping: after every settle *attempt*, lastPeriodicSettleTimestamp
   * is armed and consecutive failures are counted so the next attempt is
   * blocked by an exponentially growing cooldown (capped). This stops a
   * persistently failing input from producing identical RegisterIntent +
   * DeleteIntent retries on every 60s poll.
   */
  async runPeriodicSettle(boardingUtxos) {
    let expiredSet;
    try {
      const boardingTimelock = this.getBoardingTimelock();
      let chainTipHeight;
      if (boardingTimelock.type === "blocks") {
        const tip = await this.getOnchainProvider().getChainTip();
        chainTipHeight = tip.height;
      }
      const expired = boardingUtxos.filter(
        (utxo) => hasBoardingTxExpired(utxo, boardingTimelock, chainTipHeight)
      );
      expiredSet = new Set(expired.map((u) => `${u.txid}:${u.vout}`));
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e));
    }
    const unsettledBoarding = boardingUtxos.filter(
      (u) => u.status.confirmed && !this.knownBoardingUtxos.has(`${u.txid}:${u.vout}`) && !expiredSet.has(`${u.txid}:${u.vout}`)
    );
    let expiringVtxos = [];
    if (!this.renewalInProgress) {
      try {
        expiringVtxos = await this.getExpiringVtxos();
        expiringVtxos = await this.revalidateBeforeSettle(expiringVtxos);
      } catch (e) {
        console.error("Error fetching expiring VTXOs:", e);
      }
    }
    if (unsettledBoarding.length === 0 && expiringVtxos.length === 0) {
      return;
    }
    const cooldownMs = Math.min(
      _VtxoManager.PERIODIC_SETTLE_COOLDOWN_MS * Math.pow(2, this.consecutivePeriodicSettleFailures),
      _VtxoManager.PERIODIC_SETTLE_MAX_BACKOFF_MS
    );
    if (Date.now() - this.lastPeriodicSettleTimestamp < cooldownMs) {
      return;
    }
    const dustAmount = getDustAmount(this.wallet);
    const { fees } = await this.getArkProvider().getInfo();
    const estimator = new Estimator(fees.intentFee);
    let totalAmount = 0n;
    const filteredBoarding = [];
    for (const u of unsettledBoarding) {
      const inputFee = estimator.evalOnchainInput({
        amount: BigInt(u.value)
      });
      if (inputFee.value >= BigInt(u.value)) {
        continue;
      }
      filteredBoarding.push(u);
      totalAmount += BigInt(u.value) - BigInt(inputFee.satoshis);
    }
    const filteredVtxos = [];
    for (const v of expiringVtxos) {
      const inputFee = estimator.evalOffchainInput({
        amount: BigInt(v.value),
        type: v.virtualStatus.state === "swept" ? "recoverable" : "vtxo",
        weight: 0,
        birth: v.createdAt,
        expiry: v.virtualStatus.batchExpiry ? new Date(v.virtualStatus.batchExpiry) : void 0
      });
      if (inputFee.satoshis >= v.value) {
        continue;
      }
      filteredVtxos.push(v);
      totalAmount += BigInt(v.value) - BigInt(inputFee.satoshis);
    }
    if (filteredBoarding.length === 0 && filteredVtxos.length === 0) {
      return;
    }
    const arkAddress = await this.wallet.getAddress();
    const outputFee = estimator.evalOffchainOutput({
      amount: totalAmount,
      script: hex.encode(ArkAddress.decode(arkAddress).pkScript)
    });
    totalAmount -= BigInt(outputFee.satoshis);
    if (totalAmount < dustAmount) return;
    const includesVtxos = filteredVtxos.length > 0;
    if (includesVtxos) {
      this.renewalInProgress = true;
    }
    let success = false;
    let staleCacheSkip = false;
    try {
      try {
        await this.wallet.settle({
          inputs: [...filteredBoarding, ...filteredVtxos],
          outputs: [{ address: arkAddress, amount: totalAmount }]
        });
        for (const u of filteredBoarding) {
          this.knownBoardingUtxos.add(`${u.txid}:${u.vout}`);
        }
        success = true;
      } catch (e) {
        if (e instanceof Error && e.message.includes("VTXO_ALREADY_SPENT")) {
          staleCacheSkip = true;
          void this.maybeRefreshAfterVtxoSpent(this.extractSpentOutpoint(e));
        } else {
          throw e;
        }
      }
    } finally {
      this.lastPeriodicSettleTimestamp = Date.now();
      if (includesVtxos) {
        this.lastRenewalTimestamp = Date.now();
        this.renewalInProgress = false;
      }
      if (success) {
        this.consecutivePeriodicSettleFailures = 0;
      } else if (!staleCacheSkip) {
        this.consecutivePeriodicSettleFailures++;
      }
    }
  }
  async dispose() {
    this.disposePromise ??= (async () => {
      this.disposed = true;
      if (this.startupPollTimeoutId) {
        clearTimeout(this.startupPollTimeoutId);
        this.startupPollTimeoutId = void 0;
      }
      if (this.pollTimeoutId) {
        clearTimeout(this.pollTimeoutId);
        this.pollTimeoutId = void 0;
      }
      if (this.pollDone) {
        let timer;
        const timeout = new Promise((r) => timer = setTimeout(r, 3e4));
        await Promise.race([this.pollDone.promise, timeout]);
        clearTimeout(timer);
      }
      const subscription = await this.contractEventsSubscriptionReady;
      this.contractEventsSubscription = void 0;
      subscription?.();
    })();
    return this.disposePromise;
  }
  async [Symbol.asyncDispose]() {
    await this.dispose();
  }
};
var ArkNote = class _ArkNote {
  /**
   * Create an ArkNote from a preimage and value.
   *
   * @param preimage - 32-byte preimage revealed to spend the note
   * @param value - Note value in satoshis
   * @param HRP - Optional human-readable prefix for string encoding
   */
  constructor(preimage, value, HRP = _ArkNote.DefaultHRP) {
    this.preimage = preimage;
    this.value = value;
    this.HRP = HRP;
    const preimageHash = sha256(this.preimage);
    this.vtxoScript = new VtxoScript([noteTapscript(preimageHash)]);
    const leaf = this.vtxoScript.leaves[0];
    this.txid = hex.encode(new Uint8Array(preimageHash).reverse());
    this.tapTree = this.vtxoScript.encode();
    this.forfeitTapLeafScript = leaf;
    this.intentTapLeafScript = leaf;
    this.value = value;
    this.status = { confirmed: true };
    this.extraWitness = [this.preimage];
  }
  static DefaultHRP = "arknote";
  static PreimageLength = 32;
  // 32 bytes for the preimage
  static ValueLength = 4;
  // 4 bytes for the value
  static Length = _ArkNote.PreimageLength + _ArkNote.ValueLength;
  static FakeOutpointIndex = 0;
  vtxoScript;
  /** Hashlock script backing the note. */
  txid;
  vout = 0;
  forfeitTapLeafScript;
  intentTapLeafScript;
  tapTree;
  status;
  extraWitness;
  /**
   * Encode the note as raw bytes.
   *
   * @returns Serialized note bytes
   * @see decode
   */
  encode() {
    const result = new Uint8Array(_ArkNote.Length);
    result.set(this.preimage, 0);
    writeUInt32BE(result, this.value, this.preimage.length);
    return result;
  }
  /**
   * Decode a note from raw bytes.
   *
   * @param data - Serialized note bytes
   * @param hrp - Human-readable prefix expected for future string encoding
   * @returns Decoded ArkNote
   * @throws Error if the payload length is invalid
   * @see encode
   */
  static decode(data, hrp = _ArkNote.DefaultHRP) {
    if (data.length !== _ArkNote.Length) {
      throw new Error(
        `invalid data length: expected ${_ArkNote.Length} bytes, got ${data.length}`
      );
    }
    const preimage = data.subarray(0, _ArkNote.PreimageLength);
    const value = readUInt32BE(data, _ArkNote.PreimageLength);
    return new _ArkNote(preimage, value, hrp);
  }
  /**
   * Decode a note from its base58 string form.
   *
   * @param noteStr - Base58-encoded note string
   * @param hrp - Human-readable prefix expected on the note string
   * @returns Decoded ArkNote
   * @throws Error if the prefix or base58 payload is invalid
   * @see toString
   */
  static fromString(noteStr, hrp = _ArkNote.DefaultHRP) {
    noteStr = noteStr.trim();
    if (!noteStr.startsWith(hrp)) {
      throw new Error(
        `invalid human-readable part: expected ${hrp} prefix (note '${noteStr}')`
      );
    }
    const encoded = noteStr.slice(hrp.length);
    const decoded = base58.decode(encoded);
    if (decoded.length === 0) {
      throw new Error("failed to decode base58 string");
    }
    return _ArkNote.decode(decoded, hrp);
  }
  /**
   * Encode the note to its human-readable base58 string form.
   *
   * @returns Base58-encoded note string
   * @see fromString
   */
  toString() {
    return this.HRP + base58.encode(this.encode());
  }
};
function writeUInt32BE(array, value, offset) {
  const view2 = new DataView(array.buffer, array.byteOffset + offset, 4);
  view2.setUint32(0, value, false);
}
function readUInt32BE(array, offset) {
  const view2 = new DataView(array.buffer, array.byteOffset + offset, 4);
  return view2.getUint32(0, false);
}
function noteTapscript(preimageHash) {
  return Script.encode(["SHA256", preimageHash, "EQUAL"]);
}
var TxTree = class {
  constructor(root, children = /* @__PURE__ */ new Map()) {
    this.root = root;
    this.children = children;
  }
  static create(chunks) {
    if (chunks.length === 0) {
      throw new Error("empty chunks");
    }
    const chunksByTxid = /* @__PURE__ */ new Map();
    for (const chunk of chunks) {
      const decodedChunk = decodeNode(chunk);
      const txid = decodedChunk.tx.id;
      chunksByTxid.set(txid, decodedChunk);
    }
    const rootTxids = [];
    for (const [txid] of chunksByTxid) {
      let isChild = false;
      for (const [otherTxid, otherChunk] of chunksByTxid) {
        if (otherTxid === txid) {
          continue;
        }
        isChild = hasChild(otherChunk, txid);
        if (isChild) {
          break;
        }
      }
      if (!isChild) {
        rootTxids.push(txid);
        continue;
      }
    }
    if (rootTxids.length === 0) {
      throw new Error("no root chunk found");
    }
    if (rootTxids.length > 1) {
      throw new Error(`multiple root chunks found: ${rootTxids.join(", ")}`);
    }
    const graph = buildGraph(rootTxids[0], chunksByTxid);
    if (!graph) {
      throw new Error(`chunk not found for root txid: ${rootTxids[0]}`);
    }
    if (graph.nbOfNodes() !== chunks.length) {
      throw new Error(
        `number of chunks (${chunks.length}) is not equal to the number of nodes in the graph (${graph.nbOfNodes()})`
      );
    }
    return graph;
  }
  nbOfNodes() {
    let count = 1;
    for (const child of this.children.values()) {
      count += child.nbOfNodes();
    }
    return count;
  }
  validate() {
    if (!this.root) {
      throw new Error("unexpected nil root");
    }
    const nbOfOutputs = this.root.outputsLength;
    const nbOfInputs = this.root.inputsLength;
    if (nbOfInputs !== 1) {
      throw new Error(`unexpected number of inputs: ${nbOfInputs}, expected 1`);
    }
    if (this.children.size > nbOfOutputs - 1) {
      throw new Error(
        `unexpected number of children: ${this.children.size}, expected maximum ${nbOfOutputs - 1}`
      );
    }
    for (const [outputIndex, child] of this.children) {
      if (outputIndex >= nbOfOutputs) {
        throw new Error(
          `output index ${outputIndex} is out of bounds (nb of outputs: ${nbOfOutputs})`
        );
      }
      child.validate();
      const childInput = child.root.getInput(0);
      const parentTxid = this.root.id;
      if (!childInput.txid || hex.encode(childInput.txid) !== parentTxid || childInput.index !== outputIndex) {
        throw new Error(`input of child ${outputIndex} is not the output of the parent`);
      }
      let childOutputsSum = 0n;
      for (let i = 0; i < child.root.outputsLength; i++) {
        const output = child.root.getOutput(i);
        if (output?.amount) {
          childOutputsSum += output.amount;
        }
      }
      const parentOutput = this.root.getOutput(outputIndex);
      if (!parentOutput?.amount) {
        throw new Error(`parent output ${outputIndex} has no amount`);
      }
      if (childOutputsSum !== parentOutput.amount) {
        throw new Error(
          `sum of child's outputs is not equal to the output of the parent: ${childOutputsSum} != ${parentOutput.amount}`
        );
      }
    }
  }
  leaves() {
    if (this.children.size === 0) {
      return [this.root];
    }
    const leaves = [];
    for (const child of this.children.values()) {
      leaves.push(...child.leaves());
    }
    return leaves;
  }
  get txid() {
    return this.root.id;
  }
  find(txid) {
    if (txid === this.txid) {
      return this;
    }
    for (const child of this.children.values()) {
      const found = child.find(txid);
      if (found) {
        return found;
      }
    }
    return null;
  }
  update(txid, fn) {
    if (txid === this.txid) {
      fn(this.root);
      return;
    }
    for (const child of this.children.values()) {
      try {
        child.update(txid, fn);
        return;
      } catch (error) {
        continue;
      }
    }
    throw new Error(`tx not found: ${txid}`);
  }
  *iterator() {
    for (const child of this.children.values()) {
      yield* child.iterator();
    }
    yield this;
  }
};
function hasChild(chunk, childTxid) {
  return Object.values(chunk.children).includes(childTxid);
}
function buildGraph(rootTxid, chunksByTxid) {
  const chunk = chunksByTxid.get(rootTxid);
  if (!chunk) {
    return null;
  }
  const rootTx = chunk.tx;
  const children = /* @__PURE__ */ new Map();
  for (const [outputIndexStr, childTxid] of Object.entries(chunk.children)) {
    const outputIndex = parseInt(outputIndexStr);
    const childGraph = buildGraph(childTxid, chunksByTxid);
    if (childGraph) {
      children.set(outputIndex, childGraph);
    }
  }
  return new TxTree(rootTx, children);
}
function decodeNode(chunk) {
  const tx = Transaction$1.fromPSBT(base64.decode(chunk.tx));
  return { tx, children: chunk.children };
}
var Batch;
((Batch2) => {
  let Step;
  ((Step2) => {
    Step2["Start"] = "start";
    Step2["BatchStarted"] = "batch_started";
    Step2["TreeSigningStarted"] = "tree_signing_started";
    Step2["TreeNoncesAggregated"] = "tree_nonces_aggregated";
    Step2["BatchFinalization"] = "batch_finalization";
  })(Step || (Step = {}));
  async function join(eventIterator, handler, options = {}) {
    const { abortController, skipVtxoTreeSigning = false, eventCallback } = options;
    let step = "start" /* Start */;
    const flatVtxoTree = [];
    const flatConnectorTree = [];
    let vtxoTree = void 0;
    let connectorTree = void 0;
    for await (const event of eventIterator) {
      if (abortController?.signal.aborted) {
        throw new Error("canceled");
      }
      if (eventCallback) {
        eventCallback(event).catch(() => {
        });
      }
      switch (event.type) {
        case "batch_started" /* BatchStarted */: {
          const e = event;
          const { skip } = await handler.onBatchStarted(e);
          if (!skip) {
            step = "batch_started" /* BatchStarted */;
            if (skipVtxoTreeSigning) {
              step = "tree_nonces_aggregated" /* TreeNoncesAggregated */;
            }
          }
          continue;
        }
        case "batch_finalized" /* BatchFinalized */: {
          if (step !== "batch_finalization" /* BatchFinalization */) {
            continue;
          }
          if (handler.onBatchFinalized) {
            await handler.onBatchFinalized(event);
          }
          return event.commitmentTxid;
        }
        case "batch_failed" /* BatchFailed */: {
          if (handler.onBatchFailed) {
            await handler.onBatchFailed(event);
            continue;
          }
          throw new Error(event.reason);
        }
        case "tree_tx" /* TreeTx */: {
          if (step !== "batch_started" /* BatchStarted */ && step !== "tree_nonces_aggregated" /* TreeNoncesAggregated */) {
            continue;
          }
          if (event.batchIndex === 0) {
            flatVtxoTree.push(event.chunk);
          } else {
            flatConnectorTree.push(event.chunk);
          }
          if (handler.onTreeTxEvent) {
            await handler.onTreeTxEvent(event);
          }
          continue;
        }
        case "tree_signature" /* TreeSignature */: {
          if (step !== "tree_nonces_aggregated" /* TreeNoncesAggregated */) {
            continue;
          }
          if (!vtxoTree) {
            throw new Error("vtxo tree not initialized");
          }
          const tapKeySig = hex.decode(event.signature);
          vtxoTree.update(event.txid, (tx) => {
            tx.updateInput(0, {
              tapKeySig
            });
          });
          if (handler.onTreeSignatureEvent) {
            await handler.onTreeSignatureEvent(event);
          }
          continue;
        }
        case "tree_signing_started" /* TreeSigningStarted */: {
          if (step !== "batch_started" /* BatchStarted */) {
            continue;
          }
          vtxoTree = TxTree.create(flatVtxoTree);
          const { skip } = await handler.onTreeSigningStarted(event, vtxoTree);
          if (!skip) {
            step = "tree_signing_started" /* TreeSigningStarted */;
          }
          continue;
        }
        case "tree_nonces" /* TreeNonces */: {
          if (step !== "tree_signing_started" /* TreeSigningStarted */) {
            continue;
          }
          const { fullySigned } = await handler.onTreeNonces(event);
          if (fullySigned) {
            step = "tree_nonces_aggregated" /* TreeNoncesAggregated */;
          }
          continue;
        }
        case "batch_finalization" /* BatchFinalization */: {
          if (step !== "tree_nonces_aggregated" /* TreeNoncesAggregated */) {
            continue;
          }
          if (!vtxoTree && flatVtxoTree.length > 0) {
            vtxoTree = TxTree.create(flatVtxoTree);
          }
          if (!vtxoTree && !skipVtxoTreeSigning) {
            throw new Error("vtxo tree not initialized");
          }
          if (flatConnectorTree.length > 0) {
            connectorTree = TxTree.create(flatConnectorTree);
          }
          await handler.onBatchFinalization(event, vtxoTree, connectorTree);
          step = "batch_finalization" /* BatchFinalization */;
          continue;
        }
        default:
          continue;
      }
    }
    throw new Error("event stream closed");
  }
  Batch2.join = join;
})(Batch || (Batch = {}));

// src/utils/transactionHistory.ts
var txKey = {
  commitmentTxid: "",
  boardingTxid: "",
  arkTxid: ""
};
function consumeBoardingReceive(boardingTxs, predicate) {
  const index = boardingTxs.findIndex(predicate);
  if (index === -1) return false;
  boardingTxs.splice(index, 1);
  return true;
}
function isSettledBoardingReceive(tx) {
  return tx.type === "RECEIVED" /* TxReceived */ && tx.settled && tx.key.boardingTxid !== "";
}
function collectAssets(vtxos) {
  const map = /* @__PURE__ */ new Map();
  for (const vtxo of vtxos) {
    if (vtxo.assets) {
      for (const a of vtxo.assets) {
        map.set(a.assetId, (map.get(a.assetId) ?? 0n) + a.amount);
      }
    }
  }
  if (map.size === 0) return void 0;
  return Array.from(map, ([assetId, amount]) => ({ assetId, amount }));
}
function subtractAssets(spent, change) {
  const map = /* @__PURE__ */ new Map();
  for (const vtxo of change) {
    if (vtxo.assets) {
      for (const a of vtxo.assets) {
        map.set(a.assetId, (map.get(a.assetId) ?? 0n) + a.amount);
      }
    }
  }
  for (const vtxo of spent) {
    if (vtxo.assets) {
      for (const a of vtxo.assets) {
        const current = map.get(a.assetId) ?? 0n;
        const remaining = current - a.amount;
        if (remaining !== 0n) {
          map.set(a.assetId, remaining);
        } else {
          map.delete(a.assetId);
        }
      }
    }
  }
  if (map.size === 0) return void 0;
  return Array.from(map, ([assetId, amount]) => ({ assetId, amount }));
}
async function buildTransactionHistory(vtxos, allBoardingTxs, commitmentsToIgnore, getTxCreatedAt) {
  const fromOldestVtxo = [...vtxos].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const unmatchedSettledBoardingTxs = allBoardingTxs.filter(isSettledBoardingReceive).sort((a, b) => a.createdAt - b.createdAt);
  const sent = [];
  let received = [];
  for (const vtxo of fromOldestVtxo) {
    if (vtxo.status.isLeaf) {
      const commitmentTxid = vtxo.virtualStatus.commitmentTxIds[0];
      const vtxoCreatedAt = vtxo.createdAt.getTime();
      const ignoredCommitment = commitmentsToIgnore.has(commitmentTxid) || !!vtxo.settledBy && commitmentsToIgnore.has(vtxo.settledBy);
      if (ignoredCommitment) {
        consumeBoardingReceive(
          unmatchedSettledBoardingTxs,
          (tx) => tx.createdAt <= vtxoCreatedAt && (tx.key.commitmentTxid === commitmentTxid || tx.key.commitmentTxid === vtxo.settledBy)
        );
      } else if (fromOldestVtxo.filter((v) => v.settledBy === vtxo.virtualStatus.commitmentTxIds[0]).length === 0) {
        const duplicateBoardingReceive = consumeBoardingReceive(
          unmatchedSettledBoardingTxs,
          (tx) => tx.amount === vtxo.value && tx.createdAt <= vtxoCreatedAt
        );
        if (!duplicateBoardingReceive) {
          const assets = collectAssets([vtxo]);
          received.push({
            key: {
              ...txKey,
              commitmentTxid
            },
            tag: "batch",
            type: "RECEIVED" /* TxReceived */,
            amount: vtxo.value,
            settled: vtxo.status.isLeaf || vtxo.isSpent,
            createdAt: vtxoCreatedAt,
            ...assets && { assets }
          });
        }
      }
    } else if (fromOldestVtxo.filter((v) => v.arkTxId === vtxo.txid).length === 0) {
      const assets = collectAssets([vtxo]);
      received.push({
        key: { ...txKey, arkTxid: vtxo.txid },
        tag: "offchain",
        type: "RECEIVED" /* TxReceived */,
        amount: vtxo.value,
        settled: vtxo.status.isLeaf || vtxo.isSpent,
        createdAt: vtxo.createdAt.getTime(),
        ...assets && { assets }
      });
    }
    if (vtxo.isSpent) {
      if (vtxo.arkTxId && !sent.some((s) => s.key.arkTxid === vtxo.arkTxId)) {
        const changes = fromOldestVtxo.filter((_) => _.txid === vtxo.arkTxId);
        const allSpent = fromOldestVtxo.filter((v) => v.arkTxId === vtxo.arkTxId);
        const spentAmount = allSpent.reduce((acc, v) => acc + v.value, 0);
        let txAmount = 0;
        let txTime = 0;
        if (changes.length > 0) {
          const changeAmount = changes.reduce((acc, v) => acc + v.value, 0);
          txAmount = spentAmount - changeAmount;
          txTime = changes[0].createdAt.getTime();
        } else {
          txAmount = spentAmount;
          txTime = getTxCreatedAt ? await getTxCreatedAt(vtxo.arkTxId) ?? vtxo.createdAt.getTime() + 1 : vtxo.createdAt.getTime() + 1;
        }
        const assets = subtractAssets(allSpent, changes);
        sent.push({
          key: { ...txKey, arkTxid: vtxo.arkTxId },
          tag: "offchain",
          type: "SENT" /* TxSent */,
          amount: txAmount,
          settled: true,
          createdAt: txTime,
          ...assets && { assets }
        });
      }
      if (vtxo.settledBy && !commitmentsToIgnore.has(vtxo.settledBy) && !sent.some((s) => s.key.commitmentTxid === vtxo.settledBy)) {
        const changes = fromOldestVtxo.filter(
          (v) => v.status.isLeaf && v.virtualStatus.commitmentTxIds?.every((_) => vtxo.settledBy === _)
        );
        const forfeitVtxos = fromOldestVtxo.filter((v) => v.settledBy === vtxo.settledBy);
        const forfeitAmount = forfeitVtxos.reduce((acc, v) => acc + v.value, 0);
        if (changes.length > 0) {
          const settledAmount = changes.reduce((acc, v) => acc + v.value, 0);
          if (forfeitAmount > settledAmount) {
            const assets = subtractAssets(forfeitVtxos, changes);
            sent.push({
              key: { ...txKey, commitmentTxid: vtxo.settledBy },
              tag: "exit",
              type: "SENT" /* TxSent */,
              amount: forfeitAmount - settledAmount,
              settled: true,
              createdAt: changes[0].createdAt.getTime(),
              ...assets && { assets }
            });
          }
        } else {
          const assets = subtractAssets(forfeitVtxos, []);
          sent.push({
            key: { ...txKey, commitmentTxid: vtxo.settledBy },
            tag: "exit",
            type: "SENT" /* TxSent */,
            amount: forfeitAmount,
            settled: true,
            // TODO: fetch commitment tx with /v1/indexer/commitmentTx/<commitmentTxid> to know when the tx was made
            createdAt: vtxo.createdAt.getTime() + 1,
            ...assets && { assets }
          });
        }
      }
    }
  }
  const boardingTx = allBoardingTxs.map((tx) => ({ ...tx, tag: "boarding" }));
  const sorted = [...boardingTx, ...sent, ...received].sort((a, b) => b.createdAt - a.createdAt);
  return sorted;
}

// src/wallet/asset-manager.ts
var ReadonlyAssetManager = class {
  constructor(indexer) {
    this.indexer = indexer;
  }
  async getAssetDetails(assetId) {
    return this.indexer.getAssetDetails(assetId);
  }
};
var AssetManager = class extends ReadonlyAssetManager {
  constructor(wallet) {
    super(wallet.indexerProvider);
    this.wallet = wallet;
  }
  /**
   * Issue a new asset.
   * @param params - Parameters for asset issuance
   * @param params.amount - Amount of asset units to issue
   * @param params.controlAssetId - Optional control asset ID (for reissuable assets)
   * @param params.metadata - Optional metadata to attach to the asset
   * @returns Promise resolving to the Arkade transaction ID and asset ID
   *
   * @example
   * ```typescript
   * // Issue a simple non-reissuable asset
   * const result = await wallet.assetManager.issue({ amount: 1000 });
   * console.log('Asset ID:', result.assetId);
   *
   * // Issue a reissuable asset with an existing control asset
   * const result = await wallet.assetManager.issue({
   *   amount: 1000,
   *   controlAssetId: 'existingControlAssetId'
   * });
   * console.log('Asset ID:', result.assetId);
   * ```
   */
  async issue(params) {
    if (params.amount <= 0n) {
      throw new Error(`Issue amount must be greater than 0, got ${params.amount}`);
    }
    const metadata = castMetadata(params.metadata);
    const virtualCoins = await this.wallet.getVtxos({
      withRecoverable: false
    });
    const controlAssetRef = params.controlAssetId ? AssetRef.fromId(AssetId.fromString(params.controlAssetId)) : null;
    const coinSelection = selectVirtualCoins(virtualCoins, Number(this.wallet.dustAmount));
    let totalBtcSelected = 0n;
    const assetChanges = /* @__PURE__ */ new Map();
    for (const coin of coinSelection.inputs) {
      totalBtcSelected += BigInt(coin.value);
      if (!coin.assets) continue;
      for (const { assetId, amount } of coin.assets) {
        const existing = assetChanges.get(assetId) ?? 0n;
        assetChanges.set(assetId, existing + amount);
      }
    }
    const groups = [];
    const issuedAssetOutput = AssetOutput.create(0, params.amount);
    const issuedAssetGroup = AssetGroup.create(
      null,
      controlAssetRef,
      [],
      [issuedAssetOutput],
      metadata
    );
    groups.push(issuedAssetGroup);
    if (assetChanges.size > 0) {
      const assetInputs = selectedCoinsToAssetInputs(coinSelection.inputs);
      for (const [assetId, amount] of assetChanges) {
        const changeInputs = [];
        for (const [inputIndex, assets] of assetInputs) {
          for (const asset of assets) {
            if (asset.assetId !== assetId) continue;
            changeInputs.push(AssetInput.create(inputIndex, asset.amount));
          }
        }
        groups.push(
          AssetGroup.create(
            AssetId.fromString(assetId),
            null,
            changeInputs,
            [AssetOutput.create(0, amount)],
            []
          )
        );
      }
    }
    const address = await this.wallet.getAddress();
    const outputAddress = ArkAddress.decode(address);
    const outputs = [
      {
        script: outputAddress.pkScript,
        amount: BigInt(totalBtcSelected)
      },
      Extension.create([Packet.create(groups)]).txOut()
    ];
    const { arkTxid } = await this.wallet.buildAndSubmitOffchainTx(
      coinSelection.inputs,
      outputs
    );
    return {
      arkTxId: arkTxid,
      assetId: AssetId.create(arkTxid, 0).toString()
    };
  }
  /**
   * Reissue more units of an existing asset.
   * Requires ownership of the control asset.
   *
   * @param params - Parameters for asset reissuance
   * @param params.assetId - The asset ID to reissue (control asset ID is resolved via getAssetDetails)
   * @param params.amount - Amount of additional units to issue
   * @returns Promise resolving to the Arkade transaction ID
   *
   * @example
   * ```typescript
   * const txid = await wallet.assetManager.reissue({
   *   assetId: 'def456...',
   *   amount: 500
   * });
   * ```
   */
  async reissue(params) {
    if (params.amount <= 0n) {
      throw new Error(`Reissuance amount must be greater than 0, got ${params.amount}`);
    }
    const { controlAssetId } = await this.getAssetDetails(params.assetId);
    if (!controlAssetId) {
      throw new Error(`Asset ${params.assetId} is not reissuable`);
    }
    const virtualCoins = await this.wallet.getVtxos({
      withRecoverable: false
    });
    const assetChanges = /* @__PURE__ */ new Map();
    const { selected: controlCoins } = selectCoinsWithAsset(virtualCoins, controlAssetId, 1n);
    let selectedCoins = [...controlCoins];
    let assetToReissueAmount = 0n;
    for (const coin of controlCoins) {
      if (!coin.assets) continue;
      for (const { assetId, amount } of coin.assets) {
        if (assetId === params.assetId) {
          assetToReissueAmount += amount;
          continue;
        }
        const existing = assetChanges.get(assetId) ?? 0n;
        assetChanges.set(assetId, existing + amount);
      }
    }
    const minBtcNeeded = Number(this.wallet.dustAmount);
    let totalBtcSelected = selectedCoins.reduce((sum, c) => sum + c.value, 0);
    if (totalBtcSelected < minBtcNeeded) {
      const remainingCoins = virtualCoins.filter(
        (c) => !selectedCoins.find((sc) => sc.txid === c.txid && sc.vout === c.vout)
      );
      const additional = selectVirtualCoins(remainingCoins, minBtcNeeded - totalBtcSelected);
      for (const coin of additional.inputs) {
        if (!coin.assets) continue;
        for (const { assetId, amount } of coin.assets) {
          if (assetId === params.assetId) {
            assetToReissueAmount += amount;
            continue;
          }
          const existing = assetChanges.get(assetId) ?? 0n;
          assetChanges.set(assetId, existing + amount);
        }
      }
      selectedCoins = [...selectedCoins, ...additional.inputs];
      totalBtcSelected += additional.inputs.reduce((sum, c) => sum + c.value, 0);
    }
    const assetInputs = selectedCoinsToAssetInputs(selectedCoins);
    const reissueInputs = [];
    for (const [inputIndex, assets] of assetInputs) {
      for (const asset of assets) {
        if (asset.assetId !== params.assetId) continue;
        reissueInputs.push(AssetInput.create(inputIndex, asset.amount));
      }
    }
    const totalAssetAmount = assetToReissueAmount + params.amount;
    const reissueAssetIdObj = AssetId.fromString(params.assetId);
    const reissueAssetGroup = AssetGroup.create(
      reissueAssetIdObj,
      null,
      reissueInputs,
      [AssetOutput.create(0, totalAssetAmount)],
      []
    );
    const groups = [reissueAssetGroup];
    for (const [assetId, amount] of assetChanges) {
      const changeInputs = [];
      for (const [inputIndex, assets] of assetInputs) {
        for (const asset of assets) {
          if (asset.assetId !== assetId) continue;
          changeInputs.push(AssetInput.create(inputIndex, asset.amount));
        }
      }
      groups.push(
        AssetGroup.create(
          AssetId.fromString(assetId),
          null,
          changeInputs,
          [AssetOutput.create(0, amount)],
          []
        )
      );
    }
    const address = await this.wallet.getAddress();
    const outputAddress = ArkAddress.decode(address);
    const outputs = [
      {
        script: outputAddress.pkScript,
        amount: BigInt(totalBtcSelected)
      },
      Extension.create([Packet.create(groups)]).txOut()
    ];
    const { arkTxid } = await this.wallet.buildAndSubmitOffchainTx(selectedCoins, outputs);
    return arkTxid;
  }
  /**
   * Burn assets.
   * @param params - Parameters for burning
   * @param params.assetId - The asset ID to burn
   * @param params.amount - Amount of units to burn
   * @returns Promise resolving to the Arkade transaction ID
   *
   * @example
   * ```typescript
   * const txid = await wallet.assetManager.burn({
   *   assetId: 'abc123...',
   *   amount: 100
   * });
   * ```
   */
  async burn(params) {
    if (params.amount <= 0n) {
      throw new Error(`Burn amount must be greater than 0, got ${params.amount}`);
    }
    const virtualCoins = await this.wallet.getVtxos({
      withRecoverable: false
    });
    const assetChanges = /* @__PURE__ */ new Map();
    const { selected: assetCoins } = selectCoinsWithAsset(
      virtualCoins,
      params.assetId,
      params.amount
    );
    const selectedCoins = [...assetCoins];
    let totalBtcSelected = 0;
    for (const coin of assetCoins) {
      totalBtcSelected += coin.value;
      if (!coin.assets) continue;
      for (const { assetId, amount } of coin.assets) {
        const existing = assetChanges.get(assetId) ?? 0n;
        assetChanges.set(assetId, existing + amount);
      }
    }
    assetChanges.set(params.assetId, (assetChanges.get(params.assetId) ?? 0n) - params.amount);
    const minBtcNeeded = Number(this.wallet.dustAmount);
    if (totalBtcSelected < minBtcNeeded) {
      const remainingCoins = virtualCoins.filter(
        (c) => !selectedCoins.find((sc) => sc.txid === c.txid && sc.vout === c.vout)
      );
      const additional = selectVirtualCoins(remainingCoins, minBtcNeeded - totalBtcSelected);
      for (const coin of additional.inputs) {
        totalBtcSelected += coin.value;
        if (!coin.assets) continue;
        for (const { assetId, amount } of coin.assets) {
          const existing = assetChanges.get(assetId) ?? 0n;
          assetChanges.set(assetId, existing + amount);
        }
      }
      selectedCoins.push(...additional.inputs);
    }
    const groups = [];
    const assetInputs = selectedCoinsToAssetInputs(selectedCoins);
    for (const [assetId, amount] of assetChanges) {
      const changeInputs = [];
      for (const [inputIndex, assets] of assetInputs) {
        for (const asset of assets) {
          if (asset.assetId !== assetId) continue;
          changeInputs.push(AssetInput.create(inputIndex, asset.amount));
        }
      }
      groups.push(
        AssetGroup.create(
          AssetId.fromString(assetId),
          null,
          changeInputs,
          amount > 0n ? [AssetOutput.create(0, amount)] : [],
          []
        )
      );
    }
    const address = await this.wallet.getAddress();
    const outputAddress = ArkAddress.decode(address);
    const outputs = [
      {
        script: outputAddress.pkScript,
        amount: BigInt(totalBtcSelected)
      },
      Extension.create([Packet.create(groups)]).txOut()
    ];
    const { arkTxid } = await this.wallet.buildAndSubmitOffchainTx(selectedCoins, outputs);
    return arkTxid;
  }
};
function castMetadata(metadata) {
  if (!metadata) {
    return [];
  }
  const md = [];
  const textEncoder = new TextEncoder();
  for (const [key, value] of Object.entries(metadata)) {
    let valueBytes;
    if (typeof value === "string") {
      valueBytes = textEncoder.encode(value);
    } else if (typeof value === "number") {
      valueBytes = textEncoder.encode(String(value));
    } else if (value instanceof Uint8Array) {
      valueBytes = value;
    } else if (value instanceof ArrayBuffer) {
      valueBytes = new Uint8Array(value);
    } else {
      throw new Error("Invalid metadata value type");
    }
    md.push(Metadata.create(textEncoder.encode(key), valueBytes));
  }
  return md;
}
var DelegateManagerImpl = class {
  /** Create a delegate manager from the configured provider, Arkade info source, and wallet identity. */
  constructor(delegateProvider, arkInfoProvider, identity) {
    this.delegateProvider = delegateProvider;
    this.arkInfoProvider = arkInfoProvider;
    this.identity = identity;
  }
  async getDelegateInfo() {
    return this.delegateProvider.getDelegateInfo();
  }
  async delegate(vtxos, destination, delegateAt) {
    if (vtxos.length === 0) {
      return { delegated: [], failed: [] };
    }
    const destinationScript = ArkAddress.decode(destination).pkScript;
    const arkInfo = await this.arkInfoProvider.getInfo();
    const delegateInfo = await this.delegateProvider.getDelegateInfo();
    const eligible = vtxos.filter(
      (v) => isAnnotated(v) && findDelegateTapLeaf(v, delegateInfo.pubkey) !== void 0
    );
    if (eligible.length === 0) {
      return { delegated: [], failed: [] };
    }
    if (delegateAt) {
      try {
        await delegate(
          this.identity,
          this.delegateProvider,
          arkInfo,
          delegateInfo,
          eligible,
          destinationScript,
          delegateAt
        );
      } catch (error) {
        return {
          delegated: [],
          failed: [{ outpoints: eligible, error }]
        };
      }
      return { delegated: eligible, failed: [] };
    }
    const groupByExpiry = /* @__PURE__ */ new Map();
    let recoverableVtxos = [];
    for (const vtxo of eligible) {
      if (isRecoverable(vtxo)) {
        recoverableVtxos.push(vtxo);
        continue;
      }
      const expiry = vtxo.virtualStatus.batchExpiry;
      if (!expiry) continue;
      const dayKey = getDayTimestamp(expiry);
      groupByExpiry.set(dayKey, [...groupByExpiry.get(dayKey) ?? [], vtxo]);
    }
    if (groupByExpiry.size === 0) {
      try {
        await delegate(
          this.identity,
          this.delegateProvider,
          arkInfo,
          delegateInfo,
          recoverableVtxos,
          destinationScript,
          delegateAt
        );
      } catch (error) {
        return {
          delegated: [],
          failed: [{ outpoints: recoverableVtxos, error }]
        };
      }
      return { delegated: recoverableVtxos, failed: [] };
    }
    const earliestGroup = Math.min(...groupByExpiry.keys());
    groupByExpiry.set(earliestGroup, [
      ...groupByExpiry.get(earliestGroup) ?? [],
      ...recoverableVtxos
    ]);
    const groupsList = Array.from(groupByExpiry.entries());
    const result = await Promise.allSettled(
      groupsList.map(
        async ([, vtxosGroup]) => delegate(
          this.identity,
          this.delegateProvider,
          arkInfo,
          delegateInfo,
          vtxosGroup,
          destinationScript
        )
      )
    );
    const delegated = [];
    const failed = [];
    for (const [index, resultItem] of result.entries()) {
      const vtxos2 = groupsList[index][1];
      if (resultItem.status === "rejected") {
        failed.push({ outpoints: vtxos2, error: resultItem.reason });
        continue;
      }
      delegated.push(...vtxos2);
    }
    return { delegated, failed };
  }
};
var DelegatorManagerImpl = DelegateManagerImpl;
async function delegate(identity, delegateProvider, arkInfo, delegateInfo, vtxos, destinationScript, delegateAt) {
  if (vtxos.length === 0) {
    throw new Error("unable to delegate: no vtxos provided");
  }
  if (!delegateProvider) {
    throw new Error("unable to delegate: delegate provider not configured");
  }
  if (!delegateAt) {
    const expiryTimestamp = vtxos.filter((coin) => !isRecoverable(coin) && coin.virtualStatus.batchExpiry).reduce(
      (min, coin) => Math.min(min, coin.virtualStatus.batchExpiry),
      Number.MAX_SAFE_INTEGER
    );
    if (!expiryTimestamp || expiryTimestamp === Number.MAX_SAFE_INTEGER) {
      delegateAt = new Date(Date.now() + 1 * 60 * 1e3);
    } else {
      const remainingTimeMs = expiryTimestamp - Date.now();
      if (remainingTimeMs <= 0) {
        delegateAt = new Date(Date.now() + 1 * 60 * 1e3);
      } else {
        delegateAt = new Date(expiryTimestamp - remainingTimeMs * 0.1);
      }
    }
  }
  const { fees, dust, forfeitAddress, network } = arkInfo;
  const delegateAtSeconds = delegateAt.getTime() / 1e3;
  const estimator = new Estimator({
    ...fees.intentFee,
    // replace now() function with the delegateAt timestamp
    offchainInput: fees.intentFee.offchainInput?.replace(
      "now()",
      `double(${delegateAtSeconds})`
    ),
    offchainOutput: fees.intentFee.offchainOutput?.replace(
      "now()",
      `double(${delegateAtSeconds})`
    )
  });
  let amount = 0n;
  for (const coin of vtxos) {
    const inputFee = estimator.evalOffchainInput({
      amount: BigInt(coin.value),
      type: "vtxo",
      weight: 0,
      birth: coin.createdAt,
      expiry: coin.virtualStatus.batchExpiry ? new Date(coin.virtualStatus.batchExpiry) : void 0
    });
    if (inputFee.value >= coin.value) {
      continue;
    }
    amount += BigInt(coin.value) - BigInt(inputFee.value);
  }
  const { pubkey, fee } = delegateInfo;
  const delegateAddress = delegateInfo.delegateAddress;
  const outputs = [];
  const delegateFee = BigInt(Number(fee));
  if (delegateFee > 0n) {
    outputs.push({
      script: ArkAddress.decode(delegateAddress).pkScript,
      amount: delegateFee
    });
  }
  const outputFee = outputs.reduce((fee2, output) => {
    if (!output.amount || !output.script) return fee2;
    return fee2 + estimator.evalOffchainOutput({
      amount: output.amount,
      script: hex.encode(output.script)
    }).satoshis;
  }, 0);
  if (amount - BigInt(outputFee) <= dust) {
    throw new Error("Amount is below dust limit, cannot delegate");
  }
  amount -= BigInt(outputFee);
  amount -= delegateFee;
  if (amount <= dust) {
    throw new Error("Amount is below dust limit, cannot delegate");
  }
  outputs.push({
    script: destinationScript,
    amount
  });
  const registerIntent = await makeSignedDelegateIntent(
    identity,
    vtxos,
    outputs,
    [],
    [pubkey],
    delegateAtSeconds,
    destinationScript
  );
  const forfeitOutputScript = OutScript.encode(
    Address(getNetwork(network)).decode(forfeitAddress)
  );
  const forfeits = await Promise.all(
    vtxos.filter((v) => !isRecoverable(v)).map(async (coin) => {
      const forfeit = await makeDelegateForfeitTx(
        coin,
        dust,
        pubkey,
        forfeitOutputScript,
        identity
      );
      return base64.encode(forfeit.toPSBT());
    })
  );
  await delegateProvider.delegate(registerIntent, forfeits);
}
async function makeDelegateForfeitTx(input, connectorAmount, delegatePubkey, forfeitOutputScript, identity) {
  const delegateTapLeaf = findDelegateTapLeaf(input, delegatePubkey);
  if (!delegateTapLeaf) {
    throw new Error(`delegate tap leaf not found for input: ${input.txid}:${input.vout}`);
  }
  const tx = buildForfeitTxWithOutput(
    [
      {
        txid: input.txid,
        index: input.vout,
        witnessUtxo: {
          amount: BigInt(input.value),
          script: VtxoScript.decode(input.tapTree).pkScript
        },
        sighashType: SigHash.ALL_ANYONECANPAY,
        tapLeafScript: [delegateTapLeaf]
      }
    ],
    {
      script: forfeitOutputScript,
      amount: BigInt(input.value) + connectorAmount
    }
  );
  return identity.sign(tx);
}
async function makeSignedDelegateIntent(identity, coins, outputs, onchainOutputsIndexes, cosignerPubKeys, validAt, destinationScript) {
  const assetInputs = /* @__PURE__ */ new Map();
  for (let i = 0; i < coins.length; i++) {
    if ("assets" in coins[i]) {
      const assets = coins[i].assets;
      if (assets && assets.length > 0) {
        assetInputs.set(i + 1, assets);
      }
    }
  }
  let outputAssets;
  const assetOutputIndex = findDestinationOutputIndex(outputs, destinationScript);
  if (assetInputs.size > 0) {
    if (assetOutputIndex === -1) {
      throw new Error("Cannot assign assets: no output matches the destination address");
    }
    const allAssets = /* @__PURE__ */ new Map();
    for (const [, assets] of assetInputs) {
      for (const asset of assets) {
        const existing = allAssets.get(asset.assetId) ?? 0n;
        allAssets.set(asset.assetId, existing + asset.amount);
      }
    }
    outputAssets = [];
    for (const [assetId, amount] of allAssets) {
      outputAssets.push({ assetId, amount });
    }
  }
  const recipients = outputs.map((output, i) => ({
    address: "",
    // not needed for asset packet creation
    amount: Number(output.amount),
    assets: i === assetOutputIndex ? outputAssets : void 0
  }));
  if (outputAssets && outputAssets.length > 0) {
    const assetPacket = createAssetPacket(assetInputs, recipients);
    outputs.push(Extension.create([assetPacket]).txOut());
  }
  const message = {
    type: "register",
    onchain_output_indexes: onchainOutputsIndexes,
    valid_at: Math.floor(validAt),
    expire_at: 0,
    cosigners_public_keys: cosignerPubKeys
  };
  const proof = Intent.create(message, coins, outputs);
  const signedProof = await identity.sign(proof);
  return {
    proof: base64.encode(signedProof.toPSBT()),
    message
  };
}
function findDestinationOutputIndex(outputs, destinationScript) {
  return outputs.findIndex((o) => o.script && equalBytes$1(o.script, destinationScript));
}
function getDayTimestamp(timestamp) {
  const date = new Date(timestamp);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}
function findDelegateTapLeaf(vtxo, delegatePubkey) {
  if (!vtxo.tapTree) return void 0;
  const pk = delegatePubkey.length === 66 ? delegatePubkey.slice(2) : delegatePubkey;
  const vtxoScript = VtxoScript.decode(vtxo.tapTree);
  return vtxoScript.leaves.find((tapLeaf) => {
    const arkTapscript = decodeTapscript(scriptFromTapLeafScript(tapLeaf));
    if (!MultisigTapscript.is(arkTapscript)) return false;
    return arkTapscript.params.pubkeys.map(hex.encode).includes(pk);
  });
}
function isAnnotated(v) {
  return v.tapTree !== void 0 && v.forfeitTapLeafScript !== void 0 && v.intentTapLeafScript !== void 0;
}

// src/contracts/vtxoOwnership.ts
function vtxoOutpoint(vtxo) {
  return `${vtxo.txid}:${vtxo.vout}`;
}
function isVtxoForScript(vtxo, script) {
  return !!vtxo.script && vtxo.script === script;
}
function filterVtxosForScript(vtxos, script) {
  return vtxos.filter((v) => isVtxoForScript(v, script));
}
function warnAndFilterVtxosForScript(vtxos, script, context) {
  const matches = [];
  const rejected = [];
  for (const v of vtxos) {
    if (isVtxoForScript(v, script)) {
      matches.push(v);
    } else {
      rejected.push(`${vtxoOutpoint(v)}(script=${v.script ?? ""})`);
    }
  }
  if (rejected.length > 0) {
    console.warn(
      `${context}: dropped ${rejected.length} wrong-script VTXO(s) for script ${script}: ${rejected.join(", ")}`
    );
  }
  return matches;
}
function validateVtxosForScript(vtxos, script, context) {
  const mismatches = vtxos.filter((v) => !isVtxoForScript(v, script));
  if (mismatches.length === 0) return;
  const detail = mismatches.map((v) => `${vtxoOutpoint(v)}(script=${v.script ?? ""})`).join(", ");
  throw new Error(
    `${context}: refusing to persist ${mismatches.length} VTXO(s) whose script does not match ${script}: ${detail}`
  );
}
async function getVtxosForContract(repo, contract) {
  return repo.getVtxosForScript ? repo.getVtxosForScript(contract.script) : filterVtxosForScript(await repo.getVtxos(contract.address), contract.script);
}
async function saveVtxosForContract(repo, contract, vtxos) {
  if (repo.saveVtxosForScript) {
    return repo.saveVtxosForScript(
      { script: contract.script, address: contract.address },
      vtxos
    );
  }
  validateVtxosForScript(vtxos, contract.script, "saveVtxosForContract");
  return repo.saveVtxos(contract.address, vtxos);
}

// src/repositories/inMemory/walletRepository.ts
var InMemoryWalletRepository = class {
  version = 1;
  vtxosByAddress = /* @__PURE__ */ new Map();
  utxosByAddress = /* @__PURE__ */ new Map();
  txsByAddress = /* @__PURE__ */ new Map();
  walletState = null;
  async getVtxos(address) {
    return this.vtxosByAddress.get(address) ?? [];
  }
  async saveVtxos(address, vtxos) {
    const existing = this.vtxosByAddress.get(address) ?? [];
    const next = mergeByKey(existing, vtxos, (item) => `${item.txid}:${item.vout}`);
    this.vtxosByAddress.set(address, next);
  }
  async deleteVtxos(address) {
    this.vtxosByAddress.delete(address);
  }
  async getVtxosForScript(script) {
    const allMatches = [];
    for (const bucket of this.vtxosByAddress.values()) {
      for (const vtxo of bucket) {
        if (isVtxoForScript(vtxo, script)) {
          allMatches.push(vtxo);
        }
      }
    }
    return mergeByKey([], allMatches, (item) => `${item.txid}:${item.vout}`);
  }
  async saveVtxosForScript(key, vtxos) {
    if (!key.address) {
      throw new Error("InMemoryWalletRepository requires an address");
    }
    for (const vtxo of vtxos) {
      if (!isVtxoForScript(vtxo, key.script)) {
        throw new Error(
          `VTXO ${vtxo.txid}:${vtxo.vout} script mismatch: expected ${key.script}, got ${vtxo.script}`
        );
      }
    }
    return this.saveVtxos(key.address, vtxos);
  }
  async deleteVtxosForScript(script) {
    for (const [address, bucket] of this.vtxosByAddress.entries()) {
      const next = bucket.filter((v) => !isVtxoForScript(v, script));
      if (next.length === 0) {
        this.vtxosByAddress.delete(address);
      } else {
        this.vtxosByAddress.set(address, next);
      }
    }
  }
  async getUtxos(address) {
    return this.utxosByAddress.get(address) ?? [];
  }
  async saveUtxos(address, utxos) {
    const existing = this.utxosByAddress.get(address) ?? [];
    const next = mergeByKey(existing, utxos, (item) => `${item.txid}:${item.vout}`);
    this.utxosByAddress.set(address, next);
  }
  async deleteUtxos(address) {
    this.utxosByAddress.delete(address);
  }
  async getTransactionHistory(address) {
    return this.txsByAddress.get(address) ?? [];
  }
  async saveTransactions(address, txs) {
    const existing = this.txsByAddress.get(address) ?? [];
    const next = mergeByKey(existing, txs, serializeTxKey);
    this.txsByAddress.set(address, next);
  }
  async deleteTransactions(address) {
    this.txsByAddress.delete(address);
  }
  async getWalletState() {
    return this.walletState;
  }
  async saveWalletState(state) {
    this.walletState = state;
  }
  async clear() {
    this.vtxosByAddress.clear();
    this.utxosByAddress.clear();
    this.txsByAddress.clear();
    this.walletState = null;
  }
  async [Symbol.asyncDispose]() {
    return;
  }
};
function serializeTxKey(tx) {
  const key = tx.key;
  return `${key.boardingTxid}:${key.commitmentTxid}:${key.arkTxid}`;
}
function mergeByKey(existing, incoming, toKey) {
  const next = /* @__PURE__ */ new Map();
  existing.forEach((item) => {
    next.set(toKey(item), item);
  });
  incoming.forEach((item) => {
    next.set(toKey(item), item);
  });
  return Array.from(next.values());
}

// src/repositories/inMemory/contractRepository.ts
var InMemoryContractRepository = class {
  version = 1;
  contractData = /* @__PURE__ */ new Map();
  collections = /* @__PURE__ */ new Map();
  contractsByScript = /* @__PURE__ */ new Map();
  async clear() {
    this.contractData.clear();
    this.collections.clear();
    this.contractsByScript.clear();
  }
  // Contract entity management methods
  async getContracts(filter) {
    const contracts = this.contractsByScript.values();
    if (!filter) {
      return [...contracts];
    }
    const matches = (value, criterion) => {
      if (criterion === void 0) {
        return true;
      }
      return Array.isArray(criterion) ? criterion.includes(value) : value === criterion;
    };
    const results = [];
    for (const contract of contracts) {
      if (matches(contract.script, filter.script) && matches(contract.state, filter.state) && matches(contract.type, filter.type)) {
        results.push(contract);
      }
    }
    return results;
  }
  async saveContract(contract) {
    this.contractsByScript.set(contract.script, contract);
  }
  async deleteContract(script) {
    this.contractsByScript.delete(script);
  }
  async [Symbol.asyncDispose]() {
    return;
  }
};
function scriptFromArkAddress(address) {
  return hex.encode(ArkAddress.decode(address).pkScript);
}

// src/repositories/indexedDB/schema.ts
var STORE_VTXOS = "vtxos";
var STORE_UTXOS = "utxos";
var STORE_TRANSACTIONS = "transactions";
var STORE_WALLET_STATE = "walletState";
var STORE_CONTRACTS = "contracts";
var LEGACY_STORE_CONTRACT_COLLECTIONS = "contractsCollections";
var DB_VERSION = 3;
function initDatabase(db, oldVersion, transaction) {
  if (!db.objectStoreNames.contains(STORE_VTXOS)) {
    const vtxosStore = db.createObjectStore(STORE_VTXOS, {
      keyPath: ["address", "txid", "vout"]
    });
    if (!vtxosStore.indexNames.contains("address")) {
      vtxosStore.createIndex("address", "address", {
        unique: false
      });
    }
    if (!vtxosStore.indexNames.contains("txid")) {
      vtxosStore.createIndex("txid", "txid", { unique: false });
    }
    if (!vtxosStore.indexNames.contains("value")) {
      vtxosStore.createIndex("value", "value", { unique: false });
    }
    if (!vtxosStore.indexNames.contains("status")) {
      vtxosStore.createIndex("status", "status", {
        unique: false
      });
    }
    if (!vtxosStore.indexNames.contains("virtualStatus")) {
      vtxosStore.createIndex("virtualStatus", "virtualStatus", {
        unique: false
      });
    }
    if (!vtxosStore.indexNames.contains("createdAt")) {
      vtxosStore.createIndex("createdAt", "createdAt", {
        unique: false
      });
    }
    if (!vtxosStore.indexNames.contains("isSpent")) {
      vtxosStore.createIndex("isSpent", "isSpent", {
        unique: false
      });
    }
    if (!vtxosStore.indexNames.contains("isUnrolled")) {
      vtxosStore.createIndex("isUnrolled", "isUnrolled", {
        unique: false
      });
    }
    if (!vtxosStore.indexNames.contains("spentBy")) {
      vtxosStore.createIndex("spentBy", "spentBy", {
        unique: false
      });
    }
    if (!vtxosStore.indexNames.contains("settledBy")) {
      vtxosStore.createIndex("settledBy", "settledBy", {
        unique: false
      });
    }
    if (!vtxosStore.indexNames.contains("arkTxId")) {
      vtxosStore.createIndex("arkTxId", "arkTxId", {
        unique: false
      });
    }
    if (!vtxosStore.indexNames.contains("script")) {
      vtxosStore.createIndex("script", "script", {
        unique: false
      });
    }
  }
  if (!db.objectStoreNames.contains(STORE_UTXOS)) {
    const utxosStore = db.createObjectStore(STORE_UTXOS, {
      keyPath: ["address", "txid", "vout"]
    });
    if (!utxosStore.indexNames.contains("address")) {
      utxosStore.createIndex("address", "address", {
        unique: false
      });
    }
    if (!utxosStore.indexNames.contains("txid")) {
      utxosStore.createIndex("txid", "txid", { unique: false });
    }
    if (!utxosStore.indexNames.contains("value")) {
      utxosStore.createIndex("value", "value", { unique: false });
    }
    if (!utxosStore.indexNames.contains("status")) {
      utxosStore.createIndex("status", "status", {
        unique: false
      });
    }
  }
  if (!db.objectStoreNames.contains(STORE_TRANSACTIONS)) {
    const transactionsStore = db.createObjectStore(STORE_TRANSACTIONS, {
      keyPath: ["address", "keyBoardingTxid", "keyCommitmentTxid", "keyArkTxid"]
    });
    if (!transactionsStore.indexNames.contains("address")) {
      transactionsStore.createIndex("address", "address", {
        unique: false
      });
    }
    if (!transactionsStore.indexNames.contains("type")) {
      transactionsStore.createIndex("type", "type", {
        unique: false
      });
    }
    if (!transactionsStore.indexNames.contains("amount")) {
      transactionsStore.createIndex("amount", "amount", {
        unique: false
      });
    }
    if (!transactionsStore.indexNames.contains("settled")) {
      transactionsStore.createIndex("settled", "settled", {
        unique: false
      });
    }
    if (!transactionsStore.indexNames.contains("createdAt")) {
      transactionsStore.createIndex("createdAt", "createdAt", {
        unique: false
      });
    }
    if (!transactionsStore.indexNames.contains("arkTxid")) {
      transactionsStore.createIndex("arkTxid", "key.arkTxid", {
        unique: false
      });
    }
  }
  if (!db.objectStoreNames.contains(STORE_WALLET_STATE)) {
    db.createObjectStore(STORE_WALLET_STATE, {
      keyPath: "key"
    });
  }
  if (!db.objectStoreNames.contains(STORE_CONTRACTS)) {
    const contractsStore = db.createObjectStore(STORE_CONTRACTS, {
      keyPath: "script"
    });
    if (!contractsStore.indexNames.contains("type")) {
      contractsStore.createIndex("type", "type", {
        unique: false
      });
    }
    if (!contractsStore.indexNames.contains("state")) {
      contractsStore.createIndex("state", "state", {
        unique: false
      });
    }
  }
  if (!db.objectStoreNames.contains(LEGACY_STORE_CONTRACT_COLLECTIONS)) {
    db.createObjectStore(LEGACY_STORE_CONTRACT_COLLECTIONS, {
      keyPath: "key"
    });
  }
  if (oldVersion >= 1 && oldVersion < 3 && transaction) {
    const vtxosStore = transaction.objectStore(STORE_VTXOS);
    if (!vtxosStore.indexNames.contains("script")) {
      vtxosStore.createIndex("script", "script", { unique: false });
    }
    backfillVtxoScripts(transaction);
  }
}
function backfillVtxoScripts(transaction) {
  const store = transaction.objectStore(STORE_VTXOS);
  const cursorRequest = store.openCursor();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    const value = cursor.value;
    if (!value.script) {
      value.script = scriptFromArkAddress(value.address);
      cursor.update(value);
    }
    cursor.continue();
  };
}
var serializeTapLeaf = ([cb, s]) => ({
  cb: hex.encode(TaprootControlBlock.encode(cb)),
  s: hex.encode(s)
});
var serializeAsset = (a) => ({
  assetId: a.assetId,
  amount: a.amount.toString()
});
var deserializeAsset = (a) => {
  if (typeof a.amount === "number" && !Number.isSafeInteger(a.amount)) {
    throw new Error(
      `Unsafe legacy asset amount for ${a.assetId}; re-sync from the original source`
    );
  }
  return {
    assetId: a.assetId,
    amount: typeof a.amount === "bigint" ? a.amount : BigInt(a.amount)
  };
};
var serializeAssets = (assets) => assets?.map(serializeAsset);
var deserializeAssets = (assets) => assets?.map(deserializeAsset);
var serializeVtxo = (v) => ({
  ...v,
  tapTree: hex.encode(v.tapTree),
  forfeitTapLeafScript: serializeTapLeaf(v.forfeitTapLeafScript),
  intentTapLeafScript: serializeTapLeaf(v.intentTapLeafScript),
  extraWitness: v.extraWitness?.map(hex.encode),
  assets: serializeAssets(v.assets)
});
var serializeUtxo = (u) => ({
  ...u,
  tapTree: hex.encode(u.tapTree),
  forfeitTapLeafScript: serializeTapLeaf(u.forfeitTapLeafScript),
  intentTapLeafScript: serializeTapLeaf(u.intentTapLeafScript),
  extraWitness: u.extraWitness?.map(hex.encode)
});
var serializeTransaction = (t) => ({
  ...t,
  assets: serializeAssets(t.assets)
});
var deserializeTapLeaf = (t) => {
  const cb = TaprootControlBlock.decode(hex.decode(t.cb));
  const s = hex.decode(t.s);
  return [cb, s];
};
var deserializeVtxo = (o) => ({
  ...o,
  createdAt: new Date(o.createdAt),
  tapTree: hex.decode(o.tapTree),
  forfeitTapLeafScript: deserializeTapLeaf(o.forfeitTapLeafScript),
  intentTapLeafScript: deserializeTapLeaf(o.intentTapLeafScript),
  extraWitness: o.extraWitness?.map(hex.decode),
  assets: deserializeAssets(o.assets)
});
var deserializeUtxo = (o) => ({
  ...o,
  tapTree: hex.decode(o.tapTree),
  forfeitTapLeafScript: deserializeTapLeaf(o.forfeitTapLeafScript),
  intentTapLeafScript: deserializeTapLeaf(o.intentTapLeafScript),
  extraWitness: o.extraWitness?.map(hex.decode)
});
var deserializeTransaction = (o) => ({
  ...o,
  assets: deserializeAssets(o.assets)
});

// src/repositories/indexedDB/manager.ts
function getGlobalObject() {
  if (typeof globalThis !== "undefined") {
    if (typeof globalThis.self === "object" && globalThis.self !== null) {
      return { globalObject: globalThis.self };
    }
    if (typeof globalThis.window === "object" && globalThis.window !== null) {
      return { globalObject: globalThis.window };
    }
    return { globalObject: globalThis };
  }
  throw new Error("Global object not found");
}
var dbCache = /* @__PURE__ */ new Map();
var refCounts = /* @__PURE__ */ new Map();
async function openDatabase(dbName, dbVersion, initDatabase2) {
  const { globalObject } = getGlobalObject();
  if (!globalObject.indexedDB) {
    throw new Error("IndexedDB is not available in this environment");
  }
  const cached = dbCache.get(dbName);
  if (cached) {
    if (cached.version !== dbVersion) {
      throw new Error(
        `Database "${dbName}" already opened with version ${cached.version}; requested ${dbVersion}`
      );
    }
    refCounts.set(dbName, (refCounts.get(dbName) ?? 0) + 1);
    return cached.promise;
  }
  const dbPromise = new Promise((resolve, reject) => {
    const request = globalObject.indexedDB.open(dbName, dbVersion);
    request.onerror = () => {
      dbCache.delete(dbName);
      refCounts.delete(dbName);
      reject(request.error);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onupgradeneeded = (event) => {
      const db = request.result;
      initDatabase2(db, event.oldVersion, request.transaction);
    };
    request.onblocked = () => {
      console.warn("Database upgrade blocked - close other tabs/connections");
    };
  });
  dbCache.set(dbName, { version: dbVersion, promise: dbPromise });
  refCounts.set(dbName, 1);
  return dbPromise;
}
async function closeDatabase(dbName) {
  const cachedEntry = dbCache.get(dbName);
  if (!cachedEntry) return false;
  const count = (refCounts.get(dbName) ?? 1) - 1;
  if (count > 0) {
    refCounts.set(dbName, count);
    return false;
  }
  refCounts.delete(dbName);
  dbCache.delete(dbName);
  try {
    const db = await cachedEntry.promise;
    db.close();
  } catch {
  }
  return true;
}

// src/worker/browser/utils.ts
var DEFAULT_DB_NAME = "arkade-service-worker";
var DEFAULT_SERVICE_WORKER_ACTIVATION_TIMEOUT_MS = 1e4;
function normalizeOptions2(pathOrOptions) {
  if (typeof pathOrOptions === "string") {
    return {
      path: pathOrOptions,
      activationTimeoutMs: DEFAULT_SERVICE_WORKER_ACTIVATION_TIMEOUT_MS
    };
  }
  return {
    path: pathOrOptions.path,
    activationTimeoutMs: pathOrOptions.activationTimeoutMs ?? DEFAULT_SERVICE_WORKER_ACTIVATION_TIMEOUT_MS
  };
}
function waitForServiceWorkerReady(timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Service worker activation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    navigator.serviceWorker.ready.then((registration) => {
      clearTimeout(timeoutId);
      resolve(registration);
    }).catch((error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
  });
}
async function setupServiceWorker(pathOrOptions) {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service workers are not supported in this browser");
  }
  const { path, activationTimeoutMs } = normalizeOptions2(pathOrOptions);
  const registration = await navigator.serviceWorker.register(path);
  await registration.update();
  const serviceWorker = registration.active || registration.waiting || registration.installing;
  if (!serviceWorker) {
    throw new Error("Failed to get service worker instance");
  }
  if (serviceWorker.state === "activated") {
    return serviceWorker;
  }
  const readyRegistration = await waitForServiceWorkerReady(activationTimeoutMs);
  if (!readyRegistration.active) {
    throw new Error("Service worker registration is ready but has no active worker");
  }
  return readyRegistration.active;
}

// src/repositories/indexedDB/contractRepository.ts
var IndexedDBContractRepository = class {
  constructor(dbName = DEFAULT_DB_NAME) {
    this.dbName = dbName;
  }
  version = 1;
  db = null;
  async clear() {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_CONTRACTS], "readwrite");
        const contractDataStore = transaction.objectStore(STORE_CONTRACTS);
        const contractsStore = transaction.objectStore(STORE_CONTRACTS);
        const contractDataRequest = contractDataStore.clear();
        const contractsRequest = contractsStore.clear();
        let completed = 0;
        const checkComplete = () => {
          completed++;
          if (completed === 2) {
            resolve();
          }
        };
        contractDataRequest.onsuccess = checkComplete;
        contractsRequest.onsuccess = checkComplete;
        contractDataRequest.onerror = () => reject(contractDataRequest.error);
        contractsRequest.onerror = () => reject(contractsRequest.error);
      });
    } catch (error) {
      console.error("Failed to clear contract data:", error);
      throw error;
    }
  }
  async getContracts(filter) {
    try {
      const db = await this.getDB();
      const store = db.transaction([STORE_CONTRACTS], "readonly").objectStore(STORE_CONTRACTS);
      if (!filter || Object.keys(filter).length === 0) {
        return new Promise((resolve, reject) => {
          const request = store.getAll();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result ?? []);
        });
      }
      const normalizedFilter = normalizeFilter(filter);
      if (normalizedFilter.has("script")) {
        const scripts = normalizedFilter.get("script");
        const contracts = await Promise.all(
          scripts.map(
            (script) => new Promise((resolve, reject) => {
              const req = store.get(script);
              req.onerror = () => reject(req.error);
              req.onsuccess = () => resolve(req.result);
            })
          )
        );
        return this.applyContractFilter(contracts, normalizedFilter);
      }
      if (normalizedFilter.has("state")) {
        const contracts = await this.getContractsByIndexValues(
          store,
          "state",
          normalizedFilter.get("state")
        );
        return this.applyContractFilter(contracts, normalizedFilter);
      }
      if (normalizedFilter.has("type")) {
        const contracts = await this.getContractsByIndexValues(
          store,
          "type",
          normalizedFilter.get("type")
        );
        return this.applyContractFilter(contracts, normalizedFilter);
      }
      const allContracts = await new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result ?? []);
      });
      return this.applyContractFilter(allContracts, normalizedFilter);
    } catch (error) {
      console.error("Failed to get contracts:", error);
      return [];
    }
  }
  async saveContract(contract) {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_CONTRACTS], "readwrite");
        const store = transaction.objectStore(STORE_CONTRACTS);
        const request = store.put(contract);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
      });
    } catch (error) {
      console.error("Failed to save contract:", error);
      throw error;
    }
  }
  async deleteContract(script) {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_CONTRACTS], "readwrite");
        const store = transaction.objectStore(STORE_CONTRACTS);
        const getRequest = store.get(script);
        getRequest.onerror = () => reject(getRequest.error);
        getRequest.onsuccess = () => {
          const request = store.delete(script);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve();
        };
      });
    } catch (error) {
      console.error(`Failed to delete contract ${script}:`, error);
      throw error;
    }
  }
  getContractsByIndexValues(store, indexName, values) {
    if (values.length === 0) return Promise.resolve([]);
    const index = store.index(indexName);
    const requests = values.map(
      (value) => new Promise((resolve, reject) => {
        const request = index.getAll(value);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result ?? []);
      })
    );
    return Promise.all(requests).then((results) => results.flatMap((result) => result));
  }
  applyContractFilter(contracts, filter) {
    return contracts.filter((contract) => {
      if (contract === void 0) return false;
      if (filter.has("script") && !filter.get("script")?.includes(contract.script))
        return false;
      if (filter.has("state") && !filter.get("state")?.includes(contract.state)) return false;
      if (filter.has("type") && !filter.get("type")?.includes(contract.type)) return false;
      return true;
    });
  }
  async getDB() {
    if (this.db) return this.db;
    this.db = await openDatabase(this.dbName, DB_VERSION, initDatabase);
    return this.db;
  }
  async [Symbol.asyncDispose]() {
    if (!this.db) return;
    await closeDatabase(this.dbName);
    this.db = null;
  }
};
var FILTER_FIELDS = ["script", "state", "type"];
function normalizeFilter(filter) {
  const res = /* @__PURE__ */ new Map();
  FILTER_FIELDS.forEach((current) => {
    if (!filter?.[current]) return;
    if (Array.isArray(filter[current])) {
      res.set(current, filter[current]);
    } else {
      res.set(current, [filter[current]]);
    }
  });
  return res;
}

// src/repositories/indexedDB/walletRepository.ts
var IndexedDBWalletRepository = class {
  constructor(dbName = DEFAULT_DB_NAME) {
    this.dbName = dbName;
  }
  version = 1;
  db = null;
  async clear() {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(
          [STORE_VTXOS, STORE_UTXOS, STORE_TRANSACTIONS, STORE_WALLET_STATE],
          "readwrite"
        );
        const vtxosStore = transaction.objectStore(STORE_VTXOS);
        const utxosStore = transaction.objectStore(STORE_UTXOS);
        const transactionsStore = transaction.objectStore(STORE_TRANSACTIONS);
        const walletStateStore = transaction.objectStore(STORE_WALLET_STATE);
        const requests = [
          vtxosStore.clear(),
          utxosStore.clear(),
          transactionsStore.clear(),
          walletStateStore.clear()
        ];
        let completed = 0;
        const checkComplete = () => {
          completed++;
          if (completed === requests.length) {
            resolve();
          }
        };
        requests.forEach((request) => {
          request.onsuccess = checkComplete;
          request.onerror = () => reject(request.error);
        });
      });
    } catch (error) {
      console.error("Failed to clear wallet data:", error);
      throw error;
    }
  }
  async [Symbol.asyncDispose]() {
    if (!this.db) return;
    await closeDatabase(this.dbName);
    this.db = null;
  }
  async getVtxos(address) {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_VTXOS], "readonly");
        const store = transaction.objectStore(STORE_VTXOS);
        const index = store.index("address");
        const request = index.getAll(address);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const results = request.result || [];
          try {
            resolve(results.map(deserializeVtxoWithBackfill));
          } catch (err) {
            reject(err);
          }
        };
      });
    } catch (error) {
      console.error(`Failed to get VTXOs for address ${address}:`, error);
      return [];
    }
  }
  async saveVtxos(address, vtxos) {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_VTXOS], "readwrite");
        const store = transaction.objectStore(STORE_VTXOS);
        const promises = vtxos.map((vtxo) => {
          return new Promise((resolveItem, rejectItem) => {
            const serialized = serializeVtxo(vtxo);
            const item = {
              address,
              ...serialized
            };
            const request = store.put(item);
            request.onerror = () => rejectItem(request.error);
            request.onsuccess = () => resolveItem();
          });
        });
        Promise.all(promises).then(() => resolve()).catch(reject);
        transaction.onerror = () => reject(transaction.error);
      });
    } catch (error) {
      console.error(`Failed to save VTXOs for address ${address}:`, error);
      throw error;
    }
  }
  async deleteVtxos(address) {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_VTXOS], "readwrite");
        const store = transaction.objectStore(STORE_VTXOS);
        const index = store.index("address");
        const request = index.openCursor(IDBKeyRange.only(address));
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            resolve();
          }
        };
      });
    } catch (error) {
      console.error(`Failed to clear VTXOs for address ${address}:`, error);
      throw error;
    }
  }
  async getVtxosForScript(script) {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_VTXOS], "readonly");
        const store = transaction.objectStore(STORE_VTXOS);
        const index = store.index("script");
        const request = index.getAll(script);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const results = request.result || [];
          try {
            const matching = results.filter((r) => r.script === script);
            const byOutpoint = /* @__PURE__ */ new Map();
            for (const row of matching) {
              const outpoint = `${row.txid}:${row.vout}`;
              const existing = byOutpoint.get(outpoint);
              if (!existing) {
                byOutpoint.set(outpoint, row);
                continue;
              }
              if (shouldReplaceVtxo(existing, row)) {
                byOutpoint.set(outpoint, row);
              }
            }
            resolve(Array.from(byOutpoint.values()).map(deserializeVtxoWithBackfill));
          } catch (err) {
            reject(err);
          }
        };
      });
    } catch (error) {
      console.error(`Failed to get VTXOs for script ${script}:`, error);
      throw error;
    }
  }
  async saveVtxosForScript(key, vtxos) {
    if (!key.address) {
      throw new Error("IndexedDBWalletRepository requires an address");
    }
    for (const vtxo of vtxos) {
      if (!isVtxoForScript(vtxo, key.script)) {
        throw new Error(
          `VTXO ${vtxo.txid}:${vtxo.vout} script mismatch: expected ${key.script}, got ${vtxo.script}`
        );
      }
    }
    return this.saveVtxos(key.address, vtxos);
  }
  async deleteVtxosForScript(script) {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_VTXOS], "readwrite");
        const store = transaction.objectStore(STORE_VTXOS);
        const index = store.index("script");
        const request = index.openCursor(IDBKeyRange.only(script));
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            resolve();
          }
        };
      });
    } catch (error) {
      console.error(`Failed to clear VTXOs for script ${script}:`, error);
      throw error;
    }
  }
  async getUtxos(address) {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_UTXOS], "readonly");
        const store = transaction.objectStore(STORE_UTXOS);
        const index = store.index("address");
        const request = index.getAll(address);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const results = request.result || [];
          const utxos = results.map(deserializeUtxo);
          resolve(utxos);
        };
      });
    } catch (error) {
      console.error(`Failed to get UTXOs for address ${address}:`, error);
      return [];
    }
  }
  async saveUtxos(address, utxos) {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_UTXOS], "readwrite");
        const store = transaction.objectStore(STORE_UTXOS);
        const promises = utxos.map((utxo) => {
          return new Promise((resolveItem, rejectItem) => {
            const serialized = serializeUtxo(utxo);
            const item = {
              address,
              ...serialized
            };
            const request = store.put(item);
            request.onerror = () => rejectItem(request.error);
            request.onsuccess = () => resolveItem();
          });
        });
        Promise.all(promises).then(() => resolve()).catch(reject);
        transaction.onerror = () => reject(transaction.error);
      });
    } catch (error) {
      console.error(`Failed to save UTXOs for address ${address}:`, error);
      throw error;
    }
  }
  async deleteUtxos(address) {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_UTXOS], "readwrite");
        const store = transaction.objectStore(STORE_UTXOS);
        const index = store.index("address");
        const request = index.openCursor(IDBKeyRange.only(address));
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            resolve();
          }
        };
      });
    } catch (error) {
      console.error(`Failed to clear UTXOs for address ${address}:`, error);
      throw error;
    }
  }
  async getTransactionHistory(address) {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_TRANSACTIONS], "readonly");
        const store = transaction.objectStore(STORE_TRANSACTIONS);
        const index = store.index("address");
        const request = index.getAll(address);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const results = request.result || [];
          resolve(results.sort((a, b) => a.createdAt - b.createdAt));
        };
      });
    } catch (error) {
      console.error(`Failed to get transaction history for address ${address}:`, error);
      return [];
    }
  }
  async saveTransactions(address, txs) {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_TRANSACTIONS], "readwrite");
        const store = transaction.objectStore(STORE_TRANSACTIONS);
        txs.forEach((tx) => {
          const item = {
            address,
            ...tx,
            keyBoardingTxid: tx.key.boardingTxid,
            keyCommitmentTxid: tx.key.commitmentTxid,
            keyArkTxid: tx.key.arkTxid
          };
          store.put(item);
        });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(new Error("Transaction aborted"));
      });
    } catch (error) {
      console.error(`Failed to save transactions for address ${address}:`, error);
      throw error;
    }
  }
  async deleteTransactions(address) {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_TRANSACTIONS], "readwrite");
        const store = transaction.objectStore(STORE_TRANSACTIONS);
        const index = store.index("address");
        const request = index.openCursor(IDBKeyRange.only(address));
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            resolve();
          }
        };
      });
    } catch (error) {
      console.error(`Failed to clear transactions for address ${address}:`, error);
      throw error;
    }
  }
  async getWalletState() {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_WALLET_STATE], "readonly");
        const store = transaction.objectStore(STORE_WALLET_STATE);
        const request = store.get("state");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const result = request.result;
          if (result && result.data) {
            resolve(result.data);
          } else {
            resolve(null);
          }
        };
      });
    } catch (error) {
      console.error("Failed to get wallet state:", error);
      return null;
    }
  }
  async saveWalletState(state) {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_WALLET_STATE], "readwrite");
        const store = transaction.objectStore(STORE_WALLET_STATE);
        const item = {
          key: "state",
          data: state
        };
        const request = store.put(item);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
      });
    } catch (error) {
      console.error("Failed to save wallet state:", error);
      throw error;
    }
  }
  async getDB() {
    if (this.db) return this.db;
    this.db = await openDatabase(this.dbName, DB_VERSION, initDatabase);
    return this.db;
  }
};
function deserializeVtxoWithBackfill(o) {
  if (!o.script) {
    o = { ...o, script: scriptFromArkAddress(o.address) };
  }
  return deserializeVtxo(o);
}
function isCanonicalRow(row) {
  try {
    return scriptFromArkAddress(row.address) === row.script;
  } catch {
    return false;
  }
}
function shouldReplaceVtxo(existing, incoming) {
  const existingCanonical = isCanonicalRow(existing);
  const incomingCanonical = isCanonicalRow(incoming);
  if (incomingCanonical && !existingCanonical) return true;
  if (existingCanonical && !incomingCanonical) return false;
  const existingWeight = getLifecycleWeight(existing);
  const incomingWeight = getLifecycleWeight(incoming);
  if (incomingWeight > existingWeight) return true;
  if (existingWeight > incomingWeight) return false;
  return incoming.address < existing.address;
}
function getLifecycleWeight(v) {
  let weight = 0;
  if (v.isSpent !== void 0) weight += 1;
  if (v.spentBy) weight += 2;
  if (v.settledBy) weight += 2;
  if (v.arkTxId) weight += 2;
  return weight;
}
var getVtxosStorageKey = (address) => `vtxos:${address}`;
var getUtxosStorageKey = (address) => `utxos:${address}`;
var getTransactionsStorageKey = (address) => `tx:${address}`;
var walletStateStorageKey = "wallet:state";
var serializeVtxo2 = (v) => ({
  ...v,
  tapTree: hex.encode(v.tapTree),
  forfeitTapLeafScript: serializeTapLeaf2(v.forfeitTapLeafScript),
  intentTapLeafScript: serializeTapLeaf2(v.intentTapLeafScript),
  extraWitness: v.extraWitness?.map(hex.encode),
  assets: serializeAssets(v.assets)
});
var serializeUtxo2 = (u) => ({
  ...u,
  tapTree: hex.encode(u.tapTree),
  forfeitTapLeafScript: serializeTapLeaf2(u.forfeitTapLeafScript),
  intentTapLeafScript: serializeTapLeaf2(u.intentTapLeafScript),
  extraWitness: u.extraWitness?.map(hex.encode)
});
var deserializeVtxo2 = (o) => ({
  ...o,
  createdAt: new Date(o.createdAt),
  tapTree: hex.decode(o.tapTree),
  forfeitTapLeafScript: deserializeTapLeaf2(o.forfeitTapLeafScript),
  intentTapLeafScript: deserializeTapLeaf2(o.intentTapLeafScript),
  extraWitness: o.extraWitness?.map(hex.decode),
  assets: deserializeAssets(o.assets)
});
var deserializeUtxo2 = (o) => ({
  ...o,
  tapTree: hex.decode(o.tapTree),
  forfeitTapLeafScript: deserializeTapLeaf2(o.forfeitTapLeafScript),
  intentTapLeafScript: deserializeTapLeaf2(o.intentTapLeafScript),
  extraWitness: o.extraWitness?.map(hex.decode)
});
var serializeTapLeaf2 = ([cb, s]) => ({
  cb: hex.encode(TaprootControlBlock.encode(cb)),
  s: hex.encode(s)
});
var deserializeTapLeaf2 = (t) => {
  const cb = TaprootControlBlock.decode(hex.decode(t.cb));
  const s = hex.decode(t.s);
  return [cb, s];
};
var WalletRepositoryImpl = class {
  version = 1;
  storage;
  constructor(storage) {
    this.storage = storage;
  }
  async getVtxos(address) {
    const stored = await this.storage.getItem(getVtxosStorageKey(address));
    if (!stored) return [];
    try {
      const parsed = JSON.parse(stored);
      return parsed.map(deserializeVtxo2);
    } catch (error) {
      console.error(`Failed to parse VTXOs for address ${address}:`, error);
      return [];
    }
  }
  async saveVtxos(address, vtxos) {
    const storedVtxos = await this.getVtxos(address);
    for (const vtxo of vtxos) {
      const existing = storedVtxos.findIndex(
        (v) => v.txid === vtxo.txid && v.vout === vtxo.vout
      );
      if (existing !== -1) {
        storedVtxos[existing] = vtxo;
      } else {
        storedVtxos.push(vtxo);
      }
    }
    await this.storage.setItem(
      getVtxosStorageKey(address),
      JSON.stringify(storedVtxos.map(serializeVtxo2))
    );
  }
  async clearVtxos(address) {
    return this.deleteVtxos(address);
  }
  async deleteVtxos(address) {
    await this.storage.removeItem(getVtxosStorageKey(address));
  }
  async getUtxos(address) {
    const stored = await this.storage.getItem(getUtxosStorageKey(address));
    if (!stored) return [];
    try {
      const parsed = JSON.parse(stored);
      return parsed.map(deserializeUtxo2);
    } catch (error) {
      console.error(`Failed to parse UTXOs for address ${address}:`, error);
      return [];
    }
  }
  async saveUtxos(address, utxos) {
    const storedUtxos = await this.getUtxos(address);
    utxos.forEach((utxo) => {
      const existing = storedUtxos.findIndex(
        (u) => u.txid === utxo.txid && u.vout === utxo.vout
      );
      if (existing !== -1) {
        storedUtxos[existing] = utxo;
      } else {
        storedUtxos.push(utxo);
      }
    });
    await this.storage.setItem(
      getUtxosStorageKey(address),
      JSON.stringify(storedUtxos.map(serializeUtxo2))
    );
  }
  async clearUtxos(address) {
    return this.deleteVtxos(address);
  }
  async deleteUtxos(address) {
    await this.storage.removeItem(getUtxosStorageKey(address));
  }
  async getTransactionHistory(address) {
    const storageKey = getTransactionsStorageKey(address);
    const stored = await this.storage.getItem(storageKey);
    if (!stored) return [];
    try {
      const parsed = JSON.parse(stored);
      return parsed.map(deserializeTransaction);
    } catch (error) {
      console.error(`Failed to parse transactions for address ${address}:`, error);
      return [];
    }
  }
  async saveTransactions(address, txs) {
    const storedTransactions = await this.getTransactionHistory(address);
    for (const tx of txs) {
      const existing = storedTransactions.findIndex(
        (t) => t.key.boardingTxid === tx.key.boardingTxid && t.key.commitmentTxid === tx.key.commitmentTxid && t.key.arkTxid === tx.key.arkTxid
      );
      if (existing !== -1) {
        storedTransactions[existing] = tx;
      } else {
        storedTransactions.push(tx);
      }
    }
    await this.storage.setItem(
      getTransactionsStorageKey(address),
      JSON.stringify(storedTransactions.map(serializeTransaction))
    );
  }
  async clearTransactions(address) {
    return this.deleteTransactions(address);
  }
  async deleteTransactions(address) {
    await this.storage.removeItem(getTransactionsStorageKey(address));
  }
  async getWalletState() {
    const stored = await this.storage.getItem(walletStateStorageKey);
    if (!stored) return null;
    try {
      const state = JSON.parse(stored);
      return state;
    } catch (error) {
      console.error("Failed to parse wallet state:", error);
      return null;
    }
  }
  async saveWalletState(state) {
    await this.storage.setItem(walletStateStorageKey, JSON.stringify(state));
  }
  // New method added in V2, not implemented for legacy
  async clear() {
    throw new Error("Method not implemented.");
  }
  async [Symbol.asyncDispose]() {
    return;
  }
};

// src/repositories/migrations/fromStorageAdapter.ts
var MIGRATION_KEY = (repoType) => `migration-from-storage-adapter-${repoType}`;
async function getMigrationStatus(repoType, storageAdapter) {
  try {
    const migration = await storageAdapter.getItem(MIGRATION_KEY(repoType));
    if (migration === "done") return "done";
    if (migration === "in-progress") return "in-progress";
    return "pending";
  } catch (e) {
    if (e instanceof DOMException && e.name === "NotFoundError") return "not-needed";
    throw e;
  }
}
async function requiresMigration(repoType, storageAdapter) {
  const status = await getMigrationStatus(repoType, storageAdapter);
  return status === "pending" || status === "in-progress";
}
async function rollbackMigration(repoType, storageAdapter) {
  await storageAdapter.removeItem(MIGRATION_KEY(repoType));
}
async function migrateWalletRepository(storageAdapter, fresh, addresses) {
  const migrate = await requiresMigration("wallet", storageAdapter);
  if (!migrate) return;
  await storageAdapter.setItem(MIGRATION_KEY("wallet"), "in-progress");
  const old = new WalletRepositoryImpl(storageAdapter);
  const walletData = await old.getWalletState();
  const onchainAddrData = await Promise.all(
    addresses.onchain.map(async (address) => {
      const utxos = await old.getUtxos(address);
      return { address, utxos };
    })
  );
  const offchainAddrData = await Promise.all(
    addresses.offchain.map(async (address) => {
      const vtxos = await old.getVtxos(address);
      const txs = await old.getTransactionHistory(address);
      return { address, vtxos, txs };
    })
  );
  await Promise.all([
    walletData && fresh.saveWalletState(walletData),
    ...offchainAddrData.map(
      (addressData) => Promise.all([
        fresh.saveVtxos(addressData.address, addressData.vtxos),
        fresh.saveTransactions(addressData.address, addressData.txs)
      ])
    ),
    ...onchainAddrData.map(
      (addressData) => fresh.saveUtxos(addressData.address, addressData.utxos)
    )
  ]);
  await storageAdapter.setItem(MIGRATION_KEY("wallet"), "done");
}

// src/repositories/migrations/contractRepositoryImpl.ts
var getContractStorageKey = (id, key) => `contract:${id}:${key}`;
var getCollectionStorageKey = (type) => `collection:${type}`;
var ContractRepositoryImpl = class {
  version = 1;
  storage;
  constructor(storage) {
    this.storage = storage;
  }
  async getContractData(contractId, key) {
    const stored = await this.storage.getItem(getContractStorageKey(contractId, key));
    if (!stored) return null;
    try {
      const data = JSON.parse(stored);
      return data;
    } catch (error) {
      console.error(`Failed to parse contract data for ${contractId}:${key}:`, error);
      return null;
    }
  }
  async setContractData(contractId, key, data) {
    try {
      await this.storage.setItem(
        getContractStorageKey(contractId, key),
        JSON.stringify(data)
      );
    } catch (error) {
      console.error(`Failed to persist contract data for ${contractId}:${key}:`, error);
      throw error;
    }
  }
  async deleteContractData(contractId, key) {
    try {
      await this.storage.removeItem(getContractStorageKey(contractId, key));
    } catch (error) {
      console.error(`Failed to remove contract data for ${contractId}:${key}:`, error);
      throw error;
    }
  }
  async getContractCollection(contractType) {
    const stored = await this.storage.getItem(getCollectionStorageKey(contractType));
    if (!stored) return [];
    try {
      const collection = JSON.parse(stored);
      return collection;
    } catch (error) {
      console.error(`Failed to parse contract collection ${contractType}:`, error);
      return [];
    }
  }
  async saveToContractCollection(contractType, item, idField) {
    const collection = await this.getContractCollection(contractType);
    const itemId = item[idField];
    if (itemId === void 0 || itemId === null) {
      throw new Error(`Item is missing required field '${String(idField)}'`);
    }
    const existingIndex = collection.findIndex((i) => i[idField] === itemId);
    let newCollection;
    if (existingIndex !== -1) {
      newCollection = [
        ...collection.slice(0, existingIndex),
        item,
        ...collection.slice(existingIndex + 1)
      ];
    } else {
      newCollection = [...collection, item];
    }
    try {
      await this.storage.setItem(
        getCollectionStorageKey(contractType),
        JSON.stringify(newCollection)
      );
    } catch (error) {
      console.error(`Failed to persist contract collection ${contractType}:`, error);
      throw error;
    }
  }
  async removeFromContractCollection(contractType, id, idField) {
    if (id === void 0 || id === null) {
      throw new Error(`Invalid id provided for removal: ${String(id)}`);
    }
    const collection = await this.getContractCollection(contractType);
    const filtered = collection.filter((item) => item[idField] !== id);
    try {
      await this.storage.setItem(
        getCollectionStorageKey(contractType),
        JSON.stringify(filtered)
      );
    } catch (error) {
      console.error(
        `Failed to persist contract collection removal for ${contractType}:`,
        error
      );
      throw error;
    }
  }
  // The following methods are implemented for compatibility with the new ContractRepository interface
  // but aren't used.
  async getContracts(_) {
    throw new TypeError(
      "Method not implemented, this is a legacy class and should only be used for migrating data."
    );
  }
  async saveContract(_) {
    throw new TypeError(
      "Method not implemented, this is a legacy class and should only be used for migrating data."
    );
  }
  async deleteContract(_) {
    throw new TypeError(
      "Method not implemented, this is a legacy class and should only be used for migrating data."
    );
  }
  // used only for tests
  async clear() {
    await this.storage.clear();
  }
  async [Symbol.asyncDispose]() {
    return;
  }
};

// src/contracts/types.ts
function isDiscoverable(handler) {
  return !!handler && typeof handler.discoverAt === "function";
}

// src/contracts/contractWatcher.ts
var ContractWatcher = class {
  config;
  contracts = /* @__PURE__ */ new Map();
  subscriptionId;
  abortController;
  isWatching = false;
  eventCallback;
  connectionState = "disconnected";
  reconnectAttempts = 0;
  reconnectTimeoutId;
  failsafePollIntervalId;
  /**
   * Create a contract watcher with the given providers and polling settings.
   *
   * @param config - Contract watcher configuration
   * @see ContractWatcherConfig
   */
  constructor(config) {
    this.config = {
      failsafePollIntervalMs: 6e4,
      // 1 minute
      reconnectDelayMs: 1e3,
      // 1 second
      maxReconnectDelayMs: 3e4,
      // 30 seconds
      maxReconnectAttempts: 0,
      // unlimited
      ...config
    };
  }
  /**
   * Add a contract to be watched.
   *
   * Active contracts are immediately subscribed.
   *
   * All contracts are polled to discover any existing virtual outputs
   * (which may cause them to be watched even if inactive).
   */
  async addContract(contract) {
    const state = {
      contract,
      lastKnownVtxos: /* @__PURE__ */ new Map()
    };
    this.contracts.set(contract.script, state);
    await this.seedLastKnownVtxos(state);
    if (this.isWatching) {
      await this.pollContracts([contract.script]);
      await this.tryUpdateSubscription();
    }
  }
  /**
   * Pre-populate `lastKnownVtxos` from the wallet repository.
   *
   * Runs on add (and can be re-run after reconnect) so polling always
   * compares the indexer's view against what is already persisted,
   * emitting only genuine deltas.
   */
  async seedLastKnownVtxos(state) {
    try {
      const cached = await getVtxosForContract(this.config.walletRepository, state.contract);
      for (const vtxo of cached) {
        if (vtxo.isSpent) continue;
        const key = `${vtxo.txid}:${vtxo.vout}`;
        state.lastKnownVtxos.set(key, vtxo);
      }
    } catch (error) {
      console.error(
        `ContractWatcher: failed to seed lastKnownVtxos for ${state.contract.script}`,
        error
      );
    }
  }
  /**
   * Update an existing contract.
   */
  async updateContract(contract) {
    const existing = this.contracts.get(contract.script);
    if (!existing) {
      throw new Error(`Contract ${contract.script} not found`);
    }
    existing.contract = contract;
    if (this.isWatching) {
      await this.tryUpdateSubscription();
    }
  }
  /**
   * Remove a contract from watching.
   */
  async removeContract(contractScript) {
    const state = this.contracts.get(contractScript);
    if (state) {
      this.contracts.delete(contractScript);
      if (this.isWatching) {
        await this.tryUpdateSubscription();
      }
    }
  }
  /**
   * Get all in-memory contracts.
   */
  getAllContracts() {
    return Array.from(this.contracts.values()).map((s) => s.contract);
  }
  /**
   * Contracts the watcher is actually tracking:
   * - all active contracts, plus
   * - inactive contracts that still hold known virtual outputs
   *   (the subscription keeps watching them so `vtxo_spent` events for
   *   those unspent outputs are still observed).
   *
   * This is the single source of truth for "contracts whose VTXO state
   * we still care about" — callers and the subscription itself fan out
   * over the same set so nothing is reconciled that isn't also watched.
   */
  getWatchedContracts() {
    return Array.from(this.contracts.values()).filter((s) => s.contract.state === "active" || s.lastKnownVtxos.size > 0).map((s) => s.contract);
  }
  /**
   * Get virtual outputs for contracts, grouped by contract script.
   * @see WalletRepository for `repo`
   */
  async getContractVtxos(options) {
    const { contractScripts, includeSpent } = options;
    const repo = this.config.walletRepository;
    const contractsToQuery = Array.from(this.contracts.values());
    const asyncResults = contractsToQuery.filter((_) => {
      if (contractScripts && !contractScripts.includes(_.contract.script)) return false;
      return true;
    }).map(async (state) => {
      const cached = await getVtxosForContract(repo, state.contract);
      if (cached.length > 0) {
        const contractVtxos = cached.map((v) => ({
          ...v,
          contractScript: state.contract.script
        }));
        const filtered = includeSpent ? contractVtxos : contractVtxos.filter((v) => !v.isSpent);
        return [[state.contract.script, filtered]];
      }
      return [];
    });
    const results = await Promise.all(asyncResults);
    return new Map(results.flat(1));
  }
  /**
   * Start watching for virtual output events across all active contracts.
   */
  async startWatching(callback) {
    if (this.isWatching) {
      throw new Error("Already watching");
    }
    this.eventCallback = callback;
    this.isWatching = true;
    this.abortController = new AbortController();
    this.reconnectAttempts = 0;
    await this.connect();
    this.startFailsafePolling();
    return () => this.stopWatching();
  }
  /**
   * Stop watching for events.
   */
  async stopWatching() {
    this.isWatching = false;
    this.connectionState = "disconnected";
    this.abortController?.abort();
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = void 0;
    }
    if (this.failsafePollIntervalId) {
      clearInterval(this.failsafePollIntervalId);
      this.failsafePollIntervalId = void 0;
    }
    if (this.subscriptionId) {
      try {
        await this.config.indexerProvider.unsubscribeForScripts(this.subscriptionId);
      } catch {
      }
      this.subscriptionId = void 0;
    }
    this.eventCallback = void 0;
  }
  /**
   * Check if currently watching.
   */
  isCurrentlyWatching() {
    return this.isWatching;
  }
  /**
   * Get current connection state.
   */
  getConnectionState() {
    return this.connectionState;
  }
  /**
   * Force a poll of all active contracts.
   * Useful for manual refresh or after app resume.
   */
  async forcePoll() {
    if (!this.isWatching) return;
    await this.pollAllContracts();
  }
  /**
   * Connect to the subscription.
   *
   * @param skipUpdate - Skip the leading `updateSubscription` call when
   *   the caller has already established `subscriptionId`.
   */
  async connect(skipUpdate = false) {
    if (!this.isWatching) return;
    this.connectionState = "connecting";
    try {
      if (!skipUpdate) {
        await this.updateSubscription();
      }
      await this.pollAllContracts();
      this.connectionState = "connected";
      this.reconnectAttempts = 0;
      this.listenLoop().catch((e) => {
        if (isEventSourceError(e)) {
          console.debug("ContractWatcher subscription disconnected; reconnecting");
        } else {
          console.error(e);
        }
        this.connectionState = "disconnected";
        this.eventCallback?.({
          type: "connection_reset",
          timestamp: Date.now()
        });
        this.scheduleReconnect();
      });
    } catch (error) {
      console.error("ContractWatcher connection failed:", error);
      this.connectionState = "disconnected";
      this.eventCallback?.({
        type: "connection_reset",
        timestamp: Date.now()
      });
      this.scheduleReconnect();
    }
  }
  /**
   * Schedule a reconnection attempt.
   */
  scheduleReconnect() {
    if (!this.isWatching) return;
    if (this.config.maxReconnectAttempts > 0 && this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error(
        `ContractWatcher: Max reconnection attempts (${this.config.maxReconnectAttempts}) reached`
      );
      return;
    }
    this.connectionState = "reconnecting";
    this.reconnectAttempts++;
    const delay = Math.min(
      this.config.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1),
      this.config.maxReconnectDelayMs
    );
    this.reconnectTimeoutId = setTimeout(() => {
      this.reconnectTimeoutId = void 0;
      this.connect();
    }, delay);
  }
  /**
   * Start the failsafe polling interval.
   */
  startFailsafePolling() {
    if (this.failsafePollIntervalId) {
      clearInterval(this.failsafePollIntervalId);
    }
    this.failsafePollIntervalId = setInterval(() => {
      if (this.isWatching) {
        this.pollAllContracts().catch((error) => {
          console.error("ContractWatcher failsafe poll failed:", error);
        });
      }
    }, this.config.failsafePollIntervalMs);
  }
  async pollAllContracts() {
    const scripts = this.getWatchedContracts().map((c) => c.script);
    if (scripts.length === 0) return;
    await this.pollContracts(scripts);
  }
  /**
   * Poll specific contracts and emit events for changes.
   */
  async pollContracts(contractScripts) {
    if (!this.eventCallback) return;
    const now = Date.now();
    try {
      const vtxosMap = await this.getContractVtxos({
        contractScripts,
        includeSpent: false
        // only spendable ones!
      });
      for (const contractScript of contractScripts) {
        const state = this.contracts.get(contractScript);
        if (!state) continue;
        const currentVtxos = vtxosMap.get(contractScript) || [];
        const currentKeys = new Set(currentVtxos.map((v) => `${v.txid}:${v.vout}`));
        const newVtxos = [];
        for (const vtxo of currentVtxos) {
          const key = `${vtxo.txid}:${vtxo.vout}`;
          if (!state.lastKnownVtxos.has(key)) {
            newVtxos.push(vtxo);
            state.lastKnownVtxos.set(key, vtxo);
          }
        }
        const spentVtxos = [];
        for (const [key, vtxo] of state.lastKnownVtxos) {
          if (!currentKeys.has(key)) {
            spentVtxos.push(vtxo);
            state.lastKnownVtxos.delete(key);
          }
        }
        if (newVtxos.length > 0) {
          this.emitVtxoEvent(contractScript, newVtxos, "vtxo_received", now);
        }
        if (spentVtxos.length > 0) {
          this.emitVtxoEvent(contractScript, spentVtxos, "vtxo_spent", now);
        }
      }
    } catch (error) {
      console.error("ContractWatcher poll failed:", error);
    }
  }
  async tryUpdateSubscription() {
    const hadSubscription = this.subscriptionId !== void 0;
    try {
      await this.updateSubscription();
    } catch (error) {
      return;
    }
    const justGotSubscription = !hadSubscription && this.subscriptionId !== void 0;
    const listenerParked = this.connectionState === "disconnected" || this.connectionState === "reconnecting";
    if (this.isWatching && justGotSubscription && listenerParked) {
      if (this.reconnectTimeoutId) {
        clearTimeout(this.reconnectTimeoutId);
        this.reconnectTimeoutId = void 0;
      }
      this.reconnectAttempts = 0;
      this.connect(true).catch((error) => {
        console.warn("ContractWatcher cold-start connect failed:", error);
      });
    }
  }
  /**
   * Update the subscription with scripts that should be watched.
   *
   * Watches both active contracts and contracts with virtual outputs.
   */
  async updateSubscription() {
    const scriptsToWatch = this.getWatchedContracts().map((c) => c.script);
    if (scriptsToWatch.length === 0) {
      if (this.subscriptionId) {
        try {
          await this.config.indexerProvider.unsubscribeForScripts(this.subscriptionId);
        } catch {
        }
        this.subscriptionId = void 0;
      }
      return;
    }
    try {
      this.subscriptionId = await this.config.indexerProvider.subscribeForScripts(
        scriptsToWatch,
        this.subscriptionId
      );
    } catch (error) {
      const isStale = error instanceof Error && /subscription\s+\S+\s+not\s+found/i.test(error.message);
      if (this.subscriptionId && isStale) {
        this.subscriptionId = void 0;
        this.subscriptionId = await this.config.indexerProvider.subscribeForScripts(scriptsToWatch);
      } else {
        throw error;
      }
    }
  }
  /**
   * Main listening loop for subscription events.
   */
  async listenLoop() {
    if (!this.subscriptionId || !this.abortController || !this.isWatching) {
      if (this.isWatching) {
        this.connectionState = "disconnected";
        this.scheduleReconnect();
      }
      return;
    }
    const subscription = this.config.indexerProvider.getSubscription(
      this.subscriptionId,
      this.abortController.signal
    );
    for await (const update of subscription) {
      if (!this.isWatching) break;
      this.handleSubscriptionUpdate(update);
    }
    if (this.isWatching) {
      this.connectionState = "disconnected";
      this.scheduleReconnect();
    }
  }
  /**
   * Handle a subscription update.
   */
  handleSubscriptionUpdate(update) {
    if (!this.eventCallback) return;
    const timestamp = Date.now();
    if (update.newVtxos?.length) {
      this.processSubscriptionVtxos(update.newVtxos, "vtxo_received", timestamp);
    }
    if (update.spentVtxos?.length) {
      this.processSubscriptionVtxos(update.spentVtxos, "vtxo_spent", timestamp);
    }
  }
  /**
   * Process virtual outputs from subscription and route each VTXO to the
   * single contract that actually locks it via `vtxo.script`. If the script
   * doesn't match any watched contract, skip the VTXO rather than fan it
   * out to every matching contract — fan-out produced phantom state in
   * non-owning contracts that then never reconciled.
   */
  processSubscriptionVtxos(vtxos, eventType, timestamp) {
    const byContract = /* @__PURE__ */ new Map();
    let unknownScript = 0;
    for (const vtxo of vtxos) {
      if (!this.contracts.has(vtxo.script)) {
        unknownScript++;
        continue;
      }
      let bucket = byContract.get(vtxo.script);
      if (!bucket) {
        bucket = [];
        byContract.set(vtxo.script, bucket);
      }
      bucket.push(vtxo);
    }
    if (unknownScript > 0) {
      console.debug(
        `ContractWatcher.processSubscriptionVtxos[${eventType}]: dropped ${unknownScript} unknown-script VTXOs (${vtxos.length} total)`
      );
    }
    for (const [contractScript, bucketVtxos] of byContract) {
      const state = this.contracts.get(contractScript);
      if (state) {
        for (const vtxo of bucketVtxos) {
          const key = `${vtxo.txid}:${vtxo.vout}`;
          if (eventType === "vtxo_received") {
            state.lastKnownVtxos.set(key, vtxo);
          } else if (eventType === "vtxo_spent") {
            state.lastKnownVtxos.delete(key);
          }
        }
      }
      this.emitVtxoEvent(contractScript, bucketVtxos, eventType, timestamp);
    }
  }
  /**
   * Emit a virtual output event for a contract.
   */
  emitVtxoEvent(contractScript, vtxos, eventType, timestamp) {
    if (!this.eventCallback) return;
    const state = this.contracts.get(contractScript);
    if (!state) return;
    const extended = [];
    for (const v of vtxos) {
      try {
        const extendedVtxo = extendVirtualCoinForContract(v, state.contract);
        extended.push({ ...extendedVtxo, contractScript });
      } catch (err) {
        console.warn(`failed to extend vtxo ${v.txid}:${v.vout}`, err);
        extended.push({ ...v, contractScript });
      }
    }
    switch (eventType) {
      case "vtxo_received":
        this.eventCallback({
          type: "vtxo_received",
          vtxos: extended,
          contractScript,
          contract: state.contract,
          timestamp
        });
        return;
      case "vtxo_spent":
        this.eventCallback({
          type: "vtxo_spent",
          vtxos: extended,
          contractScript,
          contract: state.contract,
          timestamp
        });
        return;
      default:
        return;
    }
  }
};

// src/utils/syncCursors.ts
var SAFETY_LAG_MS = 3e4;
var OVERLAP_MS = 24 * 60 * 60 * 1e3;
var walletStateLocks = /* @__PURE__ */ new WeakMap();
async function updateWalletState(repo, updater) {
  const prev = walletStateLocks.get(repo) ?? Promise.resolve();
  const op = prev.then(async () => {
    const state = await repo.getWalletState() ?? {};
    await repo.saveWalletState(updater(state));
  });
  walletStateLocks.set(
    repo,
    op.catch(() => {
    })
  );
  return op;
}
var CURSOR_MIGRATED_KEY = "vtxoCursorMigrated";
function hasMigrationMarker(state) {
  return state?.settings?.[CURSOR_MIGRATED_KEY] === true;
}
async function getSyncCursor(repo) {
  const state = await repo.getWalletState();
  if (!hasMigrationMarker(state)) return 0;
  return state?.lastSyncTime ?? 0;
}
async function advanceSyncCursor(repo, lastUpdatedAt) {
  await updateWalletState(repo, (state) => {
    const current = hasMigrationMarker(state) ? state.lastSyncTime ?? 0 : 0;
    return {
      ...state,
      lastSyncTime: Math.max(current, lastUpdatedAt),
      settings: {
        ...state.settings ?? {},
        [CURSOR_MIGRATED_KEY]: true
      }
    };
  });
}
async function clearSyncCursor(repo) {
  await updateWalletState(repo, (state) => {
    const { [CURSOR_MIGRATED_KEY]: _, ...restSettings } = state.settings ?? {};
    return {
      ...state,
      lastSyncTime: void 0,
      settings: restSettings
    };
  });
}
function computeSyncWindow(cursor) {
  const after = Math.max(0, cursor - OVERLAP_MS);
  return { after };
}
function cursorCutoff(requestStartedAt) {
  return (requestStartedAt ?? Date.now()) - SAFETY_LAG_MS;
}

// src/contracts/contractManager.ts
var DEFAULT_PAGE_SIZE = 500;
var SCAN_MAX_INDEX = 1e4;
var ContractManager = class _ContractManager {
  config;
  watcher;
  initialized = false;
  eventCallbacks = /* @__PURE__ */ new Set();
  stopWatcherFn;
  constructor(config) {
    this.config = config;
    this.watcher = new ContractWatcher({
      indexerProvider: config.indexerProvider,
      walletRepository: config.walletRepository,
      ...config.watcherConfig
    });
  }
  /**
   * Static factory method for creating a new ContractManager.
   * Initialize the manager by loading persisted contracts and starting to watch.
   *
   * After initialization, the manager automatically watches all active contracts
   * and contracts with virtual outputs. Use `onContractEvent()` to register event callbacks.
   *
   * @param config ContractManagerConfig
   */
  static async create(config) {
    const cm = new _ContractManager(config);
    await cm.initialize();
    return cm;
  }
  async initialize() {
    if (this.initialized) {
      return;
    }
    const contracts = await this.config.contractRepository.getContracts();
    for (const contract of contracts) {
      await this.watcher.addContract(contract);
    }
    await this.reconcileWatched();
    this.initialized = true;
    this.stopWatcherFn = await this.watcher.startWatching((event) => {
      this.handleContractEvent(event).catch((error) => {
        console.error("Error handling contract event:", error);
      });
    });
  }
  /**
   * Delta-sync the full watched set and reconcile the pending frontier.
   *
   * Shared recovery path used on initial boot and after a subscription
   * reconnect. `syncContracts({})` scopes to the current watched set
   * (see {@link ContractWatcher.getWatchedContracts}), uses the
   * cursor-derived delta window, and advances the cursor on success.
   * `reconcilePendingFrontier` catches not-yet-finalized virtual
   * outputs that could sit outside any delta window.
   */
  async reconcileWatched() {
    await this.syncContracts({});
    const watched = this.watcher.getWatchedContracts();
    if (watched.length > 0) {
      await this.reconcilePendingFrontier(watched);
    }
  }
  /**
   * Create and register a new contract.
   *
   * @param params - Contract parameters
   * @returns The created contract
   */
  async createContract(params) {
    const { contract, persisted } = await this.upsertContract(params);
    if (persisted) {
      await this.fetchContractVxosFromIndexer([contract]);
      await this.watcher.addContract(contract);
    }
    return contract;
  }
  /**
   * Lightweight variant of {@link createContract} for batch discovery
   * paths (currently: {@link scanContracts}). Validates, dedupes, persists,
   * and registers the watcher — but skips the per-contract
   * `fetchContractVxosFromIndexer` round-trip. The caller is responsible
   * for hydrating VTXOs afterwards via a bulk `refreshVtxos(...)` so a
   * scan that finds N contracts costs one batched indexer call instead
   * of N + 1. Error semantics are identical to `createContract`:
   * validation / type-mismatch / persistence failures propagate.
   */
  async persistAndWatchContract(params) {
    const { contract, persisted } = await this.upsertContract(params);
    if (persisted) {
      await this.watcher.addContract(contract);
    }
    return contract;
  }
  /**
   * Shared validate + check-existing + persist core for
   * {@link createContract} and {@link persistAndWatchContract}. Returns
   * the resolved contract and whether *this* call wrote it — callers
   * that need to attach hydration / watcher work do so only when
   * `persisted` is `true`.
   */
  async upsertContract(params) {
    const handler = contractHandlers.get(params.type);
    if (!handler) {
      throw new Error(`No handler registered for contract type '${params.type}'`);
    }
    try {
      const script = handler.createScript(params.params);
      const derivedScript = hex.encode(script.pkScript);
      if (derivedScript !== params.script) {
        throw new Error(
          `Script mismatch: provided script does not match script derived from params. Expected ${derivedScript}, got ${params.script}`
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("mismatch")) {
        throw error;
      }
      throw new Error(
        `Invalid params for contract type '${params.type}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const [existing] = await this.getContracts({ script: params.script });
    if (existing) {
      if (existing.type === params.type) return { contract: existing, persisted: false };
      throw new Error(
        `Contract with script ${params.script} already exists with with type ${existing.type}.`
      );
    }
    const contract = {
      ...params,
      createdAt: Date.now(),
      state: params.state || "active"
    };
    await this.config.contractRepository.saveContract(contract);
    return { contract, persisted: true };
  }
  /**
   * Explicit, gap-limit contract discovery (see {@link IContractManager.scanContracts}).
   *
   * Each hit is routed through {@link persistAndWatchContract} — the same
   * dedupe + watcher-register path as {@link createContract} minus the
   * per-contract indexer round-trip. The caller (`Wallet.restore`) follows
   * up with a single bulk `refreshVtxos({ includeInactive: true })`, so a
   * scan that finds N contracts costs one batched indexer call instead of
   * N + 1.
   *
   * Safety-critical invariants (spec §2.C / §4):
   * - `opts.materialize(i)` throwing is structural/fatal: it is NOT
   *   wrapped — it propagates and aborts the scan.
   * - A `discoverAt` rejection is collected into `handlerErrors` and the
   *   loop continues (the gap counter still advances for that index if no
   *   other handler hit it).
   * - `persistAndWatchContract` rejecting is operational/fatal and
   *   propagates (only `discoverAt` is guarded).
   */
  async scanContracts(opts) {
    const gapLimit = opts.gapLimit ?? 20;
    if (!Number.isInteger(gapLimit) || gapLimit <= 0) {
      throw new Error(
        `scanContracts: gapLimit must be a positive integer (got ${String(opts.gapLimit)})`
      );
    }
    const discoverables = contractHandlers.getRegisteredTypes().map((t) => contractHandlers.get(t)).filter(isDiscoverable);
    const maxIdx = opts.hd ? SCAN_MAX_INDEX : 0;
    const handlerErrors = [];
    let lastIndexUsed = -1;
    let unused = 0;
    let i = 0;
    while (i <= maxIdx && unused < gapLimit) {
      const descriptor = opts.materialize(i);
      let hitAtThisIndex = false;
      for (const h of discoverables) {
        let found;
        try {
          found = await h.discoverAt(i, descriptor, opts.deps);
        } catch (error) {
          handlerErrors.push({ handler: h.type, index: i, error });
          continue;
        }
        for (const c of found) {
          await this.persistAndWatchContract(c);
          hitAtThisIndex = true;
        }
      }
      if (hitAtThisIndex) {
        lastIndexUsed = i;
        unused = 0;
      } else {
        unused += 1;
      }
      i += 1;
    }
    if (opts.hd && i > maxIdx && unused < gapLimit) {
      throw new Error(
        `scanContracts: reached SCAN_MAX_INDEX (${SCAN_MAX_INDEX}) without closing the ${gapLimit}-index gap window; a Discoverable handler may be returning unconditional hits`
      );
    }
    return { lastIndexUsed, handlerErrors };
  }
  /**
   * Get contracts with optional filters.
   *
   * @param filter - Optional filter criteria
   * @returns Filtered contracts TODO: filter spent/unspent
   *
   * @example
   * ```typescript
   * // Get all VHTLC contracts
   * const vhtlcs = await manager.getContracts({ type: 'vhtlc' });
   *
   * // Get all active contracts
   * const active = await manager.getContracts({ state: 'active' });
   * ```
   */
  async getContracts(filter) {
    const dbFilter = this.buildContractsDbFilter(filter ?? {});
    return await this.config.contractRepository.getContracts(dbFilter);
  }
  async getContractsWithVtxos(filter, pageSize) {
    const contracts = await this.getContracts(filter);
    await this.syncContracts({ contracts, pageSize });
    const vtxos = await this.getVtxosForContracts(contracts);
    return contracts.map((contract) => ({
      contract,
      vtxos: vtxos.filter((vtxo) => vtxo.contractScript === contract.script)
    }));
  }
  async annotateVtxos(vtxos) {
    if (vtxos.length === 0) return [];
    const scripts = Array.from(new Set(vtxos.map((v) => v.script)));
    const byScript = /* @__PURE__ */ new Map();
    const contracts = await this.config.contractRepository.getContracts({
      script: scripts
    });
    for (const contract of contracts) {
      byScript.set(contract.script, contract);
    }
    const tapscriptCache = /* @__PURE__ */ new Map();
    return vtxos.map((vtxo) => extendVirtualCoinForContract(vtxo, byScript, tapscriptCache));
  }
  buildContractsDbFilter(filter) {
    return {
      script: filter.script,
      state: filter.state,
      type: filter.type
    };
  }
  /**
   * Update a contract.
   * Nested fields like `params` and `metadata` are replaced with the provided values.
   * If you need to preserve existing fields, merge them manually.
   *
   * @param script - Contract script
   * @param updates - Fields to update
   */
  async updateContract(script, updates) {
    const contracts = await this.config.contractRepository.getContracts({
      script
    });
    const existing = contracts[0];
    if (!existing) {
      throw new Error(`Contract ${script} not found`);
    }
    const updated = {
      ...existing,
      ...updates
    };
    await this.config.contractRepository.saveContract(updated);
    await this.watcher.updateContract(updated);
    return updated;
  }
  /**
   * Update a contract's params.
   * This method preserves existing params by merging the provided values.
   *
   * @param script - Contract script
   * @param updates - The new values to merge with existing params
   */
  async updateContractParams(script, updates) {
    const contracts = await this.config.contractRepository.getContracts({
      script
    });
    const existing = contracts[0];
    if (!existing) {
      throw new Error(`Contract ${script} not found`);
    }
    const updated = {
      ...existing,
      params: { ...existing.params, ...updates }
    };
    await this.config.contractRepository.saveContract(updated);
    await this.watcher.updateContract(updated);
    return updated;
  }
  /**
   * Set a contract's state.
   */
  async setContractState(script, state) {
    await this.updateContract(script, { state });
  }
  /**
   * Delete a contract.
   *
   * @param script - Contract script
   */
  async deleteContract(script) {
    await this.config.contractRepository.deleteContract(script);
    await this.watcher.removeContract(script);
  }
  /**
   * Get currently spendable paths for a contract.
   *
   * @param options - Options for getting spendable paths
   */
  async getSpendablePaths(options) {
    const { contractScript, collaborative = true, walletPubKey, vtxo } = options;
    const [contract] = await this.getContracts({ script: contractScript });
    if (!contract) return [];
    const handler = contractHandlers.get(contract.type);
    if (!handler) return [];
    const script = handler.createScript(contract.params);
    const context = {
      collaborative,
      currentTime: Date.now(),
      walletPubKey,
      vtxo
    };
    return handler.getSpendablePaths(script, contract, context);
  }
  /**
   * Get every currently valid spending path for a contract.
   *
   * @param options - Options for getting spending paths
   */
  async getAllSpendingPaths(options) {
    const { contractScript, collaborative = true, walletPubKey } = options;
    const [contract] = await this.getContracts({ script: contractScript });
    if (!contract) return [];
    const handler = contractHandlers.get(contract.type);
    if (!handler) return [];
    const script = handler.createScript(contract.params);
    const context = {
      collaborative,
      currentTime: Date.now(),
      walletPubKey
    };
    return handler.getAllSpendingPaths(script, contract, context);
  }
  /**
   * Register a callback for contract events.
   *
   * The manager automatically watches after `initialize()`. This method
   * allows registering callbacks to receive events.
   *
   * @param callback - Event callback
   * @returns Unsubscribe function to remove this callback
   *
   * @example
   * ```typescript
   * const unsubscribe = manager.onContractEvent((event) => {
   *   console.log(`${event.type} on ${event.contractScript}`);
   * });
   *
   * // Later: stop receiving events
   * unsubscribe();
   * ```
   */
  onContractEvent(callback) {
    this.eventCallbacks.add(callback);
    return () => {
      this.eventCallbacks.delete(callback);
    };
  }
  /**
   * Force refresh virtual outputs from the indexer.
   *
   * Without options, re-fetches every contract in the watcher's
   * watched set and advances the global cursor.
   *
   * `scripts` narrows the refresh to a specific list (subset query —
   * cursor is not advanced because contracts outside the list may
   * have data we'd skip).
   *
   * `includeInactive: true` (and no `scripts`) widens the refresh to
   * every contract in the repository, including ones marked
   * `inactive` and ones that have dropped out of the watcher's
   * active set. This is a *superset* of the watched set, so the
   * cursor invariant still holds and the cursor advances normally.
   *
   * `after` / `before` apply a caller-supplied time window. The
   * cursor never advances on a windowed query because the window
   * may skip data outside its bounds.
   */
  async refreshVtxos(opts) {
    const contracts = opts?.scripts ? await this.getContracts({ script: opts.scripts }) : void 0;
    const hasExplicitWindow = opts?.after !== void 0 || opts?.before !== void 0;
    await this.syncContracts({
      contracts,
      // Scope-only widener; never set together with explicit
      // `contracts` because `scripts` already names the exact set.
      includeInactive: contracts ? false : opts?.includeInactive,
      window: hasExplicitWindow ? { after: opts?.after, before: opts?.before } : void 0
    });
  }
  async refreshOutpoints(outpoints) {
    if (outpoints.length === 0) return;
    const { vtxos } = await this.config.indexerProvider.getVtxos({
      outpoints
    });
    if (vtxos.length === 0) return;
    const scripts = Array.from(new Set(vtxos.map((v) => v.script)));
    const contracts = await this.config.contractRepository.getContracts({
      script: scripts
    });
    const scriptToContract = new Map(contracts.map((c) => [c.script, c]));
    const owned = vtxos.filter((v) => scriptToContract.has(v.script));
    if (owned.length === 0) return;
    const annotated = await this.annotateVtxos(owned);
    const byAddress = /* @__PURE__ */ new Map();
    for (const vtxo of annotated) {
      const contract = scriptToContract.get(vtxo.script);
      if (!contract) continue;
      const address = contract.address;
      const arr = byAddress.get(address) ?? [];
      arr.push(vtxo);
      byAddress.set(address, arr);
    }
    for (const [address, addressVtxos] of byAddress) {
      const contract = contracts.find((c) => c.address === address);
      if (contract) {
        await saveVtxosForContract(this.config.walletRepository, contract, addressVtxos);
      } else {
        await this.config.walletRepository.saveVtxos(address, addressVtxos);
      }
    }
  }
  /**
   * Check if currently watching.
   */
  async isWatching() {
    return this.watcher.isCurrentlyWatching();
  }
  /**
   * Emit an event to all registered callbacks.
   */
  emitEvent(event) {
    for (const callback of this.eventCallbacks) {
      try {
        callback(event);
      } catch (error) {
        console.error("Error in contract event callback:", error);
      }
    }
  }
  /**
   * Handle events from the watcher.
   */
  async handleContractEvent(event) {
    switch (event.type) {
      // Delta-sync only the changed virtual outputs for this contract.
      case "vtxo_received":
      case "vtxo_spent":
        await this.syncContracts({ contracts: [event.contract] });
        break;
      case "connection_reset":
        await this.reconcileWatched();
        break;
    }
    this.emitEvent(event);
  }
  async getVtxosForContracts(contracts) {
    const res = await Promise.all(
      contracts.map(
        (contract) => getVtxosForContract(this.config.walletRepository, contract).then(
          (vtxos) => vtxos.map(
            (vtxo) => ({
              ...vtxo,
              contractScript: contract.script
            })
          )
        )
      )
    );
    return res.flat();
  }
  /**
   * Sync virtual outputs for the given contracts against the indexer.
   *
   * When `options.contracts` is omitted the sync covers the full
   * watched set (active contracts plus any inactive contracts still
   * holding cached VTXOs) and the global cursor is advanced on
   * success. Passing an explicit subset leaves the cursor alone so a
   * narrow poll can't hide data that other contracts still need to
   * pick up.
   */
  async syncContracts(options) {
    const cursor = await getSyncCursor(this.config.walletRepository);
    const window2 = options.window ?? computeSyncWindow(cursor);
    const mustUpdateCursor = options.contracts === void 0 && options.window === void 0 && (window2.after ?? 0) <= cursor;
    const contracts = options.contracts ?? (options.includeInactive ? await this.config.contractRepository.getContracts({}) : this.watcher.getWatchedContracts());
    const requestStartedAt = Date.now();
    const result = await this.fetchContractVxosFromIndexer(contracts, options.pageSize, window2);
    if (mustUpdateCursor) {
      const cutoff = cursorCutoff(requestStartedAt);
      await advanceSyncCursor(this.config.walletRepository, cutoff);
    }
    return result;
  }
  /**
   * Fetch all pending (unfinalized) virtual outputs and upsert them into the
   * repository. This catches virtual outputs whose state changed outside the delta
   * window (e.g. a spend that hasn't settled yet).
   */
  async reconcilePendingFrontier(contracts) {
    const scripts = contracts.map((c) => c.script);
    const scriptToContract = new Map(contracts.map((c) => [c.script, c]));
    const { vtxos } = await this.config.indexerProvider.getVtxos({
      scripts,
      pendingOnly: true
    });
    const owned = vtxos.filter((v) => scriptToContract.has(v.script));
    const annotated = await this.annotateVtxos(owned);
    const byContract = /* @__PURE__ */ new Map();
    for (const vtxo of annotated) {
      const contract = scriptToContract.get(vtxo.script);
      let arr = byContract.get(contract.address);
      if (!arr) {
        arr = [];
        byContract.set(contract.address, arr);
      }
      arr.push({
        ...vtxo,
        contractScript: contract.script
      });
    }
    for (const [addr, contractVtxos] of byContract) {
      const contract = contracts.find((c) => c.address === addr);
      const filtered = warnAndFilterVtxosForScript(
        contractVtxos,
        contract.script,
        "ContractManager.reconcilePendingFrontier"
      );
      if (filtered.length === 0) continue;
      await saveVtxosForContract(
        this.config.walletRepository,
        contract,
        filtered
      );
    }
  }
  async fetchContractVxosFromIndexer(contracts, pageSize, syncWindow) {
    const fetched = await this.fetchContractVtxosBulk(contracts, pageSize, syncWindow);
    const result = /* @__PURE__ */ new Map();
    for (const [contractScript, vtxos] of fetched) {
      result.set(contractScript, vtxos);
      const contract = contracts.find((c) => c.script === contractScript);
      if (contract) {
        const filtered = warnAndFilterVtxosForScript(
          vtxos,
          contract.script,
          "ContractManager.fetchContractVxosFromIndexer"
        );
        if (filtered.length === 0) continue;
        await saveVtxosForContract(
          this.config.walletRepository,
          contract,
          filtered
        );
      }
    }
    return result;
  }
  async fetchContractVtxosBulk(contracts, pageSize = DEFAULT_PAGE_SIZE, syncWindow) {
    if (contracts.length === 0) {
      return /* @__PURE__ */ new Map();
    }
    const scriptToContract = new Map(contracts.map((c) => [c.script, c]));
    const result = new Map(
      contracts.map((c) => [c.script, []])
    );
    const scripts = contracts.map((c) => c.script);
    const windowOpts = syncWindow ? {
      ...syncWindow.after !== void 0 && {
        after: syncWindow.after
      },
      ...syncWindow.before !== void 0 && {
        before: syncWindow.before
      }
    } : {};
    let pageIndex = 0;
    let hasMore = true;
    while (hasMore) {
      const { vtxos, page } = await this.config.indexerProvider.getVtxos({
        scripts,
        ...windowOpts,
        pageIndex,
        pageSize
      });
      const owned = vtxos.filter((v) => scriptToContract.has(v.script));
      const annotated = await this.annotateVtxos(owned);
      for (const vtxo of annotated) {
        result.get(vtxo.script).push({
          ...vtxo,
          contractScript: vtxo.script
        });
      }
      hasMore = page ? vtxos.length === pageSize : false;
      pageIndex++;
      if (hasMore) await new Promise((r) => setTimeout(r, 500));
    }
    return result;
  }
  /**
   * Dispose of the ContractManager and release all resources.
   *
   * Stops the watcher, clears callbacks, and marks
   * the manager as uninitialized.
   *
   * Implements the disposable pattern for cleanup.
   */
  dispose() {
    this.stopWatcherFn?.();
    this.stopWatcherFn = void 0;
    this.eventCallbacks.clear();
    this.initialized = false;
  }
  /**
   * Symbol.dispose implementation for using with `using` keyword.
   * @example
   * ```typescript
   * {
   *   using manager = await wallet.getContractManager();
   *   // ... use manager
   * } // automatically disposed
   * ```
   */
  [Symbol.dispose]() {
    this.dispose();
  }
};
var HD_SETTINGS_KEY = "hd";
var HDDescriptorProvider = class _HDDescriptorProvider {
  constructor(identity, walletRepository) {
    this.identity = identity;
    this.walletRepository = walletRepository;
  }
  /**
   * Construct an HDDescriptorProvider. No I/O is performed here;
   * persisted state is read lazily on the first call to
   * `getNextSigningDescriptor`. A descriptor-mismatch error surfaces on
   * first use rather than at boot.
   */
  static async create(identity, walletRepository) {
    return new _HDDescriptorProvider(identity, walletRepository);
  }
  /**
   * Allocate the next descriptor and return it. The first call on a fresh
   * wallet returns descriptor at index 0; subsequent calls return 1, 2, 3,
   * ... in order. Each call is atomic with respect to other rotations on
   * the same repo: two concurrent callers can never observe the same
   * index.
   */
  async getNextSigningDescriptor() {
    return this.mutate((settings) => {
      const next = settings.lastIndexUsed === void 0 ? 0 : settings.lastIndexUsed + 1;
      settings.lastIndexUsed = next;
      return this.materializeDescriptorAt(next);
    });
  }
  /**
   * Re-derive the descriptor at the most recently allocated index
   * WITHOUT advancing — i.e. read the same descriptor
   * `getNextSigningDescriptor` last returned. Returns `undefined`
   * when no descriptor has ever been allocated on this repo.
   *
   * Used by the boot path to keep the wallet's display address
   * stable across restarts: when no tagged display contract exists
   * (e.g. a fresh wallet that hasn't rotated yet, or a wallet whose
   * baseline-only repo carries no rotation history), the boot should
   * re-derive the existing index rather than burn a new one.
   */
  async getCurrentSigningDescriptor() {
    const state = await this.walletRepository.getWalletState();
    const settings = this.parseSettings(state ?? {});
    if (settings.lastIndexUsed === void 0) return void 0;
    return this.materializeDescriptorAt(settings.lastIndexUsed);
  }
  /**
   * Monotonically advance the allocation watermark so the next
   * `getNextSigningDescriptor()` skips indices discovered by a restore
   * scan. Never rewinds: a lower or equal `index` is a no-op.
   *
   * An invalid `index` (non-integer / negative) is ignored (no-op):
   * persisting it would corrupt `lastIndexUsed` and make the next
   * `parseSettings()` throw, mirroring the validation parseSettings
   * already enforces.
   */
  async advanceLastIndexUsed(index) {
    if (!Number.isInteger(index) || index < 0) return;
    await this.mutate((settings) => {
      if (settings.lastIndexUsed === void 0 || index > settings.lastIndexUsed) {
        settings.lastIndexUsed = index;
      }
    });
  }
  /**
   * Returns true when the given descriptor is derivable from this wallet's
   * seed. Delegates to the underlying identity, which handles both HD and
   * simple `tr(pubkey)` descriptors.
   */
  isOurs(descriptor) {
    return this.identity.isOurs(descriptor);
  }
  /**
   * Signs each request with the key derived from its descriptor. Delegates
   * to the identity's signing primitives — the identity, not the provider,
   * holds the seed.
   */
  async signWithDescriptor(requests) {
    return this.identity.signWithDescriptor(requests);
  }
  /** Signs a message using the key derived from `descriptor`. */
  async signMessageWithDescriptor(descriptor, message, signatureType = "schnorr") {
    return this.identity.signMessageWithDescriptor(descriptor, message, signatureType);
  }
  /**
   * HD providers participate in receive rotation. The default
   * factory boot (contract-repo lookup → allocate fresh descriptor)
   * is exactly what we want, so this just delegates to
   * {@link WalletReceiveRotator.defaultBoot}.
   */
  async createReceiveRotator(opts) {
    return WalletReceiveRotator.defaultBoot(this, opts);
  }
  // ── internals ────────────────────────────────────────────────────
  /**
   * Substitute the wildcard in the identity's account-descriptor template
   * with a concrete index, going through the descriptors-scure parser
   * rather than ad-hoc string substitution. The parser's `expand({ index })`
   * call validates that the input is a ranged template AND produces a
   * canonical materialized key expression at the given index.
   *
   * This is a pure read: it does NOT advance the allocation watermark.
   * Used by restore's gap-scan to peek descriptors at arbitrary indices
   * without side-effects.
   */
  materializeDescriptorAt(index) {
    const descriptor = this.identity.descriptor;
    const network = isMainnetDescriptor(descriptor) ? networks.bitcoin : networks.testnet;
    const expansion = expand({ descriptor, network, index });
    const keyInfo = expansion.expansionMap?.["@0"];
    if (!keyInfo?.keyExpression) {
      throw new Error(
        `HDDescriptorProvider: cannot materialize descriptor at index ${index}`
      );
    }
    return `tr(${keyInfo.keyExpression})`;
  }
  /**
   * Run the read-modify-write of HD settings inside the shared per-repo
   * wallet-state mutex. The closure receives a freshly-validated settings
   * snapshot, mutates it, and returns whatever value the caller wants to
   * surface; the mutated settings are then persisted as part of the same
   * atomic update.
   *
   * Doing the read inside the lock is what prevents two providers (or two
   * concurrent callers on the same provider) from racing on a stale index.
   */
  async mutate(fn) {
    let result;
    await updateWalletState(this.walletRepository, (state) => {
      const settings = this.parseSettings(state);
      result = fn(settings);
      return {
        ...state,
        settings: {
          ...state.settings ?? {},
          [HD_SETTINGS_KEY]: settings
        }
      };
    });
    return result;
  }
  /**
   * Validate the persisted HD settings (or initialize a fresh record when
   * absent) and return a clone safe for the caller to mutate.
   *
   * The cast to `HDWalletSettings` trusts storage; a corrupted or
   * partially-migrated repo could otherwise produce `NaN` descriptors.
   * Fail loud rather than silently derive garbage.
   */
  parseSettings(state) {
    const stored = state.settings?.[HD_SETTINGS_KEY];
    const expected = this.identity.descriptor;
    if (!stored) {
      return { descriptor: expected };
    }
    if (stored.descriptor !== expected) {
      throw new Error(
        `HD descriptor mismatch: stored "${stored.descriptor}", expected "${expected}". Refusing to reuse HD state from a different identity.`
      );
    }
    if (stored.lastIndexUsed !== void 0 && (typeof stored.lastIndexUsed !== "number" || !Number.isInteger(stored.lastIndexUsed) || stored.lastIndexUsed < 0)) {
      throw new Error(
        `Corrupt HD settings: lastIndexUsed is not a non-negative integer (got ${String(stored.lastIndexUsed)}).`
      );
    }
    return { ...stored };
  }
};

// src/wallet/walletReceiveRotator.ts
function hasReceiveRotatorFactory(provider) {
  return typeof provider.createReceiveRotator === "function";
}
function hasPeekableDescriptor(provider) {
  return typeof provider.getCurrentSigningDescriptor === "function";
}
function signingDescriptorIndex(descriptor) {
  if (typeof descriptor !== "string") return 0;
  const m = descriptor.match(/\/(\d+)\)\s*$/);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}
var NonRangeableDescriptorError = class extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "NonRangeableDescriptorError";
  }
};
var ROTATION_MAX_BACKOFF_MS = 6e4;
var WalletReceiveRotator = class _WalletReceiveRotator {
  constructor(provider, priorTaggedScript, logger) {
    this.provider = provider;
    this.currentTaggedScript = priorTaggedScript;
    this.logger = logger ?? console;
  }
  unsubscribe;
  chain = Promise.resolve();
  /**
   * Script of the most-recent tagged display contract — populated
   * either from the boot-time repo lookup or from the previous
   * `rotate()` call within this session. The next `rotate()` marks
   * this contract `inactive` once the new tagged contract is in
   * place. `undefined` means the wallet's current display is the
   * untagged index-0 baseline (no rotation has happened yet on this
   * repo), and the baseline must NOT be deactivated.
   */
  currentTaggedScript;
  /**
   * Consecutive rotation failures since the last successful rotate.
   * Drives an exponential backoff (capped at
   * {@link ROTATION_MAX_BACKOFF_MS}) so a broken provider can't make
   * the rotator hammer `getNextSigningDescriptor` + `createContract`
   * on every inbound VTXO. Reset to zero on a successful rotate.
   */
  consecutiveFailures = 0;
  /**
   * Unix-ms timestamp before which incoming `vtxo_received` events
   * skip the rotation attempt entirely. Zero means "no backoff
   * active" — the next event can rotate immediately.
   */
  nextRotationAllowedAt = 0;
  logger;
  /**
   * Phase 1 — pre-Wallet-construction. Resolves `walletMode` to a
   * {@link DescriptorProvider}, then asks that provider to construct
   * the rotator (delegated through
   * {@link DescriptorProvider.createReceiveRotator}, which falls back
   * to {@link defaultBoot} when the provider doesn't override it).
   *
   * Returns the rotator paired with the offchain tapscript the wallet
   * should actually install (rebuilt to the resolved receive pubkey
   * when it differs from the identity's static pubkey), or
   * `undefined` when the wallet should stay on the static path.
   *
   * Errors during pubkey resolution propagate when:
   * - `walletMode === 'hd'` (caller asked for HD; loud failure expected).
   * - `walletMode` is a {@link DescriptorProvider} (caller supplied an
   *   explicit allocator; silently degrading would hide misconfig).
   *
   * Errors are silently swallowed (returning `undefined`) only under
   * `walletMode: 'auto'` with the built-in HD provider, to preserve
   * backwards compatibility with wallets whose identity descriptor
   * isn't actually rangeable.
   */
  static async resolveBoot(config, setup) {
    const provider = await resolveDescriptorProvider(config, setup.walletRepository);
    if (!provider) return void 0;
    const allowSilentFallback = (config.walletMode ?? "auto") === "auto";
    const expectedContractType = setup.offchainTapscript instanceof DelegateVtxo.Script ? "delegate" : "default";
    const factoryOpts = {
      walletRepository: setup.walletRepository,
      contractRepository: setup.contractRepository,
      serverPubKey: setup.serverPubKey,
      expectedContractType
    };
    let boot;
    try {
      boot = hasReceiveRotatorFactory(provider) ? await provider.createReceiveRotator(factoryOpts) : await _WalletReceiveRotator.defaultBoot(provider, factoryOpts);
    } catch (e) {
      if (allowSilentFallback && e instanceof NonRangeableDescriptorError) {
        return void 0;
      }
      throw e;
    }
    if (!boot) return void 0;
    const offchainTapscript = equalBytes$1(
      boot.receivePubkey,
      setup.offchainTapscript.options.pubKey
    ) ? setup.offchainTapscript : rebuildTapscript(setup.offchainTapscript, boot.receivePubkey);
    return { rotator: boot.rotator, offchainTapscript, provider };
  }
  /**
   * Default factory-shaped boot any
   * {@link ReceiveRotatorFactory.createReceiveRotator} implementation
   * can delegate to. Pulls the wallet's current display contract from
   * the contract repository (or allocates a fresh receive descriptor
   * via the provider when no tagged display contract exists), and
   * returns the rotator paired with the resolved receive pubkey.
   *
   * Used internally by `resolveBoot` when the provider doesn't
   * implement {@link ReceiveRotatorFactory}. Exported so providers
   * that *do* override can still invoke the default work for the
   * parts of the boot path they don't want to customise. Tapscript
   * construction is intentionally NOT in here — that's the
   * orchestrator's job.
   */
  static async defaultBoot(provider, opts) {
    const existing = await pickActiveReceive(
      opts.contractRepository,
      opts.serverPubKey,
      opts.expectedContractType
    );
    if (existing) {
      return {
        rotator: new _WalletReceiveRotator(provider, existing.script, opts.logger),
        receivePubkey: existing.pubKey
      };
    }
    let descriptor;
    if (hasPeekableDescriptor(provider)) {
      descriptor = await provider.getCurrentSigningDescriptor();
    }
    descriptor ??= await provider.getNextSigningDescriptor();
    return {
      rotator: new _WalletReceiveRotator(provider, void 0, opts.logger),
      receivePubkey: deriveLeafPubkey(descriptor)
    };
  }
  /**
   * Phase 2 — post-`getVtxoManager()`. Subscribe to `vtxo_received`
   * and trigger a rotation whenever the currently-active display
   * contract receives funds. Old display contracts remain `active`
   * in the repo so earlier shared addresses keep crediting this
   * wallet.
   */
  async install(wallet) {
    const manager = await wallet.getContractManager();
    this.unsubscribe = manager.onContractEvent((event) => {
      if (event.type !== "vtxo_received") return;
      if (event.contractScript !== wallet.defaultContractScript) return;
      this.chain = this.chain.catch(() => void 0).then(() => this.runRotateWithBackoff(wallet));
    });
  }
  /**
   * Run a single rotation attempt, applying exponential backoff on
   * failure. Public-shaped behavior:
   * - During a backoff window: log + skip (no `rotate()` call).
   * - On success: reset failure count and backoff.
   * - On failure: increment counter, schedule next attempt at
   *   `min(2^consecutiveFailures * 1s, ROTATION_MAX_BACKOFF_MS)`.
   *
   * Errors are deliberately swallowed (logged, not rethrown) so the
   * surrounding `chain` Promise never settles to rejected — the next
   * `vtxo_received` event must still get a chance to run.
   */
  async runRotateWithBackoff(wallet) {
    const now = Date.now();
    if (now < this.nextRotationAllowedAt) {
      this.logger.error("WalletReceiveRotator: skipping rotation (in backoff)", {
        consecutiveFailures: this.consecutiveFailures,
        retryInMs: this.nextRotationAllowedAt - now
      });
      return;
    }
    try {
      await this.rotate(wallet);
      this.consecutiveFailures = 0;
      this.nextRotationAllowedAt = 0;
    } catch (err) {
      this.consecutiveFailures += 1;
      const exponent = Math.min(this.consecutiveFailures, 16);
      const backoffMs = Math.min(2 ** exponent * 1e3, ROTATION_MAX_BACKOFF_MS);
      this.nextRotationAllowedAt = Date.now() + backoffMs;
      this.logger.error("WalletReceiveRotator: rotation failed", err, {
        consecutiveFailures: this.consecutiveFailures,
        nextAttemptInMs: backoffMs
      });
    }
  }
  /**
   * Wait for any in-flight rotation to complete. Useful in tests
   * that need to observe the post-rotation state after dispatching
   * a `vtxo_received` event synchronously; production code rarely
   * needs to call this directly.
   */
  async drain() {
    await this.chain.catch(() => void 0);
  }
  /**
   * Tear down the subscription first so no late `vtxo_received` event
   * can queue work on a disposing wallet, then drain any in-flight
   * rotation so its `createContract` finishes before the contract
   * manager itself disposes.
   */
  async dispose() {
    if (this.unsubscribe) {
      try {
        this.unsubscribe();
      } catch {
      } finally {
        this.unsubscribe = void 0;
      }
    }
    await this.chain.catch(() => void 0);
  }
  /**
   * Allocate the next descriptor, swap it into the wallet's active
   * offchain tapscript, register the new tagged contract, and retire
   * the previous tagged contract (if any) by setting its state to
   * `inactive`. The contract watcher keeps watching inactive
   * contracts until their VTXOs are spent, so funds in flight at the
   * old display address are not lost — only the address stops being
   * advertised.
   *
   * Contract type matches the wallet's tapscript shape: a default
   * wallet rotates to a new `default` contract, a delegate wallet to
   * a new `delegate` contract.
   *
   * The first rotation on a fresh wallet does NOT deactivate
   * anything: `currentTaggedScript` is `undefined` because the wallet
   * was displaying the untagged index-0 baseline, which must stay
   * active forever.
   */
  async rotate(wallet) {
    const descriptor = await this.provider.getNextSigningDescriptor();
    const pubKey = deriveLeafPubkey(descriptor);
    const newTapscript = rebuildTapscript(wallet.offchainTapscript, pubKey);
    const newScript = hex.encode(newTapscript.pkScript);
    const newAddress = newTapscript.address(wallet.network.hrp, wallet.arkServerPublicKey).encode();
    const manager = await wallet.getContractManager();
    const csvTimelock = newTapscript.options.csvTimelock ?? DefaultVtxo.Script.DEFAULT_TIMELOCK;
    const csvTimelockStr = timelockToSequence(csvTimelock).toString();
    const serverPubKeyHex = hex.encode(newTapscript.options.serverPubKey);
    const baseParams = {
      script: newScript,
      address: newAddress,
      state: "active",
      // Persist the materialized signing descriptor alongside the
      // source tag. The wallet's spending paths read this at sign
      // time to route inputs locked by a rotated pubkey through
      // `DescriptorProvider.signWithDescriptor` instead of the
      // identity's index-0 key. Without it, post-rotation sends
      // produce unsigned PSBTs that the server rejects with
      // `INVALID_PSBT_INPUT (5): missing tapscript spend sig`.
      metadata: {
        source: WALLET_RECEIVE_SOURCE,
        signingDescriptor: descriptor
      }
    };
    if (newTapscript instanceof DelegateVtxo.Script) {
      await manager.createContract({
        ...baseParams,
        type: "delegate",
        params: {
          pubKey: hex.encode(pubKey),
          serverPubKey: serverPubKeyHex,
          delegatePubKey: hex.encode(newTapscript.options.delegatePubKey),
          csvTimelock: csvTimelockStr
        }
      });
    } else {
      await manager.createContract({
        ...baseParams,
        type: "default",
        params: {
          pubKey: hex.encode(pubKey),
          serverPubKey: serverPubKeyHex,
          csvTimelock: csvTimelockStr
        }
      });
    }
    wallet.setOffchainTapscriptForRotation(newTapscript);
    const previousTagged = this.currentTaggedScript;
    if (previousTagged !== void 0 && previousTagged !== newScript) {
      await manager.setContractState(previousTagged, "inactive");
    }
    this.currentTaggedScript = newScript;
  }
};
function deriveLeafPubkey(descriptor) {
  try {
    return deriveDescriptorLeafPubKey(descriptor);
  } catch (e) {
    throw new NonRangeableDescriptorError(
      "Cannot derive leaf pubkey: descriptor is not a materialized, parsable tr(...) shape.",
      { cause: e }
    );
  }
}
function rebuildTapscript(current, pubKey) {
  if (current instanceof DelegateVtxo.Script) {
    return new DelegateVtxo.Script({ ...current.options, pubKey });
  }
  return new DefaultVtxo.Script({ ...current.options, pubKey });
}
async function pickActiveReceive(contractRepository, serverPubKey, expectedType) {
  const candidates = await contractRepository.getContracts({
    type: expectedType ? [expectedType] : ["default", "delegate"],
    state: "active"
  });
  const serverPubKeyHex = hex.encode(serverPubKey);
  const matching = candidates.filter(
    (c) => c.params.serverPubKey === serverPubKeyHex && c.metadata?.source === WALLET_RECEIVE_SOURCE
  ).sort((a, b) => {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return signingDescriptorIndex(b.metadata?.signingDescriptor) - signingDescriptorIndex(a.metadata?.signingDescriptor);
  });
  const newest = matching[0];
  if (!newest?.params.pubKey) return void 0;
  try {
    return {
      pubKey: hex.decode(newest.params.pubKey),
      script: newest.script
    };
  } catch {
    return void 0;
  }
}
async function resolveDescriptorProvider(config, walletRepository) {
  const mode = config.walletMode ?? "auto";
  if (mode === "static" || mode === "auto") return void 0;
  if (typeof mode !== "string") {
    return mode;
  }
  if (!isHDCapableIdentity(config.identity)) {
    throw new Error(
      "walletMode 'hd' requires an HD-capable identity (SeedIdentity / MnemonicIdentity with a rangeable BIP-32 descriptor) or an explicit DescriptorProvider."
    );
  }
  try {
    return await HDDescriptorProvider.create(config.identity, walletRepository);
  } catch (e) {
    throw new Error(
      "walletMode 'hd' failed to initialize: " + (e instanceof Error ? e.message : String(e)),
      { cause: e }
    );
  }
}

// src/wallet/signingErrors.ts
var MissingSigningDescriptorError = class extends Error {
  constructor(contractScript, contractType) {
    super(
      `Cannot sign input for ${contractType} contract ${contractScript}: metadata.signingDescriptor is missing. This wallet was rotated on an earlier build that did not persist signing descriptors. Manually set metadata.signingDescriptor on the contract record, or restore from a pre-rotation snapshot.`
    );
    this.contractScript = contractScript;
    this.contractType = contractType;
  }
  name = "MissingSigningDescriptorError";
};
var DescriptorSigningProviderMissingError = class extends Error {
  name = "DescriptorSigningProviderMissingError";
  constructor() {
    super("Descriptor signing requested but no DescriptorProvider was wired into this wallet");
  }
};

// src/wallet/inputSignerRouter.ts
var DESCRIPTOR_CAPABLE_CONTRACT_TYPES = /* @__PURE__ */ new Set(["default", "delegate"]);
var InputSignerRouter = class {
  constructor(deps) {
    this.deps = deps;
  }
  /**
   * Resolve each job to its target signer without invoking signing. The
   * returned plan is the single source of truth for both {@link sign} and
   * the batch-eligibility predicate {@link canBatch} — callers that want
   * to pre-flight a batch path call {@link canBatch} (which delegates
   * here) so the routing rules never live in two places.
   *
   * Throws {@link MissingSigningDescriptorError} for a non-baseline
   * default/delegate contract whose `metadata.signingDescriptor` is
   * missing — the same condition that would later abort signing. Failing
   * here moves the failure earlier, before any PSBT is mutated.
   */
  async classify(jobs) {
    const identityIndexes = [];
    const descriptorGroups = /* @__PURE__ */ new Map();
    if (jobs.length === 0) {
      return { identityIndexes, descriptorGroups };
    }
    const distinctScripts = Array.from(new Set(jobs.map((j) => hex.encode(j.lookupScript))));
    const contracts = await this.deps.contractRepository.getContracts({
      script: distinctScripts
    });
    const scriptToContract = /* @__PURE__ */ new Map();
    for (const contract of contracts) {
      if (!scriptToContract.has(contract.script)) {
        scriptToContract.set(contract.script, contract);
      }
    }
    const baselinePubKeyHex = hex.encode(await this.deps.identity.xOnlyPublicKey());
    const boardingScriptHex = hex.encode(this.deps.boardingPkScript);
    for (const job of jobs) {
      const scriptHex = hex.encode(job.lookupScript);
      const contract = scriptToContract.get(scriptHex);
      if (!contract) {
        if (scriptHex === boardingScriptHex) {
          identityIndexes.push(job.index);
        }
        continue;
      }
      if (!DESCRIPTOR_CAPABLE_CONTRACT_TYPES.has(contract.type)) {
        identityIndexes.push(job.index);
        continue;
      }
      const ownerPubKeyHex = contract.params.pubKey?.toLowerCase();
      if (ownerPubKeyHex && ownerPubKeyHex === baselinePubKeyHex) {
        identityIndexes.push(job.index);
        continue;
      }
      const descriptor = contract.metadata?.signingDescriptor;
      if (typeof descriptor !== "string" || descriptor.length === 0) {
        throw new MissingSigningDescriptorError(
          contract.script,
          contract.type
        );
      }
      const bucket = descriptorGroups.get(descriptor);
      if (bucket) {
        bucket.push(job.index);
      } else {
        descriptorGroups.set(descriptor, [job.index]);
      }
    }
    return { identityIndexes, descriptorGroups };
  }
  /**
   * Returns `true` when every signable input across all `jobSets` resolves
   * to the baseline {@link Identity} key — i.e. the descriptor provider
   * would not be invoked. Used by the wallet's send/recovery paths to
   * pre-flight the {@link BatchSignableIdentity.signMultiple} fast path,
   * which can only fold work a single identity key can sign.
   *
   * Accepts several job sets (e.g. an arkTx's jobs plus one set per
   * checkpoint) and classifies their union in a single pass. Eligibility
   * is monotonic — the union routes entirely to the baseline key iff every
   * set does — so this returns the same answer as ANDing the per-set
   * results, but with one {@link classify} (one repo round-trip + one
   * `xOnlyPublicKey` call) instead of one per set. Only the routing buckets
   * matter here, so the input-index collisions produced by flattening jobs
   * from different transactions are irrelevant.
   */
  async canBatch(...jobSets) {
    const plan = await this.classify(jobSets.flat());
    return plan.descriptorGroups.size === 0;
  }
  async sign(tx, jobs) {
    if (jobs.length === 0) return tx;
    const { identityIndexes, descriptorGroups } = await this.classify(jobs);
    let signed = tx;
    if (identityIndexes.length > 0) {
      signed = await this.deps.identity.sign(signed, identityIndexes);
    }
    if (descriptorGroups.size > 0) {
      if (!this.deps.descriptorProvider) {
        throw new DescriptorSigningProviderMissingError();
      }
      const sortedDescriptors = Array.from(descriptorGroups.keys()).sort();
      for (const descriptor of sortedDescriptors) {
        const indexes = descriptorGroups.get(descriptor);
        const [next] = await this.deps.descriptorProvider.signWithDescriptor([
          {
            tx: signed,
            descriptor,
            inputIndexes: indexes
          }
        ]);
        signed = next;
      }
    }
    return signed;
  }
};

// src/wallet/wallet.ts
var getArkadeServerUrl = ({ arkServerUrl }) => arkServerUrl || DEFAULT_ARKADE_SERVER_URL;
function intentProofJobs(coins) {
  if (coins.length === 0) return [];
  const coinJobs = coins.map((coin, i) => ({
    index: i + 1,
    lookupScript: VtxoScript.decode(coin.tapTree).pkScript
  }));
  return [{ index: 0, lookupScript: coinJobs[0].lookupScript }, ...coinJobs];
}
function extractArkProviderUrl(provider) {
  const serverUrl = provider.serverUrl;
  return typeof serverUrl === "string" && serverUrl.length > 0 ? serverUrl : void 0;
}
var MAINNET_UNILATERAL_EXIT_DELAY = 605184n;
function delayToTimelock(delay) {
  return {
    value: delay,
    type: delay < 512n ? "blocks" : "seconds"
  };
}
function dedupeTimelocks(timelocks) {
  const seen = /* @__PURE__ */ new Set();
  const deduped = [];
  for (const timelock of timelocks) {
    const sequence = timelockToSequence(timelock).toString();
    if (seen.has(sequence)) continue;
    seen.add(sequence);
    deduped.push(timelock);
  }
  return deduped;
}
function hasToReadonly(identity) {
  return typeof identity === "object" && identity !== null && "toReadonly" in identity && typeof identity.toReadonly === "function";
}
var ReadonlyWallet = class _ReadonlyWallet {
  constructor(identity, network, onchainProvider, indexerProvider, arkServerPublicKey, offchainTapscript, boardingTapscript, dustAmount, walletRepository, contractRepository, delegateProvider, watcherConfig, walletContractTimelocks) {
    this.identity = identity;
    this.network = network;
    this.onchainProvider = onchainProvider;
    this.indexerProvider = indexerProvider;
    this.arkServerPublicKey = arkServerPublicKey;
    this.boardingTapscript = boardingTapscript;
    this.dustAmount = dustAmount;
    this.walletRepository = walletRepository;
    this.contractRepository = contractRepository;
    this.delegateProvider = delegateProvider;
    if ("descriptor" in identity) {
      const descriptor = identity.descriptor;
      const identityIsMainnet = !descriptor.includes("tpub");
      const serverIsMainnet = network.bech32 === "bc";
      if (identityIsMainnet !== serverIsMainnet) {
        throw new Error(
          `Network mismatch: identity uses ${identityIsMainnet ? "mainnet" : "testnet"} derivation but wallet network is ${serverIsMainnet ? "mainnet" : "testnet"}. Create identity with { isMainnet: ${serverIsMainnet} } to match.`
        );
      }
    }
    this._offchainTapscript = offchainTapscript;
    this.watcherConfig = watcherConfig;
    this._assetManager = new ReadonlyAssetManager(this.indexerProvider);
    this.walletContractTimelocks = walletContractTimelocks && walletContractTimelocks.length > 0 ? dedupeTimelocks(walletContractTimelocks) : [
      this.offchainTapscript.options.csvTimelock ?? DefaultVtxo.Script.DEFAULT_TIMELOCK
    ];
  }
  _contractManager;
  _contractManagerInitializing;
  watcherConfig;
  _assetManager;
  _syncVtxosInflight;
  walletContractTimelocks;
  // Outpoints ("txid:vout") committed to an in-flight settle/send. Filtered
  // from getVtxos() so concurrent callers (UI, VtxoManager auto-renewal,
  // another send/settle racing the _txLock) can't reselect coins that are
  // already on their way out. The set is in-memory only: a process crash
  // clears it, and a stale entry only hides a VTXO (never spends one).
  _pendingSpendOutpoints = /* @__PURE__ */ new Set();
  get assetManager() {
    return this._assetManager;
  }
  /**
   * Backing field for the active receive tapscript. Read via the
   * public `offchainTapscript` getter; written only by
   * {@link Wallet.setOffchainTapscriptForRotation}, which
   * {@link WalletReceiveRotator.rotate} is the sole intended caller of.
   */
  _offchainTapscript;
  /**
   * Currently-active receive tapscript. Read-only from the outside;
   * mutated only via {@link Wallet.setOffchainTapscriptForRotation}
   * by {@link WalletReceiveRotator.rotate}.
   */
  get offchainTapscript() {
    return this._offchainTapscript;
  }
  /**
   * Protected helper to set up shared wallet configuration.
   * Extracts common logic used by both ReadonlyWallet.create() and Wallet.create().
   */
  static async setupWalletConfig(config, pubKey) {
    const arkadeServerUrl = getArkadeServerUrl(config);
    const arkProvider = config.arkProvider || new RestArkProvider(arkadeServerUrl);
    let indexerProvider = config.indexerProvider;
    if (!indexerProvider) {
      let indexerUrl = config.indexerUrl;
      if (!indexerUrl) {
        if (config.arkProvider) {
          const derived = extractArkProviderUrl(config.arkProvider);
          if (!derived) {
            throw new Error(
              "indexerUrl is required when arkProvider is provided without a discoverable serverUrl"
            );
          }
          indexerUrl = derived;
        } else {
          indexerUrl = arkadeServerUrl;
        }
      }
      indexerProvider = new RestIndexerProvider(indexerUrl);
    }
    const info = await arkProvider.getInfo();
    const network = getNetwork(info.network);
    if ("descriptor" in config.identity) {
      const descriptor = config.identity.descriptor;
      const identityIsMainnet = !descriptor.includes("tpub");
      const serverIsMainnet = info.network === "bitcoin";
      if (identityIsMainnet && !serverIsMainnet) {
        throw new Error(
          `Network mismatch: identity uses mainnet derivation (coin type 0) but the Arkade server is on ${info.network}. Create identity with { isMainnet: false } to use testnet derivation.`
        );
      }
      if (!identityIsMainnet && serverIsMainnet) {
        throw new Error(
          `Network mismatch: identity uses testnet derivation (coin type 1) but the Arkade server is on mainnet. Create identity with { isMainnet: true } or omit isMainnet (defaults to mainnet).`
        );
      }
    }
    const esploraUrl = config.esploraUrl || ESPLORA_URL[info.network];
    const onchainProvider = config.onchainProvider || new EsploraProvider(esploraUrl);
    if (config.exitTimelock) {
      const { value, type } = config.exitTimelock;
      if (value < 512n && type !== "blocks" || value >= 512n && type !== "seconds") {
        throw new Error("invalid exitTimelock");
      }
    }
    const arkdExitTimelock = delayToTimelock(info.unilateralExitDelay);
    const exitTimelock = config.exitTimelock ?? arkdExitTimelock;
    const walletContractTimelocks = config.exitTimelock ? [exitTimelock] : dedupeTimelocks([
      arkdExitTimelock,
      ...info.network === "bitcoin" ? [delayToTimelock(MAINNET_UNILATERAL_EXIT_DELAY)] : []
    ]);
    if (config.boardingTimelock) {
      const { value, type } = config.boardingTimelock;
      if (value < 512n && type !== "blocks" || value >= 512n && type !== "seconds") {
        throw new Error("invalid boardingTimelock");
      }
    }
    const boardingTimelock = config.boardingTimelock ?? {
      value: info.boardingExitDelay,
      type: info.boardingExitDelay < 512n ? "blocks" : "seconds"
    };
    const serverPubKey = hex.decode(info.signerPubkey).slice(1);
    const delegatePubKey = config.delegateProvider ? await config.delegateProvider.getDelegateInfo().then((info2) => hex.decode(info2.pubkey).slice(1)) : config.delegatorProvider ? await config.delegatorProvider.getDelegateInfo().then((info2) => hex.decode(info2.pubkey).slice(1)) : void 0;
    const offchainOptions = {
      pubKey,
      serverPubKey,
      csvTimelock: exitTimelock
    };
    const offchainTapscript = !delegatePubKey ? new DefaultVtxo.Script(offchainOptions) : new DelegateVtxo.Script({ ...offchainOptions, delegatePubKey });
    const boardingTapscript = new DefaultVtxo.Script({
      ...offchainOptions,
      csvTimelock: boardingTimelock
    });
    const walletRepository = config.storage?.walletRepository ?? new IndexedDBWalletRepository();
    const contractRepository = config.storage?.contractRepository ?? new IndexedDBContractRepository();
    return {
      arkProvider,
      indexerProvider,
      onchainProvider,
      network,
      networkName: info.network,
      serverPubKey,
      offchainTapscript,
      boardingTapscript,
      dustAmount: info.dust,
      walletRepository,
      contractRepository,
      info,
      delegateProvider: config.delegateProvider || config.delegatorProvider,
      /** @deprecated alias for `delegateProvider` */
      delegatorProvider: config.delegateProvider || config.delegatorProvider,
      walletContractTimelocks
    };
  }
  /**
   * Create a readonly wallet for querying balances, addresses, and history.
   *
   * @param config - Readonly wallet configuration
   * @returns A readonly wallet instance
   */
  static async create(config) {
    const pubkey = await config.identity.xOnlyPublicKey();
    if (!pubkey) {
      throw new Error("Invalid configured public key");
    }
    const setup = await _ReadonlyWallet.setupWalletConfig(config, pubkey);
    return new _ReadonlyWallet(
      config.identity,
      setup.network,
      setup.onchainProvider,
      setup.indexerProvider,
      setup.serverPubKey,
      setup.offchainTapscript,
      setup.boardingTapscript,
      setup.dustAmount,
      setup.walletRepository,
      setup.contractRepository,
      setup.delegateProvider || setup.delegatorProvider,
      config.watcherConfig,
      setup.walletContractTimelocks
    );
  }
  get arkAddress() {
    return this.offchainTapscript.address(this.network.hrp, this.arkServerPublicKey);
  }
  /**
   * Get the pkScript hex for the wallet's primary offchain address.
   * For the full wallet-owned script set registered in ContractManager, use getWalletScripts().
   */
  get defaultContractScript() {
    return hex.encode(this.offchainTapscript.pkScript);
  }
  /** Returns the wallet's Arkade address. */
  async getAddress() {
    return this.arkAddress.encode();
  }
  /** Returns the onchain boarding address used to move funds into Arkade. */
  async getBoardingAddress() {
    return this.boardingTapscript.onchainAddress(this.network);
  }
  /**
   * Return the wallet's combined onchain and offchain balances.
   */
  async getBalance() {
    const [boardingUtxos, vtxos] = await Promise.all([
      this.getBoardingUtxos(),
      this.getVtxos()
    ]);
    let confirmed = 0;
    let unconfirmed = 0;
    for (const utxo of boardingUtxos) {
      if (utxo.status.confirmed) {
        confirmed += utxo.value;
      } else {
        unconfirmed += utxo.value;
      }
    }
    let settled = 0;
    let preconfirmed = 0;
    let recoverable = 0;
    settled = vtxos.filter((coin) => coin.virtualStatus.state === "settled").reduce((sum, coin) => sum + coin.value, 0);
    preconfirmed = vtxos.filter((coin) => coin.virtualStatus.state === "preconfirmed").reduce((sum, coin) => sum + coin.value, 0);
    recoverable = vtxos.filter((coin) => isSpendable(coin) && coin.virtualStatus.state === "swept").reduce((sum, coin) => sum + coin.value, 0);
    const totalBoarding = confirmed + unconfirmed;
    const totalOffchain = settled + preconfirmed + recoverable;
    const assetBalances = /* @__PURE__ */ new Map();
    for (const vtxo of vtxos) {
      if (!isSpendable(vtxo)) continue;
      if (vtxo.assets) {
        for (const a of vtxo.assets) {
          const current = assetBalances.get(a.assetId) ?? 0n;
          assetBalances.set(a.assetId, current + a.amount);
        }
      }
    }
    const assets = Array.from(assetBalances.entries()).map(([assetId, amount]) => ({
      assetId,
      amount
    }));
    return {
      boarding: {
        confirmed,
        unconfirmed,
        total: totalBoarding
      },
      settled,
      preconfirmed,
      available: settled + preconfirmed,
      recoverable,
      total: totalBoarding + totalOffchain,
      assets
    };
  }
  /**
   * Return virtual outputs tracked by the wallet.
   *
   * @param filter - Optional flags controlling whether recoverable or unrolled VTXOs are included
   */
  async getVtxos(filter) {
    const f = filter ?? { withRecoverable: true, withUnrolled: false };
    const contractManager = await this.getContractManager();
    const vtxos = await contractManager.getContractsWithVtxos();
    return vtxos.flatMap((_) => _.vtxos).filter((vtxo) => {
      if (this._pendingSpendOutpoints.has(`${vtxo.txid}:${vtxo.vout}`)) {
        return false;
      }
      if (isSpendable(vtxo)) {
        if (!f.withRecoverable && (isRecoverable(vtxo) || isExpired(vtxo))) {
          return false;
        }
        return true;
      }
      return !!(f.withUnrolled && vtxo.isUnrolled);
    });
  }
  /**
   * Return wallet transaction history derived from Arkade state and boarding transactions.
   */
  async getTransactionHistory() {
    const contractManager = await this.getContractManager();
    const response = await contractManager.getContractsWithVtxos();
    const allVtxos = response.flatMap((_) => _.vtxos);
    const { boardingTxs, commitmentsToIgnore } = await this.getBoardingTxs();
    const getTxCreatedAt = (txid) => this.indexerProvider.getVtxos({ outpoints: [{ txid, vout: 0 }] }).then((res) => res.vtxos[0]?.createdAt.getTime());
    return buildTransactionHistory(allVtxos, boardingTxs, commitmentsToIgnore, getTxCreatedAt);
  }
  /**
   * Clear the global VTXO sync cursor, forcing a full re-bootstrap on next sync.
   * Useful for recovery after indexer reprocessing or debugging.
   */
  async clearSyncCursor() {
    await clearSyncCursor(this.walletRepository);
  }
  /**
   * Build a transaction history view for the wallet's boarding address.
   */
  async getBoardingTxs() {
    const utxos = [];
    const commitmentsToIgnore = /* @__PURE__ */ new Set();
    const boardingAddress = await this.getBoardingAddress();
    const txs = await this.onchainProvider.getTransactions(boardingAddress);
    const outspendCache = /* @__PURE__ */ new Map();
    for (const tx of txs) {
      for (let i = 0; i < tx.vout.length; i++) {
        const vout = tx.vout[i];
        if (vout.scriptpubkey_address === boardingAddress) {
          let spentStatuses = outspendCache.get(tx.txid);
          if (!spentStatuses) {
            spentStatuses = await this.onchainProvider.getTxOutspends(tx.txid);
            outspendCache.set(tx.txid, spentStatuses);
          }
          const spentStatus = spentStatuses[i];
          if (spentStatus?.spent) {
            commitmentsToIgnore.add(spentStatus.txid);
          }
          utxos.push({
            txid: tx.txid,
            vout: i,
            value: Number(vout.value),
            status: {
              confirmed: tx.status.confirmed,
              block_time: tx.status.block_time
            },
            isUnrolled: true,
            virtualStatus: {
              state: spentStatus?.spent ? "spent" : "settled",
              commitmentTxIds: spentStatus?.spent ? [spentStatus.txid] : void 0
            },
            createdAt: tx.status.confirmed ? new Date(tx.status.block_time * 1e3) : /* @__PURE__ */ new Date(0),
            script: hex.encode(this.boardingTapscript.pkScript)
          });
        }
      }
    }
    const unconfirmedTxs = [];
    const confirmedTxs = [];
    for (const utxo of utxos) {
      const tx = {
        key: {
          boardingTxid: utxo.txid,
          commitmentTxid: utxo.virtualStatus.commitmentTxIds?.[0] ?? "",
          arkTxid: ""
        },
        amount: utxo.value,
        type: "RECEIVED" /* TxReceived */,
        settled: utxo.virtualStatus.state === "spent",
        createdAt: utxo.status.block_time ? new Date(utxo.status.block_time * 1e3).getTime() : 0
      };
      if (!utxo.status.block_time) {
        unconfirmedTxs.push(tx);
      } else {
        confirmedTxs.push(tx);
      }
    }
    return {
      boardingTxs: [...unconfirmedTxs, ...confirmedTxs],
      commitmentsToIgnore
    };
  }
  /**
   * Fetch and cache onchain inputs (UTXOs) received at the boarding address.
   */
  async getBoardingUtxos() {
    const boardingAddress = await this.getBoardingAddress();
    const boardingUtxos = await this.onchainProvider.getCoins(boardingAddress);
    const utxos = boardingUtxos.map((utxo) => {
      return extendCoin(this, utxo);
    });
    await this.walletRepository.saveUtxos(boardingAddress, utxos);
    return utxos;
  }
  /**
   * Subscribe to onchain and offchain notifications for newly received funds.
   *
   * @param eventCallback - Callback invoked when matching funds are detected
   * @returns A function that stops the subscriptions
   */
  async notifyIncomingFunds(eventCallback) {
    const arkAddress = await this.getAddress();
    const boardingAddress = await this.getBoardingAddress();
    let onchainStopFunc;
    let indexerStopFunc;
    if (this.onchainProvider && boardingAddress) {
      const findVoutOnTx = (tx) => {
        return tx.vout.findIndex((v) => v.scriptpubkey_address === boardingAddress);
      };
      onchainStopFunc = await this.onchainProvider.watchAddresses(
        [boardingAddress],
        (txs) => {
          const coins = txs.filter((tx) => findVoutOnTx(tx) !== -1).map((tx) => {
            const { txid, status } = tx;
            const vout = findVoutOnTx(tx);
            const value = Number(tx.vout[vout].value);
            return { txid, vout, value, status };
          });
          eventCallback({
            type: "utxo",
            coins
          });
        }
      );
    }
    if (this.indexerProvider && arkAddress) {
      const cm = await this.getContractManager();
      let annotationQueue = Promise.resolve();
      indexerStopFunc = cm.onContractEvent((event) => {
        if (event.type !== "vtxo_received" && event.type !== "vtxo_spent") {
          return;
        }
        if (event.contract.type !== "default" && event.contract.type !== "delegate") {
          return;
        }
        annotationQueue = annotationQueue.then(async () => {
          try {
            const annotated = await cm.annotateVtxos(event.vtxos);
            eventCallback({
              type: "vtxo",
              newVtxos: event.type === "vtxo_received" ? annotated : [],
              spentVtxos: event.type === "vtxo_spent" ? annotated : []
            });
          } catch (error) {
            console.warn(
              "Dropping subscription update after annotation failed; next sync will reconcile:",
              error
            );
          }
        });
      });
    }
    const stopFunc = () => {
      onchainStopFunc?.();
      indexerStopFunc?.();
    };
    return stopFunc;
  }
  /** Fetch Arkade transaction ids that are still pending final settlement. */
  async fetchPendingTxs() {
    const scripts = await this.getWalletScripts();
    let { vtxos } = await this.indexerProvider.getVtxos({
      scripts
    });
    return vtxos.filter(
      (vtxo) => vtxo.virtualStatus.state !== "swept" && vtxo.virtualStatus.state !== "settled" && vtxo.arkTxId !== void 0
    ).map((_) => _.arkTxId);
  }
  // ========================================================================
  // Multi-script support (default + delegate addresses)
  // ========================================================================
  /**
   * Get all pkScript hex strings for the wallet's own addresses
   * (both delegate and non-delegate, current and historical).
   */
  async getWalletScripts() {
    const manager = await this.getContractManager();
    const contracts = await manager.getContracts({
      type: ["default", "delegate"]
    });
    return contracts.map((c) => c.script);
  }
  /**
   * Build a map of scriptHex → VtxoScript for all wallet contracts,
   * so virtual outputs can be extended with the correct tapscript per contract.
   */
  async getScriptMap() {
    const map = /* @__PURE__ */ new Map();
    const manager = await this.getContractManager();
    const contracts = await manager.getContracts({
      type: ["default", "delegate"]
    });
    for (const contract of contracts) {
      if (map.has(contract.script)) continue;
      const handler = contractHandlers.get(contract.type);
      if (handler) {
        const script = handler.createScript(contract.params);
        map.set(contract.script, script);
      }
    }
    return map;
  }
  // ========================================================================
  // Contract Management
  // ========================================================================
  /**
   * Get the ContractManager for managing contracts including the wallet's default address.
   *
   * The ContractManager handles:
   * - The wallet's default receiving address (as a "default" contract)
   * - External contracts (Boltz swaps, HTLCs, etc.)
   * - Multi-contract watching with resilient connections
   *
   * @example
   * ```typescript
   * const manager = await wallet.getContractManager();
   *
   * // Create a contract for a Boltz swap
   * const contract = await manager.createContract({
   *   label: "Boltz Swap",
   *   type: "vhtlc",
   *   params: { ... },
   *   script: swapScript,
   *   address: swapAddress,
   * });
   *
   * // Start watching for events (includes wallet's default address)
   * const stop = await manager.onContractEvent((event) => {
   *   console.log(`${event.type} on ${event.contractScript}`);
   * });
   * ```
   */
  async getContractManager() {
    if (this._contractManager) {
      return this._contractManager;
    }
    if (this._contractManagerInitializing) {
      return this._contractManagerInitializing;
    }
    this._contractManagerInitializing = this.initializeContractManager();
    try {
      const manager = await this._contractManagerInitializing;
      this._contractManager = manager;
      return manager;
    } catch (error) {
      this._contractManagerInitializing = void 0;
      throw error;
    } finally {
      this._contractManagerInitializing = void 0;
    }
  }
  async initializeContractManager() {
    const manager = await ContractManager.create({
      indexerProvider: this.indexerProvider,
      contractRepository: this.contractRepository,
      walletRepository: this.walletRepository,
      watcherConfig: this.watcherConfig
    });
    const baselinePubkey = await this.identity.xOnlyPublicKey();
    for (const csvTimelock of this.walletContractTimelocks) {
      const csvTimelockStr = timelockToSequence(csvTimelock).toString();
      const defaultScript = new DefaultVtxo.Script({
        pubKey: baselinePubkey,
        serverPubKey: this.offchainTapscript.options.serverPubKey,
        csvTimelock
      });
      const defaultScriptHex = hex.encode(defaultScript.pkScript);
      await manager.createContract({
        type: "default",
        params: {
          pubKey: hex.encode(defaultScript.options.pubKey),
          serverPubKey: hex.encode(defaultScript.options.serverPubKey),
          csvTimelock: csvTimelockStr
        },
        script: defaultScriptHex,
        address: defaultScript.address(this.network.hrp, this.arkServerPublicKey).encode(),
        state: "active"
      });
      if (this.offchainTapscript instanceof DelegateVtxo.Script) {
        const delegateScript = new DelegateVtxo.Script({
          pubKey: baselinePubkey,
          serverPubKey: this.offchainTapscript.options.serverPubKey,
          delegatePubKey: this.offchainTapscript.options.delegatePubKey,
          csvTimelock
        });
        const delegateScriptHex = hex.encode(delegateScript.pkScript);
        await manager.createContract({
          type: "delegate",
          params: {
            pubKey: hex.encode(delegateScript.options.pubKey),
            serverPubKey: hex.encode(delegateScript.options.serverPubKey),
            delegatePubKey: hex.encode(delegateScript.options.delegatePubKey),
            csvTimelock: csvTimelockStr
          },
          script: delegateScriptHex,
          address: delegateScript.address(this.network.hrp, this.arkServerPublicKey).encode(),
          state: "active"
        });
      }
    }
    return manager;
  }
  /** Dispose wallet-owned managers and release background resources. */
  async dispose() {
    const manager = this._contractManager ?? (this._contractManagerInitializing ? await this._contractManagerInitializing.catch(() => void 0) : void 0);
    manager?.dispose();
    this._contractManager = void 0;
    this._contractManagerInitializing = void 0;
  }
  /** Async-dispose hook that forwards to `dispose()`. */
  async [Symbol.asyncDispose]() {
    await this.dispose();
  }
};
var Wallet2 = class _Wallet extends ReadonlyWallet {
  constructor(identity, network, onchainProvider, arkProvider, indexerProvider, arkServerPublicKey, offchainTapscript, boardingTapscript, serverUnrollScript, forfeitOutputScript, forfeitPubkey, dustAmount, walletRepository, contractRepository, renewalConfig, delegateProvider, watcherConfig, settlementConfig, walletContractTimelocks, receiveRotator, descriptorProvider) {
    super(
      identity,
      network,
      onchainProvider,
      indexerProvider,
      arkServerPublicKey,
      offchainTapscript,
      boardingTapscript,
      dustAmount,
      walletRepository,
      contractRepository,
      delegateProvider,
      watcherConfig,
      walletContractTimelocks
    );
    this.arkProvider = arkProvider;
    this.serverUnrollScript = serverUnrollScript;
    this.forfeitOutputScript = forfeitOutputScript;
    this.forfeitPubkey = forfeitPubkey;
    this.identity = identity;
    this.renewalConfig = {
      enabled: renewalConfig?.enabled ?? false,
      ...DEFAULT_RENEWAL_CONFIG,
      ...renewalConfig
    };
    if (settlementConfig !== void 0) {
      this.settlementConfig = settlementConfig;
    } else if (renewalConfig && this.renewalConfig.enabled) {
      this.settlementConfig = {
        vtxoThreshold: renewalConfig.thresholdMs ? renewalConfig.thresholdMs / 1e3 : void 0
      };
    } else if (renewalConfig) {
      this.settlementConfig = false;
    } else {
      this.settlementConfig = { ...DEFAULT_SETTLEMENT_CONFIG };
    }
    this._delegateManager = delegateProvider ? new DelegateManagerImpl(delegateProvider, arkProvider, identity) : void 0;
    this._receiveRotator = receiveRotator;
    this._descriptorProvider = descriptorProvider;
    this._signerRouter = new InputSignerRouter({
      identity,
      contractRepository,
      descriptorProvider,
      boardingPkScript: boardingTapscript.pkScript
    });
  }
  static MIN_FEE_RATE = 1;
  // sats/vbyte
  identity;
  _delegateManager;
  _vtxoManager;
  _vtxoManagerInitializing;
  _walletAssetManager;
  /**
   * HD receive rotator. Owns the {@link DescriptorProvider}, the
   * `vtxo_received` subscription, and the rotate-and-register
   * lifecycle. Absent in `walletMode: 'static'` and for SingleKey
   * wallets under `'auto'`. Wired in via the constructor; the actual
   * subscription is installed lazily on first `getVtxoManager()` so
   * the contract manager is up first.
   */
  _receiveRotator;
  _receiveRotatorInstalled = false;
  /**
   * Descriptor-aware signer used by {@link _signerRouter} to sign
   * inputs locked by rotated pubkeys. Same instance the rotator owns;
   * stashed here so the spending paths don't have to reach inside the
   * rotator. Undefined for static / non-HD-capable wallets — those
   * paths only ever take the identity-sign branch.
   */
  _descriptorProvider;
  _signerRouter;
  /**
   * @internal Sole write path for `offchainTapscript` after construction.
   * Called by {@link WalletReceiveRotator.rotate} once the rotated
   * display contract has been persisted. External code must treat
   * `offchainTapscript` as read-only.
   */
  setOffchainTapscriptForRotation(tapscript) {
    this._offchainTapscript = tapscript;
  }
  /**
   * Async mutex that serializes all operations submitting VTXOs to the Arkade
   * server (`settle`, `send`, `sendBitcoin`). This prevents VtxoManager's
   * background renewal from racing with user-initiated transactions for the
   * same VTXO inputs.
   */
  _txLock = Promise.resolve();
  /**
   * In-flight guard for {@link restore}. A second `restore()` while one
   * is running returns the same promise so concurrent callers coalesce
   * into a single scan (spec §3.E). Cleared on settle so a later
   * explicit `restore()` re-runs.
   */
  _restoreInFlight;
  _addPendingSpends(inputs) {
    for (const input of inputs) {
      if ("virtualStatus" in input) {
        this._pendingSpendOutpoints.add(`${input.txid}:${input.vout}`);
      }
    }
  }
  _removePendingSpends(inputs) {
    for (const input of inputs) {
      if ("virtualStatus" in input) {
        this._pendingSpendOutpoints.delete(`${input.txid}:${input.vout}`);
      }
    }
  }
  _withTxLock(fn) {
    let release;
    const lock = new Promise((r) => release = r);
    const prev = this._txLock;
    this._txLock = lock;
    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }
  /**
   * Explicitly recover this wallet's contracts and balance on a fresh
   * repo. HD wallets run a gap-limit scan across the index range;
   * static / non-HD wallets restore based on the single default
   * pubkey. Never throws because of identity/mode (a static identity
   * is a valid, narrower restore); throws on operational failure (so a
   * truncated restore is loud, not silent — the gap window may have
   * closed early). Idempotent and safe to call concurrently (calls
   * coalesce into one scan).
   *
   * Ordering is deliberate (spec §3.B / §4): scan → advance the HD
   * watermark → inline VTXO pull → only THEN surface aggregated
   * handler errors, so safely-discovered funds are always recovered
   * even when one discovery handler failed.
   *
   * @param opts.gapLimit - Consecutive-unused-index window. Default
   * 20. A non-positive / non-integer value is a programmer error and
   * throws synchronously (distinct from operational failure).
   *
   * @note Concurrent calls coalesce: if a restore is already in flight,
   * subsequent callers receive the same promise and their `gapLimit` is
   * ignored — the first caller's value governs the running scan.
   */
  async restore(opts) {
    if (this._restoreInFlight) return this._restoreInFlight;
    const gapLimit = opts?.gapLimit ?? 20;
    if (!Number.isInteger(gapLimit) || gapLimit <= 0) {
      throw new Error(
        `restore: gapLimit must be a positive integer (got ${String(opts?.gapLimit)})`
      );
    }
    this._restoreInFlight = this._runRestore(gapLimit).finally(() => {
      this._restoreInFlight = void 0;
    });
    return this._restoreInFlight;
  }
  async _runRestore(gapLimit) {
    const manager = await this.getContractManager();
    const provider = this._descriptorProvider;
    const hd = provider instanceof HDDescriptorProvider;
    const staticDescriptor = hd ? void 0 : `tr(${hex.encode(await this.identity.xOnlyPublicKey())})`;
    const materialize = (index) => hd ? provider.materializeDescriptorAt(index) : staticDescriptor;
    const delegatePubKey = this.offchainTapscript instanceof DelegateVtxo.Script ? this.offchainTapscript.options.delegatePubKey : void 0;
    const deps = {
      indexerProvider: this.indexerProvider,
      onchainProvider: this.onchainProvider,
      network: { hrp: this.network.hrp },
      serverPubKey: this.offchainTapscript.options.serverPubKey,
      csvTimelocks: this.walletContractTimelocks,
      delegatePubKey
    };
    const result = await manager.scanContracts({
      gapLimit,
      hd,
      materialize,
      deps
    });
    if (hd && result.lastIndexUsed >= 0) {
      await provider.advanceLastIndexUsed(result.lastIndexUsed);
    }
    await manager.refreshVtxos({ includeInactive: true });
    if (result.handlerErrors.length > 0) {
      throw new AggregateError(
        result.handlerErrors.map(
          (e) => e.error instanceof Error ? e.error : new Error(String(e.error))
        ),
        `restore: ${result.handlerErrors.length} discovery handler(s) failed; the gap window may have closed early \u2014 retry is safe (idempotent).`
      );
    }
  }
  /** @deprecated Use settlementConfig instead */
  renewalConfig;
  settlementConfig;
  get assetManager() {
    this._walletAssetManager ??= new AssetManager(this);
    return this._walletAssetManager;
  }
  async getVtxoManager() {
    if (this._vtxoManager) {
      return this._vtxoManager;
    }
    if (this._vtxoManagerInitializing) {
      return this._vtxoManagerInitializing;
    }
    this._vtxoManagerInitializing = Promise.resolve(
      new VtxoManager(this, this.renewalConfig, this.settlementConfig)
    );
    try {
      const manager = await this._vtxoManagerInitializing;
      if (this._receiveRotator && !this._receiveRotatorInstalled) {
        try {
          await this._receiveRotator.install(this);
        } catch (installErr) {
          await manager.dispose();
          throw installErr;
        }
        this._receiveRotatorInstalled = true;
      }
      this._vtxoManager = manager;
      return manager;
    } finally {
      this._vtxoManagerInitializing = void 0;
    }
  }
  async dispose() {
    await this._restoreInFlight?.catch(() => void 0);
    let rotatorError;
    try {
      await this._receiveRotator?.dispose();
    } catch (error) {
      rotatorError = error;
    }
    const manager = this._vtxoManager ?? (this._vtxoManagerInitializing ? await this._vtxoManagerInitializing.catch(() => void 0) : void 0);
    try {
      if (manager) {
        await manager.dispose();
      }
    } catch {
    } finally {
      this._vtxoManager = void 0;
      this._vtxoManagerInitializing = void 0;
      await super.dispose();
    }
    if (rotatorError) {
      throw rotatorError;
    }
  }
  /**
   * Create a full wallet and initialize its background managers.
   *
   * @param config - Wallet configuration
   * @returns A wallet ready to query balances and send transactions
   * @example
   * ```typescript
   * const wallet = await Wallet.create({
   *   identity,
   *   arkProvider: new RestArkProvider(),
   * });
   * ```
   */
  static async create(config) {
    const pubkey = await config.identity.xOnlyPublicKey();
    if (!pubkey) {
      throw new Error("Invalid configured public key");
    }
    const setup = await ReadonlyWallet.setupWalletConfig(config, pubkey);
    let serverUnrollScript;
    try {
      const raw = hex.decode(setup.info.checkpointTapscript);
      serverUnrollScript = CSVMultisigTapscript.decode(raw);
    } catch (e) {
      throw new Error("Invalid checkpointTapscript from server");
    }
    const forfeitPubkey = hex.decode(setup.info.forfeitPubkey).slice(1);
    const forfeitAddress = Address(setup.network).decode(setup.info.forfeitAddress);
    const forfeitOutputScript = OutScript.encode(forfeitAddress);
    const boot = await WalletReceiveRotator.resolveBoot(config, setup);
    const wallet = new _Wallet(
      config.identity,
      setup.network,
      setup.onchainProvider,
      setup.arkProvider,
      setup.indexerProvider,
      setup.serverPubKey,
      boot?.offchainTapscript ?? setup.offchainTapscript,
      setup.boardingTapscript,
      serverUnrollScript,
      forfeitOutputScript,
      forfeitPubkey,
      setup.dustAmount,
      setup.walletRepository,
      setup.contractRepository,
      config.renewalConfig,
      config.delegateProvider || config.delegatorProvider,
      config.watcherConfig,
      config.settlementConfig,
      setup.walletContractTimelocks,
      boot?.rotator,
      boot?.provider
    );
    await wallet.getVtxoManager();
    return wallet;
  }
  /**
   * Convert this wallet to a readonly wallet.
   *
   * @returns A readonly wallet with the same configuration but readonly identity
   * @example
   * ```typescript
   * const wallet = await Wallet.create({ identity: MnemonicIdentity.fromMnemonic('abandon abandon...'), ... });
   * const readonlyWallet = await wallet.toReadonly();
   *
   * // Can query balance and addresses
   * const balance = await readonlyWallet.getBalance();
   * const address = await readonlyWallet.getAddress();
   *
   * // But cannot send transactions (type error)
   * // readonlyWallet.send(...); // TypeScript error
   * ```
   */
  async toReadonly() {
    const readonlyIdentity = hasToReadonly(this.identity) ? await this.identity.toReadonly() : this.identity;
    return new ReadonlyWallet(
      readonlyIdentity,
      this.network,
      this.onchainProvider,
      this.indexerProvider,
      this.arkServerPublicKey,
      this.offchainTapscript,
      this.boardingTapscript,
      this.dustAmount,
      this.walletRepository,
      this.contractRepository,
      this.delegateProvider,
      this.watcherConfig,
      this.walletContractTimelocks
    );
  }
  /** Returns the delegate manager when delegation support is configured. */
  async getDelegateManager() {
    return this._delegateManager;
  }
  /** @deprecated alias for @see Wallet.getDelegateManager */
  async getDelegatorManager() {
    return this.getDelegateManager();
  }
  /**
   * Send bitcoin to an Arkade address.
   *
   * @deprecated Use `send`.
   * @param params - Send parameters
   */
  async sendBitcoin(params) {
    if (params.amount <= 0) {
      throw new Error("Amount must be positive");
    }
    if (!isValidArkAddress(params.address)) {
      throw new Error("Invalid Arkade address " + params.address);
    }
    if (params.selectedVtxos && params.selectedVtxos.length > 0) {
      return this._withTxLock(async () => {
        const offchainTapscript = this.offchainTapscript;
        const arkAddress = offchainTapscript.address(
          this.network.hrp,
          this.arkServerPublicKey
        );
        const selectedVtxoSum = params.selectedVtxos.map((v) => v.value).reduce((a, b) => a + b, 0);
        if (selectedVtxoSum < params.amount) {
          throw new Error("Selected VTXOs do not cover specified amount");
        }
        const changeAmount = selectedVtxoSum - params.amount;
        const selected = {
          inputs: params.selectedVtxos,
          changeAmount: BigInt(changeAmount)
        };
        const outputAddress = ArkAddress.decode(params.address);
        const outputScript = BigInt(params.amount) < this.dustAmount ? outputAddress.subdustPkScript : outputAddress.pkScript;
        const outputs = [
          {
            script: outputScript,
            amount: BigInt(params.amount)
          }
        ];
        if (selected.changeAmount > 0n) {
          const changeOutputScript = selected.changeAmount < this.dustAmount ? arkAddress.subdustPkScript : arkAddress.pkScript;
          outputs.push({
            script: changeOutputScript,
            amount: BigInt(selected.changeAmount)
          });
        }
        this._addPendingSpends(selected.inputs);
        try {
          const { arkTxid, signedCheckpointTxs } = await this.buildAndSubmitOffchainTx(
            selected.inputs,
            outputs
          );
          await this.updateDbAfterOffchainTx(
            selected.inputs,
            arkTxid,
            signedCheckpointTxs,
            params.amount,
            selected.changeAmount,
            selected.changeAmount > 0n ? outputs.length - 1 : 0,
            offchainTapscript
          );
          return arkTxid;
        } finally {
          this._removePendingSpends(selected.inputs);
        }
      });
    }
    return this.send({
      address: params.address,
      amount: params.amount
    });
  }
  /**
   * Settle boarding inputs and/or virtual outputs into a finalized mainnet transaction.
   *
   * @param params - Optional settlement inputs and outputs. When omitted, the wallet settles all eligible funds.
   * @param eventCallback - Optional callback invoked for settlement stream events.
   * @returns The finalized Arkade transaction id
   */
  async settle(params, eventCallback) {
    return this._withTxLock(() => this._settleImpl(params, eventCallback));
  }
  async _settleImpl(params, eventCallback) {
    if (params?.inputs) {
      for (const input of params.inputs) {
        if (typeof input === "string") {
          try {
            ArkNote.fromString(input);
          } catch (e) {
            throw new Error(`Invalid arknote "${input}"`);
          }
        }
      }
    }
    if (!params) {
      const { fees } = await this.arkProvider.getInfo();
      const estimator = new Estimator(fees.intentFee);
      let amount = 0;
      const exitScript = CSVMultisigTapscript.decode(
        hex.decode(this.boardingTapscript.exitScript)
      );
      const boardingTimelock = exitScript.params.timelock;
      let chainTipHeight;
      if (boardingTimelock.type === "blocks") {
        const tip = await this.onchainProvider.getChainTip();
        chainTipHeight = tip.height;
      }
      const boardingUtxos = (await this.getBoardingUtxos()).filter(
        (utxo) => utxo.status.confirmed && !hasBoardingTxExpired(utxo, boardingTimelock, chainTipHeight)
      );
      const filteredBoardingUtxos = [];
      for (const utxo of boardingUtxos) {
        const inputFee = estimator.evalOnchainInput({
          amount: BigInt(utxo.value)
        });
        if (inputFee.value >= utxo.value) {
          continue;
        }
        filteredBoardingUtxos.push(utxo);
        amount += utxo.value - inputFee.satoshis;
      }
      const vtxos = await this.getVtxos({ withRecoverable: true });
      const filteredVtxos = [];
      for (const vtxo of vtxos) {
        const inputFee = estimator.evalOffchainInput({
          amount: BigInt(vtxo.value),
          type: vtxo.virtualStatus.state === "swept" ? "recoverable" : "vtxo",
          weight: 0,
          birth: vtxo.createdAt,
          expiry: vtxo.virtualStatus.batchExpiry ? new Date(vtxo.virtualStatus.batchExpiry) : void 0
        });
        if (inputFee.satoshis >= vtxo.value) {
          continue;
        }
        filteredVtxos.push(vtxo);
        amount += vtxo.value - inputFee.satoshis;
      }
      const inputs = [...filteredBoardingUtxos, ...filteredVtxos];
      if (inputs.length === 0) {
        throw new Error("No inputs found");
      }
      const output = {
        address: await this.getAddress(),
        amount: BigInt(amount)
      };
      const outputFee = estimator.evalOffchainOutput({
        amount: output.amount,
        script: hex.encode(ArkAddress.decode(output.address).pkScript)
      });
      output.amount -= BigInt(outputFee.satoshis);
      if (output.amount <= this.dustAmount) {
        throw new Error("Output amount is below dust limit");
      }
      params = {
        inputs,
        outputs: [output]
      };
    }
    const onchainOutputIndexes = [];
    const outputs = [];
    let hasOffchainOutputs = false;
    for (const [index, output] of params.outputs.entries()) {
      let script;
      try {
        const addr = ArkAddress.decode(output.address);
        script = addr.pkScript;
        hasOffchainOutputs = true;
      } catch {
        const addr = Address(this.network).decode(output.address);
        script = OutScript.encode(addr);
        onchainOutputIndexes.push(index);
      }
      outputs.push({
        amount: output.amount,
        script
      });
    }
    const assetInputs = /* @__PURE__ */ new Map();
    for (let i = 0; i < params.inputs.length; i++) {
      if ("assets" in params.inputs[i]) {
        const assets = params.inputs[i].assets;
        if (assets && assets.length > 0) {
          assetInputs.set(i + 1, assets);
        }
      }
    }
    let outputAssets;
    const destinationScript = ArkAddress.decode(await this.getAddress()).pkScript;
    const assetOutputIndex = findDestinationOutputIndex(outputs, destinationScript);
    if (assetInputs.size > 0) {
      if (assetOutputIndex === -1) {
        throw new Error("Cannot assign assets: no output matches the destination address");
      }
      const allAssets = /* @__PURE__ */ new Map();
      for (const [, assets] of assetInputs) {
        for (const asset of assets) {
          const existing = allAssets.get(asset.assetId) ?? 0n;
          allAssets.set(asset.assetId, existing + asset.amount);
        }
      }
      outputAssets = [];
      for (const [assetId, amount] of allAssets) {
        outputAssets.push({ assetId, amount });
      }
    }
    const recipients = params.outputs.map((output, i) => ({
      address: output.address,
      amount: Number(output.amount),
      assets: i === assetOutputIndex ? outputAssets : void 0
    }));
    if (outputAssets && outputAssets.length > 0) {
      const assetPacket = createAssetPacket(assetInputs, recipients);
      outputs.push(Extension.create([assetPacket]).txOut());
    }
    let session;
    const signingPublicKeys = [];
    if (hasOffchainOutputs) {
      session = this.identity.signerSession();
      signingPublicKeys.push(hex.encode(await session.getPublicKey()));
    }
    const [intent, deleteIntent] = await Promise.all([
      this.makeRegisterIntentSignature(
        params.inputs,
        outputs,
        onchainOutputIndexes,
        signingPublicKeys
      ),
      this.makeDeleteIntentSignature(params.inputs)
    ]);
    const topics = [
      ...signingPublicKeys,
      ...params.inputs.map((input) => `${input.txid}:${input.vout}`)
    ];
    const abortController = new AbortController();
    let stream;
    this._addPendingSpends(params.inputs);
    try {
      stream = this.arkProvider.getEventStream(abortController.signal, topics);
      const firstNext = stream.next();
      void firstNext.catch(() => {
      });
      const primedStream = (async function* () {
        const first = await firstNext;
        if (!first.done) {
          yield first.value;
        }
        yield* stream;
      })();
      const intentId = await this.safeRegisterIntent(intent, params.inputs);
      const handler = this.createBatchHandler(intentId, params.inputs, recipients, session);
      const commitmentTxid = await Batch.join(primedStream, handler, {
        abortController,
        skipVtxoTreeSigning: !hasOffchainOutputs,
        eventCallback: eventCallback ? (event) => Promise.resolve(eventCallback(event)) : void 0
      });
      await this.updateDbAfterSettle(params.inputs, commitmentTxid);
      return commitmentTxid;
    } catch (error) {
      const inputIds = params.inputs.map((i) => `${i.txid}:${i.vout}`).join(",");
      await this.arkProvider.deleteIntent(deleteIntent).catch((e) => {
        console.warn(
          `Failed to delete intent after settle failure for inputs [${inputIds}]; intent may linger on server and cause 'duplicated input' on next settle`,
          e
        );
      });
      throw error;
    } finally {
      this._removePendingSpends(params.inputs);
      abortController.abort();
      await stream?.return?.().catch(() => {
      });
    }
  }
  async handleSettlementFinalizationEvent(event, inputs, forfeitOutputScript, connectorsGraph) {
    const signedForfeits = [];
    const isVtxo = (input) => "virtualStatus" in input;
    let settlementPsbt = Transaction$2.fromPSBT(base64.decode(event.commitmentTx));
    let hasBoardingUtxos = false;
    let connectorIndex = 0;
    const connectorsLeaves = connectorsGraph?.leaves() || [];
    for (const input of inputs) {
      if (!isVtxo(input)) {
        for (let i = 0; i < settlementPsbt.inputsLength; i++) {
          const settlementInput = settlementPsbt.getInput(i);
          if (!settlementInput.txid || settlementInput.index === void 0) {
            throw new Error(
              "The server returned incomplete data. No settlement input found in the PSBT"
            );
          }
          const inputTxId = hex.encode(settlementInput.txid);
          if (inputTxId !== input.txid) continue;
          if (settlementInput.index !== input.vout) continue;
          settlementPsbt.updateInput(i, {
            tapLeafScript: [input.forfeitTapLeafScript]
          });
          const script = settlementPsbt.getInput(i).witnessUtxo?.script;
          if (!script) {
            throw new Error(
              "The server returned incomplete data. Settlement input is missing witnessUtxo.script"
            );
          }
          settlementPsbt = await this._signerRouter.sign(settlementPsbt, [
            { index: i, lookupScript: script }
          ]);
          hasBoardingUtxos = true;
          break;
        }
        continue;
      }
      if (isRecoverable(input) || isSubdust(input, this.dustAmount)) {
        continue;
      }
      if (connectorsLeaves.length === 0) {
        throw new Error("connectors not received");
      }
      if (connectorIndex >= connectorsLeaves.length) {
        throw new Error("not enough connectors received");
      }
      const connectorLeaf = connectorsLeaves[connectorIndex];
      const connectorTxId = connectorLeaf.id;
      const connectorOutput = connectorLeaf.getOutput(0);
      if (!connectorOutput) {
        throw new Error("connector output not found");
      }
      const connectorAmount = connectorOutput.amount;
      const connectorPkScript = connectorOutput.script;
      if (!connectorAmount || !connectorPkScript) {
        throw new Error("invalid connector output");
      }
      connectorIndex++;
      let forfeitTx = buildForfeitTx(
        [
          {
            txid: input.txid,
            index: input.vout,
            witnessUtxo: {
              amount: BigInt(input.value),
              script: VtxoScript.decode(input.tapTree).pkScript
            },
            sighashType: SigHash.DEFAULT,
            tapLeafScript: [input.forfeitTapLeafScript]
          },
          {
            txid: connectorTxId,
            index: 0,
            witnessUtxo: {
              amount: connectorAmount,
              script: connectorPkScript
            }
          }
        ],
        forfeitOutputScript
      );
      forfeitTx = await this._signerRouter.sign(forfeitTx, [
        {
          index: 0,
          lookupScript: VtxoScript.decode(input.tapTree).pkScript
        }
      ]);
      signedForfeits.push(base64.encode(forfeitTx.toPSBT()));
    }
    if (signedForfeits.length > 0 || hasBoardingUtxos) {
      await this.arkProvider.submitSignedForfeitTxs(
        signedForfeits,
        hasBoardingUtxos ? base64.encode(settlementPsbt.toPSBT()) : void 0
      );
    }
  }
  /**
   * Create a batch event handler for settlement flows.
   *
   * @param intentId - The intent ID.
   * @param inputs - Inputs used by the intent.
   * @param expectedRecipients - Expected recipients to validate in the virtual output tree.
   * @param session - Optional musig2 signing session. When omitted, signing steps are skipped.
   */
  createBatchHandler(intentId, inputs, expectedRecipients, session) {
    let sweepTapTreeRoot;
    return {
      onBatchStarted: async (event) => {
        const utf8IntentId = new TextEncoder().encode(intentId);
        const intentIdHash = sha256(utf8IntentId);
        const intentIdHashStr = hex.encode(intentIdHash);
        let skip = true;
        for (const idHash of event.intentIdHashes) {
          if (idHash === intentIdHashStr) {
            if (!this.arkProvider) {
              throw new Error("Arkade provider not configured");
            }
            await this.arkProvider.confirmRegistration(intentId);
            skip = false;
          }
        }
        if (skip) {
          return { skip };
        }
        const sweepTapscript = CSVMultisigTapscript.encode({
          timelock: {
            value: event.batchExpiry,
            type: event.batchExpiry >= 512n ? "seconds" : "blocks"
          },
          pubkeys: [this.forfeitPubkey]
        }).script;
        sweepTapTreeRoot = tapLeafHash(sweepTapscript);
        return { skip: false };
      },
      onTreeSigningStarted: async (event, vtxoTree) => {
        if (!session) {
          return { skip: true };
        }
        if (!sweepTapTreeRoot) {
          throw new Error("Sweep tap tree root not set");
        }
        const xOnlyPublicKeys = event.cosignersPublicKeys.map((k) => k.slice(2));
        const signerPublicKey = await session.getPublicKey();
        const xonlySignerPublicKey = signerPublicKey.subarray(1);
        if (!xOnlyPublicKeys.includes(hex.encode(xonlySignerPublicKey))) {
          return { skip: true };
        }
        const commitmentTx = Transaction$2.fromPSBT(
          base64.decode(event.unsignedCommitmentTx)
        );
        validateVtxoTxGraph(vtxoTree, commitmentTx, sweepTapTreeRoot);
        if (expectedRecipients && expectedRecipients.length > 0) {
          validateBatchRecipients(
            commitmentTx,
            vtxoTree.leaves(),
            expectedRecipients,
            this.network
          );
        }
        const sharedOutput = commitmentTx.getOutput(0);
        if (!sharedOutput?.amount) {
          throw new Error("Shared output not found");
        }
        await session.init(vtxoTree, sweepTapTreeRoot, sharedOutput.amount);
        const pubkey = hex.encode(await session.getPublicKey());
        const nonces = await session.getNonces();
        await this.arkProvider.submitTreeNonces(event.id, pubkey, nonces);
        return { skip: false };
      },
      onTreeNonces: async (event) => {
        if (!session) {
          return { fullySigned: true };
        }
        const { hasAllNonces } = await session.aggregatedNonces(event.txid, event.nonces);
        if (!hasAllNonces) return { fullySigned: false };
        const signatures = await session.sign();
        const pubkey = hex.encode(await session.getPublicKey());
        await this.arkProvider.submitTreeSignatures(event.id, pubkey, signatures);
        return { fullySigned: true };
      },
      onBatchFinalization: async (event, _, connectorTree) => {
        if (!this.forfeitOutputScript) {
          throw new Error("Forfeit output script not set");
        }
        if (connectorTree) {
          validateConnectorsTxGraph(event.commitmentTx, connectorTree);
        }
        await this.handleSettlementFinalizationEvent(
          event,
          inputs,
          this.forfeitOutputScript,
          connectorTree
        );
      }
    };
  }
  /**
   * Build {@link InputSigningJob}s for a tx whose signable inputs can be
   * resolved from their own `witnessUtxo.script`. Inputs without a
   * `witnessUtxo` are silently omitted, mirroring the wallet's
   * historical silent-skip behaviour for cosigner/connector inputs.
   */
  inputSigningJobsFromWitnessUtxos(tx, indexes) {
    const candidateIndexes = indexes ?? Array.from({ length: tx.inputsLength }, (_, i) => i);
    const jobs = [];
    for (const index of candidateIndexes) {
      const script = tx.getInput(index).witnessUtxo?.script;
      if (script) jobs.push({ index, lookupScript: script });
    }
    return jobs;
  }
  async safeRegisterIntent(intent, inputs) {
    try {
      return await this.arkProvider.registerIntent(intent);
    } catch (error) {
      if (error instanceof ArkError && error.code === 0 && error.message.includes("duplicated input")) {
        const deleteIntent = await this.makeDeleteIntentSignature(inputs);
        await this.arkProvider.deleteIntent(deleteIntent);
        return this.arkProvider.registerIntent(intent);
      }
      throw error;
    }
  }
  async makeRegisterIntentSignature(coins, outputs, onchainOutputsIndexes, cosignerPubKeys, validAt) {
    const message = {
      type: "register",
      onchain_output_indexes: onchainOutputsIndexes,
      valid_at: validAt ? Math.floor(validAt) : 0,
      expire_at: 0,
      cosigners_public_keys: cosignerPubKeys
    };
    const proof = Intent.create(message, coins, outputs);
    const signedProof = await this._signerRouter.sign(proof, intentProofJobs(coins));
    return {
      proof: base64.encode(signedProof.toPSBT()),
      message
    };
  }
  async makeDeleteIntentSignature(coins) {
    const message = {
      type: "delete",
      expire_at: 0
    };
    const proof = Intent.create(message, coins, []);
    const signedProof = await this._signerRouter.sign(proof, intentProofJobs(coins));
    return {
      proof: base64.encode(signedProof.toPSBT()),
      message
    };
  }
  async makeGetPendingTxIntentSignature(coins) {
    const message = {
      type: "get-pending-tx",
      expire_at: 0
    };
    const proof = Intent.create(message, coins, []);
    const signedProof = await this._signerRouter.sign(proof, intentProofJobs(coins));
    return {
      proof: base64.encode(signedProof.toPSBT()),
      message
    };
  }
  /**
   * Finalizes pending transactions by retrieving them from the server and finalizing each one.
   * Skips the server check entirely when no send was interrupted (no pending tx flag set).
   * @param vtxos - Optional list of virtual outputs to use instead of retrieving them from the server
   * @returns Array of transaction IDs that were finalized
   */
  async finalizePendingTxs(vtxos) {
    const hasPending = await this.hasPendingTxFlag();
    if (!hasPending) {
      return { finalized: [], pending: [] };
    }
    const MAX_INPUTS_PER_INTENT = 20;
    if (!vtxos || vtxos.length === 0) {
      const scriptMap = await this.getScriptMap();
      const allExtended = [];
      const allScripts = [...scriptMap.keys()];
      const { vtxos: fetchedVtxos } = await this.indexerProvider.getVtxos({
        scripts: allScripts
      });
      for (const vtxo of fetchedVtxos) {
        const vtxoScript = scriptMap.get(vtxo.script);
        if (!vtxoScript) continue;
        if (vtxo.virtualStatus.state === "swept" || vtxo.virtualStatus.state === "settled") {
          continue;
        }
        allExtended.push({
          ...vtxo,
          forfeitTapLeafScript: vtxoScript.forfeit(),
          intentTapLeafScript: vtxoScript.forfeit(),
          tapTree: vtxoScript.encode()
        });
      }
      if (allExtended.length === 0) {
        return { finalized: [], pending: [] };
      }
      vtxos = allExtended;
    }
    const batches = [];
    for (let i = 0; i < vtxos.length; i += MAX_INPUTS_PER_INTENT) {
      batches.push(vtxos.slice(i, i + MAX_INPUTS_PER_INTENT));
    }
    const seen = /* @__PURE__ */ new Set();
    const results = await Promise.all(
      batches.map(async (batch) => {
        const batchFinalized = [];
        const batchPending = [];
        const intent = await this.makeGetPendingTxIntentSignature(batch);
        const pendingTxs = await this.arkProvider.getPendingTxs(intent);
        for (const pendingTx of pendingTxs) {
          if (seen.has(pendingTx.arkTxid)) continue;
          seen.add(pendingTx.arkTxid);
          batchPending.push(pendingTx.arkTxid);
          try {
            const checkpointTxs = pendingTx.signedCheckpointTxs.map(
              (c) => Transaction$2.fromPSBT(base64.decode(c))
            );
            const checkpointJobs = checkpointTxs.map(
              (tx) => this.inputSigningJobsFromWitnessUtxos(tx)
            );
            const identity = this.identity;
            const batchEligible = isBatchSignable(identity) && await this._signerRouter.canBatch(...checkpointJobs);
            let finalCheckpoints;
            if (batchEligible) {
              const requests = checkpointTxs.map((tx, i) => ({
                tx,
                inputIndexes: checkpointJobs[i].map((j) => j.index)
              }));
              const signed = await identity.signMultiple(requests);
              if (signed.length !== requests.length) {
                throw new Error(
                  `signMultiple returned ${signed.length} transactions, expected ${requests.length}`
                );
              }
              finalCheckpoints = signed.map((tx) => base64.encode(tx.toPSBT()));
            } else {
              finalCheckpoints = await Promise.all(
                checkpointTxs.map(async (tx, i) => {
                  const signedCheckpoint = await this._signerRouter.sign(
                    tx,
                    checkpointJobs[i]
                  );
                  return base64.encode(signedCheckpoint.toPSBT());
                })
              );
            }
            await this.arkProvider.finalizeTx(pendingTx.arkTxid, finalCheckpoints);
            batchFinalized.push(pendingTx.arkTxid);
          } catch (error) {
            console.error(
              `Failed to finalize transaction ${pendingTx.arkTxid}:`,
              error
            );
          }
        }
        return {
          finalized: batchFinalized,
          pending: batchPending
        };
      })
    );
    const finalized = [];
    const pending = [];
    for (const result of results) {
      finalized.push(...result.finalized);
      pending.push(...result.pending);
    }
    if (finalized.length === pending.length) {
      await this.setPendingTxFlag(false);
    }
    return { finalized, pending };
  }
  async hasPendingTxFlag() {
    const state = await this.walletRepository.getWalletState();
    return state?.settings?.hasPendingTx === true;
  }
  async setPendingTxFlag(value) {
    await updateWalletState(this.walletRepository, (state) => ({
      ...state,
      settings: { ...state.settings, hasPendingTx: value }
    }));
  }
  /**
   * Send BTC and/or assets to one or more recipients.
   *
   * @param args - Recipients with their addresses, BTC amounts, and assets
   * @returns Promise resolving to the Arkade transaction ID
   *
   * @example
   * ```typescript
   * const txid = await wallet.send({
   *     address: 'ark1q...',
   *     amount: 1000, // (optional, default to dust) btc amount to send to the output
   *     assets: [{ assetId: 'abc123...', amount: 50n }] // (optional) list of assets to send
   * });
   * ```
   */
  async send(...args) {
    return this._withTxLock(() => this._sendImpl(...args));
  }
  async _sendImpl(...args) {
    if (args.length === 0) {
      throw new Error("At least one receiver is required");
    }
    const offchainTapscript = this.offchainTapscript;
    const outputAddress = offchainTapscript.address(this.network.hrp, this.arkServerPublicKey);
    const address = outputAddress.encode();
    const recipients = validateRecipients(args, Number(this.dustAmount));
    const virtualCoins = await this.getVtxos({
      withRecoverable: false
    });
    const assetChanges = /* @__PURE__ */ new Map();
    let selectedCoins = [];
    let btcAmountToSelect = 0;
    for (const recipient of recipients) {
      btcAmountToSelect += Math.max(recipient.amount, Number(this.dustAmount));
    }
    for (const recipient of recipients) {
      if (!recipient.assets) {
        continue;
      }
      for (const receiverAsset of recipient.assets) {
        let amountToSelect = receiverAsset.amount;
        const existingChange = assetChanges.get(receiverAsset.assetId) ?? 0n;
        if (existingChange >= amountToSelect) {
          assetChanges.set(receiverAsset.assetId, existingChange - amountToSelect);
          if (assetChanges.get(receiverAsset.assetId) === 0n) {
            assetChanges.delete(receiverAsset.assetId);
          }
          continue;
        }
        if (existingChange > 0n) {
          amountToSelect -= existingChange;
          assetChanges.delete(receiverAsset.assetId);
        }
        const availableCoins = virtualCoins.filter(
          (c) => !selectedCoins.find((sc) => sc.txid === c.txid && sc.vout === c.vout)
        );
        const { selected, totalAssetAmount } = selectCoinsWithAsset(
          availableCoins,
          receiverAsset.assetId,
          amountToSelect
        );
        for (const coin of selected) {
          selectedCoins.push(coin);
          btcAmountToSelect -= coin.value;
          if (coin.assets) {
            for (const a of coin.assets) {
              if (a.assetId === receiverAsset.assetId) {
                continue;
              }
              const existing = assetChanges.get(a.assetId) ?? 0n;
              assetChanges.set(a.assetId, existing + a.amount);
            }
          }
        }
        const assetChangeAmount = totalAssetAmount - amountToSelect;
        if (assetChangeAmount > 0n) {
          const existing = assetChanges.get(receiverAsset.assetId) ?? 0n;
          assetChanges.set(receiverAsset.assetId, existing + assetChangeAmount);
        }
      }
    }
    if (btcAmountToSelect > 0) {
      const availableCoins = virtualCoins.filter(
        (c) => !selectedCoins.find((sc) => sc.txid === c.txid && sc.vout === c.vout)
      );
      const { inputs: btcCoins } = selectVirtualCoins(availableCoins, btcAmountToSelect);
      for (const coin of btcCoins) {
        if (coin.assets) {
          for (const asset of coin.assets) {
            const existing = assetChanges.get(asset.assetId) ?? 0n;
            assetChanges.set(asset.assetId, existing + asset.amount);
          }
        }
      }
      selectedCoins = [...selectedCoins, ...btcCoins];
    }
    let totalBtcSelected = selectedCoins.reduce((sum, c) => sum + c.value, 0);
    const outputs = recipients.map((recipient) => ({
      script: recipient.script,
      amount: BigInt(recipient.amount)
    }));
    const totalBtcOutput = outputs.reduce((sum, o) => sum + Number(o.amount), 0);
    let changeAmount = totalBtcSelected - totalBtcOutput;
    if (assetChanges.size > 0 && changeAmount < Number(this.dustAmount)) {
      const availableCoins = virtualCoins.filter(
        (c) => !selectedCoins.find((sc) => sc.txid === c.txid && sc.vout === c.vout)
      );
      const { inputs: extraCoins } = selectVirtualCoins(
        availableCoins,
        Number(this.dustAmount) - changeAmount
      );
      for (const coin of extraCoins) {
        if (coin.assets) {
          for (const asset of coin.assets) {
            const existing = assetChanges.get(asset.assetId) ?? 0n;
            assetChanges.set(asset.assetId, existing + asset.amount);
          }
        }
      }
      selectedCoins = [...selectedCoins, ...extraCoins];
      totalBtcSelected += extraCoins.reduce((sum, c) => sum + c.value, 0);
      changeAmount = totalBtcSelected - totalBtcOutput;
    }
    let changeReceiver;
    let changeIndex = 0;
    if (changeAmount > 0) {
      const changeAssets = [];
      for (const [assetId, amount] of assetChanges) {
        if (amount > 0n) {
          changeAssets.push({ assetId, amount });
        }
      }
      changeIndex = outputs.length;
      outputs.push({
        script: BigInt(changeAmount) < this.dustAmount ? outputAddress.subdustPkScript : outputAddress.pkScript,
        amount: BigInt(changeAmount)
      });
      changeReceiver = {
        address,
        amount: changeAmount,
        assets: changeAssets.length > 0 ? changeAssets : void 0
      };
    }
    const assetInputs = selectedCoinsToAssetInputs(selectedCoins);
    const hasAssets = assetInputs.size > 0 || recipients.some((r) => r.assets && r.assets.length > 0);
    const customExtPackets = [];
    for (const r of args) {
      if (r.extensions) {
        for (const ext of r.extensions) {
          customExtPackets.push({
            type: () => ext.type,
            serialize: () => ext.payload
          });
        }
      }
    }
    const allExtPackets = [];
    if (hasAssets) {
      allExtPackets.push(createAssetPacket(assetInputs, recipients, changeReceiver));
    }
    allExtPackets.push(...customExtPackets);
    if (allExtPackets.length > 0) {
      outputs.push(Extension.create(allExtPackets).txOut());
    }
    const sentAmount = recipients.reduce((sum, r) => sum + r.amount, 0);
    this._addPendingSpends(selectedCoins);
    try {
      const { arkTxid, signedCheckpointTxs } = await this.buildAndSubmitOffchainTx(
        selectedCoins,
        outputs
      );
      await this.updateDbAfterOffchainTx(
        selectedCoins,
        arkTxid,
        signedCheckpointTxs,
        sentAmount,
        BigInt(changeAmount),
        changeReceiver ? changeIndex : 0,
        offchainTapscript,
        changeReceiver?.assets
      );
      return arkTxid;
    } finally {
      this._removePendingSpends(selectedCoins);
    }
  }
  /**
   * Build an offchain transaction from the given inputs and outputs,
   * sign it, submit to the Arkade provider, and finalize.
   * @returns The Arkade transaction id and server-signed checkpoint PSBTs (for bookkeeping)
   */
  async buildAndSubmitOffchainTx(inputs, outputs) {
    const offchainTx = buildOffchainTx(
      inputs.map((input) => {
        return {
          ...input,
          tapLeafScript: input.forfeitTapLeafScript
        };
      }),
      outputs,
      this.serverUnrollScript
    );
    const arkTxJobs = inputs.map((input, index) => ({
      index,
      lookupScript: VtxoScript.decode(input.tapTree).pkScript
    }));
    const checkpointJobs = offchainTx.checkpoints.map(
      (c) => this.inputSigningJobsFromWitnessUtxos(c)
    );
    let signedVirtualTx;
    let userSignedCheckpoints;
    const identity = this.identity;
    const batchEligible = isBatchSignable(identity) && await this._signerRouter.canBatch(arkTxJobs, ...checkpointJobs);
    if (batchEligible) {
      const requests = [
        {
          tx: offchainTx.arkTx.clone(),
          inputIndexes: arkTxJobs.map((j) => j.index)
        },
        ...offchainTx.checkpoints.map((c, i) => ({
          tx: c.clone(),
          inputIndexes: checkpointJobs[i].map((j) => j.index)
        }))
      ];
      const signed = await identity.signMultiple(requests);
      if (signed.length !== requests.length) {
        throw new Error(
          `signMultiple returned ${signed.length} transactions, expected ${requests.length}`
        );
      }
      const [firstSignedTx, ...signedCheckpoints] = signed;
      signedVirtualTx = firstSignedTx;
      userSignedCheckpoints = signedCheckpoints;
    } else {
      signedVirtualTx = await this._signerRouter.sign(offchainTx.arkTx, arkTxJobs);
    }
    await this.setPendingTxFlag(true);
    const { arkTxid, signedCheckpointTxs } = await this.arkProvider.submitTx(
      base64.encode(signedVirtualTx.toPSBT()),
      offchainTx.checkpoints.map((c) => base64.encode(c.toPSBT()))
    );
    let finalCheckpoints;
    if (userSignedCheckpoints) {
      if (signedCheckpointTxs.length !== userSignedCheckpoints.length) {
        throw new Error(
          `submitTx returned ${signedCheckpointTxs.length} checkpoints, expected ${userSignedCheckpoints.length}`
        );
      }
      finalCheckpoints = signedCheckpointTxs.map((c, i) => {
        const serverSigned = Transaction$2.fromPSBT(base64.decode(c));
        combineTapscriptSigs(userSignedCheckpoints[i], serverSigned);
        return base64.encode(serverSigned.toPSBT());
      });
    } else {
      finalCheckpoints = await Promise.all(
        signedCheckpointTxs.map(async (c) => {
          const tx = Transaction$2.fromPSBT(base64.decode(c));
          const signedCheckpoint = await this._signerRouter.sign(
            tx,
            this.inputSigningJobsFromWitnessUtxos(tx)
          );
          return base64.encode(signedCheckpoint.toPSBT());
        })
      );
    }
    await this.arkProvider.finalizeTx(arkTxid, finalCheckpoints);
    try {
      await this.setPendingTxFlag(false);
    } catch (error) {
      console.error("Failed to clear pending tx flag:", error);
    }
    return { arkTxid, signedCheckpointTxs };
  }
  // mark virtual outputs as spent, save change outputs if any.
  // `offchainTapscript` is the snapshot the caller captured under
  // `_txLock` before any `await`; deriving both the change-VTXO
  // metadata and `primaryAddress` from it here guarantees the local
  // record matches the pkScript the server saw on the inbound
  // transaction, even if `WalletReceiveRotator.rotate` swaps
  // `this.offchainTapscript` mid-flight.
  async updateDbAfterOffchainTx(inputs, arkTxid, signedCheckpointTxs, sentAmount, changeAmount, changeVout, offchainTapscript, changeAssets) {
    const primaryAddress = offchainTapscript.address(this.network.hrp, this.arkServerPublicKey).encode();
    try {
      const spentVtxos = [];
      const commitmentTxIds = /* @__PURE__ */ new Set();
      let batchExpiry = Number.MAX_SAFE_INTEGER;
      if (inputs.length !== signedCheckpointTxs.length) {
        console.warn(
          `updateDbAfterOffchainTx: inputs length (${inputs.length}) differs from signedCheckpointTxs length (${signedCheckpointTxs.length})`
        );
      }
      const safeLength = Math.min(inputs.length, signedCheckpointTxs.length);
      const cm = await this.getContractManager();
      const annotatedInputs = await cm.annotateVtxos(inputs);
      for (const [inputIndex, vtxo] of annotatedInputs.entries()) {
        if (inputIndex < safeLength && signedCheckpointTxs[inputIndex]) {
          const checkpoint = Transaction$2.fromPSBT(
            base64.decode(signedCheckpointTxs[inputIndex])
          );
          spentVtxos.push({
            ...vtxo,
            virtualStatus: {
              ...vtxo.virtualStatus,
              state: "spent"
            },
            spentBy: checkpoint.id,
            arkTxId: arkTxid,
            isSpent: true
          });
        } else {
          spentVtxos.push({
            ...vtxo,
            virtualStatus: {
              ...vtxo.virtualStatus,
              state: "spent"
            },
            arkTxId: arkTxid,
            isSpent: true
          });
        }
        if (vtxo.virtualStatus.commitmentTxIds) {
          for (const id of vtxo.virtualStatus.commitmentTxIds) {
            commitmentTxIds.add(id);
          }
        }
        if (vtxo.virtualStatus.batchExpiry) {
          batchExpiry = Math.min(batchExpiry, vtxo.virtualStatus.batchExpiry);
        }
      }
      const createdAt = Date.now();
      let changeVtxo;
      if (changeAmount > 0n && batchExpiry !== Number.MAX_SAFE_INTEGER) {
        changeVtxo = {
          txid: arkTxid,
          vout: changeVout,
          createdAt: new Date(createdAt),
          forfeitTapLeafScript: offchainTapscript.forfeit(),
          intentTapLeafScript: offchainTapscript.forfeit(),
          isUnrolled: false,
          isSpent: false,
          tapTree: offchainTapscript.encode(),
          value: Number(changeAmount),
          virtualStatus: {
            state: "preconfirmed",
            commitmentTxIds: Array.from(commitmentTxIds),
            batchExpiry
          },
          status: {
            confirmed: false
          },
          assets: changeAssets,
          script: hex.encode(offchainTapscript.pkScript)
        };
      }
      const contracts = await cm.getContracts();
      const addrByScript = new Map(contracts.map((c) => [c.script, c.address]));
      const spentByScript = /* @__PURE__ */ new Map();
      for (const v of spentVtxos) {
        if (!v.script) {
          throw new Error(
            `Wallet.updateDbAfterOffchainTx: spent VTXO ${v.txid}:${v.vout} has no script`
          );
        }
        const arr = spentByScript.get(v.script) ?? [];
        arr.push(v);
        spentByScript.set(v.script, arr);
      }
      for (const [script, vtxos] of spentByScript) {
        validateVtxosForScript(vtxos, script, "Wallet.updateDbAfterOffchainTx");
        const targetAddr = addrByScript.get(script);
        if (!targetAddr) {
          throw new Error(
            `Wallet.updateDbAfterOffchainTx: no contract owns script ${script}`
          );
        }
        await saveVtxosForContract(
          this.walletRepository,
          { script, address: targetAddr },
          vtxos
        );
      }
      if (changeVtxo) {
        await saveVtxosForContract(
          this.walletRepository,
          { script: changeVtxo.script, address: primaryAddress },
          [changeVtxo]
        );
      }
      await this.walletRepository.saveTransactions(primaryAddress, [
        {
          key: {
            boardingTxid: "",
            commitmentTxid: "",
            arkTxid
          },
          amount: sentAmount,
          type: "SENT" /* TxSent */,
          settled: false,
          createdAt
        }
      ]);
    } catch (e) {
      console.warn("error saving offchain tx to repository", e);
      throw e;
    }
  }
  // mark virtual outputs as spent/settled, remove boarding inputs
  async updateDbAfterSettle(inputs, commitmentTxid) {
    try {
      const boardingAddress = await this.getBoardingAddress();
      const spentVtxos = [];
      const inputArkTxIds = /* @__PURE__ */ new Set();
      const boardingUtxoToRemove = /* @__PURE__ */ new Set();
      const isVtxo = (input) => "virtualStatus" in input;
      const vtxoInputs = inputs.filter(isVtxo);
      const cm = await this.getContractManager();
      const annotatedVtxos = await cm.annotateVtxos(vtxoInputs);
      const annotatedByKey = new Map(annotatedVtxos.map((v) => [`${v.txid}:${v.vout}`, v]));
      for (const input of inputs) {
        if (isVtxo(input)) {
          const vtxo = annotatedByKey.get(`${input.txid}:${input.vout}`);
          if (vtxo.arkTxId) {
            inputArkTxIds.add(vtxo.arkTxId);
          }
          spentVtxos.push({
            ...vtxo,
            virtualStatus: {
              ...vtxo.virtualStatus,
              state: "settled"
            },
            settledBy: commitmentTxid,
            isSpent: true
          });
        } else {
          boardingUtxoToRemove.add(`${input.txid}:${input.vout}`);
        }
      }
      if (spentVtxos.length > 0) {
        const contracts = await cm.getContracts();
        const addrByScript = new Map(contracts.map((c) => [c.script, c.address]));
        const byScript = /* @__PURE__ */ new Map();
        for (const v of spentVtxos) {
          if (!v.script) {
            throw new Error(
              `Wallet.updateDbAfterSettle: spent VTXO ${v.txid}:${v.vout} has no script`
            );
          }
          const arr = byScript.get(v.script) ?? [];
          arr.push(v);
          byScript.set(v.script, arr);
        }
        for (const [script, vtxos] of byScript) {
          validateVtxosForScript(vtxos, script, "Wallet.updateDbAfterSettle");
          const targetAddr = addrByScript.get(script);
          if (!targetAddr) {
            throw new Error(
              `Wallet.updateDbAfterSettle: no contract owns script ${script}`
            );
          }
          await saveVtxosForContract(
            this.walletRepository,
            { script, address: targetAddr },
            vtxos
          );
        }
      }
      if (boardingUtxoToRemove.size > 0) {
        const currentUtxos = await this.walletRepository.getUtxos(boardingAddress);
        const filtered = currentUtxos.filter(
          (u) => !boardingUtxoToRemove.has(`${u.txid}:${u.vout}`)
        );
        await this.walletRepository.deleteUtxos(boardingAddress);
        if (filtered.length > 0) {
          await this.walletRepository.saveUtxos(boardingAddress, filtered);
        }
      }
    } catch (e) {
      console.warn("error updating repository after settle", e);
      throw e;
    }
  }
};
function selectVirtualCoins(coins, targetAmount) {
  const sortedCoins = [...coins].sort((a, b) => {
    const expiryA = a.virtualStatus.batchExpiry || Number.MAX_SAFE_INTEGER;
    const expiryB = b.virtualStatus.batchExpiry || Number.MAX_SAFE_INTEGER;
    if (expiryA !== expiryB) {
      return expiryA - expiryB;
    }
    return b.value - a.value;
  });
  const selectedCoins = [];
  let selectedAmount = 0;
  for (const coin of sortedCoins) {
    selectedCoins.push(coin);
    selectedAmount += coin.value;
    if (selectedAmount >= targetAmount) {
      break;
    }
  }
  if (selectedAmount === targetAmount) {
    return { inputs: selectedCoins, changeAmount: 0n };
  }
  if (selectedAmount < targetAmount) {
    throw new Error("Insufficient funds");
  }
  const changeAmount = BigInt(selectedAmount - targetAmount);
  return {
    inputs: selectedCoins,
    changeAmount
  };
}
async function waitForIncomingFunds(wallet) {
  let stopFunc;
  let settled = false;
  return new Promise((resolve) => {
    wallet.notifyIncomingFunds((funds) => {
      const hasFunds = funds.type === "utxo" ? funds.coins.length > 0 : funds.newVtxos.length > 0;
      if (settled || !hasFunds) return;
      settled = true;
      resolve(funds);
      stopFunc?.();
    }).then((stop) => {
      stopFunc = stop;
      if (settled) stop();
    });
  });
}

// src/worker/errors.ts
var MESSAGE_BUS_NOT_INITIALIZED = "MessageBus not initialized";
var MessageBusNotInitializedError = class extends Error {
  constructor() {
    super(MESSAGE_BUS_NOT_INITIALIZED);
  }
};
var ServiceWorkerTimeoutError = class extends Error {
  constructor(detail) {
    super(detail);
  }
};

// src/worker/messageBus.ts
var LATE_DELIVERY_GRACE_MS = 5 * 6e4;
var MessageBus = class {
  /** Create the service-worker message bus with repositories and handler configuration. */
  constructor(walletRepository, contractRepository, {
    messageHandlers,
    tickIntervalMs = 1e4,
    messageTimeoutMs = 3e4,
    messageTimeoutOverrides = {},
    debug = false,
    buildServices
  }) {
    this.walletRepository = walletRepository;
    this.contractRepository = contractRepository;
    this.handlers = new Map(messageHandlers.map((u) => [u.messageTag, u]));
    this.tickIntervalMs = tickIntervalMs;
    this.messageTimeoutMs = messageTimeoutMs;
    this.constructorTimeoutOverrides = { ...messageTimeoutOverrides };
    this.messageTimeoutOverrides = { ...this.constructorTimeoutOverrides };
    this.debug = debug;
    this.buildServicesFn = buildServices ?? this.buildServices.bind(this);
  }
  handlers;
  tickIntervalMs;
  messageTimeoutMs;
  constructorTimeoutOverrides;
  messageTimeoutOverrides;
  lateDeliveries = /* @__PURE__ */ new Set();
  running = false;
  tickTimeout = null;
  tickInProgress = false;
  debug = false;
  initialized = false;
  buildServicesFn;
  boundOnMessage = this.onMessage.bind(this);
  /** Start the message bus and attach service-worker event listeners. */
  async start() {
    if (this.running) return;
    this.running = true;
    if (this.debug) console.log("MessageBus starting");
    self.addEventListener("message", this.boundOnMessage);
    self.addEventListener("install", () => {
      self.skipWaiting();
    });
    self.addEventListener("activate", () => {
      self.clients.claim();
      if (this.initialized) {
        this.runTick();
      }
    });
  }
  /** Stop the message bus, cancel ticks, and stop all registered handlers. */
  async stop() {
    if (this.debug) console.log("MessageBus stopping");
    this.running = false;
    this.tickInProgress = false;
    this.initialized = false;
    if (this.tickTimeout !== null) {
      self.clearTimeout(this.tickTimeout);
      this.tickTimeout = null;
    }
    for (const record of this.lateDeliveries) {
      record.settled = true;
      self.clearTimeout(record.deadline);
    }
    this.lateDeliveries.clear();
    self.removeEventListener("message", this.boundOnMessage);
    await Promise.all(Array.from(this.handlers.values()).map((updater) => updater.stop()));
  }
  scheduleNextTick() {
    if (!this.running) return;
    if (this.tickTimeout !== null) return;
    if (this.tickInProgress) return;
    this.tickTimeout = self.setTimeout(() => this.runTick(), this.tickIntervalMs);
  }
  async runTick() {
    if (!this.running) return;
    if (this.tickInProgress) return;
    this.tickInProgress = true;
    if (this.tickTimeout !== null) {
      self.clearTimeout(this.tickTimeout);
      this.tickTimeout = null;
    }
    try {
      const now = Date.now();
      for (const updater of this.handlers.values()) {
        try {
          const tickLabel = `${updater.messageTag}:tick`;
          const response = await this.withTimeout(
            updater.tick(now),
            this.resolveTimeoutMs(tickLabel, updater.messageTag),
            tickLabel
          );
          if (this.debug)
            console.log(`[${updater.messageTag}] outgoing tick response:`, response);
          if (response && response.length > 0) {
            self.clients.matchAll({
              includeUncontrolled: true,
              type: "window"
            }).then((clients) => {
              for (const message of response) {
                clients.forEach((client) => {
                  client.postMessage(message);
                });
              }
            });
          }
        } catch (err) {
          if (this.debug) console.error(`[${updater.messageTag}] tick failed`, err);
        }
      }
    } finally {
      this.tickInProgress = false;
      this.scheduleNextTick();
    }
  }
  async waitForInit(config) {
    if (this.initialized) {
      this.initialized = false;
      await Promise.all(
        Array.from(this.handlers.values()).map((h) => h.stop().catch(() => {
        }))
      );
    }
    this.messageTimeoutOverrides = {
      ...this.constructorTimeoutOverrides,
      ...config.messageTimeouts ?? {}
    };
    const services = await this.buildServicesFn(config);
    for (const updater of this.handlers.values()) {
      if (this.debug) console.log(`Starting updater: ${updater.messageTag}`);
      await updater.start(services, {
        walletRepository: this.walletRepository
      });
    }
    this.scheduleNextTick();
    this.initialized = true;
  }
  async buildServices(config) {
    const arkProvider = new RestArkProvider(config.arkServer.url);
    const storage = {
      walletRepository: this.walletRepository,
      contractRepository: this.contractRepository
    };
    const delegateProvider = config.delegateUrl ? new RestDelegateProvider(config.delegateUrl) : config.delegatorUrl ? new RestDelegateProvider(config.delegatorUrl) : void 0;
    const serialized = normalizeSerializedIdentity(config.wallet);
    if (isSigningSerialized(serialized)) {
      const identity2 = hydrateIdentity(serialized);
      const wallet = await Wallet2.create({
        identity: identity2,
        arkServerUrl: config.arkServer.url,
        arkServerPublicKey: config.arkServer.publicKey,
        indexerUrl: config.indexerUrl,
        esploraUrl: config.esploraUrl,
        storage,
        delegateProvider,
        settlementConfig: config.settlementConfig,
        walletMode: config.walletMode,
        watcherConfig: config.watcherConfig
      });
      return { wallet, arkProvider, readonlyWallet: wallet };
    }
    const identity = hydrateIdentity(serialized);
    const readonlyWallet = await ReadonlyWallet.create({
      identity,
      arkServerUrl: config.arkServer.url,
      arkServerPublicKey: config.arkServer.publicKey,
      indexerUrl: config.indexerUrl,
      esploraUrl: config.esploraUrl,
      storage,
      delegateProvider,
      watcherConfig: config.watcherConfig
    });
    return { readonlyWallet, arkProvider };
  }
  onMessage(event) {
    const promise = this.processMessage(event);
    if (typeof event.waitUntil === "function") {
      event.waitUntil(promise);
    }
    return promise;
  }
  async processMessage(event) {
    const { id, tag, broadcast } = event.data;
    if (tag === "PING") {
      this.deliverResponse(event.source, { id, tag: "PONG" }, { id, tag: "PONG" });
      return;
    }
    if (tag === "INITIALIZE_MESSAGE_BUS") {
      if (this.debug) {
        console.log("Init Command received");
      }
      await this.waitForInit(event.data.config);
      this.deliverResponse(event.source, { id, tag }, { id, tag });
      if (this.debug) {
        console.log("MessageBus initialized");
      }
      return;
    }
    if (!this.initialized) {
      if (this.debug)
        console.warn("Event received before initialization, dropping", event.data);
      const fallbackTag = tag ?? "unknown";
      this.deliverResponse(
        event.source,
        {
          id,
          tag: fallbackTag,
          error: new MessageBusNotInitializedError()
        },
        { id, tag: fallbackTag }
      );
      return;
    }
    if (!id || !tag) {
      if (this.debug)
        console.error("Invalid message received, missing required fields:", event.data);
      const fallbackTag = tag ?? "unknown";
      this.deliverResponse(
        event.source,
        {
          id,
          tag: fallbackTag,
          error: new TypeError("Invalid message received, missing required fields")
        },
        { id, tag: fallbackTag }
      );
      return;
    }
    const messageType = this.extractMessageType(event.data);
    if (broadcast) {
      const updaters = Array.from(this.handlers.values());
      const entries = updaters.map((updater2) => {
        const label2 = this.labelFor(messageType, updater2.messageTag);
        const timeoutMs2 = this.resolveTimeoutMs(messageType, updater2.messageTag);
        const handlerPromise2 = updater2.handleMessage(event.data);
        const raced = updater2.isLongRunning?.(event.data) ? handlerPromise2 : this.withTimeout(handlerPromise2, timeoutMs2, label2);
        return { updater: updater2, handlerPromise: handlerPromise2, raced };
      });
      const results = await Promise.allSettled(entries.map((e) => e.raced));
      results.forEach((result, index) => {
        const { updater: updater2, handlerPromise: handlerPromise2 } = entries[index];
        const handlerTag = updater2.messageTag;
        const context2 = { id, tag: handlerTag, messageType };
        if (result.status === "fulfilled") {
          const response = result.value;
          this.deliverResponse(
            event.source,
            response ?? { id, tag: handlerTag },
            context2
          );
        } else {
          if (this.debug)
            console.error(`[${handlerTag}] handleMessage failed`, result.reason);
          const error = toError(result.reason);
          this.deliverResponse(event.source, { id, tag: handlerTag, error }, context2);
          if (result.reason instanceof ServiceWorkerTimeoutError) {
            this.attachLateDelivery(
              handlerPromise2,
              event.source,
              id,
              handlerTag,
              messageType
            );
          }
        }
      });
      return;
    }
    const updater = this.handlers.get(tag);
    if (!updater) {
      if (this.debug) console.warn(`[${tag}] unknown message tag, ignoring message`);
      this.deliverResponse(
        event.source,
        {
          id,
          tag,
          error: new Error(`Unknown handler tag: ${tag}`)
        },
        { id, tag, messageType }
      );
      return;
    }
    const label = this.labelFor(messageType, tag);
    const timeoutMs = this.resolveTimeoutMs(messageType, tag);
    const handlerPromise = updater.handleMessage(event.data);
    const context = { id, tag, messageType };
    try {
      const response = updater.isLongRunning?.(event.data) ? await handlerPromise : await this.withTimeout(handlerPromise, timeoutMs, label);
      if (this.debug) console.log(`[${tag}] outgoing response:`, response);
      this.deliverResponse(event.source, response ?? { id, tag }, context);
    } catch (err) {
      if (this.debug) console.error(`[${tag}] handleMessage failed`, err);
      const error = toError(err);
      this.deliverResponse(event.source, { id, tag, error }, context);
      if (err instanceof ServiceWorkerTimeoutError) {
        this.attachLateDelivery(handlerPromise, event.source, id, tag, messageType);
      }
    }
  }
  /**
   * Race `promise` against a timeout. Note: this does NOT cancel the
   * underlying work — the original promise keeps running. Call
   * `attachLateDelivery` after catching the timeout to surface the
   * eventual result so the message id does not go silent.
   */
  withTimeout(promise, timeoutMs, label) {
    if (timeoutMs <= 0) return promise;
    return new Promise((resolve, reject) => {
      const timer = self.setTimeout(() => {
        reject(
          new ServiceWorkerTimeoutError(
            `Message handler timed out after ${timeoutMs}ms (${label})`
          )
        );
      }, timeoutMs);
      promise.then(
        (val) => {
          self.clearTimeout(timer);
          resolve(val);
        },
        (err) => {
          self.clearTimeout(timer);
          reject(err);
        }
      );
    });
  }
  /**
   * Extract the declared `type` from a request envelope (e.g. "SETTLE").
   * Not every envelope carries a type (PING/INIT are special cased
   * earlier), so this returns undefined for envelopes that lack one.
   */
  extractMessageType(data) {
    const maybeType = data.type;
    return typeof maybeType === "string" ? maybeType : void 0;
  }
  /**
   * Resolve the timeout for an operation. Message-type overrides take
   * precedence over handler-tag overrides, with the bus-wide default
   * (`messageTimeoutMs`) as the final fallback.
   */
  resolveTimeoutMs(messageType, handlerTag) {
    if (messageType && Object.prototype.hasOwnProperty.call(this.messageTimeoutOverrides, messageType)) {
      return this.messageTimeoutOverrides[messageType];
    }
    if (Object.prototype.hasOwnProperty.call(this.messageTimeoutOverrides, handlerTag)) {
      return this.messageTimeoutOverrides[handlerTag];
    }
    return this.messageTimeoutMs;
  }
  /**
   * Build a human-readable label for timeout errors. Format:
   * `"<MESSAGE_TYPE> via <HANDLER_TAG>"` when both are known, else the
   * handler tag alone. Used so timeout errors name the operation the
   * client actually triggered (e.g. SETTLE) rather than just the
   * handler that received it (e.g. WALLET_UPDATER).
   */
  labelFor(messageType, handlerTag) {
    return messageType ? `${messageType} via ${handlerTag}` : handlerTag;
  }
  /**
   * Post a response to the originating client. When `source` is null
   * (client tab closed, detached frame, etc.) the response cannot be
   * delivered; we log the drop in debug mode so it is not invisible.
   */
  deliverResponse(source, response, context) {
    if (!source) {
      if (this.debug)
        console.warn(`[${context.tag}] cannot deliver response: event.source is null`, {
          id: context.id,
          messageType: context.messageType
        });
      return;
    }
    source.postMessage(response);
  }
  /**
   * After a handler times out the client has already received a timeout
   * error, but the handler keeps running. Attach a follow-up so the
   * handler's eventual result (or error) is delivered under the same
   * message id, or — if the handler never completes within
   * {@link LATE_DELIVERY_GRACE_MS} — an "Operation abandoned" error is
   * sent so the client's listener (if still attached) does not hang.
   */
  attachLateDelivery(handlerPromise, source, id, tag, messageType) {
    const context = { id, tag, messageType };
    const record = {
      settled: false,
      deadline: self.setTimeout(() => {
        if (record.settled) return;
        record.settled = true;
        this.lateDeliveries.delete(record);
        this.deliverResponse(
          source,
          {
            id,
            tag,
            error: new Error(
              `Operation abandoned: handler did not complete within ${LATE_DELIVERY_GRACE_MS}ms after timeout (${this.labelFor(messageType, tag)})`
            )
          },
          context
        );
      }, LATE_DELIVERY_GRACE_MS)
    };
    this.lateDeliveries.add(record);
    handlerPromise.then(
      (response) => {
        if (record.settled) return;
        record.settled = true;
        self.clearTimeout(record.deadline);
        this.lateDeliveries.delete(record);
        this.deliverResponse(source, response ?? { id, tag }, context);
      },
      (err) => {
        if (record.settled) return;
        record.settled = true;
        self.clearTimeout(record.deadline);
        this.lateDeliveries.delete(record);
        this.deliverResponse(source, { id, tag, error: toError(err) }, context);
      }
    );
  }
  /**
   * Returns the registered SW for the path.
   * It uses the functions in `service-worker-manager.ts` module.
   * @param path
   * @return the Service Worker
   * @throws if not running in a browser environment
   */
  static async getServiceWorker(path) {
    return getActiveServiceWorker(path);
  }
  /**
   * Set up and register the Service Worker, ensuring it's done once at most.
   * It uses the functions in `service-worker-manager.ts` module.
   * @param path
   * @return the Service Worker
   * @throws if not running in a browser environment
   */
  static async setup(path) {
    await setupServiceWorkerOnce(path);
    return getActiveServiceWorker(path);
  }
};
function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
var DustChangeError = class extends Error {
  change;
  dustAmount;
  constructor(change, dustAmount) {
    super(
      `change ${change} sats is below dust threshold ${dustAmount}; consider exiting the full balance`
    );
    this.name = "DustChangeError";
    this.change = change;
    this.dustAmount = dustAmount;
  }
};
var Ramps = class {
  /**
   * Create convenience wrappers for onboarding and offboarding flows.
   *
   * @param wallet - Wallet used to query funds and execute settlement transactions
   */
  constructor(wallet) {
    this.wallet = wallet;
  }
  /**
   * Onboard boarding inputs.
   *
   * @param feeInfo - The fee info to deduct from the onboard amount.
   * @param boardingUtxos - Specific boarding inputs to onboard. If not provided, all boarding inputs will be used.
   * @param amount - Amount to onboard. If not provided, the total amount of boarding inputs will be onboarded.
   * @param eventCallback - Optional callback that receives settlement events
   * @returns The Arkade transaction id created by settlement
   * @throws Error if no boarding inputs remain after fee deduction or if `amount` exceeds available value
   * @see IWallet.getBoardingUtxos
   * @see IWallet.settle
   * @example
   * ```typescript
   * const feeInfo = { intentFee: {}, txFeeRate: '1' };
   * const ramps = new Ramps(wallet);
   * await ramps.onboard(feeInfo);
   * ```
   */
  async onboard(feeInfo, boardingUtxos, amount, eventCallback) {
    boardingUtxos = boardingUtxos ?? await this.wallet.getBoardingUtxos();
    const estimator = new Estimator(feeInfo?.intentFee ?? {});
    const filteredBoardingUtxos = [];
    let totalAmount = 0n;
    for (const utxo of boardingUtxos) {
      const inputFee = estimator.evalOnchainInput({
        amount: BigInt(utxo.value)
      });
      if (inputFee.satoshis >= utxo.value) {
        continue;
      }
      filteredBoardingUtxos.push(utxo);
      totalAmount += BigInt(utxo.value) - BigInt(inputFee.satoshis);
    }
    if (filteredBoardingUtxos.length === 0) {
      throw new Error("No boarding utxos available after deducting fees");
    }
    let change = 0n;
    if (amount) {
      if (amount > totalAmount) {
        throw new Error("Amount is greater than total amount of boarding utxos after fees");
      }
      change = totalAmount - amount;
    }
    amount = amount ?? totalAmount;
    const offchainAddress = await this.wallet.getAddress();
    const offchainAddr = ArkAddress.decode(offchainAddress);
    const offchainScript = hex.encode(offchainAddr.pkScript);
    const outputFee = estimator.evalOffchainOutput({
      amount,
      script: offchainScript
    });
    if (BigInt(outputFee.satoshis) > amount) {
      throw new Error(
        `can't deduct fees from onboard amount (${outputFee.satoshis} > ${amount})`
      );
    }
    amount -= BigInt(outputFee.satoshis);
    const outputs = [
      {
        address: offchainAddress,
        amount
      }
    ];
    if (change > 0n) {
      const boardingAddress = await this.wallet.getBoardingAddress();
      outputs.push({
        address: boardingAddress,
        amount: change
      });
    }
    return this.wallet.settle(
      {
        inputs: filteredBoardingUtxos,
        outputs
      },
      eventCallback
    );
  }
  /**
   * Offboard virtual outputs, or collaboratively exit them to an onchain address.
   *
   * @param destinationAddress - The destination address to offboard to.
   * @param feeInfo - The fee info to deduct from the offboard amount.
   * @param amount - The amount to offboard. If not provided, the total amount of virtual outputs will be offboarded.
   * @param eventCallback - Optional callback that receives settlement events
   * @returns The Arkade transaction id created by settlement
   * @throws Error if no virtual outputs remain after fee deduction or the destination address cannot be decoded
   * @see IWallet.getVtxos
   * @see IWallet.settle
   * @example
   * ```typescript
   * const feeInfo = { intentFee: {}, txFeeRate: '1' };
   * const ramps = new Ramps(wallet);
   * await ramps.offboard('bc1q...', feeInfo);
   * ```
   */
  async offboard(destinationAddress, feeInfo, amount, eventCallback) {
    const vtxos = await this.wallet.getVtxos({
      withRecoverable: true,
      withUnrolled: false
    });
    const estimator = new Estimator(feeInfo?.intentFee ?? {});
    const filteredVtxos = [];
    let totalAmount = 0n;
    for (const vtxo of vtxos) {
      const inputFee = estimator.evalOffchainInput({
        amount: BigInt(vtxo.value),
        type: vtxo.virtualStatus.state === "swept" ? "recoverable" : "vtxo",
        weight: 0,
        birth: vtxo.createdAt,
        expiry: vtxo.virtualStatus.batchExpiry ? new Date(vtxo.virtualStatus.batchExpiry) : void 0
      });
      if (inputFee.satoshis >= vtxo.value) {
        continue;
      }
      filteredVtxos.push(vtxo);
      totalAmount += BigInt(vtxo.value) - BigInt(inputFee.satoshis);
    }
    if (filteredVtxos.length === 0) {
      throw new Error("No vtxos available after deducting fees");
    }
    let change = 0n;
    if (amount) {
      if (amount > totalAmount) {
        throw new Error("Amount is greater than total amount of vtxos after fees");
      }
      change = totalAmount - amount;
    }
    const dustAmount = getDustAmount(this.wallet);
    if (change > 0n && change < dustAmount) {
      throw new DustChangeError(change, dustAmount);
    }
    amount = amount ?? totalAmount;
    const networkNames = [
      "bitcoin",
      "regtest",
      "testnet",
      "signet",
      "mutinynet"
    ];
    let destinationScript;
    for (const networkName of networkNames) {
      try {
        const network = networks$1[networkName];
        const addr = Address(network).decode(destinationAddress);
        destinationScript = OutScript.encode(addr);
        break;
      } catch {
        continue;
      }
    }
    if (!destinationScript) {
      throw new Error(`Failed to decode destination address: ${destinationAddress}`);
    }
    const outputFee = estimator.evalOnchainOutput({
      amount,
      script: hex.encode(destinationScript)
    });
    if (BigInt(outputFee.satoshis) > amount) {
      throw new Error(
        `can't deduct fees from offboard amount (${outputFee.satoshis} > ${amount})`
      );
    }
    amount -= BigInt(outputFee.satoshis);
    const outputs = [
      {
        address: destinationAddress,
        amount
      }
    ];
    if (change > 0n) {
      const offchainAddress = await this.wallet.getAddress();
      outputs.push({
        address: offchainAddress,
        amount: change
      });
    }
    return this.wallet.settle(
      {
        inputs: filteredVtxos,
        outputs
      },
      eventCallback
    );
  }
};

// src/wallet/serviceWorker/wallet-message-handler.ts
var WalletNotInitializedError = class extends Error {
  constructor() {
    super("Wallet handler not initialized");
    this.name = "WalletNotInitializedError";
  }
};
function isSerializedAggregateError(value) {
  if (!value || typeof value !== "object") return false;
  const v = value;
  return v.name === "AggregateError" && typeof v.message === "string" && Array.isArray(v.errors) && v.errors.every((e) => e && typeof e.name === "string" && typeof e.message === "string");
}
function serializeAggregateError(error) {
  const errors = [];
  for (const child of error.errors ?? []) {
    if (child instanceof Error) {
      errors.push({ name: child.name, message: child.message });
    } else {
      errors.push({ name: "Error", message: String(child) });
    }
  }
  return {
    name: "AggregateError",
    message: error.message,
    errors
  };
}
function deserializeAggregateError(payload) {
  const errs = payload.errors.map((e) => {
    const err = new Error(e.message);
    err.name = e.name;
    return err;
  });
  return new AggregateError(errs, payload.message);
}
var ReadonlyWalletError = class extends Error {
  constructor() {
    super("Read-only wallet: operation requires signing");
    this.name = "ReadonlyWalletError";
  }
};
var DelegateNotConfiguredError = class extends Error {
  constructor() {
    super("Delegate not configured");
    this.name = "DelegateNotConfiguredError";
  }
};
var DelegatorNotConfiguredError = DelegateNotConfiguredError;
var DEFAULT_MESSAGE_TAG = "WALLET_UPDATER";
var WalletMessageHandler = class {
  messageTag;
  wallet;
  readonlyWallet;
  arkProvider;
  indexerProvider;
  walletRepository;
  incomingFundsSubscription;
  contractEventsSubscription;
  onNextTick = [];
  /**
   * Instantiate a new WalletUpdater.
   * Can override the default `messageTag` allowing more than one updater to run in parallel.
   * Note that the default ServiceWorkerWallet sends messages to the default WalletUpdater tag.
   */
  constructor(options) {
    this.messageTag = options?.messageTag ?? DEFAULT_MESSAGE_TAG;
  }
  // lifecycle methods
  async start(...params) {
    const [services, repositories] = params;
    this.readonlyWallet = services.readonlyWallet;
    this.wallet = services.wallet;
    this.arkProvider = services.arkProvider;
    this.walletRepository = repositories.walletRepository;
  }
  async stop() {
    if (this.incomingFundsSubscription) {
      this.incomingFundsSubscription();
      this.incomingFundsSubscription = void 0;
    }
    if (this.contractEventsSubscription) {
      this.contractEventsSubscription();
      this.contractEventsSubscription = void 0;
    }
    try {
      if (this.wallet) {
        await this.wallet.dispose();
      } else if (this.readonlyWallet) {
        await this.readonlyWallet.dispose();
      }
    } catch (_) {
    }
    this.wallet = void 0;
    this.readonlyWallet = void 0;
    this.arkProvider = void 0;
    this.indexerProvider = void 0;
  }
  async tick(_now) {
    const results = await Promise.allSettled(this.onNextTick.map((fn) => fn()));
    this.onNextTick = [];
    return results.map((result) => {
      if (result.status === "fulfilled") {
        return result.value;
      } else {
        console.error(`[${this.messageTag}] tick failed`, result.reason);
        return null;
      }
    }).filter((response) => response !== null);
  }
  scheduleForNextTick(callback) {
    this.onNextTick.push(callback);
  }
  requireWallet() {
    if (!this.wallet) {
      throw new ReadonlyWalletError();
    }
    return this.wallet;
  }
  tagged(res) {
    return {
      ...res,
      tag: this.messageTag
    };
  }
  // Flows that surrender control to the Ark server and the other participants
  // in a batch round: quiet gaps between protocol events can easily exceed
  // the bus-level messageTimeoutMs. Liveness is covered out-of-band by the
  // page-side PING / MESSAGE_BUS_NOT_INITIALIZED path triggered by concurrent
  // short requests (GET_STATUS, GET_BALANCE, ...).
  isLongRunning(message) {
    return message.type === "SETTLE" || message.type === "RECOVER_VTXOS" || message.type === "RENEW_VTXOS" || // HD restore walks the index range with one indexer round-trip per
    // step until it hits gapLimit consecutive unused indices. The bus
    // deadline must not race the scan; liveness stays covered by PING.
    message.type === "RESTORE_WALLET";
  }
  async handleMessage(message) {
    const id = message.id;
    if (message.type === "INIT_WALLET") {
      await this.handleInitWallet(message);
      return this.tagged({
        id,
        type: "WALLET_INITIALIZED"
      });
    }
    if (!this.readonlyWallet) {
      return this.tagged({
        id,
        error: new WalletNotInitializedError()
      });
    }
    try {
      switch (message.type) {
        case "SETTLE": {
          const response = await this.handleSettle(message);
          return this.tagged({
            id,
            ...response
          });
        }
        case "SEND_BITCOIN": {
          const response = await this.handleSendBitcoin(message);
          return this.tagged({
            id,
            ...response
          });
        }
        case "GET_ADDRESS": {
          const address = await this.readonlyWallet.getAddress();
          return this.tagged({
            id,
            type: "ADDRESS",
            payload: { address }
          });
        }
        case "GET_BOARDING_ADDRESS": {
          const address = await this.readonlyWallet.getBoardingAddress();
          return this.tagged({
            id,
            type: "BOARDING_ADDRESS",
            payload: { address }
          });
        }
        case "GET_BALANCE": {
          const balance = await this.handleGetBalance();
          return this.tagged({
            id,
            type: "BALANCE",
            payload: balance
          });
        }
        case "GET_VTXOS": {
          const vtxos = await this.handleGetVtxos(message);
          return {
            tag: this.messageTag,
            id,
            type: "VTXOS",
            payload: { vtxos }
          };
        }
        case "GET_BOARDING_UTXOS": {
          const utxos = await this.getAllBoardingUtxos();
          return this.tagged({
            id,
            type: "BOARDING_UTXOS",
            payload: { utxos }
          });
        }
        case "GET_TRANSACTION_HISTORY": {
          const allVtxos = await this.getVtxosFromRepo();
          const transactions = await this.buildTransactionHistoryFromCache(allVtxos) ?? [];
          return this.tagged({
            id,
            type: "TRANSACTION_HISTORY",
            payload: { transactions }
          });
        }
        case "GET_STATUS": {
          const pubKey = await this.readonlyWallet.identity.xOnlyPublicKey();
          return this.tagged({
            id,
            type: "WALLET_STATUS",
            payload: {
              walletInitialized: true,
              xOnlyPublicKey: pubKey
            }
          });
        }
        case "CLEAR": {
          await this.clear();
          return this.tagged({
            id,
            type: "CLEAR_SUCCESS",
            payload: { cleared: true }
          });
        }
        case "RELOAD_WALLET": {
          await this.reloadWallet();
          return this.tagged({
            id,
            type: "RELOAD_SUCCESS",
            payload: { reloaded: true }
          });
        }
        case "SIGN_TRANSACTION": {
          const response = await this.handleSignTransaction(message);
          return this.tagged({
            id,
            ...response
          });
        }
        case "CREATE_CONTRACT": {
          const manager = await this.readonlyWallet.getContractManager();
          const contract = await manager.createContract(message.payload);
          return this.tagged({
            id,
            type: "CONTRACT_CREATED",
            payload: { contract }
          });
        }
        case "GET_CONTRACTS": {
          const manager = await this.readonlyWallet.getContractManager();
          const contracts = await manager.getContracts(message.payload.filter);
          return this.tagged({
            id,
            type: "CONTRACTS",
            payload: { contracts }
          });
        }
        case "GET_CONTRACTS_WITH_VTXOS": {
          const manager = await this.readonlyWallet.getContractManager();
          const contracts = await manager.getContractsWithVtxos(message.payload.filter);
          return this.tagged({
            id,
            type: "CONTRACTS_WITH_VTXOS",
            payload: { contracts }
          });
        }
        case "ANNOTATE_VTXOS": {
          const manager = await this.readonlyWallet.getContractManager();
          const annotated = await manager.annotateVtxos(message.payload.vtxos);
          return this.tagged({
            id,
            type: "ANNOTATED_VTXOS",
            payload: { vtxos: annotated }
          });
        }
        case "UPDATE_CONTRACT": {
          const manager = await this.readonlyWallet.getContractManager();
          const contract = await manager.updateContract(
            message.payload.script,
            message.payload.updates
          );
          return this.tagged({
            id,
            type: "CONTRACT_UPDATED",
            payload: { contract }
          });
        }
        case "DELETE_CONTRACT": {
          const manager = await this.readonlyWallet.getContractManager();
          await manager.deleteContract(message.payload.script);
          return this.tagged({
            id,
            type: "CONTRACT_DELETED",
            payload: { deleted: true }
          });
        }
        case "GET_SPENDABLE_PATHS": {
          const manager = await this.readonlyWallet.getContractManager();
          const paths = await manager.getSpendablePaths(message.payload.options);
          return this.tagged({
            id,
            type: "SPENDABLE_PATHS",
            payload: { paths }
          });
        }
        case "GET_ALL_SPENDING_PATHS": {
          const manager = await this.readonlyWallet.getContractManager();
          const paths = await manager.getAllSpendingPaths(message.payload.options);
          return this.tagged({
            id,
            type: "ALL_SPENDING_PATHS",
            payload: { paths }
          });
        }
        case "IS_CONTRACT_MANAGER_WATCHING": {
          const manager = await this.readonlyWallet.getContractManager();
          const isWatching = await manager.isWatching();
          return this.tagged({
            id,
            type: "CONTRACT_WATCHING",
            payload: { isWatching }
          });
        }
        case "REFRESH_VTXOS": {
          const manager = await this.readonlyWallet.getContractManager();
          await manager.refreshVtxos(message.payload);
          return this.tagged({
            id,
            type: "REFRESH_VTXOS_SUCCESS"
          });
        }
        case "REFRESH_OUTPOINTS": {
          const manager = await this.readonlyWallet.getContractManager();
          const { outpoints } = message.payload;
          await manager.refreshOutpoints(outpoints);
          return this.tagged({
            id,
            type: "REFRESH_OUTPOINTS_SUCCESS"
          });
        }
        case "SEND": {
          const { recipients } = message.payload;
          const txid = await this.wallet.send(...recipients);
          return this.tagged({
            id,
            type: "SEND_SUCCESS",
            payload: { txid }
          });
        }
        case "GET_ASSET_DETAILS": {
          const { assetId } = message.payload;
          const assetDetails = await this.readonlyWallet.assetManager.getAssetDetails(assetId);
          return this.tagged({
            id,
            type: "ASSET_DETAILS",
            payload: { assetDetails }
          });
        }
        case "ISSUE": {
          const { params } = message.payload;
          const result = await this.wallet.assetManager.issue(params);
          return this.tagged({
            id,
            type: "ISSUE_SUCCESS",
            payload: { result }
          });
        }
        case "REISSUE": {
          const { params } = message.payload;
          const txid = await this.wallet.assetManager.reissue(params);
          return this.tagged({
            id,
            type: "REISSUE_SUCCESS",
            payload: { txid }
          });
        }
        case "BURN": {
          const { params } = message.payload;
          const txid = await this.wallet.assetManager.burn(params);
          return this.tagged({
            id,
            type: "BURN_SUCCESS",
            payload: { txid }
          });
        }
        case "DELEGATE": {
          const response = await this.handleDelegate(message);
          return this.tagged({ id, ...response });
        }
        case "GET_DELEGATE_INFO": {
          const wallet = this.requireWallet();
          const delegateManager = await wallet.getDelegateManager();
          if (!delegateManager) {
            throw new DelegateNotConfiguredError();
          }
          const info = await delegateManager.getDelegateInfo();
          return this.tagged({
            id,
            type: "DELEGATE_INFO",
            payload: { info }
          });
        }
        case "RECOVER_VTXOS": {
          const wallet = this.requireWallet();
          const vtxoManager = await wallet.getVtxoManager();
          const txid = await vtxoManager.recoverVtxos((e) => {
            this.scheduleForNextTick(
              () => this.tagged({
                id,
                type: "RECOVER_VTXOS_EVENT",
                payload: e
              })
            );
          });
          return this.tagged({
            id,
            type: "RECOVER_VTXOS_SUCCESS",
            payload: { txid }
          });
        }
        case "GET_RECOVERABLE_BALANCE": {
          const wallet = this.requireWallet();
          const vtxoManager = await wallet.getVtxoManager();
          const balance = await vtxoManager.getRecoverableBalance();
          return this.tagged({
            id,
            type: "RECOVERABLE_BALANCE",
            payload: {
              recoverable: balance.recoverable.toString(),
              subdust: balance.subdust.toString(),
              includesSubdust: balance.includesSubdust,
              vtxoCount: balance.vtxoCount
            }
          });
        }
        case "GET_EXPIRING_VTXOS": {
          const wallet = this.requireWallet();
          const vtxoManager = await wallet.getVtxoManager();
          const vtxos = await vtxoManager.getExpiringVtxos(
            message.payload.thresholdMs
          );
          return this.tagged({
            id,
            type: "EXPIRING_VTXOS",
            payload: { vtxos }
          });
        }
        case "RENEW_VTXOS": {
          const wallet = this.requireWallet();
          const vtxoManager = await wallet.getVtxoManager();
          const txid = await vtxoManager.renewVtxos((e) => {
            this.scheduleForNextTick(
              () => this.tagged({
                id,
                type: "RENEW_VTXOS_EVENT",
                payload: e
              })
            );
          }, message.payload);
          return this.tagged({
            id,
            type: "RENEW_VTXOS_SUCCESS",
            payload: { txid }
          });
        }
        case "GET_EXPIRED_BOARDING_UTXOS": {
          const wallet = this.requireWallet();
          const vtxoManager = await wallet.getVtxoManager();
          const utxos = await vtxoManager.getExpiredBoardingUtxos();
          return this.tagged({
            id,
            type: "EXPIRED_BOARDING_UTXOS",
            payload: { utxos }
          });
        }
        case "SWEEP_EXPIRED_BOARDING_UTXOS": {
          const wallet = this.requireWallet();
          const vtxoManager = await wallet.getVtxoManager();
          const txid = await vtxoManager.sweepExpiredBoardingUtxos();
          return this.tagged({
            id,
            type: "SWEEP_EXPIRED_BOARDING_UTXOS_SUCCESS",
            payload: { txid }
          });
        }
        case "RESTORE_WALLET": {
          const wallet = this.requireWallet();
          try {
            await wallet.restore(message.payload);
          } catch (error) {
            if (error instanceof AggregateError) {
              return this.tagged({
                id,
                error: serializeAggregateError(error)
              });
            }
            throw error;
          }
          return this.tagged({
            id,
            type: "RESTORE_WALLET_SUCCESS"
          });
        }
        default:
          console.error("Unknown message type", message);
          throw new Error("Unknown message");
      }
    } catch (error) {
      return this.tagged({ id, error });
    }
  }
  // Wallet methods
  async handleInitWallet({ payload }) {
    const { arkServerUrl } = payload;
    this.indexerProvider = new RestIndexerProvider(arkServerUrl);
    await this.onWalletInitialized();
  }
  async handleGetBalance() {
    const [boardingUtxos, allVtxos] = await Promise.all([
      this.getAllBoardingUtxos(),
      this.getVtxosFromRepo()
    ]);
    let confirmed = 0;
    let unconfirmed = 0;
    for (const utxo of boardingUtxos) {
      if (utxo.status.confirmed) {
        confirmed += utxo.value;
      } else {
        unconfirmed += utxo.value;
      }
    }
    const spendableVtxos = allVtxos.filter(isSpendable);
    const sweptVtxos = allVtxos.filter((vtxo) => vtxo.virtualStatus.state === "swept");
    let settled = 0;
    let preconfirmed = 0;
    let recoverable = 0;
    for (const vtxo of spendableVtxos) {
      if (vtxo.virtualStatus.state === "settled") {
        settled += vtxo.value;
      } else if (vtxo.virtualStatus.state === "preconfirmed") {
        preconfirmed += vtxo.value;
      }
    }
    for (const vtxo of sweptVtxos) {
      if (isSpendable(vtxo)) {
        recoverable += vtxo.value;
      }
    }
    const totalBoarding = confirmed + unconfirmed;
    const totalOffchain = settled + preconfirmed + recoverable;
    const assetBalances = /* @__PURE__ */ new Map();
    for (const vtxo of spendableVtxos) {
      if (vtxo.assets) {
        for (const a of vtxo.assets) {
          const current = assetBalances.get(a.assetId) ?? 0n;
          assetBalances.set(a.assetId, current + a.amount);
        }
      }
    }
    const assets = Array.from(assetBalances.entries()).map(([assetId, amount]) => ({
      assetId,
      amount
    }));
    return {
      boarding: {
        confirmed,
        unconfirmed,
        total: totalBoarding
      },
      settled,
      preconfirmed,
      available: settled + preconfirmed,
      recoverable,
      total: totalBoarding + totalOffchain,
      assets
    };
  }
  async getAllBoardingUtxos() {
    if (!this.readonlyWallet) return [];
    return this.readonlyWallet.getBoardingUtxos();
  }
  /**
   * Get spendable vtxos from the repository
   */
  async getSpendableVtxos() {
    const vtxos = await this.getVtxosFromRepo();
    return vtxos.filter(isSpendable);
  }
  async onWalletInitialized() {
    if (!this.readonlyWallet || !this.arkProvider || !this.indexerProvider || !this.walletRepository) {
      return;
    }
    await this.ensureContractEventBroadcasting();
    await this.refreshCachedData();
    if (this.wallet) {
      try {
        const vtxos = await this.getVtxosFromRepo();
        const { pending, finalized } = await this.wallet.finalizePendingTxs(
          vtxos.filter(
            (vtxo) => vtxo.virtualStatus.state !== "swept" && vtxo.virtualStatus.state !== "settled"
          )
        );
        console.info(
          `Recovered ${finalized.length}/${pending.length} pending transactions: ${finalized.join(", ")}`
        );
      } catch (error) {
        console.error("Error recovering pending transactions:", error);
      }
    }
    if (this.incomingFundsSubscription) this.incomingFundsSubscription();
    const address = await this.readonlyWallet.getAddress();
    this.incomingFundsSubscription = await this.readonlyWallet.notifyIncomingFunds(
      async (funds) => {
        if (funds.type === "vtxo") {
          const { newVtxos, spentVtxos } = funds;
          if (newVtxos.length + spentVtxos.length === 0) return;
          const byScript = /* @__PURE__ */ new Map();
          for (const v of [...newVtxos, ...spentVtxos]) {
            if (!v.script) {
              console.warn(
                `WalletMessageHandler.notifyIncomingFunds: dropping VTXO without script ${v.txid}:${v.vout}`
              );
              continue;
            }
            const arr = byScript.get(v.script) ?? [];
            arr.push(v);
            byScript.set(v.script, arr);
          }
          let walletScript;
          try {
            walletScript = scriptFromArkAddress(address);
          } catch {
            walletScript = void 0;
          }
          const cm = await this.readonlyWallet.getContractManager();
          const contracts = await cm.getContracts();
          const addrByScript = new Map(contracts.map((c) => [c.script, c.address]));
          for (const [script, vtxos] of byScript) {
            const filtered = warnAndFilterVtxosForScript(
              vtxos,
              script,
              "WalletMessageHandler.notifyIncomingFunds"
            );
            if (filtered.length === 0) continue;
            const targetAddress = script === walletScript ? address : addrByScript.get(script);
            if (!targetAddress) continue;
            if (this.walletRepository) {
              await saveVtxosForContract(
                this.walletRepository,
                { script, address: targetAddress },
                filtered
              );
            }
          }
          this.scheduleForNextTick(
            () => this.tagged({
              type: "VTXO_UPDATE",
              broadcast: true,
              payload: { newVtxos, spentVtxos }
            })
          );
        }
        if (funds.type === "utxo") {
          const utxos = funds.coins.map((utxo) => extendCoin(this.readonlyWallet, utxo));
          const boardingAddress = await this.readonlyWallet.getBoardingAddress();
          await this.walletRepository?.saveUtxos(boardingAddress, utxos);
          this.scheduleForNextTick(
            () => this.tagged({
              type: "UTXO_UPDATE",
              broadcast: true,
              payload: { coins: utxos }
            })
          );
        }
      }
    );
    if (this.wallet) {
      try {
        await this.wallet.getVtxoManager();
      } catch (error) {
        console.error("Error starting VtxoManager:", error);
      }
    }
  }
  /**
   * Refresh virtual outputs, boarding inputs, and transaction history from cache.
   * Shared by onWalletInitialized (full bootstrap) and reloadWallet
   * (post-refresh), avoiding duplicate subscriptions and VtxoManager restarts.
   */
  async refreshCachedData() {
    if (!this.readonlyWallet || !this.walletRepository) {
      return;
    }
    const vtxos = await this.getVtxosFromRepo();
    const boardingAddress = await this.readonlyWallet.getBoardingAddress();
    const coins = await this.readonlyWallet.onchainProvider.getCoins(boardingAddress);
    await this.walletRepository.deleteUtxos(boardingAddress);
    await this.walletRepository.saveUtxos(
      boardingAddress,
      coins.map((utxo) => extendCoin(this.readonlyWallet, utxo))
    );
    const address = await this.readonlyWallet.getAddress();
    const txs = await this.buildTransactionHistoryFromCache(vtxos);
    if (txs) await this.walletRepository.saveTransactions(address, txs);
  }
  /**
   * Force a full VTXO refresh from the indexer, then refresh cached data.
   * Used by RELOAD_WALLET to ensure fresh data without re-subscribing
   * to incoming funds or restarting the VtxoManager.
   */
  async reloadWallet() {
    if (!this.readonlyWallet) return;
    const manager = await this.readonlyWallet.getContractManager();
    await manager.refreshVtxos();
    await this.refreshCachedData();
  }
  async handleSettle(message) {
    const wallet = this.requireWallet();
    const txid = await wallet.settle(message.payload.params, (e) => {
      this.scheduleForNextTick(
        () => this.tagged({
          id: message.id,
          type: "SETTLE_EVENT",
          payload: e
        })
      );
    });
    if (!txid) {
      throw new Error("Settlement failed");
    }
    return { type: "SETTLE_SUCCESS", payload: { txid } };
  }
  async handleSendBitcoin(message) {
    const wallet = this.requireWallet();
    const txid = await wallet.sendBitcoin(message.payload);
    if (!txid) {
      throw new Error("Send bitcoin failed");
    }
    return {
      type: "SEND_BITCOIN_SUCCESS",
      payload: { txid }
    };
  }
  async handleSignTransaction(message) {
    const wallet = this.requireWallet();
    const { tx, inputIndexes } = message.payload;
    const signature = await wallet.identity.sign(tx, inputIndexes);
    if (!signature) {
      throw new Error("Sign transaction failed");
    }
    return {
      type: "SIGN_TRANSACTION",
      payload: { tx: signature }
    };
  }
  async handleDelegate(message) {
    const wallet = this.requireWallet();
    const delegateManager = await wallet.getDelegateManager();
    if (!delegateManager) {
      throw new DelegateNotConfiguredError();
    }
    const { vtxoOutpoints, destination, delegateAt } = message.payload;
    const allVtxos = await wallet.getVtxos();
    const outpointSet = new Set(vtxoOutpoints.map((o) => `${o.txid}:${o.vout}`));
    const filtered = allVtxos.filter((v) => outpointSet.has(`${v.txid}:${v.vout}`)).map((v) => ({ ...v, contractScript: v.script }));
    const result = await delegateManager.delegate(
      filtered,
      destination,
      delegateAt !== void 0 ? new Date(delegateAt) : void 0
    );
    return {
      tag: this.messageTag,
      type: "DELEGATE_SUCCESS",
      payload: {
        delegated: result.delegated.map((o) => ({
          txid: o.txid,
          vout: o.vout
        })),
        failed: result.failed.map((f) => ({
          outpoints: f.outpoints.map((o) => ({
            txid: o.txid,
            vout: o.vout
          })),
          error: String(f.error)
        }))
      }
    };
  }
  async handleGetVtxos(message) {
    if (!this.readonlyWallet) {
      throw new WalletNotInitializedError();
    }
    const vtxos = await this.getSpendableVtxos();
    const dustAmount = this.readonlyWallet.dustAmount;
    const includeRecoverable = message.payload.filter?.withRecoverable ?? false;
    const filteredVtxos = includeRecoverable ? vtxos : vtxos.filter((v) => {
      if (dustAmount != null && isSubdust(v, dustAmount)) {
        return false;
      }
      if (isRecoverable(v)) {
        return false;
      }
      if (isExpired(v)) {
        return false;
      }
      return true;
    });
    return filteredVtxos;
  }
  async clear() {
    if (!this.readonlyWallet) return;
    if (this.incomingFundsSubscription) this.incomingFundsSubscription();
    if (this.contractEventsSubscription) {
      this.contractEventsSubscription();
      this.contractEventsSubscription = void 0;
    }
    try {
      if (this.wallet) {
        await this.wallet.dispose();
      } else {
        await this.readonlyWallet.dispose();
      }
    } catch (_) {
    }
    try {
      await this.walletRepository?.clear();
    } catch (_) {
      console.warn("Failed to clear vtxos from wallet repository");
    }
    this.wallet = void 0;
    this.readonlyWallet = void 0;
    this.arkProvider = void 0;
    this.indexerProvider = void 0;
  }
  /**
   * Read all virtual outputs from the repository, aggregated across all contract
   * addresses and the wallet's primary address, with deduplication.
   */
  async getVtxosFromRepo() {
    if (!this.walletRepository || !this.readonlyWallet) return [];
    const seen = /* @__PURE__ */ new Set();
    const allVtxos = [];
    const addVtxos = (vtxos) => {
      for (const vtxo of vtxos) {
        const key = `${vtxo.txid}:${vtxo.vout}`;
        if (!seen.has(key)) {
          seen.add(key);
          allVtxos.push(vtxo);
        }
      }
    };
    const manager = await this.readonlyWallet.getContractManager();
    const contracts = await manager.getContracts();
    for (const contract of contracts) {
      addVtxos(await getVtxosForContract(this.walletRepository, contract));
    }
    const walletAddress = await this.readonlyWallet.getAddress();
    let walletScript;
    try {
      walletScript = scriptFromArkAddress(walletAddress);
    } catch (e) {
      throw new Error(
        `WalletMessageHandler.getVtxosFromRepo: failed to derive script from wallet address ${walletAddress}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    const walletVtxos = await this.walletRepository.getVtxos(walletAddress);
    addVtxos(filterVtxosForScript(walletVtxos, walletScript));
    return allVtxos;
  }
  /**
   * Build transaction history from cached virtual outputs without hitting the indexer.
   * Falls back to indexer only for uncached transaction timestamps.
   */
  async buildTransactionHistoryFromCache(vtxos) {
    if (!this.readonlyWallet) return null;
    const { boardingTxs, commitmentsToIgnore } = await this.readonlyWallet.getBoardingTxs();
    const vtxoCreatedAt = /* @__PURE__ */ new Map();
    for (const vtxo of vtxos) {
      const existing = vtxoCreatedAt.get(vtxo.txid);
      const ts = vtxo.createdAt.getTime();
      if (existing === void 0 || ts < existing) {
        vtxoCreatedAt.set(vtxo.txid, ts);
      }
    }
    if (this.indexerProvider) {
      const uncachedTxids = /* @__PURE__ */ new Set();
      for (const vtxo of vtxos) {
        if (vtxo.isSpent && vtxo.arkTxId && !vtxoCreatedAt.has(vtxo.arkTxId) && !vtxos.some((v) => v.txid === vtxo.arkTxId)) {
          uncachedTxids.add(vtxo.arkTxId);
        }
      }
      if (uncachedTxids.size > 0) {
        const outpoints = [...uncachedTxids].map((txid) => ({
          txid,
          vout: 0
        }));
        const BATCH_SIZE = 100;
        for (let i = 0; i < outpoints.length; i += BATCH_SIZE) {
          const res = await this.indexerProvider.getVtxos({
            outpoints: outpoints.slice(i, i + BATCH_SIZE)
          });
          for (const v of res.vtxos) {
            vtxoCreatedAt.set(v.txid, v.createdAt.getTime());
          }
        }
      }
    }
    const getTxCreatedAt = async (txid) => {
      return vtxoCreatedAt.get(txid);
    };
    return buildTransactionHistory(vtxos, boardingTxs, commitmentsToIgnore, getTxCreatedAt);
  }
  async ensureContractEventBroadcasting() {
    if (!this.readonlyWallet) return;
    if (this.contractEventsSubscription) return;
    try {
      const manager = await this.readonlyWallet.getContractManager();
      this.contractEventsSubscription = manager.onContractEvent((event) => {
        this.scheduleForNextTick(
          () => this.tagged({
            type: "CONTRACT_EVENT",
            broadcast: true,
            payload: { event }
          })
        );
      });
    } catch (error) {
      console.error("Error subscribing to contract events:", error);
    }
  }
};

// src/wallet/serviceWorker/wallet.ts
function isMessageBusNotInitializedError(error) {
  return error instanceof Error && error.message.includes(MESSAGE_BUS_NOT_INITIALIZED);
}
var DEFAULT_MESSAGE_TIMEOUTS = {
  // Fast reads — fail quickly
  GET_ADDRESS: 1e4,
  GET_BALANCE: 1e4,
  GET_BOARDING_ADDRESS: 1e4,
  GET_STATUS: 1e4,
  GET_DELEGATE_INFO: 1e4,
  IS_CONTRACT_MANAGER_WATCHING: 1e4,
  // Medium reads — may involve indexer queries
  GET_VTXOS: 2e4,
  GET_BOARDING_UTXOS: 2e4,
  GET_TRANSACTION_HISTORY: 2e4,
  GET_CONTRACTS: 2e4,
  GET_CONTRACTS_WITH_VTXOS: 2e4,
  ANNOTATE_VTXOS: 2e4,
  GET_SPENDABLE_PATHS: 2e4,
  GET_ALL_SPENDING_PATHS: 2e4,
  GET_ASSET_DETAILS: 2e4,
  GET_EXPIRING_VTXOS: 2e4,
  GET_EXPIRED_BOARDING_UTXOS: 2e4,
  GET_RECOVERABLE_BALANCE: 2e4,
  RELOAD_WALLET: 2e4,
  // Transactions — need more headroom.
  // SETTLE / RECOVER_VTXOS / RENEW_VTXOS go through the streaming path and
  // are treated as long-running on both sides of the bus: the values below
  // are retained only for type completeness and are never enforced.
  SEND_BITCOIN: 5e4,
  SEND: 5e4,
  SETTLE: 5e4,
  ISSUE: 5e4,
  REISSUE: 5e4,
  BURN: 5e4,
  DELEGATE: 5e4,
  RECOVER_VTXOS: 5e4,
  RENEW_VTXOS: 5e4,
  SWEEP_EXPIRED_BOARDING_UTXOS: 5e4,
  // RESTORE_WALLET is a streaming/long-running path (sendMessageWithEvents)
  // like SETTLE; the value here is kept for type completeness and is never
  // enforced as an inactivity deadline.
  RESTORE_WALLET: 5e4,
  // Misc writes
  INIT_WALLET: 3e4,
  CLEAR: 1e4,
  SIGN_TRANSACTION: 3e4,
  CREATE_CONTRACT: 3e4,
  UPDATE_CONTRACT: 3e4,
  DELETE_CONTRACT: 1e4,
  REFRESH_VTXOS: 3e4,
  REFRESH_OUTPOINTS: 3e4
};
var DEDUPABLE_REQUEST_TYPES = /* @__PURE__ */ new Set([
  "GET_ADDRESS",
  "GET_BALANCE",
  "GET_BOARDING_ADDRESS",
  "GET_BOARDING_UTXOS",
  "GET_STATUS",
  "GET_TRANSACTION_HISTORY",
  "IS_CONTRACT_MANAGER_WATCHING",
  "GET_DELEGATE_INFO",
  "GET_RECOVERABLE_BALANCE",
  "GET_EXPIRED_BOARDING_UTXOS",
  "GET_VTXOS",
  "GET_CONTRACTS",
  "GET_CONTRACTS_WITH_VTXOS",
  "ANNOTATE_VTXOS",
  "GET_SPENDABLE_PATHS",
  "GET_ALL_SPENDING_PATHS",
  "GET_ASSET_DETAILS",
  "GET_EXPIRING_VTXOS",
  "RELOAD_WALLET"
]);
function getRequestDedupKey(request) {
  const { id, tag, ...rest } = request;
  return JSON.stringify(rest);
}
function isSigningCapable(identity) {
  const candidate = identity;
  return typeof candidate.signMessage === "function" && typeof candidate.sign === "function" && typeof candidate.signerSession === "function";
}
var ServiceWorkerReadonlyAssetManager = class {
  constructor(sendMessage, messageTag) {
    this.sendMessage = sendMessage;
    this.messageTag = messageTag;
  }
  async getAssetDetails(assetId) {
    const message = {
      tag: this.messageTag,
      type: "GET_ASSET_DETAILS",
      id: getRandomId(),
      payload: { assetId }
    };
    const response = await this.sendMessage(message);
    return response.payload.assetDetails;
  }
};
var ServiceWorkerAssetManager = class extends ServiceWorkerReadonlyAssetManager {
  async issue(params) {
    const message = {
      tag: this.messageTag,
      type: "ISSUE",
      id: getRandomId(),
      payload: { params }
    };
    const response = await this.sendMessage(message);
    return response.payload.result;
  }
  async reissue(params) {
    const message = {
      tag: this.messageTag,
      type: "REISSUE",
      id: getRandomId(),
      payload: { params }
    };
    const response = await this.sendMessage(message);
    return response.payload.txid;
  }
  async burn(params) {
    const message = {
      tag: this.messageTag,
      type: "BURN",
      id: getRandomId(),
      payload: { params }
    };
    const response = await this.sendMessage(message);
    return response.payload.txid;
  }
};
var initializeMessageBus = (serviceWorker, config, timeoutMs = 2e3) => {
  const initCmd = {
    tag: "INITIALIZE_MESSAGE_BUS",
    id: getRandomId(),
    config: { ...config, timeoutMs }
  };
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      navigator.serviceWorker.removeEventListener("message", onMessage);
      clearTimeout(timeoutId);
    };
    const onMessage = (event) => {
      const response = event.data;
      if (response?.id !== initCmd.id) return;
      cleanup();
      if (response.error) {
        reject(response.error);
      } else {
        resolve();
      }
    };
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new ServiceWorkerTimeoutError("MessageBus timed out"));
    }, timeoutMs);
    navigator.serviceWorker.addEventListener("message", onMessage);
    serviceWorker.postMessage(initCmd);
  });
};
var ServiceWorkerReadonlyWallet = class _ServiceWorkerReadonlyWallet {
  constructor(serviceWorker, identity, walletRepository, contractRepository, messageTag) {
    this.serviceWorker = serviceWorker;
    this.messageTag = messageTag;
    this.identity = identity;
    this.walletRepository = walletRepository;
    this.contractRepository = contractRepository;
    this._readonlyAssetManager = new ServiceWorkerReadonlyAssetManager(
      (msg) => this.sendMessage(msg),
      messageTag
    );
  }
  walletRepository;
  contractRepository;
  identity;
  _readonlyAssetManager;
  initConfig = null;
  initWalletPayload = null;
  messageBusTimeoutMs;
  messageTimeouts = DEFAULT_MESSAGE_TIMEOUTS;
  // Denormalized from options so buildInitConfig() can rebuild the init
  // envelope on demand for SDK-factory-created wallets. `create()` sets
  // these immediately after construction.
  arkServerUrl;
  arkServerPublicKey;
  delegateUrl;
  /** @deprecated alias for @see ServiceWorkerReadonlyWallet.delegateUrl */
  delegatorUrl;
  indexerUrl;
  esploraUrl;
  watcherConfig;
  settlementConfig;
  reinitPromise = null;
  pingPromise = null;
  inflightRequests = /* @__PURE__ */ new Map();
  get assetManager() {
    return this._readonlyAssetManager;
  }
  getTimeoutForRequest(request) {
    return this.messageTimeouts[request.type] ?? 3e4;
  }
  /**
   * Create a readonly service-worker wallet bound to an already-registered worker.
   *
   * @param options - Service worker, identity, and backend configuration
   * @returns Initialized readonly service-worker wallet
   * @throws Error if service-worker initialization fails
   */
  static async create(options) {
    const walletRepository = options.storage?.walletRepository ?? new IndexedDBWalletRepository();
    const contractRepository = options.storage?.contractRepository ?? new IndexedDBContractRepository();
    const messageTag = options.walletUpdaterTag ?? DEFAULT_MESSAGE_TAG;
    const wallet = new _ServiceWorkerReadonlyWallet(
      options.serviceWorker,
      options.identity,
      walletRepository,
      contractRepository,
      messageTag
    );
    const serializedWallet = await serializeReadonlyIdentity(options.identity);
    const publicKey = await options.identity.compressedPublicKey().then(hex.encode);
    const initWalletPayload = {
      key: { publicKey },
      arkServerUrl: getArkadeServerUrl(options),
      arkServerPublicKey: options.arkServerPublicKey,
      delegateUrl: options.delegateUrl || options.delegatorUrl,
      // Keep the deprecated field populated so pre-#519 service workers
      // (which only read delegatorUrl) keep delegating until they activate
      // a newer version.
      delegatorUrl: options.delegateUrl || options.delegatorUrl
    };
    const messageTimeouts = options.messageTimeouts ? {
      ...DEFAULT_MESSAGE_TIMEOUTS,
      ...options.messageTimeouts
    } : DEFAULT_MESSAGE_TIMEOUTS;
    const busInitConfig = {
      wallet: serializedWallet,
      arkServer: {
        url: getArkadeServerUrl(options),
        publicKey: options.arkServerPublicKey
      },
      delegateUrl: options.delegateUrl || options.delegatorUrl,
      // Keep the deprecated field populated so pre-#519 service workers
      // (which only read delegatorUrl) keep delegating until they activate
      // a newer version.
      delegatorUrl: options.delegateUrl || options.delegatorUrl,
      indexerUrl: options.indexerUrl,
      esploraUrl: options.esploraUrl,
      watcherConfig: options.watcherConfig,
      messageTimeouts
    };
    await initializeMessageBus(
      options.serviceWorker,
      { ...busInitConfig, timeoutMs: options.messageBusTimeoutMs },
      options.messageBusTimeoutMs
    );
    const initMessage = {
      tag: messageTag,
      type: "INIT_WALLET",
      id: getRandomId(),
      payload: initWalletPayload
    };
    await wallet.sendMessage(initMessage);
    wallet.initConfig = busInitConfig;
    wallet.initWalletPayload = initWalletPayload;
    wallet.messageBusTimeoutMs = options.messageBusTimeoutMs;
    wallet.messageTimeouts = messageTimeouts;
    return wallet;
  }
  /**
   * Simplified setup method that handles service worker registration
   * and wallet initialization automatically.
   *
   * @see ServiceWorkerReadonlyWallet.create
   *
   * @example
   * ```typescript
   * const wallet = await ServiceWorkerReadonlyWallet.setup({
   *   serviceWorkerPath: '/service-worker.js',
   *   arkServerUrl: 'https://arkade.computer',
   *   identity: ReadonlySingleKey.fromPublicKey('your_public_key_hex')
   * });
   * ```
   */
  static async setup(options) {
    const serviceWorker = await setupServiceWorker({
      path: options.serviceWorkerPath,
      activationTimeoutMs: options.serviceWorkerActivationTimeoutMs
    });
    return await _ServiceWorkerReadonlyWallet.create({
      ...options,
      serviceWorker
    });
  }
  sendMessageDirect(request, timeoutMs) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeoutId);
        navigator.serviceWorker.removeEventListener("message", messageHandler);
      };
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(
          new ServiceWorkerTimeoutError(
            `Service worker message timed out (${request.type})`
          )
        );
      }, timeoutMs);
      const messageHandler = (event) => {
        const response = event.data;
        if (request.id !== response.id) {
          return;
        }
        cleanup();
        if (response.error) {
          reject(response.error);
        } else {
          resolve(response);
        }
      };
      navigator.serviceWorker.addEventListener("message", messageHandler);
      this.serviceWorker.postMessage(request);
    });
  }
  // Like sendMessageDirect but supports streaming responses: intermediate
  // messages are forwarded via onEvent while the promise resolves on the
  // first response for which isComplete returns true. No inactivity deadline:
  // settlement-class flows surrender control to remote peers and can sit
  // idle for long stretches between protocol events. Service-worker death
  // is detected out-of-band via concurrent short requests that surface
  // MESSAGE_BUS_NOT_INITIALIZED.
  sendMessageStreaming(request, onEvent, isComplete) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        navigator.serviceWorker.removeEventListener("message", messageHandler);
      };
      const messageHandler = (event) => {
        const response = event.data;
        if (request.id !== response.id) return;
        if (response.error) {
          cleanup();
          reject(response.error);
          return;
        }
        if (isComplete(response)) {
          cleanup();
          resolve(response);
        } else {
          onEvent(response);
        }
      };
      navigator.serviceWorker.addEventListener("message", messageHandler);
      this.serviceWorker.postMessage(request);
    });
  }
  async sendMessage(request) {
    if (!DEDUPABLE_REQUEST_TYPES.has(request.type)) {
      return this.sendMessageWithRetry(request);
    }
    const key = getRequestDedupKey(request);
    const existing = this.inflightRequests.get(key);
    if (existing) return existing;
    const promise = this.sendMessageWithRetry(request).finally(() => {
      this.inflightRequests.delete(key);
    });
    this.inflightRequests.set(key, promise);
    return promise;
  }
  pingServiceWorker() {
    if (this.pingPromise) return this.pingPromise;
    this.pingPromise = new Promise((resolve, reject) => {
      const pingId = getRandomId();
      const cleanup = () => {
        clearTimeout(timeoutId);
        navigator.serviceWorker.removeEventListener("message", onMessage);
      };
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new ServiceWorkerTimeoutError("Service worker ping timed out"));
      }, 2e3);
      const onMessage = (event) => {
        if (event.data?.id === pingId && event.data?.tag === "PONG") {
          cleanup();
          resolve();
        }
      };
      navigator.serviceWorker.addEventListener("message", onMessage);
      this.serviceWorker.postMessage({
        id: pingId,
        tag: "PING"
      });
    }).finally(() => {
      this.pingPromise = null;
    });
    return this.pingPromise;
  }
  // send a message, retrying up to 2 times if the service worker was
  // killed and restarted by the OS (mobile browsers do this aggressively)
  async sendMessageWithRetry(request) {
    if (this.initConfig) {
      try {
        await this.pingServiceWorker();
      } catch {
        await this.reinitialize();
      }
    }
    const timeoutMs = this.getTimeoutForRequest(request);
    const maxRetries = 2;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.sendMessageDirect(request, timeoutMs);
      } catch (error) {
        if (!isMessageBusNotInitializedError(error) || attempt >= maxRetries) {
          throw error;
        }
        await this.reinitialize();
      }
    }
  }
  // Like sendMessage but for streaming responses — retries with
  // reinitialize when the service worker has been killed/restarted.
  async sendMessageWithEvents(request, onEvent, isComplete) {
    if (this.initConfig) {
      try {
        await this.pingServiceWorker();
      } catch {
        await this.reinitialize();
      }
    }
    const maxRetries = 2;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.sendMessageStreaming(request, onEvent, isComplete);
      } catch (error) {
        if (!isMessageBusNotInitializedError(error) || attempt >= maxRetries) {
          throw error;
        }
        await this.reinitialize();
      }
    }
  }
  /**
   * Produce a serialized envelope for the wallet's identity. The base
   * class always emits a readonly envelope; `ServiceWorkerWallet`
   * overrides to emit a signing envelope.
   */
  async serializeIdentity() {
    return serializeReadonlyIdentity(this.identity);
  }
  /**
   * Return the cached init config, or rebuild one from live instance
   * state when the cache was never populated. Recovery path for
   * SDK-factory-created wallets; manual constructor bypasses do not
   * retain enough state here and will hit the "never initialized" throw.
   */
  async buildInitConfig() {
    if (this.initConfig) return this.initConfig;
    if (!this.arkServerUrl) {
      throw new Error("Cannot re-initialize: wallet was not initialized via the SDK factory");
    }
    const wallet = await this.serializeIdentity();
    this.initConfig = {
      wallet,
      arkServer: {
        url: this.arkServerUrl,
        publicKey: this.arkServerPublicKey
      },
      delegateUrl: this.delegateUrl || this.delegatorUrl,
      // Keep the deprecated field populated so pre-#519 service workers
      // (which only read delegatorUrl) keep delegating until they activate
      // a newer version.
      delegatorUrl: this.delegateUrl || this.delegatorUrl,
      indexerUrl: this.indexerUrl,
      esploraUrl: this.esploraUrl,
      watcherConfig: this.watcherConfig,
      settlementConfig: this.settlementConfig
    };
    return this.initConfig;
  }
  /** Minimal INIT_WALLET payload used on reinitialize when the cache is gone. */
  buildInitWalletPayload() {
    if (this.initWalletPayload) return this.initWalletPayload;
    if (!this.arkServerUrl) {
      throw new Error("Cannot re-initialize: wallet was not initialized via the SDK factory");
    }
    this.initWalletPayload = {
      // `key` is deprecated and ignored by the current handler.
      key: {},
      arkServerUrl: this.arkServerUrl,
      arkServerPublicKey: this.arkServerPublicKey
    };
    return this.initWalletPayload;
  }
  async reinitialize() {
    if (this.reinitPromise) return this.reinitPromise;
    this.reinitPromise = (async () => {
      const config = await this.buildInitConfig();
      const payload = this.buildInitWalletPayload();
      await initializeMessageBus(this.serviceWorker, config, this.messageBusTimeoutMs);
      const initMessage = {
        tag: this.messageTag,
        type: "INIT_WALLET",
        id: getRandomId(),
        payload
      };
      await this.sendMessageDirect(initMessage, this.getTimeoutForRequest(initMessage));
    })().finally(() => {
      this.reinitPromise = null;
    });
    return this.reinitPromise;
  }
  /** Clear cached wallet state from both the page and service worker storage. */
  async clear() {
    const message = {
      id: getRandomId(),
      tag: this.messageTag,
      type: "CLEAR"
    };
    try {
      const address = await this.getAddress();
      await this.walletRepository.deleteVtxos(address);
    } catch (_) {
      console.warn("Failed to clear vtxos from wallet repository");
    }
    await this.sendMessage(message);
  }
  async getAddress() {
    const message = {
      id: getRandomId(),
      tag: this.messageTag,
      type: "GET_ADDRESS"
    };
    try {
      const response = await this.sendMessage(message);
      return response.payload.address;
    } catch (error) {
      throw new Error(`Failed to get address: ${error}`);
    }
  }
  async getBoardingAddress() {
    const message = {
      id: getRandomId(),
      tag: this.messageTag,
      type: "GET_BOARDING_ADDRESS"
    };
    try {
      const response = await this.sendMessage(message);
      return response.payload.address;
    } catch (error) {
      throw new Error(`Failed to get boarding address: ${error}`);
    }
  }
  async getBalance() {
    const message = {
      id: getRandomId(),
      tag: this.messageTag,
      type: "GET_BALANCE"
    };
    try {
      const response = await this.sendMessage(message);
      return response.payload;
    } catch (error) {
      throw new Error(`Failed to get balance: ${error}`);
    }
  }
  async getBoardingUtxos() {
    const message = {
      id: getRandomId(),
      tag: this.messageTag,
      type: "GET_BOARDING_UTXOS"
    };
    try {
      const response = await this.sendMessage(message);
      return response.payload.utxos;
    } catch (error) {
      throw new Error(`Failed to get boarding UTXOs: ${error}`);
    }
  }
  /**
   * Return service-worker wallet status, including connectivity and sync state.
   *
   * @returns Current service-worker wallet status payload including `walletInitalized` and `xOnlyPublicKey`
   */
  async getStatus() {
    const message = {
      id: getRandomId(),
      tag: this.messageTag,
      type: "GET_STATUS"
    };
    try {
      const response = await this.sendMessage(message);
      return response.payload;
    } catch (error) {
      throw new Error(`Failed to get status: ${error}`);
    }
  }
  async getTransactionHistory() {
    const message = {
      id: getRandomId(),
      tag: this.messageTag,
      type: "GET_TRANSACTION_HISTORY"
    };
    try {
      const response = await this.sendMessage(message);
      return response.payload.transactions;
    } catch (error) {
      throw new Error(`Failed to get transaction history: ${error}`);
    }
  }
  async getVtxos(filter) {
    const message = {
      id: getRandomId(),
      tag: this.messageTag,
      type: "GET_VTXOS",
      payload: { filter }
    };
    try {
      const response = await this.sendMessage(message);
      return response.payload.vtxos;
    } catch (error) {
      throw new Error(`Failed to get vtxos: ${error}`);
    }
  }
  /**
   * Trigger a wallet reload inside the service worker.
   *
   * @returns `true` when the wallet was reloaded
   */
  async reload() {
    const message = {
      id: getRandomId(),
      tag: this.messageTag,
      type: "RELOAD_WALLET"
    };
    try {
      const response = await this.sendMessage(message);
      return response.payload.reloaded;
    } catch (error) {
      throw new Error(`Failed to reload wallet: ${error}`);
    }
  }
  async getContractManager() {
    const wallet = this;
    const sendContractMessage = async (message) => {
      return wallet.sendMessage(message);
    };
    const messageTag = this.messageTag;
    const manager = {
      async createContract(params) {
        const message = {
          type: "CREATE_CONTRACT",
          id: getRandomId(),
          tag: messageTag,
          payload: params
        };
        try {
          const response = await sendContractMessage(message);
          return response.payload.contract;
        } catch (e) {
          throw new Error("Failed to create contract");
        }
      },
      async getContracts(filter) {
        const message = {
          type: "GET_CONTRACTS",
          id: getRandomId(),
          tag: messageTag,
          payload: { filter }
        };
        try {
          const response = await sendContractMessage(message);
          return response.payload.contracts;
        } catch (e) {
          throw new Error("Failed to get contracts");
        }
      },
      async getContractsWithVtxos(filter) {
        const message = {
          type: "GET_CONTRACTS_WITH_VTXOS",
          id: getRandomId(),
          tag: messageTag,
          payload: { filter }
        };
        try {
          const response = await sendContractMessage(message);
          return response.payload.contracts;
        } catch (e) {
          throw new Error("Failed to get contracts with vtxos");
        }
      },
      async annotateVtxos(vtxos) {
        if (vtxos.length === 0) return [];
        const message = {
          type: "ANNOTATE_VTXOS",
          id: getRandomId(),
          tag: messageTag,
          payload: { vtxos }
        };
        try {
          const response = await sendContractMessage(message);
          return response.payload.vtxos;
        } catch (e) {
          throw new Error("Failed to annotate vtxos");
        }
      },
      async updateContract(script, updates) {
        const message = {
          type: "UPDATE_CONTRACT",
          id: getRandomId(),
          tag: messageTag,
          payload: { script, updates }
        };
        try {
          const response = await sendContractMessage(message);
          return response.payload.contract;
        } catch (e) {
          throw new Error("Failed to update contract");
        }
      },
      async setContractState(script, state) {
        const message = {
          type: "UPDATE_CONTRACT",
          id: getRandomId(),
          tag: messageTag,
          payload: { script, updates: { state } }
        };
        try {
          await sendContractMessage(message);
          return;
        } catch (e) {
          throw new Error("Failed to update contract state");
        }
      },
      async deleteContract(script) {
        const message = {
          type: "DELETE_CONTRACT",
          id: getRandomId(),
          tag: messageTag,
          payload: { script }
        };
        try {
          await sendContractMessage(message);
          return;
        } catch (e) {
          throw new Error("Failed to delete contract");
        }
      },
      async getSpendablePaths(options) {
        const message = {
          type: "GET_SPENDABLE_PATHS",
          id: getRandomId(),
          tag: messageTag,
          payload: { options }
        };
        try {
          const response = await sendContractMessage(message);
          return response.payload.paths;
        } catch (e) {
          throw new Error("Failed to get spendable paths");
        }
      },
      async getAllSpendingPaths(options) {
        const message = {
          type: "GET_ALL_SPENDING_PATHS",
          id: getRandomId(),
          tag: messageTag,
          payload: { options }
        };
        try {
          const response = await sendContractMessage(message);
          return response.payload.paths;
        } catch (e) {
          throw new Error("Failed to get all spending paths");
        }
      },
      onContractEvent(callback) {
        const messageHandler = (event) => {
          const response = event.data;
          if (response.type !== "CONTRACT_EVENT") {
            return;
          }
          if (response.tag !== messageTag) {
            return;
          }
          callback(response.payload.event);
        };
        navigator.serviceWorker.addEventListener("message", messageHandler);
        return () => {
          navigator.serviceWorker.removeEventListener("message", messageHandler);
        };
      },
      async refreshVtxos(opts) {
        const message = {
          type: "REFRESH_VTXOS",
          id: getRandomId(),
          tag: messageTag,
          payload: opts
        };
        await sendContractMessage(message);
      },
      async refreshOutpoints(outpoints) {
        const message = {
          type: "REFRESH_OUTPOINTS",
          id: getRandomId(),
          tag: messageTag,
          payload: { outpoints }
        };
        await sendContractMessage(message);
      },
      scanContracts() {
        return Promise.reject(
          new Error(
            "scanContracts is not available on the service-worker contract-manager proxy: its materialize() callback cannot be sent across the worker message boundary. Use the wallet's restore entrypoint instead."
          )
        );
      },
      async isWatching() {
        const message = {
          type: "IS_CONTRACT_MANAGER_WATCHING",
          id: getRandomId(),
          tag: messageTag
        };
        try {
          const response = await sendContractMessage(message);
          return response.payload.isWatching;
        } catch (e) {
          throw new Error("Failed to check if contract manager is watching");
        }
      },
      dispose() {
        return;
      },
      [Symbol.dispose]() {
        return;
      }
    };
    return manager;
  }
};
var ServiceWorkerWallet = class _ServiceWorkerWallet extends ServiceWorkerReadonlyWallet {
  constructor(serviceWorker, identity, walletRepository, contractRepository, messageTag, hasDelegate) {
    super(serviceWorker, identity, walletRepository, contractRepository, messageTag);
    this.serviceWorker = serviceWorker;
    this.identity = identity;
    this.walletRepository = walletRepository;
    this.contractRepository = contractRepository;
    this._assetManager = new ServiceWorkerAssetManager(
      (msg) => this.sendMessage(msg),
      messageTag
    );
    this.hasDelegate = hasDelegate;
  }
  walletRepository;
  contractRepository;
  identity;
  _assetManager;
  hasDelegate;
  get assetManager() {
    return this._assetManager;
  }
  async serializeIdentity() {
    return serializeSigningIdentity(this.identity);
  }
  static async create(options) {
    const walletRepository = options.storage?.walletRepository ?? new IndexedDBWalletRepository();
    const contractRepository = options.storage?.contractRepository ?? new IndexedDBContractRepository();
    if (!isSigningCapable(options.identity)) {
      throw new Error(
        "ServiceWorkerWallet.create() requires a signing Identity; got a ReadonlyIdentity"
      );
    }
    const identity = options.identity;
    const serializedWallet = serializeSigningIdentity(identity);
    const messageTag = options.walletUpdaterTag ?? DEFAULT_MESSAGE_TAG;
    const wallet = new _ServiceWorkerWallet(
      options.serviceWorker,
      identity,
      walletRepository,
      contractRepository,
      messageTag,
      !!(options.delegateUrl || options.delegatorUrl)
    );
    const legacyPrivateKey = serializedWallet.type === "single-key" ? serializedWallet.privateKey : null;
    const initWalletPayload = {
      key: legacyPrivateKey ? { privateKey: legacyPrivateKey } : {},
      arkServerUrl: getArkadeServerUrl(options),
      arkServerPublicKey: options.arkServerPublicKey,
      delegateUrl: options.delegateUrl || options.delegatorUrl,
      // Keep the deprecated field populated so pre-#519 service workers
      // (which only read delegatorUrl) keep delegating until they activate
      // a newer version.
      delegatorUrl: options.delegateUrl || options.delegatorUrl
    };
    const messageTimeouts = options.messageTimeouts ? {
      ...DEFAULT_MESSAGE_TIMEOUTS,
      ...options.messageTimeouts
    } : DEFAULT_MESSAGE_TIMEOUTS;
    const busInitConfig = {
      wallet: serializedWallet,
      arkServer: {
        url: getArkadeServerUrl(options),
        publicKey: options.arkServerPublicKey
      },
      delegateUrl: options.delegateUrl || options.delegatorUrl,
      // Keep the deprecated field populated so pre-#519 service workers
      // (which only read delegatorUrl) keep delegating until they activate
      // a newer version.
      delegatorUrl: options.delegateUrl || options.delegatorUrl,
      indexerUrl: options.indexerUrl,
      esploraUrl: options.esploraUrl,
      settlementConfig: options.settlementConfig,
      walletMode: options.walletMode,
      watcherConfig: options.watcherConfig,
      messageTimeouts
    };
    await initializeMessageBus(
      options.serviceWorker,
      { ...busInitConfig, timeoutMs: options.messageBusTimeoutMs },
      options.messageBusTimeoutMs
    );
    const initMessage = {
      tag: messageTag,
      type: "INIT_WALLET",
      id: getRandomId(),
      payload: initWalletPayload
    };
    await wallet.sendMessage(initMessage);
    wallet.initConfig = busInitConfig;
    wallet.initWalletPayload = initWalletPayload;
    wallet.messageBusTimeoutMs = options.messageBusTimeoutMs;
    wallet.messageTimeouts = messageTimeouts;
    return wallet;
  }
  /**
   * Simplified setup method that handles service worker registration
   * and wallet initialization automatically.
   *
   * @example
   * ```typescript
   * const wallet = await ServiceWorkerWallet.setup({
   *   serviceWorkerPath: '/service-worker.js',
   *   arkServerUrl: 'https://arkade.computer',
   *   identity: MnemonicIdentity.fromMnemonic('abandon abandon...')
   * });
   * ```
   */
  static async setup(options) {
    const serviceWorker = await setupServiceWorker({
      path: options.serviceWorkerPath,
      activationTimeoutMs: options.serviceWorkerActivationTimeoutMs
    });
    return _ServiceWorkerWallet.create({
      ...options,
      serviceWorker
    });
  }
  async sendBitcoin(params) {
    const message = {
      id: getRandomId(),
      tag: this.messageTag,
      type: "SEND_BITCOIN",
      payload: params
    };
    try {
      const response = await this.sendMessage(message);
      return response.payload.txid;
    } catch (error) {
      throw new Error(`Failed to send bitcoin: ${error}`);
    }
  }
  async settle(params, callback) {
    const message = {
      id: getRandomId(),
      tag: this.messageTag,
      type: "SETTLE",
      payload: { params }
    };
    try {
      const response = await this.sendMessageWithEvents(
        message,
        (resp) => callback?.(resp.payload),
        (resp) => resp.type === "SETTLE_SUCCESS"
      );
      return response.payload.txid;
    } catch (error) {
      throw new Error(`Settlement failed: ${error}`);
    }
  }
  /**
   * Explicitly recover this wallet's contracts and balance on a fresh repo.
   * Mirrors {@link Wallet.restore} but drives the scan inside the service
   * worker — the materialize() callback used by `scanContracts` cannot
   * cross the postMessage boundary, so the entire flow runs worker-side
   * and only the gapLimit / outcome cross the wire.
   *
   * Uses the streaming send path so the bus deadline does not race a
   * long indexer-bound scan. AggregateError thrown by the worker is
   * reconstructed here so callers can inspect `.errors`.
   */
  async restore(opts) {
    const message = {
      id: getRandomId(),
      tag: this.messageTag,
      type: "RESTORE_WALLET",
      payload: opts ?? {}
    };
    try {
      await this.sendMessageWithEvents(
        message,
        () => {
        },
        (resp) => resp.type === "RESTORE_WALLET_SUCCESS"
      );
    } catch (error) {
      if (isSerializedAggregateError(error)) {
        throw deserializeAggregateError(error);
      }
      throw error;
    }
  }
  async send(...recipients) {
    const message = {
      tag: this.messageTag,
      type: "SEND",
      id: getRandomId(),
      payload: { recipients }
    };
    try {
      const response = await this.sendMessage(message);
      return response.payload.txid;
    } catch (error) {
      throw new Error(`Send failed: ${error}`);
    }
  }
  async getDelegateManager() {
    if (!this.hasDelegate) {
      return void 0;
    }
    const wallet = this;
    const messageTag = this.messageTag;
    const manager = {
      async delegate(vtxos, destination, delegateAt) {
        const message = {
          tag: messageTag,
          type: "DELEGATE",
          id: getRandomId(),
          payload: {
            vtxoOutpoints: vtxos.map((v) => ({
              txid: v.txid,
              vout: v.vout
            })),
            destination,
            delegateAt: delegateAt?.getTime()
          }
        };
        try {
          const response = await wallet.sendMessage(message);
          const payload = response.payload;
          return {
            delegated: payload.delegated,
            failed: payload.failed.map((f) => ({
              outpoints: f.outpoints,
              error: f.error
            }))
          };
        } catch (error) {
          throw new Error(`Delegation failed: ${error}`);
        }
      },
      async getDelegateInfo() {
        const message = {
          type: "GET_DELEGATE_INFO",
          id: getRandomId(),
          tag: messageTag
        };
        try {
          const response = await wallet.sendMessage(message);
          return response.payload.info;
        } catch (e) {
          throw new Error("Failed to get delegate info");
        }
      }
    };
    return manager;
  }
  /** @deprecated alias for @see ServiceWorkerWallet.getDelegateManager */
  async getDelegatorManager() {
    return await this.getDelegateManager();
  }
  async getVtxoManager() {
    const wallet = this;
    const messageTag = this.messageTag;
    const manager = {
      async recoverVtxos(eventCallback) {
        const message = {
          tag: messageTag,
          type: "RECOVER_VTXOS",
          id: getRandomId()
        };
        try {
          const response = await wallet.sendMessageWithEvents(
            message,
            (resp) => eventCallback?.(resp.payload),
            (resp) => resp.type === "RECOVER_VTXOS_SUCCESS"
          );
          return response.payload.txid;
        } catch (e) {
          throw new Error(`Failed to recover vtxos: ${e}`);
        }
      },
      async getRecoverableBalance() {
        const message = {
          tag: messageTag,
          type: "GET_RECOVERABLE_BALANCE",
          id: getRandomId()
        };
        try {
          const response = await wallet.sendMessage(message);
          const payload = response.payload;
          return {
            recoverable: BigInt(payload.recoverable),
            subdust: BigInt(payload.subdust),
            includesSubdust: payload.includesSubdust,
            vtxoCount: payload.vtxoCount
          };
        } catch (e) {
          throw new Error(`Failed to get recoverable balance: ${e}`);
        }
      },
      async getExpiringVtxos(thresholdMs) {
        const message = {
          tag: messageTag,
          type: "GET_EXPIRING_VTXOS",
          id: getRandomId(),
          payload: { thresholdMs }
        };
        try {
          const response = await wallet.sendMessage(message);
          return response.payload.vtxos;
        } catch (e) {
          throw new Error(`Failed to get expiring vtxos: ${e}`);
        }
      },
      async renewVtxos(eventCallback, options) {
        const message = {
          tag: messageTag,
          type: "RENEW_VTXOS",
          id: getRandomId(),
          payload: options
        };
        try {
          const response = await wallet.sendMessageWithEvents(
            message,
            (resp) => eventCallback?.(resp.payload),
            (resp) => resp.type === "RENEW_VTXOS_SUCCESS"
          );
          return response.payload.txid;
        } catch (e) {
          throw new Error(`Failed to renew vtxos: ${e}`);
        }
      },
      async getExpiredBoardingUtxos() {
        const message = {
          tag: messageTag,
          type: "GET_EXPIRED_BOARDING_UTXOS",
          id: getRandomId()
        };
        try {
          const response = await wallet.sendMessage(message);
          return response.payload.utxos;
        } catch (e) {
          throw new Error(`Failed to get expired boarding utxos: ${e}`);
        }
      },
      async sweepExpiredBoardingUtxos() {
        const message = {
          tag: messageTag,
          type: "SWEEP_EXPIRED_BOARDING_UTXOS",
          id: getRandomId()
        };
        try {
          const response = await wallet.sendMessage(message);
          return response.payload.txid;
        } catch (e) {
          throw new Error(`Failed to sweep expired boarding utxos: ${e}`);
        }
      },
      async dispose() {
        return;
      }
    };
    return manager;
  }
};
var OnchainWallet = class _OnchainWallet {
  constructor(identity, network, onchainP2TR, provider) {
    this.identity = identity;
    this.network = network;
    this.onchainP2TR = onchainP2TR;
    this.provider = provider;
  }
  static MIN_FEE_RATE = 1;
  // sat/vbyte
  onchainP2TR;
  provider;
  network;
  /**
   * Create an onchain wallet for the given identity and Bitcoin network.
   *
   * @param identity - Identity used to derive the Taproot key and sign transactions
   * @param networkName - Bitcoin network name, @see NetworkName
   * @param provider - Optional onchain provider override, @see OnchainProvider
   * @returns Configured onchain wallet
   * @throws Error if the configured identity cannot produce a valid x-only public key
   */
  static async create(identity, networkName = DEFAULT_NETWORK_NAME, provider) {
    const pubkey = await identity.xOnlyPublicKey();
    if (!pubkey) {
      throw new Error("Invalid configured public key");
    }
    const network = getNetwork(networkName);
    const onchainProvider = provider || new EsploraProvider(ESPLORA_URL[networkName]);
    const onchainP2TR = p2tr(pubkey, void 0, network);
    return new _OnchainWallet(identity, network, onchainP2TR, onchainProvider);
  }
  get address() {
    return this.onchainP2TR.address || "";
  }
  /**
   * Fetch spendable onchain outputs for the wallet address.
   *
   * @returns Spendable onchain outputs for the wallet address
   * @see getBalance
   */
  async getCoins() {
    return this.provider.getCoins(this.address);
  }
  /**
   * Return the wallet's total onchain balance in satoshis.
   *
   * @returns Confirmed plus unconfirmed onchain balance
   * @see getCoins
   */
  async getBalance() {
    const coins = await this.getCoins();
    const onchainConfirmed = coins.filter((coin) => coin.status.confirmed).reduce((sum, coin) => sum + coin.value, 0);
    const onchainUnconfirmed = coins.filter((coin) => !coin.status.confirmed).reduce((sum, coin) => sum + coin.value, 0);
    const onchainTotal = onchainConfirmed + onchainUnconfirmed;
    return onchainTotal;
  }
  /**
   * Iteratively selects coins and estimates transaction fees until convergence.
   *
   * This method handles the circular dependency between output selection and fee
   * estimation: the fee depends on transaction size, which depends on the number
   * of inputs (selected outputs) and whether a change output is needed.
   *
   * The algorithm iterates up to 10 times, refining the fee estimate based on
   * the actual transaction structure. It resolves dust oscillation loops that
   * occur when the change amount hovers near the dust threshold—adding/removing
   * the change output causes the fee to fluctuate, preventing convergence.
   * When a lower fee is computed (indicating the change output was dropped),
   * the function accepts this state to guarantee termination.
   *
   * @param coins - Available onchain outputs to select from
   * @param amount - Target send amount in satoshis
   * @param feeRate - Fee rate in sat/vbyte
   * @param recipientAddress - Destination address for size estimation
   * @returns Selected inputs, change amount, and calculated fee
   * @throws Error if fee estimation fails to converge within max iterations
   */
  estimateFeesAndSelectCoins(coins, amount, feeRate, recipientAddress) {
    const MAX_ITERATIONS = 10;
    let fee = 0;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const totalNeeded = amount + fee;
      const selected = selectCoins(coins, totalNeeded);
      const estimator = TxWeightEstimator.create();
      for (const _ of selected.inputs) {
        estimator.addKeySpendInput();
      }
      estimator.addOutputAddress(recipientAddress, this.network);
      if (selected.changeAmount >= BigInt(DUST_AMOUNT)) {
        estimator.addOutputAddress(this.address, this.network);
      }
      const newFee = Number(estimator.vsize().value) * feeRate;
      const roundedNewFee = Math.ceil(newFee);
      if (roundedNewFee <= fee) {
        return { ...selected, fee: roundedNewFee };
      }
      fee = roundedNewFee;
    }
    throw new Error("Fee estimation failed: could not converge");
  }
  /**
   * Send bitcoin to a single onchain address.
   *
   * @param params - destination `address`, `amount` (in satoshis), and optional `feeRate` override (other fields ignored)
   * @returns Broadcast transaction id
   * @throws Error if the amount is non-positive, below dust, or cannot be funded
   * @see SendBitcoinParams
   */
  async send(params) {
    if (params.amount <= 0) {
      throw new Error("Amount must be positive");
    }
    if (params.amount < DUST_AMOUNT) {
      throw new Error("Amount is below dust limit");
    }
    const coins = await this.getCoins();
    let feeRate = params.feeRate;
    if (!feeRate) {
      feeRate = await this.provider.getFeeRate();
    }
    if (!feeRate || feeRate < _OnchainWallet.MIN_FEE_RATE) {
      feeRate = _OnchainWallet.MIN_FEE_RATE;
    }
    const { inputs, changeAmount } = this.estimateFeesAndSelectCoins(
      coins,
      params.amount,
      feeRate,
      params.address
    );
    if (!inputs) {
      throw new Error("Fee estimation failed");
    }
    let tx = new Transaction();
    for (const input of inputs) {
      tx.addInput({
        txid: input.txid,
        index: input.vout,
        witnessUtxo: {
          script: this.onchainP2TR.script,
          amount: BigInt(input.value)
        },
        tapInternalKey: this.onchainP2TR.tapInternalKey
      });
    }
    tx.addOutputAddress(params.address, BigInt(params.amount), this.network);
    if (changeAmount >= BigInt(DUST_AMOUNT)) {
      tx.addOutputAddress(this.address, changeAmount, this.network);
    }
    tx = await this.identity.sign(tx);
    tx.finalize();
    const txid = await this.provider.broadcastTransaction(tx.hex);
    return txid;
  }
  /**
   * CPFP-bump a parent transaction that contains a pay-to-anchor output.
   *
   * @param parent - Parent transaction containing a pay-to-anchor output
   * @returns Tuple of parent transaction id and child transaction id
   * @throws Error if the parent transaction has no pay-to-anchor output or bumping cannot be funded
   * @see send
   */
  async bumpP2A(parent) {
    const parentVsize = parent.vsize;
    let child = new Transaction({
      version: 3,
      allowLegacyWitnessUtxo: true
    });
    child.addInput(findP2AOutput(parent));
    const childVsize = TxWeightEstimator.create().addKeySpendInput(true).addP2AInput().addOutputAddress(this.address, this.network).vsize().value;
    const packageVSize = parentVsize + Number(childVsize);
    let feeRate = await this.provider.getFeeRate();
    if (!feeRate || feeRate < _OnchainWallet.MIN_FEE_RATE) {
      feeRate = _OnchainWallet.MIN_FEE_RATE;
    }
    const fee = Math.ceil(feeRate * packageVSize);
    if (!fee) {
      throw new Error(
        `invalid fee, got ${fee} with vsize ${packageVSize}, feeRate ${feeRate}`
      );
    }
    const coins = await this.getCoins();
    const selected = selectCoins(coins, fee, true);
    for (const input of selected.inputs) {
      child.addInput({
        txid: input.txid,
        index: input.vout,
        witnessUtxo: {
          script: this.onchainP2TR.script,
          amount: BigInt(input.value)
        },
        tapInternalKey: this.onchainP2TR.tapInternalKey
      });
    }
    child.addOutputAddress(this.address, P2A.amount + selected.changeAmount, this.network);
    child = await this.identity.sign(child);
    for (let i = 1; i < child.inputsLength; i++) {
      child.finalizeIdx(i);
    }
    try {
      await this.provider.broadcastTransaction(parent.hex, child.hex);
    } catch (error) {
      console.error(error);
    } finally {
      return [parent.hex, child.hex];
    }
  }
};
function selectCoins(coins, targetAmount, forceChange = false) {
  if (isNaN(targetAmount)) {
    throw new Error("Target amount is NaN, got " + targetAmount);
  }
  if (targetAmount < 0) {
    throw new Error("Target amount is negative, got " + targetAmount);
  }
  if (targetAmount === 0) {
    return { inputs: [], changeAmount: 0n };
  }
  const sortedCoins = [...coins].sort((a, b) => b.value - a.value);
  const selectedCoins = [];
  let selectedAmount = 0;
  for (const coin of sortedCoins) {
    selectedCoins.push(coin);
    selectedAmount += coin.value;
    if (forceChange ? selectedAmount > targetAmount : selectedAmount >= targetAmount) {
      break;
    }
  }
  if (selectedAmount === targetAmount) {
    return { inputs: selectedCoins, changeAmount: 0n };
  }
  if (selectedAmount < targetAmount) {
    throw new Error("Insufficient funds");
  }
  const changeAmount = BigInt(selectedAmount - targetAmount);
  return {
    inputs: selectedCoins,
    changeAmount
  };
}
var ELECTRUM_WS_URL = {
  bitcoin: "wss://electrum.arkade.sh",
  testnet: "wss://electrum.blockstream.info:60004",
  signet: "wss://electrum.signet.arkade.sh",
  mutinynet: "wss://electrum.mutinynet.arkade.sh",
  regtest: "ws://localhost:50003"
};
var ELECTRUM_TCP_HOST = {
  bitcoin: "electrum.arkade.sh",
  testnet: null,
  signet: "electrum.signet.arkade.sh",
  mutinynet: "electrum.mutinynet.arkade.sh",
  regtest: "localhost"
};
var BroadcastTransaction = "blockchain.transaction.broadcast";
var BroadcastPackageMethod = "blockchain.transaction.broadcast_package";
var EstimateFee = "blockchain.estimatefee";
var GetBlockHeader = "blockchain.block.header";
var GetHistoryMethod = "blockchain.scripthash.get_history";
var GetTransactionMethod = "blockchain.transaction.get";
var GetTransactionMerkleMethod = "blockchain.transaction.get_merkle";
var SubscribeStatusMethod = "blockchain.scripthash";
var SubscribeHeadersMethod = "blockchain.headers";
var GetRelayFeeMethod = "blockchain.relayfee";
var ListUnspentMethod = "blockchain.scripthash.listunspent";
var MISSING_TRANSACTION = "missingtransaction";
var MAX_FETCH_TRANSACTIONS_ATTEMPTS = 5;
var BLOCK_HEADER_SIZE = 80;
function parseBlockHeader(headerHex) {
  const headerBytes = hex.decode(headerHex);
  if (headerBytes.length !== BLOCK_HEADER_SIZE) {
    throw new Error(
      `Invalid block header size: ${headerBytes.length}, expected ${BLOCK_HEADER_SIZE}`
    );
  }
  const view2 = new DataView(headerBytes.buffer, headerBytes.byteOffset);
  const timestamp = view2.getUint32(68, true);
  const hash1 = sha256(headerBytes);
  const hash2 = sha256(hash1);
  const hashStr = hex.encode(new Uint8Array(hash2).reverse());
  return { hash: hashStr, timestamp };
}
var WsElectrumChainSource = class {
  constructor(ws, network) {
    this.ws = ws;
    this.network = network;
  }
  // Cached chain tip kept fresh by the headers subscription. Initialized
  // lazily on first call to subscribeHeaders().
  cachedTip = null;
  headersSubscribePromise = null;
  /**
   * Send N requests in parallel and aggregate the results, replacement
   * for `ws.batchRequest`. The library's batchRequest is implemented as
   * `Promise.all` over individual request promises — when one element
   * rejects, the others remain pending. When their (often error)
   * responses arrive later, the library rejects them too, and nobody is
   * awaiting them: the rejections become unhandled and crash the test
   * runner / pollute production logs.
   *
   * `safeBatchRequest` issues each request through `ws.request` (so each
   * has its own request-promise lifecycle), waits for all of them via
   * `Promise.allSettled` (every promise gets an explicit handler), and
   * then surfaces the first error if any failed. Same wall-clock cost
   * as the library's batch (parallel send), no orphan rejections.
   *
   * Use this in place of `ws.batchRequest` for any call where one or
   * more elements may legitimately error (e.g. electrs index lag
   * surfacing as `missingheight` for a subset of heights/txids).
   */
  async safeBatchRequest(requests) {
    if (requests.length === 0) return [];
    const settled = await Promise.allSettled(
      requests.map(
        (req) => this.ws.request(
          req.method,
          ...req.params
        )
      )
    );
    for (const r of settled) {
      if (r.status === "rejected") throw r.reason;
    }
    return settled.map((r) => r.value);
  }
  async fetchTransactions(txids) {
    const requests = txids.map((txid) => ({
      method: GetTransactionMethod,
      params: [txid]
    }));
    for (let i = 0; i < MAX_FETCH_TRANSACTIONS_ATTEMPTS; i++) {
      try {
        const responses = await this.safeBatchRequest(requests);
        return responses.map((hexStr, i2) => ({
          txID: txids[i2],
          hex: hexStr
        }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.toLowerCase().includes(MISSING_TRANSACTION)) {
          console.warn("missing transaction error, retrying");
          await new Promise((resolve) => setTimeout(resolve, 1e3));
          continue;
        }
        throw e;
      }
    }
    throw new Error("Unable to fetch transactions: " + txids);
  }
  async fetchVerboseTransaction(txid) {
    return this.ws.request(GetTransactionMethod, txid, true);
  }
  async fetchVerboseTransactions(txids) {
    if (txids.length === 0) return [];
    const requests = txids.map((txid) => ({
      method: GetTransactionMethod,
      params: [txid, true]
    }));
    return this.safeBatchRequest(requests);
  }
  /**
   * Look up the block height of a confirmed transaction without relying
   * on the verbose-tx endpoint. `blockchain.transaction.get_merkle` is
   * part of the standard SPV protocol and is supported by both Fulcrum
   * and electrs (whereas `blockchain.transaction.get` with verbose=true
   * is Fulcrum-only). Returns `null` when the tx is in the mempool —
   * electrs in that case rejects with a "not yet in a block" error.
   */
  async fetchTxMerkle(txid) {
    let result;
    try {
      result = await this.ws.request(
        GetTransactionMerkleMethod,
        txid
      );
    } catch (err) {
      if (isTxNotInBlockError(err) || isMissingHeightError(err)) return null;
      throw err;
    }
    if (!result || typeof result.block_height !== "number" || result.block_height <= 0) {
      return null;
    }
    return { blockHeight: result.block_height };
  }
  async unsubscribeScriptStatus(script) {
    await this.ws.unsubscribe(SubscribeStatusMethod, toScriptHash(script)).catch(() => {
    });
  }
  async subscribeScriptStatus(script, callback) {
    const scriptHash = toScriptHash(script);
    await this.ws.subscribe(
      SubscribeStatusMethod,
      (scripthash, status) => {
        if (scripthash === scriptHash) {
          callback(scripthash, status);
        }
      },
      scriptHash
    );
  }
  async fetchHistories(scripts) {
    const scriptsHashes = scripts.map((s) => toScriptHash(s));
    return this.safeBatchRequest(
      scriptsHashes.map((s) => ({
        method: GetHistoryMethod,
        params: [s]
      }))
    );
  }
  async fetchHistory(script) {
    const scriptHash = toScriptHash(script);
    return this.ws.request(GetHistoryMethod, scriptHash);
  }
  async fetchBlockHeaders(heights) {
    const responses = await this.safeBatchRequest(
      heights.map((h) => ({ method: GetBlockHeader, params: [h] }))
    );
    return responses.map((hexStr, i) => ({
      height: heights[i],
      hex: hexStr
    }));
  }
  async fetchBlockHeader(height) {
    const headerHex = await this.ws.request(GetBlockHeader, height);
    return { height, hex: headerHex };
  }
  /**
   * Returns the current chain tip and keeps it fresh via a single
   * server-side subscription. Subsequent calls return the cached tip
   * (updated by background notifications) without round-tripping to the
   * server. Previously each call issued `blockchain.headers.subscribe` as
   * a regular request, leaving a stale subscription on the server every
   * time — under polling that adds up. ws-electrumx-client deduplicates
   * `subscribe()` by method+params, so registering once is enough.
   */
  async subscribeHeaders() {
    if (this.cachedTip) return this.cachedTip;
    if (this.headersSubscribePromise) return this.headersSubscribePromise;
    this.headersSubscribePromise = new Promise((resolve, reject) => {
      let resolved = false;
      this.ws.subscribe(SubscribeHeadersMethod, (header) => {
        if (!isHeaderSubscribeResult(header)) return;
        this.cachedTip = header;
        if (!resolved) {
          resolved = true;
          resolve(header);
        }
      }).catch((err) => {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
    });
    try {
      return await this.headersSubscribePromise;
    } catch (err) {
      this.headersSubscribePromise = null;
      throw err;
    }
  }
  async estimateFees(targetNumberBlocks) {
    const feeRate = await this.ws.request(EstimateFee, targetNumberBlocks);
    return feeRate;
  }
  async broadcastTransaction(txHex) {
    return this.ws.request(BroadcastTransaction, txHex);
  }
  /**
   * Submit a package of raw transactions atomically via Fulcrum's
   * `blockchain.transaction.broadcast_package` method, the on-the-wire
   * equivalent of bitcoind's `submitpackage` RPC.
   *
   * Required for TRUC (BIP 431) 1P1C relay where the parent has zero
   * (or below-minfee) fee and depends on the child to pay for both via
   * CPFP — sequential broadcast cannot work in that case because the
   * parent would be rejected from the mempool on its own.
   *
   * @param txHexes - Topologically sorted raw transactions; child must
   *                  be the last element. Currently must be a 1P1C pair
   *                  (length 2). Parents may not depend on each other.
   * @returns The child transaction id (the last entry in the array),
   *          computed locally — `broadcast_package` itself returns
   *          `{success, errors}` rather than a txid.
   * @throws If the server does not implement `broadcast_package` (e.g.
   *         ElectrumX, or older Fulcrum, or Fulcrum backed by bitcoind
   *         < v28.0.0). Callers must surface this clearly to users —
   *         this method does NOT silently fall back to sequential
   *         broadcasts because doing so would let TRUC packages fail
   *         in subtle ways.
   * @throws If the server returns `success=false`, surfacing the
   *         underlying mempool rejection in the error message.
   */
  async broadcastPackage(txHexes) {
    const result = await this.ws.request(
      BroadcastPackageMethod,
      txHexes,
      false
    );
    if (!result.success) {
      const detail = result.errors ? JSON.stringify(result.errors) : "unknown error";
      throw new Error(`Package broadcast rejected: ${detail}`);
    }
    return childTxidFromHex(txHexes[txHexes.length - 1]);
  }
  async getRelayFee() {
    return this.ws.request(GetRelayFeeMethod);
  }
  async close() {
    try {
      await this.ws.close("close");
    } catch (e) {
      console.debug("error closing ws:", e);
    }
  }
  waitForAddressReceivesTx(addr) {
    return new Promise((resolve, reject) => {
      const script = OutScript.encode(Address(this.network).decode(addr));
      this.subscribeScriptStatus(script, (_, status) => {
        if (status !== null) {
          resolve();
        }
      }).catch(reject);
    });
  }
  async listUnspents(addr) {
    const script = OutScript.encode(Address(this.network).decode(addr));
    const scriptHash = toScriptHash(script);
    const unspentsFromElectrum = await this.ws.request(
      ListUnspentMethod,
      scriptHash
    );
    const txs = await this.fetchTransactions(unspentsFromElectrum.map((u) => u.tx_hash));
    return unspentsFromElectrum.map((u, index) => {
      const tx = Transaction$2.fromRaw(hex.decode(txs[index].hex), {
        allowUnknownOutputs: true
      });
      const output = tx.getOutput(u.tx_pos);
      if (!output.script || output.amount === void 0) {
        throw new Error(`Missing output data for ${u.tx_hash}:${u.tx_pos}`);
      }
      return {
        txid: u.tx_hash,
        vout: u.tx_pos,
        witnessUtxo: {
          script: output.script,
          value: output.amount
        }
      };
    });
  }
  /**
   * Get the address string for a script output, if decodable.
   */
  addressForScript(scriptHex) {
    try {
      const script = hex.decode(scriptHex);
      return Address(this.network).encode(OutScript.decode(script));
    } catch {
      return void 0;
    }
  }
};
var ElectrumOnchainProvider = class {
  constructor(ws, network) {
    this.ws = ws;
    this.network = network;
    this.chain = new WsElectrumChainSource(ws, network);
  }
  chain;
  async getCoins(address) {
    const script = this.encodeAddress(address);
    const scriptHash = toScriptHash(script);
    const unspents = await this.ws.request(ListUnspentMethod, scriptHash);
    return unspents.map((u) => ({
      txid: u.tx_hash,
      vout: u.tx_pos,
      value: u.value,
      status: {
        confirmed: u.height > 0,
        block_height: u.height > 0 ? u.height : void 0
      }
    }));
  }
  async getFeeRate() {
    const feePerKb = await this.chain.estimateFees(1);
    if (feePerKb < 0) {
      return void 0;
    }
    return Math.max(1, Math.ceil(feePerKb * 1e5));
  }
  /**
   * Broadcast a single transaction or a TRUC (BIP 431) 1P1C package
   * atomically.
   *
   * **Server requirements for 1P1C packages:** the backing Electrum
   * server must implement `blockchain.transaction.broadcast_package`
   * (Fulcrum ≥ 1.10) and be backed by bitcoind ≥ v28.0.0. ElectrumX
   * does not implement this method. There is **no fallback** to
   * sequential parent-then-child broadcast: TRUC packages typically
   * have a zero-fee parent and would be rejected from the mempool on
   * their own, so a fallback would silently fail in subtle ways.
   * Callers receiving a "method not found" error here should route
   * through a different provider for that submission.
   *
   * @param txs - One transaction (single broadcast) or two
   *              topologically-sorted transactions (parent first,
   *              child last) for 1P1C package relay.
   * @returns The broadcast txid (or the child txid for 1P1C packages).
   */
  async broadcastTransaction(...txs) {
    if (txs.length === 1) {
      return this.chain.broadcastTransaction(txs[0]);
    }
    if (txs.length === 2) {
      return this.chain.broadcastPackage(txs);
    }
    throw new Error("Only 1 or 1P1C package can be broadcast");
  }
  async getTxOutspends(txid) {
    const [txResult] = await this.chain.fetchTransactions([txid]);
    const tx = Transaction$2.fromRaw(hex.decode(txResult.hex), {
      allowUnknownOutputs: true
    });
    const outputCount = tx.outputsLength;
    const outputScriptHashes = [];
    for (let i = 0; i < outputCount; i++) {
      const output = tx.getOutput(i);
      outputScriptHashes.push(output.script ? toScriptHash(output.script) : void 0);
    }
    const validScriptHashes = outputScriptHashes.filter((h) => h !== void 0);
    const results = Array.from(
      { length: outputCount },
      () => ({ spent: false, txid: "" })
    );
    if (validScriptHashes.length === 0) return results;
    const unspentBatch = await this.chain.safeBatchRequest(
      validScriptHashes.map((sh) => ({
        method: ListUnspentMethod,
        params: [sh]
      }))
    );
    const unspentSet = /* @__PURE__ */ new Set();
    let validIdx = 0;
    for (let i = 0; i < outputCount; i++) {
      if (outputScriptHashes[i] !== void 0) {
        for (const u of unspentBatch[validIdx]) {
          unspentSet.add(`${u.tx_hash}:${u.tx_pos}`);
        }
        validIdx++;
      }
    }
    const spentIndices = [];
    const spentScriptHashes = [];
    for (let i = 0; i < outputCount; i++) {
      const sh = outputScriptHashes[i];
      if (sh && !unspentSet.has(`${txid}:${i}`)) {
        spentIndices.push(i);
        spentScriptHashes.push(sh);
      }
    }
    if (spentIndices.length === 0) return results;
    const histories = await this.chain.safeBatchRequest(
      spentScriptHashes.map((sh) => ({
        method: GetHistoryMethod,
        params: [sh]
      }))
    );
    const ambiguousIndices = [];
    const ambiguousCandidates = [];
    for (let j = 0; j < spentIndices.length; j++) {
      const i = spentIndices[j];
      const candidates = histories[j].map((h) => h.tx_hash).filter((hash) => hash !== txid);
      if (candidates.length === 1) {
        results[i] = { spent: true, txid: candidates[0] };
      } else if (candidates.length > 1) {
        ambiguousIndices.push(i);
        ambiguousCandidates.push(candidates);
      }
    }
    if (ambiguousIndices.length > 0) {
      const allCandidateTxids = [...new Set(ambiguousCandidates.flat())];
      const fetched = await this.chain.fetchTransactions(allCandidateTxids);
      const txMap = new Map(fetched.map((t) => [t.txID, t.hex]));
      for (let j = 0; j < ambiguousIndices.length; j++) {
        const i = ambiguousIndices[j];
        for (const candidateTxid of ambiguousCandidates[j]) {
          const rawHex = txMap.get(candidateTxid);
          if (!rawHex) continue;
          const candidateTx = Transaction$2.fromRaw(hex.decode(rawHex), {
            allowUnknownOutputs: true,
            allowUnknownInputs: true
          });
          let found = false;
          for (let k = 0; k < candidateTx.inputsLength; k++) {
            const input = candidateTx.getInput(k);
            if (input.txid && hex.encode(input.txid) === txid && input.index === i) {
              results[i] = { spent: true, txid: candidateTxid };
              found = true;
              break;
            }
          }
          if (found) break;
        }
      }
    }
    return results;
  }
  async getTransactions(address) {
    const script = this.encodeAddress(address);
    const history = await this.chain.fetchHistory(script);
    if (history.length === 0) return [];
    return this.historyToExplorerTxs(history);
  }
  /**
   * Resolve a list of `{tx_hash, height}` entries (as returned by the
   * scripthash history endpoint) into ExplorerTransaction shape **without
   * using the verbose-tx endpoint**, which only Fulcrum implements. We
   * reconstruct everything the verbose response would have given us:
   *   - vouts ← parse the raw tx (exact sat amounts, no float precision risk)
   *   - block_time ← batch-fetch the block headers for the heights present
   *   - addresses ← decode each output's scriptPubKey via @scure/btc-signer
   */
  async historyToExplorerTxs(history) {
    const txids = history.map((h) => h.tx_hash);
    const rawTxs = await this.chain.fetchTransactions(txids);
    const rawHexByTxid = new Map(rawTxs.map((t) => [t.txID, t.hex]));
    const confirmedHeights = [...new Set(history.map((h) => h.height).filter((h) => h > 0))];
    const blockTimeByHeight = /* @__PURE__ */ new Map();
    if (confirmedHeights.length > 0) {
      try {
        const headers = await this.chain.fetchBlockHeaders(confirmedHeights);
        for (const header of headers) {
          blockTimeByHeight.set(header.height, parseBlockHeader(header.hex).timestamp);
        }
      } catch {
        const settled = await Promise.allSettled(
          confirmedHeights.map((h) => this.chain.fetchBlockHeader(h))
        );
        settled.forEach((res) => {
          if (res.status === "fulfilled") {
            blockTimeByHeight.set(
              res.value.height,
              parseBlockHeader(res.value.hex).timestamp
            );
          }
        });
      }
    }
    return history.map(
      (entry) => this.buildExplorerTx(entry, rawHexByTxid.get(entry.tx_hash), blockTimeByHeight)
    );
  }
  /**
   * Build an ExplorerTransaction from a history entry plus the raw tx hex
   * (when known) and a height→block_time map. Parse errors propagate —
   * silently returning an empty vout would hide real outputs (e.g. a
   * deposit) and is far worse for protocol-level money handling than
   * failing the whole batch.
   */
  buildExplorerTx(entry, rawHex, blockTimeByHeight) {
    const vout = [];
    if (rawHex) {
      let tx;
      try {
        tx = Transaction$2.fromRaw(hex.decode(rawHex), {
          allowUnknownOutputs: true,
          allowUnknownInputs: true
        });
      } catch (err) {
        throw new Error(
          `Failed to parse raw tx for ${entry.tx_hash}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      for (let i = 0; i < tx.outputsLength; i++) {
        const output = tx.getOutput(i);
        const scriptHex = output.script ? hex.encode(output.script) : "";
        vout.push({
          scriptpubkey_address: scriptHex ? this.chain.addressForScript(scriptHex) ?? "" : "",
          value: (output.amount ?? 0n).toString()
        });
      }
    }
    return {
      txid: entry.tx_hash,
      vout,
      status: {
        confirmed: entry.height > 0,
        block_time: blockTimeByHeight.get(entry.height) ?? 0
      }
    };
  }
  /**
   * Decode `address` into its scriptPubKey, throwing a clear error if the
   * input is malformed. @scure/btc-signer raises a generic decode error
   * which is hard to map back to user input — this wraps it.
   */
  encodeAddress(address) {
    try {
      return OutScript.encode(Address(this.network).decode(address));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid address ${address}: ${reason}`);
    }
  }
  async getTxStatus(txid) {
    const merkle = await this.chain.fetchTxMerkle(txid);
    if (!merkle) return { confirmed: false };
    let blockTime = 0;
    try {
      const header = await this.chain.fetchBlockHeader(merkle.blockHeight);
      blockTime = parseBlockHeader(header.hex).timestamp;
    } catch (err) {
      if (!isMissingHeightError(err)) throw err;
    }
    return {
      confirmed: true,
      blockHeight: merkle.blockHeight,
      blockTime
    };
  }
  async getChainTip() {
    const tip = await this.chain.subscribeHeaders();
    const { hash, timestamp } = parseBlockHeader(tip.hex);
    return {
      height: tip.height,
      time: timestamp,
      hash
    };
  }
  async watchAddresses(addresses, eventCallback) {
    const scripts = addresses.map((addr) => this.encodeAddress(addr));
    const scriptHashes = scripts.map(toScriptHash);
    const scriptByHash = new Map(
      scriptHashes.map((h, i) => [h, scripts[i]])
    );
    const knownTxids = /* @__PURE__ */ new Map();
    const initialHistories = await Promise.all(scripts.map((s) => this.chain.fetchHistory(s)));
    initialHistories.forEach((history, i) => {
      knownTxids.set(scriptHashes[i], new Set(history.map((h) => h.tx_hash)));
    });
    const inFlight = /* @__PURE__ */ new Map();
    const processStatusChange = async (scripthash) => {
      const script = scriptByHash.get(scripthash);
      if (!script) return;
      const history = await this.chain.fetchHistory(script);
      const known = knownTxids.get(scripthash) ?? /* @__PURE__ */ new Set();
      const newEntries = history.filter((entry) => !known.has(entry.tx_hash));
      if (newEntries.length === 0) return;
      const explorerTxs = await this.historyToExplorerTxs(newEntries);
      eventCallback(explorerTxs);
      for (const entry of newEntries) known.add(entry.tx_hash);
      knownTxids.set(scripthash, known);
    };
    const handleStatusChange = (scripthash) => {
      const previous = inFlight.get(scripthash) ?? Promise.resolve();
      const next = previous.then(() => processStatusChange(scripthash));
      inFlight.set(
        scripthash,
        next.catch(() => void 0)
      );
      return next;
    };
    const subscribed = [];
    try {
      await Promise.all(
        scripts.map(async (script) => {
          await this.chain.subscribeScriptStatus(script, (scripthash, status) => {
            if (status !== null) {
              handleStatusChange(scripthash).catch(console.error);
            }
          });
          subscribed.push(script);
        })
      );
    } catch (err) {
      await Promise.allSettled(subscribed.map((s) => this.chain.unsubscribeScriptStatus(s)));
      throw err;
    }
    return () => {
      for (const script of scripts) {
        this.chain.unsubscribeScriptStatus(script).catch(() => {
        });
      }
    };
  }
  /** Close the underlying WebSocket connection. */
  async close() {
    await this.chain.close();
  }
};
function toScriptHash(script) {
  return hex.encode(sha256(script).reverse());
}
function isHeaderSubscribeResult(v) {
  if (typeof v !== "object" || v === null) return false;
  const obj = v;
  return typeof obj.height === "number" && typeof obj.hex === "string";
}
function isMissingHeightError(err) {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return msg.toLowerCase().includes("missingheight");
}
function isTxNotInBlockError(err) {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const normalized = msg.toLowerCase();
  return normalized.includes("not yet in a block") || normalized.includes("not in a block") || normalized.includes("not in block") || normalized.includes("no confirmed transaction");
}
function childTxidFromHex(txHex) {
  const tx = Transaction$2.fromRaw(hex.decode(txHex), {
    allowUnknownOutputs: true,
    allowUnknownInputs: true
  });
  return tx.id;
}
var TAG_BIP322 = "BIP0322-signed-message";
var BIP322;
((BIP3222) => {
  async function sign2(message, identity, network) {
    const xOnlyPubKey = await identity.xOnlyPublicKey();
    const payment = p2tr(xOnlyPubKey, void 0, network);
    const toSpend = craftToSpendTx(message, payment.script, TAG_BIP322);
    const toSign = craftBIP322ToSignP2TR(toSpend, payment.script, xOnlyPubKey);
    const signed = await identity.sign(toSign, [0]);
    signed.finalizeIdx(0);
    const input = signed.getInput(0);
    if (!input.finalScriptWitness) {
      throw new Error("BIP-322: failed to produce witness after signing");
    }
    return base64.encode(RawWitness.encode(input.finalScriptWitness));
  }
  BIP3222.sign = sign2;
  function verify(message, signature, address, network) {
    let decoded;
    try {
      decoded = Address(network).decode(address);
    } catch {
      return false;
    }
    if (decoded.type === "pkh") {
      try {
        return verifyLegacy(message, base64.decode(signature), decoded.hash);
      } catch {
        return false;
      }
    }
    let pkScript;
    let witnessItems;
    try {
      pkScript = OutScript.encode(decoded);
      witnessItems = RawWitness.decode(base64.decode(signature));
    } catch {
      return false;
    }
    if (witnessItems.length === 0) {
      return false;
    }
    if (decoded.type === "tr") {
      return verifyP2TR(message, witnessItems, pkScript, decoded.pubkey);
    }
    if (decoded.type === "wpkh") {
      return verifyP2WPKH(message, witnessItems, pkScript, decoded.hash);
    }
    throw new Error(`BIP-322 verify: unsupported address type '${decoded.type}'`);
  }
  BIP3222.verify = verify;
})(BIP322 || (BIP322 = {}));
function verifyP2TR(message, witnessItems, pkScript, pubkey) {
  if (witnessItems.length !== 1) {
    return false;
  }
  const sig = witnessItems[0];
  if (sig.length !== 64 && sig.length !== 65) {
    return false;
  }
  const sighashType = sig.length === 65 ? sig[64] : SigHash.DEFAULT;
  if (sighashType !== SigHash.DEFAULT && sighashType !== SigHash.ALL) {
    return false;
  }
  const toSpend = craftToSpendTx(message, pkScript, TAG_BIP322);
  const toSign = craftBIP322ToSignP2TR(toSpend, pkScript, pubkey);
  const sighash = toSign.preimageWitnessV1(0, [pkScript], sighashType, [0n]);
  const rawSig = sig.length === 65 ? sig.subarray(0, 64) : sig;
  return schnorr.verify(rawSig, sighash, pubkey);
}
function verifyP2WPKH(message, witnessItems, pkScript, addressHash) {
  if (witnessItems.length !== 2) {
    return false;
  }
  const sigWithHash = witnessItems[0];
  const pubkey = witnessItems[1];
  if (pubkey.length !== 33 || sigWithHash.length < 2) {
    return false;
  }
  const derived = p2wpkh(pubkey);
  if (!equalBytes(derived.hash, addressHash)) {
    return false;
  }
  const sighashType = sigWithHash[sigWithHash.length - 1];
  const derSig = sigWithHash.subarray(0, sigWithHash.length - 1);
  const toSpend = craftToSpendTx(message, pkScript, TAG_BIP322);
  const toSign = craftBIP322ToSignSimple(toSpend, pkScript);
  const scriptCode = OutScript.encode({ type: "pkh", hash: addressHash });
  const sighash = toSign.preimageWitnessV0(0, scriptCode, sighashType, 0n);
  return secp256k1.verify(derSig, sighash, pubkey, {
    prehash: false,
    format: "der"
  });
}
function verifyLegacy(message, sigBytes, addressHash) {
  if (sigBytes.length !== 65) {
    return false;
  }
  const flag = sigBytes[0];
  if (flag < 27 || flag > 34) {
    return false;
  }
  const compressed = flag >= 31;
  const recoveryId = compressed ? flag - 31 : flag - 27;
  const compactSig = sigBytes.subarray(1, 65);
  const msgHash = bitcoinMessageHash(message);
  try {
    const sig = secp256k1.Signature.fromBytes(compactSig, "compact").addRecoveryBit(recoveryId);
    const point = sig.recoverPublicKey(msgHash);
    const pubkeyBytes = point.toBytes(compressed);
    return equalBytes(hash160(pubkeyBytes), addressHash);
  } catch {
    return false;
  }
}
function bitcoinMessageHash(message) {
  const MAGIC = new TextEncoder().encode("Bitcoin Signed Message:\n");
  const msgBytes = new TextEncoder().encode(message);
  return sha256x2(concatBytes(MAGIC, encodeCompactSize(msgBytes.length), msgBytes));
}
function encodeCompactSize(n) {
  if (n < 253) return new Uint8Array([n]);
  if (n <= 65535) {
    const buf2 = new Uint8Array(3);
    buf2[0] = 253;
    buf2[1] = n & 255;
    buf2[2] = n >> 8 & 255;
    return buf2;
  }
  const buf = new Uint8Array(5);
  buf[0] = 254;
  buf[1] = n & 255;
  buf[2] = n >> 8 & 255;
  buf[3] = n >> 16 & 255;
  buf[4] = n >> 24 & 255;
  return buf;
}
function craftBIP322ToSignP2TR(toSpend, pkScript, tapInternalKey) {
  const tx = new Transaction({ version: 0 });
  tx.addInput({
    txid: toSpend.id,
    index: 0,
    sequence: 0,
    witnessUtxo: {
      script: pkScript,
      amount: 0n
    },
    tapInternalKey,
    sighashType: SigHash.DEFAULT
  });
  tx.addOutput({
    amount: 0n,
    script: OP_RETURN_EMPTY_PKSCRIPT
  });
  return tx;
}
function craftBIP322ToSignSimple(toSpend, pkScript) {
  const tx = new Transaction({ version: 0 });
  tx.addInput({
    txid: toSpend.id,
    index: 0,
    sequence: 0,
    witnessUtxo: {
      script: pkScript,
      amount: 0n
    }
  });
  tx.addOutput({
    amount: 0n,
    script: OP_RETURN_EMPTY_PKSCRIPT
  });
  return tx;
}

// src/providers/emulator.ts
var RestEmulatorProvider = class {
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
  }
  async getInfo() {
    const url = `${this.serverUrl}/v1/info`;
    const response = await fetch(url);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get emulator info: ${errorText}`);
    }
    const data = await response.json();
    const signerPubkey = data.signerPubkey;
    if (typeof signerPubkey !== "string" || !signerPubkey) {
      throw new Error("Invalid emulator info response: missing signerPubkey");
    }
    return {
      version: data.version ?? "",
      signerPubkey
    };
  }
  async submitTx(arkTx, checkpointTxs) {
    const url = `${this.serverUrl}/v1/tx`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        arkTx,
        checkpointTxs
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to submit tx to emulator: ${errorText}`);
    }
    const data = await response.json();
    if (typeof data.signedArkTx !== "string" || !data.signedArkTx) {
      throw new Error("Invalid emulator submitTx response: missing signedArkTx");
    }
    if (!Array.isArray(data.signedCheckpointTxs) || !data.signedCheckpointTxs.every((item) => typeof item === "string")) {
      throw new Error(
        "Invalid emulator submitTx response: signedCheckpointTxs must be an array of strings"
      );
    }
    return {
      signedArkTx: data.signedArkTx,
      signedCheckpointTxs: data.signedCheckpointTxs
    };
  }
  async submitIntent(intent) {
    const url = `${this.serverUrl}/v1/intent`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: {
          proof: intent.proof,
          message: JSON.stringify(intent.message)
        }
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to submit intent to emulator: ${errorText}`);
    }
    const data = await response.json();
    if (typeof data.signedProof !== "string" || !data.signedProof) {
      throw new Error("Invalid emulator submitIntent response: missing signedProof");
    }
    return data.signedProof;
  }
  async submitFinalization(intent, forfeits, connectorTree, commitmentTx) {
    const url = `${this.serverUrl}/v1/finalization`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Uses "signedIntent" (not "intent") because the proof was already
      // co-signed by the emulator via submitIntent in a prior step.
      body: JSON.stringify({
        signedIntent: {
          proof: intent.proof,
          message: JSON.stringify(intent.message)
        },
        forfeits,
        connectorTree,
        commitmentTx
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to submit finalization to emulator: ${errorText}`);
    }
    const data = await response.json();
    if (!Array.isArray(data.signedForfeits) || !data.signedForfeits.every((item) => typeof item === "string")) {
      throw new Error(
        "Invalid emulator submitFinalization response: signedForfeits must be an array of strings"
      );
    }
    if ("signedCommitmentTx" in data && typeof data.signedCommitmentTx !== "string") {
      throw new Error(
        "Invalid emulator submitFinalization response: invalid signedCommitmentTx"
      );
    }
    return {
      signedForfeits: data.signedForfeits,
      signedCommitmentTx: data.signedCommitmentTx
    };
  }
  async submitOnchainTx(tx) {
    const url = `${this.serverUrl}/v1/onchain-tx`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx })
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to submit onchain tx to emulator: ${errorText}`);
    }
    const data = await response.json();
    if (typeof data.signedTx !== "string" || !data.signedTx) {
      throw new Error("Invalid emulator submitOnchainTx response: missing signedTx");
    }
    return { signedTx: data.signedTx };
  }
};
var Unroll;
((Unroll2) => {
  ((StepType2) => {
    StepType2[StepType2["UNROLL"] = 0] = "UNROLL";
    StepType2[StepType2["WAIT"] = 1] = "WAIT";
    StepType2[StepType2["DONE"] = 2] = "DONE";
  })(Unroll2.StepType || (Unroll2.StepType = {}));
  class Session2 {
    /** Create an unroll session from a virtual output outpoint and its dependency chain. */
    constructor(toUnroll, bumper, explorer, indexer) {
      this.toUnroll = toUnroll;
      this.bumper = bumper;
      this.explorer = explorer;
      this.indexer = indexer;
    }
    /** Create an unroll session by loading the virtual output chain from the indexer. */
    static async create(toUnroll, bumper, explorer, indexer) {
      const { chain } = await indexer.getVtxoChain(toUnroll);
      return new Session2({ ...toUnroll, chain }, bumper, explorer, indexer);
    }
    /**
     * Get the next step to be executed
     * @returns The next step to be executed + the function to execute it
     */
    async next() {
      let nextTxToBroadcast;
      const chain = this.toUnroll.chain;
      for (let i = chain.length - 1; i >= 0; i--) {
        const chainTx = chain[i];
        if (chainTx.type === "INDEXER_CHAINED_TX_TYPE_COMMITMENT" /* COMMITMENT */ || chainTx.type === "INDEXER_CHAINED_TX_TYPE_UNSPECIFIED" /* UNSPECIFIED */) {
          continue;
        }
        try {
          const txInfo = await this.explorer.getTxStatus(chainTx.txid);
          if (!txInfo.confirmed) {
            return {
              type: 1 /* WAIT */,
              txid: chainTx.txid,
              do: doWait(this.explorer, chainTx.txid)
            };
          }
        } catch (e) {
          nextTxToBroadcast = chainTx;
          break;
        }
      }
      if (!nextTxToBroadcast) {
        return {
          type: 2 /* DONE */,
          vtxoTxid: this.toUnroll.txid,
          do: () => Promise.resolve()
        };
      }
      const virtualTxs = await this.indexer.getVirtualTxs([nextTxToBroadcast.txid]);
      if (virtualTxs.txs.length === 0) {
        throw new Error(`Tx ${nextTxToBroadcast.txid} not found`);
      }
      const tx = Transaction.fromPSBT(base64.decode(virtualTxs.txs[0]));
      if (nextTxToBroadcast.type === "INDEXER_CHAINED_TX_TYPE_TREE" /* TREE */) {
        const input = tx.getInput(0);
        if (!input) {
          throw new Error("Input not found");
        }
        const tapKeySig = input.tapKeySig;
        if (!tapKeySig) {
          throw new Error("Tap key sig not found");
        }
        tx.updateInput(0, {
          finalScriptWitness: [tapKeySig]
        });
      } else {
        tx.finalize();
      }
      const pkg = await this.bumper.bumpP2A(tx);
      return {
        type: 0 /* UNROLL */,
        tx,
        pkg,
        do: doUnroll(this.explorer, pkg)
      };
    }
    /**
     * Iterate over the steps to be executed and execute them
     * @returns An async iterator over the executed steps
     */
    async *[Symbol.asyncIterator]() {
      let lastStep;
      do {
        if (lastStep !== void 0) {
          await sleep(1e3);
        }
        const step = await this.next();
        await step.do();
        yield step;
        lastStep = step.type;
      } while (lastStep !== 2 /* DONE */);
    }
  }
  Unroll2.Session = Session2;
  async function completeUnroll(wallet, vtxoTxids, outputAddress) {
    const signedTx = await prepareUnrollTransaction(wallet, vtxoTxids, outputAddress);
    await wallet.onchainProvider.broadcastTransaction(signedTx.hex);
    return signedTx.id;
  }
  Unroll2.completeUnroll = completeUnroll;
})(Unroll || (Unroll = {}));
async function prepareUnrollTransaction(wallet, vtxoTxIds, outputAddress) {
  const chainTip = await wallet.onchainProvider.getChainTip();
  let vtxos = await wallet.getVtxos({ withUnrolled: true });
  vtxos = vtxos.filter((vtxo) => vtxoTxIds.includes(vtxo.txid));
  if (vtxos.length === 0) {
    throw new Error("No vtxos to complete unroll");
  }
  const inputs = [];
  let totalAmount = 0n;
  const txWeightEstimator = TxWeightEstimator.create();
  for (const vtxo of vtxos) {
    if (!vtxo.isUnrolled) {
      throw new Error(
        `Vtxo ${vtxo.txid}:${vtxo.vout} is not fully unrolled, use unroll first`
      );
    }
    const txStatus = await wallet.onchainProvider.getTxStatus(vtxo.txid);
    if (!txStatus.confirmed) {
      throw new Error(`tx ${vtxo.txid} is not confirmed`);
    }
    const exit = availableExitPath(
      { height: txStatus.blockHeight, time: txStatus.blockTime },
      chainTip,
      vtxo
    );
    if (!exit) {
      throw new Error(`no available exit path found for vtxo ${vtxo.txid}:${vtxo.vout}`);
    }
    const spendingLeaf = VtxoScript.decode(vtxo.tapTree).findLeaf(hex.encode(exit.script));
    if (!spendingLeaf) {
      throw new Error(`spending leaf not found for vtxo ${vtxo.txid}:${vtxo.vout}`);
    }
    totalAmount += BigInt(vtxo.value);
    const sequence = timelockToSequence(exit.params.timelock);
    inputs.push({
      txid: vtxo.txid,
      index: vtxo.vout,
      tapLeafScript: [spendingLeaf],
      sequence,
      witnessUtxo: {
        amount: BigInt(vtxo.value),
        script: VtxoScript.decode(vtxo.tapTree).pkScript
      },
      sighashType: SigHash.DEFAULT
    });
    txWeightEstimator.addTapscriptInput(
      64,
      spendingLeaf[1].length,
      TaprootControlBlock.encode(spendingLeaf[0]).length
    );
  }
  const tx = new Transaction({ version: 2 });
  for (const input of inputs) {
    tx.addInput(input);
  }
  txWeightEstimator.addOutputAddress(outputAddress, wallet.network);
  let feeRate = await wallet.onchainProvider.getFeeRate();
  if (!feeRate || feeRate < Wallet2.MIN_FEE_RATE) {
    feeRate = Wallet2.MIN_FEE_RATE;
  }
  const feeAmount = txWeightEstimator.vsize().fee(BigInt(Math.ceil(feeRate)));
  if (feeAmount > totalAmount) {
    throw new Error("fee amount is greater than the total amount");
  }
  const sendAmount = totalAmount - feeAmount;
  if (sendAmount < BigInt(DUST_AMOUNT)) {
    throw new Error("send amount is less than dust amount");
  }
  tx.addOutputAddress(outputAddress, sendAmount, wallet.network);
  const signedTx = await wallet.identity.sign(tx);
  signedTx.finalize();
  return signedTx;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function doUnroll(onchainProvider, pkg) {
  return () => onchainProvider.broadcastTransaction(...pkg).then(() => void 0);
}
function doWait(onchainProvider, txid) {
  return () => {
    return new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        try {
          const txInfo = await onchainProvider.getTxStatus(txid);
          if (txInfo.confirmed) {
            clearInterval(interval);
            resolve();
          }
        } catch (e) {
          clearInterval(interval);
          reject(e);
        }
      }, 5e3);
    });
  };
}
function availableExitPath(confirmedAt, current, vtxo) {
  const exits = VtxoScript.decode(vtxo.tapTree).exitPaths();
  for (const exit of exits) {
    if (exit.params.timelock.type === "blocks") {
      if (current.height >= confirmedAt.height + Number(exit.params.timelock.value)) {
        return exit;
      }
    } else {
      if (current.time >= confirmedAt.time + Number(exit.params.timelock.value)) {
        return exit;
      }
    }
  }
  return void 0;
}

// src/arkade/index.ts
var arkade_exports = {};
__export(arkade_exports, {
  ARKADE_OP: () => ARKADE_OP,
  ARKADE_OPCODES: () => ARKADE_OPCODES,
  ARKADE_OPCODE_NAMES: () => ARKADE_OPCODE_NAMES,
  ARKADE_OPCODE_VALUES: () => ARKADE_OPCODE_VALUES,
  ARKADE_OPS: () => ARKADE_OPS,
  ArkadeScript: () => ArkadeScript,
  ArkadeVtxoScript: () => ArkadeVtxoScript,
  BigNum: () => bignum_exports,
  OP: () => OP,
  OPCODE_NAMES: () => OPCODE_NAMES,
  OPCODE_VALUES: () => OPCODE_VALUES,
  Script: () => Script,
  arkadeScriptHash: () => arkadeScriptHash,
  arkadeWitnessHash: () => arkadeWitnessHash,
  asmToBytes: () => asmToBytes,
  bytesToASM: () => bytesToASM,
  computeArkadeScriptPublicKey: () => computeArkadeScriptPublicKey,
  createArkadeBatchHandler: () => createArkadeBatchHandler,
  fromASM: () => fromASM,
  getOpcodeName: () => getOpcodeName,
  getOpcodeValue: () => getOpcodeValue,
  toASM: () => toASM
});
var ARKADE_OP = {
  // Merkle Branch Verification (0xb3 — repurposed NOP4 slot)
  MERKLEBRANCHVERIFY: 179,
  // SHA256 Streaming (0xc4-0xc6)
  SHA256INITIALIZE: 196,
  SHA256UPDATE: 197,
  SHA256FINALIZE: 198,
  // Input Introspection (0xc7-0xcb)
  INSPECTINPUTOUTPOINT: 199,
  INSPECTINPUTARKADESCRIPTHASH: 200,
  INSPECTINPUTVALUE: 201,
  INSPECTINPUTSCRIPTPUBKEY: 202,
  INSPECTINPUTSEQUENCE: 203,
  // Signatures (0xcc-0xcd)
  CHECKSIGFROMSTACK: 204,
  PUSHCURRENTINPUTINDEX: 205,
  // Input Arkade Witness Introspection (0xce)
  INSPECTINPUTARKADEWITNESSHASH: 206,
  // Output Introspection (0xcf, 0xd1)
  INSPECTOUTPUTVALUE: 207,
  INSPECTOUTPUTSCRIPTPUBKEY: 209,
  // Transaction Introspection (0xd2-0xd6)
  INSPECTVERSION: 210,
  INSPECTLOCKTIME: 211,
  INSPECTNUMINPUTS: 212,
  INSPECTNUMOUTPUTS: 213,
  TXWEIGHT: 214,
  // 64-bit Arithmetic (0xd7-0xdf)
  ADD64: 215,
  SUB64: 216,
  MUL64: 217,
  DIV64: 218,
  NEG64: 219,
  LESSTHAN64: 220,
  LESSTHANOREQUAL64: 221,
  GREATERTHAN64: 222,
  GREATERTHANOREQUAL64: 223,
  // Conversion (0xe0-0xe2)
  SCRIPTNUMTOLE64: 224,
  LE64TOSCRIPTNUM: 225,
  LE32TOLE64: 226,
  // EC Operations (0xe3-0xe4)
  ECMULSCALARVERIFY: 227,
  TWEAKVERIFY: 228,
  // Asset Groups (0xe5-0xf2)
  INSPECTNUMASSETGROUPS: 229,
  INSPECTASSETGROUPASSETID: 230,
  INSPECTASSETGROUPCTRL: 231,
  FINDASSETGROUPBYASSETID: 232,
  INSPECTASSETGROUPMETADATAHASH: 233,
  INSPECTASSETGROUPNUM: 234,
  INSPECTASSETGROUP: 235,
  INSPECTASSETGROUPSUM: 236,
  INSPECTOUTASSETCOUNT: 237,
  INSPECTOUTASSETAT: 238,
  INSPECTOUTASSETLOOKUP: 239,
  INSPECTINASSETCOUNT: 240,
  INSPECTINASSETAT: 241,
  INSPECTINASSETLOOKUP: 242,
  // Transaction ID (0xf3)
  TXID: 243,
  // Packet Introspection (0xf4-0xf5) — added in emulator v0.0.1
  INSPECTPACKET: 244,
  INSPECTINPUTPACKET: 245
};
var ARKADE_OPCODES = Object.values(ARKADE_OP);
var ARKADE_OPCODE_NAMES = Object.fromEntries(
  Object.entries(ARKADE_OP).map(([name, value]) => [value, name])
);
var ARKADE_OPCODE_VALUES = Object.fromEntries(
  Object.entries(ARKADE_OPCODE_NAMES).map(([value, name]) => [name, Number(value)])
);
function buildBitcoinOpcodeNames() {
  const names = {};
  for (const [key, value] of Object.entries(OP)) {
    if (typeof value === "number") {
      const name = key.startsWith("OP_") ? key : `OP_${key}`;
      names[value] = name;
    }
  }
  names[0] = "OP_0";
  return names;
}
function buildBitcoinOpcodeValues() {
  const values = {};
  for (const [key, value] of Object.entries(OP)) {
    if (typeof value === "number") {
      const name = key.startsWith("OP_") ? key : `OP_${key}`;
      values[name] = value;
      values[key] = value;
    }
  }
  return values;
}
var BITCOIN_OPCODE_NAMES = buildBitcoinOpcodeNames();
var BITCOIN_OPCODE_VALUES = buildBitcoinOpcodeValues();
var OPCODE_NAMES = {
  ...BITCOIN_OPCODE_NAMES,
  // Add Arkade opcodes with OP_ prefix
  ...Object.fromEntries(
    Object.entries(ARKADE_OPCODE_NAMES).map(([value, name]) => [Number(value), `OP_${name}`])
  )
};
var OPCODE_VALUES = {
  ...BITCOIN_OPCODE_VALUES,
  // Add Arkade opcodes with and without OP_ prefix
  ...ARKADE_OPCODE_VALUES,
  ...Object.fromEntries(
    Object.entries(ARKADE_OPCODE_VALUES).map(([name, value]) => [`OP_${name}`, value])
  )
};
function getOpcodeName(value) {
  if (value >= 1 && value <= 75) {
    return `OP_DATA_${value}`;
  }
  return OPCODE_NAMES[value];
}
function getOpcodeValue(name) {
  const dataMatch = name.match(/^OP_DATA_(\d+)$/);
  if (dataMatch) {
    const n = parseInt(dataMatch[1], 10);
    if (n >= 1 && n <= 75) {
      return n;
    }
    return void 0;
  }
  return OPCODE_VALUES[name];
}
function equalBytes6(a, b) {
  if (a.length !== b.length)
    return false;
  for (let i = 0; i < a.length; i++)
    if (a[i] !== b[i])
      return false;
  return true;
}
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
var createView = (arr) => new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
function isPlainObject(obj) {
  return Object.prototype.toString.call(obj) === "[object Object]";
}
function isNum(num) {
  return Number.isSafeInteger(num);
}
var Bitset = {
  BITS: 32,
  FULL_MASK: -1 >>> 0,
  // 1<<32 will overflow
  len: (len) => Math.ceil(len / 32),
  create: (len) => new Uint32Array(Bitset.len(len)),
  clean: (bs) => bs.fill(0),
  debug: (bs) => Array.from(bs).map((i) => (i >>> 0).toString(2).padStart(32, "0")),
  checkLen: (bs, len) => {
    if (Bitset.len(len) === bs.length)
      return;
    throw new Error(`wrong length=${bs.length}. Expected: ${Bitset.len(len)}`);
  },
  chunkLen: (bsLen, pos, len) => {
    if (pos < 0)
      throw new Error(`wrong pos=${pos}`);
    if (pos + len > bsLen)
      throw new Error(`wrong range=${pos}/${len} of ${bsLen}`);
  },
  set: (bs, chunk, value, allowRewrite = true) => {
    if (!allowRewrite && (bs[chunk] & value) !== 0)
      return false;
    bs[chunk] |= value;
    return true;
  },
  pos: (pos, i) => ({
    chunk: Math.floor((pos + i) / 32),
    mask: 1 << 32 - (pos + i) % 32 - 1
  }),
  indices: (bs, len, invert = false) => {
    Bitset.checkLen(bs, len);
    const { FULL_MASK, BITS } = Bitset;
    const left = BITS - len % BITS;
    const lastMask = left ? FULL_MASK >>> left << left : FULL_MASK;
    const res = [];
    for (let i = 0; i < bs.length; i++) {
      let c = bs[i];
      if (invert)
        c = ~c;
      if (i === bs.length - 1)
        c &= lastMask;
      if (c === 0)
        continue;
      for (let j = 0; j < BITS; j++) {
        const m = 1 << BITS - j - 1;
        if (c & m)
          res.push(i * BITS + j);
      }
    }
    return res;
  },
  range: (arr) => {
    const res = [];
    let cur;
    for (const i of arr) {
      if (cur === void 0 || i !== cur.pos + cur.length)
        res.push(cur = { pos: i, length: 1 });
      else
        cur.length += 1;
    }
    return res;
  },
  rangeDebug: (bs, len, invert = false) => `[${Bitset.range(Bitset.indices(bs, len, invert)).map((i) => `(${i.pos}/${i.length})`).join(", ")}]`,
  setRange: (bs, bsLen, pos, len, allowRewrite = true) => {
    Bitset.chunkLen(bsLen, pos, len);
    const { FULL_MASK, BITS } = Bitset;
    const first = pos % BITS ? Math.floor(pos / BITS) : void 0;
    const lastPos = pos + len;
    const last = lastPos % BITS ? Math.floor(lastPos / BITS) : void 0;
    if (first !== void 0 && first === last)
      return Bitset.set(bs, first, FULL_MASK >>> BITS - len << BITS - len - pos, allowRewrite);
    if (first !== void 0) {
      if (!Bitset.set(bs, first, FULL_MASK >>> pos % BITS, allowRewrite))
        return false;
    }
    const start = first !== void 0 ? first + 1 : pos / BITS;
    const end = last !== void 0 ? last : lastPos / BITS;
    for (let i = start; i < end; i++)
      if (!Bitset.set(bs, i, FULL_MASK, allowRewrite))
        return false;
    if (last !== void 0 && first !== last) {
      if (!Bitset.set(bs, last, FULL_MASK << BITS - lastPos % BITS, allowRewrite))
        return false;
    }
    return true;
  }
};
var Path = {
  /**
   * Internal method for handling stack of paths (debug, errors, dynamic fields via path)
   * This is looks ugly (callback), but allows us to force stack cleaning by construction (.pop always after function).
   * Also, this makes impossible:
   * - pushing field when stack is empty
   * - pushing field inside of field (real bug)
   * NOTE: we don't want to do '.pop' on error!
   */
  pushObj: (stack, obj, objFn) => {
    const last = { obj };
    stack.push(last);
    objFn((field, fieldFn) => {
      last.field = field;
      fieldFn();
      last.field = void 0;
    });
    stack.pop();
  },
  path: (stack) => {
    const res = [];
    for (const i of stack)
      if (i.field !== void 0)
        res.push(i.field);
    return res.join("/");
  },
  err: (name, stack, msg) => {
    const err = new Error(`${name}(${Path.path(stack)}): ${typeof msg === "string" ? msg : msg.message}`);
    if (msg instanceof Error && msg.stack)
      err.stack = msg.stack;
    return err;
  },
  resolve: (stack, path) => {
    const parts = path.split("/");
    const objPath = stack.map((i2) => i2.obj);
    let i = 0;
    for (; i < parts.length; i++) {
      if (parts[i] === "..")
        objPath.pop();
      else
        break;
    }
    let cur = objPath.pop();
    for (; i < parts.length; i++) {
      if (!cur || cur[parts[i]] === void 0)
        return void 0;
      cur = cur[parts[i]];
    }
    return cur;
  }
};
var _Reader = class __Reader {
  pos = 0;
  data;
  opts;
  stack;
  parent;
  parentOffset;
  bitBuf = 0;
  bitPos = 0;
  bs;
  // bitset
  view;
  constructor(data, opts = {}, stack = [], parent = void 0, parentOffset = 0) {
    this.data = data;
    this.opts = opts;
    this.stack = stack;
    this.parent = parent;
    this.parentOffset = parentOffset;
    this.view = createView(data);
  }
  /** Internal method for pointers. */
  _enablePointers() {
    if (this.parent)
      return this.parent._enablePointers();
    if (this.bs)
      return;
    this.bs = Bitset.create(this.data.length);
    Bitset.setRange(this.bs, this.data.length, 0, this.pos, this.opts.allowMultipleReads);
  }
  markBytesBS(pos, len) {
    if (this.parent)
      return this.parent.markBytesBS(this.parentOffset + pos, len);
    if (!len)
      return true;
    if (!this.bs)
      return true;
    return Bitset.setRange(this.bs, this.data.length, pos, len, false);
  }
  markBytes(len) {
    const pos = this.pos;
    this.pos += len;
    const res = this.markBytesBS(pos, len);
    if (!this.opts.allowMultipleReads && !res)
      throw this.err(`multiple read pos=${this.pos} len=${len}`);
    return res;
  }
  pushObj(obj, objFn) {
    return Path.pushObj(this.stack, obj, objFn);
  }
  readView(n, fn) {
    if (!Number.isFinite(n))
      throw this.err(`readView: wrong length=${n}`);
    if (this.pos + n > this.data.length)
      throw this.err("readView: Unexpected end of buffer");
    const res = fn(this.view, this.pos);
    this.markBytes(n);
    return res;
  }
  // read bytes by absolute offset
  absBytes(n) {
    if (n > this.data.length)
      throw new Error("Unexpected end of buffer");
    return this.data.subarray(n);
  }
  finish() {
    if (this.opts.allowUnreadBytes)
      return;
    if (this.bitPos) {
      throw this.err(`${this.bitPos} bits left after unpack: ${hex.encode(this.data.slice(this.pos))}`);
    }
    if (this.bs && !this.parent) {
      const notRead = Bitset.indices(this.bs, this.data.length, true);
      if (notRead.length) {
        const formatted = Bitset.range(notRead).map(({ pos, length }) => `(${pos}/${length})[${hex.encode(this.data.subarray(pos, pos + length))}]`).join(", ");
        throw this.err(`unread byte ranges: ${formatted} (total=${this.data.length})`);
      } else
        return;
    }
    if (!this.isEnd()) {
      throw this.err(`${this.leftBytes} bytes ${this.bitPos} bits left after unpack: ${hex.encode(this.data.slice(this.pos))}`);
    }
  }
  // User methods
  err(msg) {
    return Path.err("Reader", this.stack, msg);
  }
  offsetReader(n) {
    if (n > this.data.length)
      throw this.err("offsetReader: Unexpected end of buffer");
    return new __Reader(this.absBytes(n), this.opts, this.stack, this, n);
  }
  bytes(n, peek = false) {
    if (this.bitPos)
      throw this.err("readBytes: bitPos not empty");
    if (!Number.isFinite(n))
      throw this.err(`readBytes: wrong length=${n}`);
    if (this.pos + n > this.data.length)
      throw this.err("readBytes: Unexpected end of buffer");
    const slice = this.data.subarray(this.pos, this.pos + n);
    if (!peek)
      this.markBytes(n);
    return slice;
  }
  byte(peek = false) {
    if (this.bitPos)
      throw this.err("readByte: bitPos not empty");
    if (this.pos + 1 > this.data.length)
      throw this.err("readBytes: Unexpected end of buffer");
    const data = this.data[this.pos];
    if (!peek)
      this.markBytes(1);
    return data;
  }
  get leftBytes() {
    return this.data.length - this.pos;
  }
  get totalBytes() {
    return this.data.length;
  }
  isEnd() {
    return this.pos >= this.data.length && !this.bitPos;
  }
  // bits are read in BE mode (left to right): (0b1000_0000).readBits(1) == 1
  bits(bits) {
    if (bits > 32)
      throw this.err("BitReader: cannot read more than 32 bits in single call");
    let out = 0;
    while (bits) {
      if (!this.bitPos) {
        this.bitBuf = this.byte();
        this.bitPos = 8;
      }
      const take = Math.min(bits, this.bitPos);
      this.bitPos -= take;
      out = out << take | this.bitBuf >> this.bitPos & 2 ** take - 1;
      this.bitBuf &= 2 ** this.bitPos - 1;
      bits -= take;
    }
    return out >>> 0;
  }
  find(needle, pos = this.pos) {
    if (!isBytes(needle))
      throw this.err(`find: needle is not bytes! ${needle}`);
    if (this.bitPos)
      throw this.err("findByte: bitPos not empty");
    if (!needle.length)
      throw this.err(`find: needle is empty`);
    for (let idx = pos; (idx = this.data.indexOf(needle[0], idx)) !== -1; idx++) {
      if (idx === -1)
        return;
      const leftBytes = this.data.length - idx;
      if (leftBytes < needle.length)
        return;
      if (equalBytes6(needle, this.data.subarray(idx, idx + needle.length)))
        return idx;
    }
    return;
  }
};
var _Writer = class {
  pos = 0;
  stack;
  // We could have a single buffer here and re-alloc it with
  // x1.5-2 size each time it full, but it will be slower:
  // basic/encode bench: 395ns -> 560ns
  buffers = [];
  ptrs = [];
  bitBuf = 0;
  bitPos = 0;
  viewBuf = new Uint8Array(8);
  view;
  finished = false;
  constructor(stack = []) {
    this.stack = stack;
    this.view = createView(this.viewBuf);
  }
  pushObj(obj, objFn) {
    return Path.pushObj(this.stack, obj, objFn);
  }
  writeView(len, fn) {
    if (this.finished)
      throw this.err("buffer: finished");
    if (!isNum(len) || len > 8)
      throw new Error(`wrong writeView length=${len}`);
    fn(this.view);
    this.bytes(this.viewBuf.slice(0, len));
    this.viewBuf.fill(0);
  }
  // User methods
  err(msg) {
    if (this.finished)
      throw this.err("buffer: finished");
    return Path.err("Reader", this.stack, msg);
  }
  bytes(b) {
    if (this.finished)
      throw this.err("buffer: finished");
    if (this.bitPos)
      throw this.err("writeBytes: ends with non-empty bit buffer");
    this.buffers.push(b);
    this.pos += b.length;
  }
  byte(b) {
    if (this.finished)
      throw this.err("buffer: finished");
    if (this.bitPos)
      throw this.err("writeByte: ends with non-empty bit buffer");
    this.buffers.push(new Uint8Array([b]));
    this.pos++;
  }
  finish(clean = true) {
    if (this.finished)
      throw this.err("buffer: finished");
    if (this.bitPos)
      throw this.err("buffer: ends with non-empty bit buffer");
    const buffers = this.buffers.concat(this.ptrs.map((i) => i.buffer));
    const sum = buffers.map((b) => b.length).reduce((a, b) => a + b, 0);
    const buf = new Uint8Array(sum);
    for (let i = 0, pad = 0; i < buffers.length; i++) {
      const a = buffers[i];
      buf.set(a, pad);
      pad += a.length;
    }
    for (let pos = this.pos, i = 0; i < this.ptrs.length; i++) {
      const ptr = this.ptrs[i];
      buf.set(ptr.ptr.encode(pos), ptr.pos);
      pos += ptr.buffer.length;
    }
    if (clean) {
      this.buffers = [];
      for (const p of this.ptrs)
        p.buffer.fill(0);
      this.ptrs = [];
      this.finished = true;
      this.bitBuf = 0;
    }
    return buf;
  }
  bits(value, bits) {
    if (bits > 32)
      throw this.err("writeBits: cannot write more than 32 bits in single call");
    if (value >= 2 ** bits)
      throw this.err(`writeBits: value (${value}) >= 2**bits (${bits})`);
    while (bits) {
      const take = Math.min(bits, 8 - this.bitPos);
      this.bitBuf = this.bitBuf << take | value >> bits - take;
      this.bitPos += take;
      bits -= take;
      value &= 2 ** bits - 1;
      if (this.bitPos === 8) {
        this.bitPos = 0;
        this.buffers.push(new Uint8Array([this.bitBuf]));
        this.pos++;
      }
    }
  }
};
function _wrap(inner) {
  return {
    // NOTE: we cannot export validate here, since it is likely mistake.
    encodeStream: inner.encodeStream,
    decodeStream: inner.decodeStream,
    size: inner.size,
    encode: (value) => {
      const w = new _Writer();
      inner.encodeStream(w, value);
      return w.finish();
    },
    decode: (data, opts = {}) => {
      const r = new _Reader(data, opts);
      const res = inner.decodeStream(r);
      r.finish();
      return res;
    }
  };
}
function validate(inner, fn) {
  if (!isCoder(inner))
    throw new Error(`validate: invalid inner value ${inner}`);
  if (typeof fn !== "function")
    throw new Error("validate: fn should be function");
  return _wrap({
    size: inner.size,
    encodeStream: (w, value) => {
      let res;
      try {
        res = fn(value);
      } catch (e) {
        throw w.err(e);
      }
      inner.encodeStream(w, res);
    },
    decodeStream: (r) => {
      const res = inner.decodeStream(r);
      try {
        return fn(res);
      } catch (e) {
        throw r.err(e);
      }
    }
  });
}
var wrap = (inner) => {
  const res = _wrap(inner);
  return inner.validate ? validate(res, inner.validate) : res;
};
var isBaseCoder = (elm) => isPlainObject(elm) && typeof elm.decode === "function" && typeof elm.encode === "function";
function isCoder(elm) {
  return isPlainObject(elm) && isBaseCoder(elm) && typeof elm.encodeStream === "function" && typeof elm.decodeStream === "function" && (elm.size === void 0 || isNum(elm.size));
}
var view = (len, opts) => wrap({
  size: len,
  encodeStream: (w, value) => w.writeView(len, (view2) => opts.write(view2, value)),
  decodeStream: (r) => r.readView(len, opts.read),
  validate: (value) => {
    if (typeof value !== "number")
      throw new Error(`viewCoder: expected number, got ${typeof value}`);
    if (opts.validate)
      opts.validate(value);
    return value;
  }
});
var intView = (len, signed, opts) => {
  const bits = len * 8;
  const maxVal = 2 ** bits;
  const validateUnsigned = (value) => {
    if (!isNum(value))
      throw new Error(`uintView: value is not safe integer: ${value}`);
    if (0 > value || value >= maxVal) {
      throw new Error(`uintView: value out of bounds. Expected 0 <= ${value} < ${maxVal}`);
    }
  };
  return view(len, {
    write: opts.write,
    read: opts.read,
    validate: validateUnsigned
  });
};
var U32LE = /* @__PURE__ */ intView(4, false, {
  read: (view2, pos) => view2.getUint32(pos, true),
  write: (view2, value) => view2.setUint32(0, value, true)
});
var U16LE = /* @__PURE__ */ intView(2, false, {
  read: (view2, pos) => view2.getUint16(pos, true),
  write: (view2, value) => view2.setUint16(0, value, true)
});
var U8 = /* @__PURE__ */ intView(1, false, {
  read: (view2, pos) => view2.getUint8(pos),
  write: (view2, value) => view2.setUint8(0, value)
});

// src/arkade/bignum.ts
var bignum_exports = {};
__export(bignum_exports, {
  BIGNUM_MAX_BYTES: () => BIGNUM_MAX_BYTES,
  decode: () => decode,
  encode: () => encode,
  encodeFixed: () => encodeFixed
});
var BIGNUM_MAX_BYTES = 520;
var codec = ScriptNum(
  BIGNUM_MAX_BYTES,
  /* forceMinimal */
  true
);
function encode(value) {
  const result = codec.encode(value);
  if (result.length > BIGNUM_MAX_BYTES) {
    throw new Error(`BigNum value exceeds 520 bytes (encoded to ${result.length} bytes)`);
  }
  return result;
}
function decode(value) {
  return codec.decode(value);
}
function encodeFixed(value, size) {
  if (size < 0) throw new Error(`negative fixed size ${size}`);
  if (size === 0) {
    if (value !== 0n) throw new Error(`value ${value} does not fit in 0 bytes`);
    return new Uint8Array(0);
  }
  const minimal = encode(value);
  if (minimal.length === 0) {
    return new Uint8Array(size);
  }
  if (minimal.length > size) {
    throw new Error(`value needs ${minimal.length} bytes, size=${size}`);
  }
  const out = new Uint8Array(size);
  const sign2 = minimal[minimal.length - 1] & 128;
  out.set(minimal);
  out[minimal.length - 1] &= 127;
  out[size - 1] |= sign2;
  return out;
}

// src/arkade/script.ts
var ARKADE_OPS = { ...OP, ...ARKADE_OP };
var ArkadeOPNames = {};
for (const [k, v] of Object.entries(ARKADE_OPS)) {
  if (typeof v === "number") ArkadeOPNames[v] = k;
}
var ArkadeScript = wrap({
  encodeStream: (w, value) => {
    for (let o of value) {
      if (typeof o === "string") {
        const v = ARKADE_OPS[o];
        if (v === void 0) throw new Error(`Unknown opcode=${o}`);
        w.byte(v);
        continue;
      } else if (typeof o === "number" || typeof o === "bigint") {
        if (o === 0 || o === 0n) {
          w.byte(0);
          continue;
        } else if (o >= 1 && o <= 16) {
          w.byte(OP.OP_1 - 1 + Number(o));
          continue;
        }
        const big = typeof o === "number" ? BigInt(o) : o;
        o = encode(big);
      }
      if (!(o instanceof Uint8Array)) throw new Error(`Wrong Script OP=${o} (${typeof o})`);
      const len = o.length;
      if (len < OP.PUSHDATA1) w.byte(len);
      else if (len <= 255) {
        w.byte(OP.PUSHDATA1);
        w.byte(len);
      } else if (len <= 65535) {
        w.byte(OP.PUSHDATA2);
        w.bytes(U16LE.encode(len));
      } else {
        w.byte(OP.PUSHDATA4);
        w.bytes(U32LE.encode(len));
      }
      w.bytes(o);
    }
  },
  decodeStream: (r) => {
    const out = [];
    while (!r.isEnd()) {
      const cur = r.byte();
      if (OP.OP_0 < cur && cur <= OP.PUSHDATA4) {
        let len;
        if (cur < OP.PUSHDATA1) len = cur;
        else if (cur === OP.PUSHDATA1) len = U8.decodeStream(r);
        else if (cur === OP.PUSHDATA2) len = U16LE.decodeStream(r);
        else if (cur === OP.PUSHDATA4) len = U32LE.decodeStream(r);
        else throw new Error("Should be not possible");
        out.push(r.bytes(len));
      } else if (cur === 0) {
        out.push(0);
      } else if (OP.OP_1 <= cur && cur <= OP.OP_16) {
        out.push(cur - (OP.OP_1 - 1));
      } else {
        const op = ArkadeOPNames[cur];
        if (op === void 0) throw new Error(`Unknown opcode=${cur.toString(16)}`);
        out.push(op);
      }
    }
    return out;
  }
});
function toASM(script) {
  const parts = [];
  for (const op of script) {
    if (typeof op === "string") {
      const name = op.startsWith("OP_") ? op : `OP_${op}`;
      parts.push(name);
    } else if (typeof op === "number") {
      if (op === 0) {
        parts.push("OP_0");
      } else if (op >= 1 && op <= 16) {
        parts.push(`OP_${op}`);
      } else {
        parts.push(op.toString());
      }
    } else if (typeof op === "bigint") {
      parts.push(op.toString());
    } else {
      parts.push(hex.encode(op));
    }
  }
  return parts.join(" ");
}
function fromASM(asm) {
  const tokens = asm.trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (const token of tokens) {
    if (token === "OP_0" || token === "OP_FALSE") {
      out.push(0);
      continue;
    }
    if (token === "OP_TRUE") {
      out.push(1);
      continue;
    }
    const numMatch = token.match(/^OP_(\d+)$/);
    if (numMatch) {
      const n = parseInt(numMatch[1], 10);
      if (n >= 1 && n <= 16) {
        out.push(n);
        continue;
      }
    }
    let key;
    if (token.startsWith("OP_")) {
      key = token.slice(3);
    } else {
      key = token;
    }
    if (key in ARKADE_OPS) {
      out.push(key);
      continue;
    }
    if (/^[0-9a-fA-F]+$/.test(token) && token.length % 2 === 0) {
      try {
        out.push(hex.decode(token));
        continue;
      } catch {
      }
    }
    throw new Error(`Invalid ASM token: ${token}`);
  }
  return out;
}
function asmToBytes(asm) {
  return ArkadeScript.encode(fromASM(asm));
}
function bytesToASM(script) {
  return toASM(ArkadeScript.decode(script));
}
var TAG_SCRIPT = "ArkScriptHash";
var TAG_WITNESS = "ArkWitnessHash";
function arkadeScriptHash(script) {
  return schnorr.utils.taggedHash(TAG_SCRIPT, script);
}
function arkadeWitnessHash(witness) {
  if (witness.length === 0) {
    return new Uint8Array(32);
  }
  return schnorr.utils.taggedHash(TAG_WITNESS, witness);
}
function computeArkadeScriptPublicKey(pubKey, script) {
  const hash = arkadeScriptHash(script);
  const xOnly = pubKey.length === 33 ? pubKey.subarray(1) : pubKey;
  const point = secp256k1.Point.fromHex("02" + hex.encode(xOnly));
  const scalar = bytesToBigInt(hash) % secp256k1.Point.CURVE().n || 1n;
  const tweakPoint = secp256k1.Point.BASE.multiply(scalar);
  const result = point.add(tweakPoint);
  return result.toBytes().subarray(1);
}
function bytesToBigInt(bytes) {
  let result = 0n;
  for (const byte of bytes) {
    result = result << 8n | BigInt(byte);
  }
  return result;
}
function createArkadeBatchHandler(intentId, inputs, signer, signedProof, message, session, arkProvider, emulator, network) {
  let batchId;
  let sweepTapTreeRoot;
  return {
    onBatchStarted: async (event) => {
      const utf8IntentId = new TextEncoder().encode(intentId);
      const intentIdHash = sha256(utf8IntentId);
      const intentIdHashStr = hex.encode(intentIdHash);
      let skip = true;
      for (const idHash of event.intentIdHashes) {
        if (idHash === intentIdHashStr) {
          await arkProvider.confirmRegistration(intentId);
          skip = false;
          break;
        }
      }
      if (skip) return { skip };
      batchId = event.id;
      const sweepTapscript = CSVMultisigTapscript.encode({
        timelock: {
          value: event.batchExpiry,
          // BIP-65: values >= 512 are interpreted as seconds, below as blocks
          type: event.batchExpiry >= 512n ? "seconds" : "blocks"
        },
        pubkeys: [hex.decode((await arkProvider.getInfo()).forfeitPubkey).subarray(1)]
      }).script;
      sweepTapTreeRoot = tapLeafHash(sweepTapscript);
      return { skip: false };
    },
    onTreeSigningStarted: async (event, vtxoTree) => {
      const signerPubKey = await session.getPublicKey();
      const xonlySignerPubKey = signerPubKey.subarray(1);
      const xOnlyPubkeys = event.cosignersPublicKeys.map((k) => k.slice(2));
      if (!xOnlyPubkeys.includes(hex.encode(xonlySignerPubKey))) {
        return { skip: true };
      }
      const commitmentTx = Transaction.fromPSBT(base64.decode(event.unsignedCommitmentTx));
      const sharedOutput = commitmentTx.getOutput(0);
      if (!sharedOutput?.amount) {
        throw new Error("Shared output not found");
      }
      await session.init(vtxoTree, sweepTapTreeRoot, sharedOutput.amount);
      const pubkey = hex.encode(await session.getPublicKey());
      const nonces = await session.getNonces();
      await arkProvider.submitTreeNonces(batchId, pubkey, nonces);
      return { skip: false };
    },
    onTreeNonces: async (event) => {
      const { hasAllNonces } = await session.aggregatedNonces(event.txid, event.nonces);
      if (!hasAllNonces) return { fullySigned: false };
      const signatures = await session.sign();
      const pubkey = hex.encode(await session.getPublicKey());
      await arkProvider.submitTreeSignatures(batchId, pubkey, signatures);
      return { fullySigned: true };
    },
    onBatchFinalization: async (event, _vtxoTree, connectorTree) => {
      const info = await arkProvider.getInfo();
      const forfeitOutputScript = OutScript.encode(
        Address(network).decode(info.forfeitAddress)
      );
      let commitmentPsbt = Transaction.fromPSBT(base64.decode(event.commitmentTx));
      const signedForfeits = [];
      let hasBoardingInputs = false;
      let connectorIndex = 0;
      const connectorLeaves = connectorTree?.leaves() || [];
      const boardingIndices = [];
      for (const input of inputs) {
        let boardingIdx = null;
        for (let i = 0; i < commitmentPsbt.inputsLength; i++) {
          const psbtInput = commitmentPsbt.getInput(i);
          if (!psbtInput.txid) continue;
          if (hex.encode(psbtInput.txid) === input.txid && psbtInput.index === input.vout) {
            boardingIdx = i;
            break;
          }
        }
        if (boardingIdx !== null) {
          commitmentPsbt.updateInput(boardingIdx, {
            tapLeafScript: [input.forfeitTapLeafScript]
          });
          boardingIndices.push(boardingIdx);
          hasBoardingInputs = true;
        } else {
          if (connectorIndex >= connectorLeaves.length) {
            throw new Error("not enough connectors received");
          }
          const connectorLeaf = connectorLeaves[connectorIndex++];
          const connectorTxId = connectorLeaf.id;
          const connectorOutput = connectorLeaf.getOutput(0);
          if (!connectorOutput?.amount || !connectorOutput?.script) {
            throw new Error(
              `Invalid connector output at index ${connectorIndex - 1}: missing amount or script`
            );
          }
          let forfeitTx = buildForfeitTx(
            [
              {
                txid: input.txid,
                index: input.vout,
                witnessUtxo: {
                  amount: BigInt(input.value),
                  script: VtxoScript.decode(input.tapTree).pkScript
                },
                sighashType: SigHash.DEFAULT,
                tapLeafScript: [input.forfeitTapLeafScript]
              },
              {
                txid: connectorTxId,
                index: 0,
                witnessUtxo: {
                  amount: connectorOutput.amount,
                  script: connectorOutput.script
                }
              }
            ],
            forfeitOutputScript
          );
          forfeitTx = await signer.sign(forfeitTx, [0]);
          signedForfeits.push(base64.encode(forfeitTx.toPSBT()));
        }
      }
      if (boardingIndices.length > 0) {
        commitmentPsbt = await signer.sign(commitmentPsbt, boardingIndices);
      }
      let connectorTreeNodes = null;
      if (connectorTree) {
        connectorTreeNodes = [];
        for (const subtree of connectorTree.iterator()) {
          const children = {};
          for (const [outputIndex, child] of subtree.children) {
            children[String(outputIndex)] = child.txid;
          }
          connectorTreeNodes.push({
            txid: subtree.txid,
            tx: base64.encode(subtree.root.toPSBT()),
            children
          });
        }
      }
      const commitmentB64 = hasBoardingInputs ? base64.encode(commitmentPsbt.toPSBT()) : event.commitmentTx;
      const emuResult = await emulator.submitFinalization(
        { proof: signedProof, message },
        signedForfeits,
        connectorTreeNodes,
        commitmentB64
      );
      await arkProvider.submitSignedForfeitTxs(
        emuResult.signedForfeits,
        emuResult.signedCommitmentTx || (hasBoardingInputs ? commitmentB64 : void 0)
      );
    }
  };
}

// src/arkade/vtxoScript.ts
function isArkadeLeaf(input) {
  return typeof input === "object" && !(input instanceof Uint8Array) && "arkadeScript" in input && "tapscript" in input && "emulators" in input;
}
function reEncodeTapscript(tapscript) {
  switch (tapscript.type) {
    case "multisig" /* Multisig */:
      return MultisigTapscript.encode(tapscript.params).script;
    case "csv-multisig" /* CSVMultisig */:
      return CSVMultisigTapscript.encode(tapscript.params).script;
    case "condition-csv-multisig" /* ConditionCSVMultisig */:
      return ConditionCSVMultisigTapscript.encode(tapscript.params).script;
    case "condition-multisig" /* ConditionMultisig */:
      return ConditionMultisigTapscript.encode(tapscript.params).script;
    case "cltv-multisig" /* CLTVMultisig */:
      return CLTVMultisigTapscript.encode(tapscript.params).script;
    default:
      throw new Error(`Unsupported tapscript type: ${tapscript.type}`);
  }
}
function processScripts(scripts) {
  const processedScripts = [];
  const arkadeMap = /* @__PURE__ */ new Map();
  for (const input of scripts) {
    if (isArkadeLeaf(input)) {
      const tweakedKeys = input.emulators.map(
        (pk) => computeArkadeScriptPublicKey(pk, input.arkadeScript)
      );
      const params = {
        ...input.tapscript.params,
        pubkeys: [...input.tapscript.params.pubkeys, ...tweakedKeys]
      };
      const modified = { ...input.tapscript, params };
      const leafIndex = processedScripts.length;
      processedScripts.push(reEncodeTapscript(modified));
      arkadeMap.set(leafIndex, input.arkadeScript);
    } else {
      processedScripts.push(input);
    }
  }
  return { processedScripts, arkadeMap };
}
var ArkadeVtxoScript = class extends VtxoScript {
  arkadeScripts;
  constructor(scripts) {
    const { processedScripts, arkadeMap } = processScripts(scripts);
    super(processedScripts);
    this.arkadeScripts = arkadeMap;
  }
};
var ARKCONTRACT_PREFIX = "arkcontract";
function encodeArkContract(contract) {
  const params = new URLSearchParams();
  params.set(ARKCONTRACT_PREFIX, contract.type);
  for (const [key, value] of Object.entries(contract.params)) {
    params.set(key, value);
  }
  return params.toString();
}
function decodeArkContract(encoded) {
  const params = new URLSearchParams(encoded);
  const type = params.get(ARKCONTRACT_PREFIX);
  if (!type) {
    throw new Error(`Invalid arkcontract string: missing '${ARKCONTRACT_PREFIX}' key`);
  }
  const data = {};
  for (const [key, value] of params.entries()) {
    if (key !== ARKCONTRACT_PREFIX) {
      data[key] = value;
    }
  }
  return { type, data };
}
function contractFromArkContract(encoded, options = {}) {
  const parsed = decodeArkContract(encoded);
  const handler = contractHandlers.get(parsed.type);
  if (!handler) {
    throw new Error(`No handler registered for contract type '${parsed.type}'`);
  }
  const params = parsed.data;
  return {
    label: options.label,
    type: parsed.type,
    params,
    state: options.state || "active",
    createdAt: Date.now(),
    metadata: options.metadata
  };
}
function contractFromArkContractWithAddress(encoded, serverPubKey, addressPrefix = DEFAULT_NETWORK.hrp, options = {}) {
  const parsed = decodeArkContract(encoded);
  const handler = contractHandlers.getOrThrow(parsed.type);
  const params = parsed.data;
  const vtxoScript = handler.createScript(params);
  return {
    label: options.label,
    type: parsed.type,
    params,
    script: hex.encode(vtxoScript.pkScript),
    address: vtxoScript.address(addressPrefix, serverPubKey).encode(),
    state: options.state || "active",
    createdAt: Date.now(),
    metadata: options.metadata
  };
}
function isArkContract(str) {
  return str.startsWith(ARKCONTRACT_PREFIX + "=");
}

export { ARKADE_MAGIC, ArkNote, AssetManager, BIP322, Batch, ContractManager, ContractRepositoryImpl, ContractWatcher, DB_VERSION, DEFAULT_MESSAGE_TIMEOUTS, DelegateManagerImpl, DelegateNotConfiguredError, DelegatorManagerImpl, DelegatorNotConfiguredError, DescriptorSigningProviderMissingError, DustChangeError, ELECTRUM_TCP_HOST, ELECTRUM_WS_URL, ESPLORA_URL, ElectrumOnchainProvider, EmulatorPacket, EsploraProvider, Estimator, Extension, ExtensionNotFoundError, HDDescriptorProvider, InMemoryContractRepository, InMemoryWalletRepository, IndexedDBContractRepository, IndexedDBWalletRepository, MESSAGE_BUS_NOT_INITIALIZED, MIGRATION_KEY, MessageBus, MessageBusNotInitializedError, MissingSigningDescriptorError, MnemonicIdentity, OnchainWallet, P2A, Ramps, ReadonlyAssetManager, ReadonlyDescriptorIdentity, ReadonlySingleKey, ReadonlyWallet, ReadonlyWalletError, RestDelegateProvider, RestDelegatorProvider, RestEmulatorProvider, SeedIdentity, ServiceWorkerReadonlyWallet, ServiceWorkerTimeoutError, ServiceWorkerWallet, SingleKey, TxTree, TxType, TxWeightEstimator, UnknownPacket, Unroll, VtxoManager, Wallet2 as Wallet, WalletMessageHandler, WalletNotInitializedError, WalletRepositoryImpl, WsElectrumChainSource, arkade_exports, buildForfeitTx, buildOffchainTx, closeDatabase, combineTapscriptSigs, contractFromArkContract, contractFromArkContractWithAddress, createAssetPacket, decodeArkContract, deserializeAssets, deserializeUtxo, deserializeVtxo, encodeArkContract, extendVirtualCoinForContract, getMigrationStatus, getRandomId, hasBoardingTxExpired, isArkContract, isBatchSignable, isDiscoverable, isExpired, isRecoverable, isSpendable, isSubdust, isValidArkAddress, isVtxoExpiringSoon, isVtxoForScript, migrateWalletRepository, openDatabase, requiresMigration, rollbackMigration, saveVtxosForContract, scriptFromArkAddress, selectCoinsWithAsset, selectVirtualCoins, serializeAssets, serializeUtxo, serializeVtxo, setupServiceWorker, validateConnectorsTxGraph, validateVtxoTxGraph, verifyTapscriptSignatures, waitForIncomingFunds, warnAndFilterVtxosForScript };
//# sourceMappingURL=chunk-PX4JLJW7.js.map
//# sourceMappingURL=chunk-PX4JLJW7.js.map