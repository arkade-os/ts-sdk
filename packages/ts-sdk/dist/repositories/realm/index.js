import { serializeVtxo, isVtxoForScript, serializeUtxo, serializeAssets, scriptFromArkAddress, deserializeVtxo, deserializeUtxo, deserializeAssets } from '../../chunk-MORTWGDE.js';
import '../../chunk-DODG3PG2.js';
import '../../chunk-BUGGGM2S.js';
import '../../chunk-HAYJZIA4.js';
import '../../chunk-NSBPE2FW.js';

// src/repositories/realm/walletRepository.ts
var RealmWalletRepository = class {
  constructor(realm) {
    this.realm = realm;
  }
  version = 1;
  // ── Lifecycle ──────────────────────────────────────────────────────
  async ensureInit() {
  }
  async [Symbol.asyncDispose]() {
  }
  // ── Clear ──────────────────────────────────────────────────────────
  async clear() {
    await this.ensureInit();
    this.realm.write(() => {
      this.realm.delete(this.realm.objects("ArkVtxo"));
      this.realm.delete(this.realm.objects("ArkUtxo"));
      this.realm.delete(this.realm.objects("ArkTransaction"));
      this.realm.delete(this.realm.objects("ArkWalletState"));
    });
  }
  // ── VTXO management ────────────────────────────────────────────────
  async getVtxos(address) {
    await this.ensureInit();
    const results = this.realm.objects("ArkVtxo").filtered("address == $0", address);
    return [...results].map(vtxoObjectToDomain);
  }
  async saveVtxos(address, vtxos) {
    await this.ensureInit();
    this.realm.write(() => {
      for (const vtxo of vtxos) {
        const s = serializeVtxo(vtxo);
        this.realm.create(
          "ArkVtxo",
          {
            pk: `${s.txid}:${s.vout}`,
            address,
            txid: s.txid,
            vout: s.vout,
            value: s.value,
            tapTree: s.tapTree,
            forfeitCb: s.forfeitTapLeafScript.cb,
            forfeitS: s.forfeitTapLeafScript.s,
            intentCb: s.intentTapLeafScript.cb,
            intentS: s.intentTapLeafScript.s,
            statusJson: JSON.stringify(s.status),
            virtualStatusJson: JSON.stringify(s.virtualStatus),
            createdAt: typeof s.createdAt === "string" ? s.createdAt : s.createdAt instanceof Date ? s.createdAt.toISOString() : new Date(s.createdAt).toISOString(),
            isUnrolled: s.isUnrolled ?? false,
            isSpent: s.isSpent === void 0 ? null : s.isSpent,
            spentBy: s.spentBy ?? null,
            settledBy: s.settledBy ?? null,
            arkTxId: s.arkTxId ?? null,
            extraWitnessJson: s.extraWitness ? JSON.stringify(s.extraWitness) : null,
            assetsJson: s.assets ? JSON.stringify(s.assets) : null,
            script: s.script ?? null
          },
          "modified"
        );
      }
    });
  }
  async deleteVtxos(address) {
    await this.ensureInit();
    this.realm.write(() => {
      const toDelete = this.realm.objects("ArkVtxo").filtered("address == $0", address);
      this.realm.delete(toDelete);
    });
  }
  async getVtxosForScript(script) {
    await this.ensureInit();
    const results = this.realm.objects("ArkVtxo").filtered("script == $0", script);
    return [...results].map(vtxoObjectToDomain);
  }
  async saveVtxosForScript(key, vtxos) {
    if (!key.address) {
      throw new Error("RealmWalletRepository requires an address");
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
    await this.ensureInit();
    this.realm.write(() => {
      const toDelete = this.realm.objects("ArkVtxo").filtered("script == $0", script);
      this.realm.delete(toDelete);
    });
  }
  // ── UTXO management ────────────────────────────────────────────────
  async getUtxos(address) {
    await this.ensureInit();
    const results = this.realm.objects("ArkUtxo").filtered("address == $0", address);
    return [...results].map(utxoObjectToDomain);
  }
  async saveUtxos(address, utxos) {
    await this.ensureInit();
    this.realm.write(() => {
      for (const utxo of utxos) {
        const s = serializeUtxo(utxo);
        this.realm.create(
          "ArkUtxo",
          {
            pk: `${s.txid}:${s.vout}`,
            address,
            txid: s.txid,
            vout: s.vout,
            value: s.value,
            tapTree: s.tapTree,
            forfeitCb: s.forfeitTapLeafScript.cb,
            forfeitS: s.forfeitTapLeafScript.s,
            intentCb: s.intentTapLeafScript.cb,
            intentS: s.intentTapLeafScript.s,
            statusJson: JSON.stringify(s.status),
            extraWitnessJson: s.extraWitness ? JSON.stringify(s.extraWitness) : null
          },
          "modified"
        );
      }
    });
  }
  async deleteUtxos(address) {
    await this.ensureInit();
    this.realm.write(() => {
      const toDelete = this.realm.objects("ArkUtxo").filtered("address == $0", address);
      this.realm.delete(toDelete);
    });
  }
  // ── Transaction history ────────────────────────────────────────────
  async getTransactionHistory(address) {
    await this.ensureInit();
    const results = this.realm.objects("ArkTransaction").filtered("address == $0", address);
    const txs = [...results].map(txObjectToDomain);
    txs.sort((a, b) => a.createdAt - b.createdAt);
    return txs;
  }
  async saveTransactions(address, txs) {
    await this.ensureInit();
    this.realm.write(() => {
      for (const tx of txs) {
        this.realm.create(
          "ArkTransaction",
          {
            pk: `${address}:${tx.key.boardingTxid}:${tx.key.commitmentTxid}:${tx.key.arkTxid}`,
            address,
            boardingTxid: tx.key.boardingTxid,
            commitmentTxid: tx.key.commitmentTxid,
            arkTxid: tx.key.arkTxid,
            type: tx.type,
            amount: tx.amount,
            settled: tx.settled,
            createdAt: tx.createdAt,
            assetsJson: tx.assets ? JSON.stringify(serializeAssets(tx.assets)) : null
          },
          "modified"
        );
      }
    });
  }
  async deleteTransactions(address) {
    await this.ensureInit();
    this.realm.write(() => {
      const toDelete = this.realm.objects("ArkTransaction").filtered("address == $0", address);
      this.realm.delete(toDelete);
    });
  }
  // ── Wallet state ───────────────────────────────────────────────────
  async getWalletState() {
    await this.ensureInit();
    const results = this.realm.objects("ArkWalletState").filtered("key == $0", "state");
    const items = [...results];
    if (items.length === 0) return null;
    const obj = items[0];
    const state = {};
    if (obj.settingsJson) {
      state.settings = JSON.parse(obj.settingsJson);
    }
    state.lastSyncTime = obj.lastSyncTime ?? void 0;
    return state;
  }
  async saveWalletState(state) {
    await this.ensureInit();
    this.realm.write(() => {
      this.realm.create(
        "ArkWalletState",
        {
          key: "state",
          lastSyncTime: state.lastSyncTime,
          settingsJson: state.settings ? JSON.stringify(state.settings) : null
        },
        "modified"
      );
    });
  }
};
function vtxoObjectToDomain(obj) {
  const serialized = {
    txid: obj.txid,
    vout: obj.vout,
    value: obj.value,
    tapTree: obj.tapTree,
    forfeitTapLeafScript: {
      cb: obj.forfeitCb,
      s: obj.forfeitS
    },
    intentTapLeafScript: {
      cb: obj.intentCb,
      s: obj.intentS
    },
    status: JSON.parse(obj.statusJson),
    virtualStatus: JSON.parse(obj.virtualStatusJson),
    createdAt: new Date(obj.createdAt),
    isUnrolled: obj.isUnrolled,
    isSpent: obj.isSpent === null ? void 0 : obj.isSpent,
    spentBy: obj.spentBy ?? void 0,
    settledBy: obj.settledBy ?? void 0,
    arkTxId: obj.arkTxId ?? void 0,
    extraWitness: obj.extraWitnessJson ? JSON.parse(obj.extraWitnessJson) : void 0,
    assets: obj.assetsJson ? JSON.parse(obj.assetsJson) : void 0,
    // Post-migration every row has `script`, but the backfill is
    // idempotent: derive from `address` if the legacy column is still
    // null (e.g. the migration hasn't run yet on this handle).
    script: obj.script ?? scriptFromArkAddress(obj.address)
  };
  return deserializeVtxo(serialized);
}
function utxoObjectToDomain(obj) {
  const serialized = {
    txid: obj.txid,
    vout: obj.vout,
    value: obj.value,
    tapTree: obj.tapTree,
    forfeitTapLeafScript: {
      cb: obj.forfeitCb,
      s: obj.forfeitS
    },
    intentTapLeafScript: {
      cb: obj.intentCb,
      s: obj.intentS
    },
    status: JSON.parse(obj.statusJson),
    extraWitness: obj.extraWitnessJson ? JSON.parse(obj.extraWitnessJson) : void 0
  };
  return deserializeUtxo(serialized);
}
function txObjectToDomain(obj) {
  const tx = {
    key: {
      boardingTxid: obj.boardingTxid,
      commitmentTxid: obj.commitmentTxid,
      arkTxid: obj.arkTxid
    },
    type: obj.type,
    amount: obj.amount,
    settled: obj.settled,
    createdAt: obj.createdAt
  };
  if (obj.assetsJson) {
    tx.assets = deserializeAssets(JSON.parse(obj.assetsJson));
  }
  return tx;
}

// src/repositories/realm/contractRepository.ts
var RealmContractRepository = class {
  constructor(realm) {
    this.realm = realm;
  }
  version = 1;
  // ── Lifecycle ──────────────────────────────────────────────────────
  async ensureInit() {
  }
  async [Symbol.asyncDispose]() {
  }
  // ── Clear ──────────────────────────────────────────────────────────
  async clear() {
    await this.ensureInit();
    this.realm.write(() => {
      this.realm.delete(this.realm.objects("ArkContract"));
    });
  }
  // ── Contract management ────────────────────────────────────────────
  async getContracts(filter) {
    await this.ensureInit();
    let results = this.realm.objects("ArkContract");
    if (filter) {
      const filterParts = [];
      const filterArgs = [];
      let argIndex = 0;
      argIndex = this.addFilterCondition(
        filterParts,
        filterArgs,
        "script",
        filter.script,
        argIndex
      );
      argIndex = this.addFilterCondition(
        filterParts,
        filterArgs,
        "state",
        filter.state,
        argIndex
      );
      argIndex = this.addFilterCondition(
        filterParts,
        filterArgs,
        "type",
        filter.type,
        argIndex
      );
      if (filterParts.length > 0) {
        const query = filterParts.join(" AND ");
        results = results.filtered(query, ...filterArgs);
      }
    }
    return [...results].map(contractObjectToDomain);
  }
  async saveContract(contract) {
    await this.ensureInit();
    this.realm.write(() => {
      this.realm.create(
        "ArkContract",
        {
          script: contract.script,
          address: contract.address,
          type: contract.type,
          state: contract.state,
          paramsJson: JSON.stringify(contract.params),
          createdAt: contract.createdAt,
          label: contract.label ?? null,
          metadataJson: contract.metadata ? JSON.stringify(contract.metadata) : null
        },
        "modified"
      );
    });
  }
  async deleteContract(script) {
    await this.ensureInit();
    this.realm.write(() => {
      const toDelete = this.realm.objects("ArkContract").filtered("script == $0", script);
      this.realm.delete(toDelete);
    });
  }
  // ── Helpers ─────────────────────────────────────────────────────────
  addFilterCondition(parts, args, column, value, argIndex) {
    if (value === void 0) return argIndex;
    if (Array.isArray(value)) {
      if (value.length === 0) return argIndex;
      const conditions = value.map((_, i) => {
        return `${column} == $${argIndex + i}`;
      });
      parts.push(`(${conditions.join(" OR ")})`);
      args.push(...value);
      return argIndex + value.length;
    } else {
      parts.push(`${column} == $${argIndex}`);
      args.push(value);
      return argIndex + 1;
    }
  }
};
function contractObjectToDomain(obj) {
  const contract = {
    script: obj.script,
    address: obj.address,
    type: obj.type,
    state: obj.state,
    params: JSON.parse(obj.paramsJson),
    createdAt: obj.createdAt
  };
  if (obj.label !== null && obj.label !== void 0) {
    contract.label = obj.label;
  }
  if (obj.metadataJson !== null && obj.metadataJson !== void 0) {
    contract.metadata = JSON.parse(obj.metadataJson);
  }
  return contract;
}

// src/repositories/realm/schemas.ts
var ArkVtxoSchema = {
  name: "ArkVtxo",
  primaryKey: "pk",
  properties: {
    pk: "string",
    // composite: `${txid}:${vout}`
    address: { type: "string", indexed: true },
    txid: "string",
    vout: "int",
    value: "int",
    tapTree: "string",
    // hex-encoded
    forfeitCb: "string",
    forfeitS: "string",
    intentCb: "string",
    intentS: "string",
    extraWitnessJson: "string?",
    statusJson: "string",
    virtualStatusJson: "string",
    spentBy: "string?",
    settledBy: "string?",
    arkTxId: "string?",
    createdAt: "string",
    // ISO 8601
    isUnrolled: "bool",
    isSpent: "bool?",
    assetsJson: "string?",
    // scriptPubKey (hex) locking this VTXO, indexed so contract-scoped
    // queries can resolve ownership without touching address mapping.
    // Required as of schema v2; legacy rows are backfilled from `address`
    // during migration (see `runArkRealmMigrations`).
    script: { type: "string", indexed: true }
  }
};
var ArkUtxoSchema = {
  name: "ArkUtxo",
  primaryKey: "pk",
  properties: {
    pk: "string",
    // composite: `${txid}:${vout}`
    address: { type: "string", indexed: true },
    txid: "string",
    vout: "int",
    value: "int",
    tapTree: "string",
    // hex-encoded
    forfeitCb: "string",
    forfeitS: "string",
    intentCb: "string",
    intentS: "string",
    extraWitnessJson: "string?",
    statusJson: "string"
  }
};
var ArkTransactionSchema = {
  name: "ArkTransaction",
  primaryKey: "pk",
  properties: {
    pk: "string",
    // composite: `${address}:${boardingTxid}:${commitmentTxid}:${arkTxid}`
    address: { type: "string", indexed: true },
    boardingTxid: "string",
    commitmentTxid: "string",
    arkTxid: "string",
    type: "string",
    amount: "int",
    settled: "bool",
    createdAt: "int",
    assetsJson: "string?"
  }
};
var ArkWalletStateSchema = {
  name: "ArkWalletState",
  primaryKey: "key",
  properties: {
    key: "string",
    lastSyncTime: "int?",
    settingsJson: "string?"
  }
};
var ArkContractSchema = {
  name: "ArkContract",
  primaryKey: "script",
  properties: {
    script: "string",
    address: "string",
    type: { type: "string", indexed: true },
    state: { type: "string", indexed: true },
    paramsJson: "string",
    createdAt: "int",
    expiresAt: "int?",
    label: "string?",
    metadataJson: "string?"
  }
};
var ArkRealmSchemas = [
  ArkVtxoSchema,
  ArkUtxoSchema,
  ArkTransactionSchema,
  ArkWalletStateSchema,
  ArkContractSchema
];
var ARK_REALM_SCHEMA_VERSION = 2;
function runArkRealmMigrations(oldRealm, newRealm) {
  const newVtxos = newRealm.objects("ArkVtxo");
  for (let i = 0; i < newVtxos.length; i++) {
    const newVtxo = newVtxos[i];
    if (!newVtxo.script) {
      newVtxo.script = scriptFromArkAddress(newVtxo.address);
    }
  }
}

export { ARK_REALM_SCHEMA_VERSION, ArkRealmSchemas, RealmContractRepository, RealmWalletRepository, runArkRealmMigrations };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map