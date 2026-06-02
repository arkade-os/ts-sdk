import { scriptFromArkAddress, serializeVtxo, isVtxoForScript, serializeUtxo, serializeAssets, deserializeVtxo, deserializeUtxo, deserializeAssets } from '../../chunk-PX4JLJW7.js';
import '../../chunk-DODG3PG2.js';
import '../../chunk-BUGGGM2S.js';
import '../../chunk-HAYJZIA4.js';
import '../../chunk-NSBPE2FW.js';

// src/repositories/sqlite/walletRepository.ts
var SQLiteWalletRepository = class {
  constructor(db, options) {
    this.db = db;
    this.prefix = sanitizePrefix(options?.prefix ?? "ark_");
    this.tables = {
      vtxos: `${this.prefix}vtxos`,
      utxos: `${this.prefix}utxos`,
      transactions: `${this.prefix}transactions`,
      walletState: `${this.prefix}wallet_state`
    };
  }
  version = 1;
  initPromise = null;
  prefix;
  tables;
  // ── Lifecycle ──────────────────────────────────────────────────────
  ensureInit() {
    if (!this.initPromise) {
      this.initPromise = this.init();
    }
    return this.initPromise;
  }
  async init() {
    await this.migrateVtxosTable();
    await this.db.run(`
            CREATE TABLE IF NOT EXISTS ${this.tables.utxos} (
                txid TEXT NOT NULL,
                vout INTEGER NOT NULL,
                value INTEGER NOT NULL,
                address TEXT NOT NULL,
                tap_tree TEXT NOT NULL,
                forfeit_cb TEXT NOT NULL,
                forfeit_s TEXT NOT NULL,
                intent_cb TEXT NOT NULL,
                intent_s TEXT NOT NULL,
                status_json TEXT NOT NULL,
                extra_witness_json TEXT,
                PRIMARY KEY (txid, vout)
            )
        `);
    await this.db.run(`
            CREATE TABLE IF NOT EXISTS ${this.tables.transactions} (
                address TEXT NOT NULL,
                boarding_txid TEXT NOT NULL,
                commitment_txid TEXT NOT NULL,
                ark_txid TEXT NOT NULL,
                type TEXT NOT NULL,
                amount INTEGER NOT NULL,
                settled INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                assets_json TEXT,
                PRIMARY KEY (address, boarding_txid, commitment_txid, ark_txid)
            )
        `);
    await this.db.run(`
            CREATE TABLE IF NOT EXISTS ${this.tables.walletState} (
                key TEXT PRIMARY KEY,
                settings_json TEXT,
                last_sync_time INTEGER
            )
        `);
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_${this.prefix}vtxos_address ON ${this.tables.vtxos} (address)`
    );
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_${this.prefix}vtxos_script ON ${this.tables.vtxos} (script)`
    );
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_${this.prefix}utxos_address ON ${this.tables.utxos} (address)`
    );
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_${this.prefix}transactions_address ON ${this.tables.transactions} (address)`
    );
  }
  /**
   * Bring the `vtxos` table to the current schema (v1 = `script` NOT NULL).
   *
   * Three cases:
   *   - Fresh install: create the v1 schema directly.
   *   - Legacy install without a `script` column: add it, backfill from
   *     `address`, then rebuild the table with NOT NULL (SQLite cannot add
   *     the NOT NULL constraint in place).
   *   - Legacy install with a nullable `script` column: backfill the NULLs
   *     and rebuild.
   *
   * The backfill derives `script` from the Ark address, matching what the
   * indexer would have returned — new rows from the indexer always carry a
   * populated `script`, so the migration is idempotent.
   *
   * The rebuild path is wrapped in a transaction: without it, a crash
   * between the `DROP TABLE vtxos` and the `RENAME tmp → vtxos` commits
   * would leave the next startup seeing no `vtxos` table and create a
   * fresh empty one, silently orphaning every row in the temp table.
   */
  async migrateVtxosTable() {
    const tableExists = await this.db.get(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      [this.tables.vtxos]
    );
    if (!tableExists) {
      await this.db.run(this.vtxosCreateSql(this.tables.vtxos));
      return;
    }
    const cols = await this.db.all(
      `PRAGMA table_info(${this.tables.vtxos})`
    );
    const scriptCol = cols.find((c) => c.name === "script");
    if (scriptCol && scriptCol.notnull === 1) {
      return;
    }
    await this.db.run("BEGIN IMMEDIATE");
    try {
      if (!scriptCol) {
        await this.db.run(`ALTER TABLE ${this.tables.vtxos} ADD COLUMN script TEXT`);
      }
      const nullRows = await this.db.all(`SELECT txid, vout, address FROM ${this.tables.vtxos} WHERE script IS NULL`);
      for (const row of nullRows) {
        await this.db.run(
          `UPDATE ${this.tables.vtxos} SET script = ? WHERE txid = ? AND vout = ?`,
          [scriptFromArkAddress(row.address), row.txid, row.vout]
        );
      }
      const tempName = `${this.tables.vtxos}__migrate_tmp`;
      await this.db.run(`DROP TABLE IF EXISTS ${tempName}`);
      await this.db.run(this.vtxosCreateSql(tempName));
      await this.db.run(`
                INSERT INTO ${tempName}
                    (txid, vout, value, address, tap_tree,
                     forfeit_cb, forfeit_s, intent_cb, intent_s,
                     status_json, virtual_status_json, created_at,
                     is_unrolled, is_spent, spent_by, settled_by, ark_tx_id,
                     extra_witness_json, assets_json, script)
                SELECT txid, vout, value, address, tap_tree,
                       forfeit_cb, forfeit_s, intent_cb, intent_s,
                       status_json, virtual_status_json, created_at,
                       is_unrolled, is_spent, spent_by, settled_by, ark_tx_id,
                       extra_witness_json, assets_json, script
                FROM ${this.tables.vtxos}
            `);
      await this.db.run(`DROP TABLE ${this.tables.vtxos}`);
      await this.db.run(`ALTER TABLE ${tempName} RENAME TO ${this.tables.vtxos}`);
      await this.db.run("COMMIT");
    } catch (e) {
      try {
        await this.db.run("ROLLBACK");
      } catch {
      }
      throw e;
    }
  }
  vtxosCreateSql(tableName) {
    return `CREATE TABLE ${tableName} (
            txid TEXT NOT NULL,
            vout INTEGER NOT NULL,
            value INTEGER NOT NULL,
            address TEXT NOT NULL,
            tap_tree TEXT NOT NULL,
            forfeit_cb TEXT NOT NULL,
            forfeit_s TEXT NOT NULL,
            intent_cb TEXT NOT NULL,
            intent_s TEXT NOT NULL,
            status_json TEXT NOT NULL,
            virtual_status_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            is_unrolled INTEGER NOT NULL DEFAULT 0,
            is_spent INTEGER,
            spent_by TEXT,
            settled_by TEXT,
            ark_tx_id TEXT,
            extra_witness_json TEXT,
            assets_json TEXT,
            script TEXT NOT NULL,
            PRIMARY KEY (txid, vout)
        )`;
  }
  async [Symbol.asyncDispose]() {
  }
  // ── Clear ──────────────────────────────────────────────────────────
  async clear() {
    await this.ensureInit();
    await this.db.run(`DELETE FROM ${this.tables.vtxos}`);
    await this.db.run(`DELETE FROM ${this.tables.utxos}`);
    await this.db.run(`DELETE FROM ${this.tables.transactions}`);
    await this.db.run(`DELETE FROM ${this.tables.walletState}`);
  }
  // ── VTXO management ────────────────────────────────────────────────
  async getVtxos(address) {
    await this.ensureInit();
    const rows = await this.db.all(
      `SELECT * FROM ${this.tables.vtxos} WHERE address = ?`,
      [address]
    );
    return rows.map(vtxoRowToDomain);
  }
  async saveVtxos(address, vtxos) {
    await this.ensureInit();
    for (const vtxo of vtxos) {
      const s = serializeVtxo(vtxo);
      await this.db.run(
        `INSERT OR REPLACE INTO ${this.tables.vtxos}
                    (txid, vout, value, address,
                     tap_tree, forfeit_cb, forfeit_s, intent_cb, intent_s,
                     status_json, virtual_status_json, created_at,
                     is_unrolled, is_spent, spent_by, settled_by, ark_tx_id,
                     extra_witness_json, assets_json, script)
                 VALUES (?, ?, ?, ?,
                         ?, ?, ?, ?, ?,
                         ?, ?, ?,
                         ?, ?, ?, ?, ?,
                         ?, ?, ?)`,
        [
          s.txid,
          s.vout,
          s.value,
          address,
          s.tapTree,
          s.forfeitTapLeafScript.cb,
          s.forfeitTapLeafScript.s,
          s.intentTapLeafScript.cb,
          s.intentTapLeafScript.s,
          JSON.stringify(s.status),
          JSON.stringify(s.virtualStatus),
          typeof s.createdAt === "string" ? s.createdAt : s.createdAt instanceof Date ? s.createdAt.toISOString() : new Date(s.createdAt).toISOString(),
          s.isUnrolled ? 1 : 0,
          s.isSpent === void 0 ? null : s.isSpent ? 1 : 0,
          s.spentBy ?? null,
          s.settledBy ?? null,
          s.arkTxId ?? null,
          s.extraWitness ? JSON.stringify(s.extraWitness) : null,
          s.assets ? JSON.stringify(s.assets) : null,
          s.script ?? null
        ]
      );
    }
  }
  async deleteVtxos(address) {
    await this.ensureInit();
    await this.db.run(`DELETE FROM ${this.tables.vtxos} WHERE address = ?`, [address]);
  }
  async getVtxosForScript(script) {
    await this.ensureInit();
    const rows = await this.db.all(
      `SELECT * FROM ${this.tables.vtxos} WHERE script = ?`,
      [script]
    );
    return rows.map(vtxoRowToDomain);
  }
  async saveVtxosForScript(key, vtxos) {
    if (!key.address) {
      throw new Error("SQLiteWalletRepository requires an address");
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
    await this.db.run(`DELETE FROM ${this.tables.vtxos} WHERE script = ?`, [script]);
  }
  // ── UTXO management ────────────────────────────────────────────────
  async getUtxos(address) {
    await this.ensureInit();
    const rows = await this.db.all(
      `SELECT * FROM ${this.tables.utxos} WHERE address = ?`,
      [address]
    );
    return rows.map(utxoRowToDomain);
  }
  async saveUtxos(address, utxos) {
    await this.ensureInit();
    for (const utxo of utxos) {
      const s = serializeUtxo(utxo);
      await this.db.run(
        `INSERT OR REPLACE INTO ${this.tables.utxos}
                    (txid, vout, value, address,
                     tap_tree, forfeit_cb, forfeit_s, intent_cb, intent_s,
                     status_json, extra_witness_json)
                 VALUES (?, ?, ?, ?,
                         ?, ?, ?, ?, ?,
                         ?, ?)`,
        [
          s.txid,
          s.vout,
          s.value,
          address,
          s.tapTree,
          s.forfeitTapLeafScript.cb,
          s.forfeitTapLeafScript.s,
          s.intentTapLeafScript.cb,
          s.intentTapLeafScript.s,
          JSON.stringify(s.status),
          s.extraWitness ? JSON.stringify(s.extraWitness) : null
        ]
      );
    }
  }
  async deleteUtxos(address) {
    await this.ensureInit();
    await this.db.run(`DELETE FROM ${this.tables.utxos} WHERE address = ?`, [address]);
  }
  // ── Transaction history ────────────────────────────────────────────
  async getTransactionHistory(address) {
    await this.ensureInit();
    const rows = await this.db.all(
      `SELECT * FROM ${this.tables.transactions} WHERE address = ? ORDER BY created_at ASC`,
      [address]
    );
    return rows.map(txRowToDomain);
  }
  async saveTransactions(address, txs) {
    await this.ensureInit();
    for (const tx of txs) {
      await this.db.run(
        `INSERT OR REPLACE INTO ${this.tables.transactions}
                    (address, boarding_txid, commitment_txid, ark_txid,
                     type, amount, settled, created_at, assets_json)
                 VALUES (?, ?, ?, ?,
                         ?, ?, ?, ?, ?)`,
        [
          address,
          tx.key.boardingTxid,
          tx.key.commitmentTxid,
          tx.key.arkTxid,
          tx.type,
          tx.amount,
          tx.settled ? 1 : 0,
          tx.createdAt,
          tx.assets ? JSON.stringify(serializeAssets(tx.assets)) : null
        ]
      );
    }
  }
  async deleteTransactions(address) {
    await this.ensureInit();
    await this.db.run(`DELETE FROM ${this.tables.transactions} WHERE address = ?`, [address]);
  }
  // ── Wallet state ───────────────────────────────────────────────────
  async getWalletState() {
    await this.ensureInit();
    const row = await this.db.get(
      `SELECT * FROM ${this.tables.walletState} WHERE key = ?`,
      ["state"]
    );
    if (!row) return null;
    const state = {};
    if (row.settings_json) {
      state.settings = JSON.parse(row.settings_json);
    }
    state.lastSyncTime = row.last_sync_time ?? void 0;
    return state;
  }
  async saveWalletState(state) {
    await this.ensureInit();
    await this.db.run(
      `INSERT OR REPLACE INTO ${this.tables.walletState}
                (key, settings_json, last_sync_time)
             VALUES (?, ?, ?)`,
      [
        "state",
        state.settings ? JSON.stringify(state.settings) : null,
        state.lastSyncTime ?? null
      ]
    );
  }
};
var SAFE_PREFIX = /^[a-zA-Z0-9_]+$/;
function sanitizePrefix(prefix) {
  if (!SAFE_PREFIX.test(prefix)) {
    throw new Error(
      `Invalid table prefix "${prefix}": only letters, digits, and underscores are allowed`
    );
  }
  return prefix;
}
function vtxoRowToDomain(row) {
  const serialized = {
    txid: row.txid,
    vout: row.vout,
    value: row.value,
    tapTree: row.tap_tree,
    forfeitTapLeafScript: {
      cb: row.forfeit_cb,
      s: row.forfeit_s
    },
    intentTapLeafScript: {
      cb: row.intent_cb,
      s: row.intent_s
    },
    status: JSON.parse(row.status_json),
    virtualStatus: JSON.parse(row.virtual_status_json),
    createdAt: new Date(row.created_at),
    isUnrolled: row.is_unrolled === 1,
    isSpent: row.is_spent === null ? void 0 : row.is_spent === 1,
    spentBy: row.spent_by ?? void 0,
    settledBy: row.settled_by ?? void 0,
    arkTxId: row.ark_tx_id ?? void 0,
    extraWitness: row.extra_witness_json ? JSON.parse(row.extra_witness_json) : void 0,
    assets: row.assets_json ? JSON.parse(row.assets_json) : void 0,
    // Post-migration every row has `script`, but the backfill is
    // idempotent: derive from `address` if the legacy column is still
    // null (e.g. the migration hasn't run yet on this handle).
    script: row.script ?? scriptFromArkAddress(row.address)
  };
  return deserializeVtxo(serialized);
}
function utxoRowToDomain(row) {
  const serialized = {
    txid: row.txid,
    vout: row.vout,
    value: row.value,
    tapTree: row.tap_tree,
    forfeitTapLeafScript: {
      cb: row.forfeit_cb,
      s: row.forfeit_s
    },
    intentTapLeafScript: {
      cb: row.intent_cb,
      s: row.intent_s
    },
    status: JSON.parse(row.status_json),
    extraWitness: row.extra_witness_json ? JSON.parse(row.extra_witness_json) : void 0
  };
  return deserializeUtxo(serialized);
}
function txRowToDomain(row) {
  const tx = {
    key: {
      boardingTxid: row.boarding_txid,
      commitmentTxid: row.commitment_txid,
      arkTxid: row.ark_txid
    },
    type: row.type,
    amount: row.amount,
    settled: row.settled === 1,
    createdAt: row.created_at
  };
  if (row.assets_json) {
    tx.assets = deserializeAssets(JSON.parse(row.assets_json));
  }
  return tx;
}

// src/repositories/sqlite/contractRepository.ts
var SQLiteContractRepository = class {
  constructor(db, options) {
    this.db = db;
    this.prefix = sanitizePrefix2(options?.prefix ?? "ark_");
    this.table = `${this.prefix}contracts`;
  }
  version = 1;
  initPromise = null;
  prefix;
  table;
  // ── Lifecycle ──────────────────────────────────────────────────────
  ensureInit() {
    if (!this.initPromise) {
      this.initPromise = this.init();
    }
    return this.initPromise;
  }
  async init() {
    await this.db.run(`
            CREATE TABLE IF NOT EXISTS ${this.table} (
                script TEXT PRIMARY KEY,
                address TEXT NOT NULL,
                type TEXT NOT NULL,
                state TEXT NOT NULL,
                params_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER,
                label TEXT,
                metadata_json TEXT
            )
        `);
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_${this.prefix}contracts_type ON ${this.table} (type)`
    );
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_${this.prefix}contracts_state ON ${this.table} (state)`
    );
  }
  async [Symbol.asyncDispose]() {
  }
  // ── Clear ──────────────────────────────────────────────────────────
  async clear() {
    await this.ensureInit();
    await this.db.run(`DELETE FROM ${this.table}`);
  }
  // ── Contract management ────────────────────────────────────────────
  async getContracts(filter) {
    await this.ensureInit();
    const conditions = [];
    const params = [];
    if (filter) {
      this.addFilterCondition(conditions, params, "script", filter.script);
      this.addFilterCondition(conditions, params, "state", filter.state);
      this.addFilterCondition(conditions, params, "type", filter.type);
    }
    let sql = `SELECT * FROM ${this.table}`;
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    const rows = await this.db.all(sql, params);
    return rows.map(contractRowToDomain);
  }
  async saveContract(contract) {
    await this.ensureInit();
    await this.db.run(
      `INSERT OR REPLACE INTO ${this.table}
                (script, address, type, state, params_json,
                 created_at, label, metadata_json)
             VALUES (?, ?, ?, ?, ?,
                     ?, ?, ?)`,
      [
        contract.script,
        contract.address,
        contract.type,
        contract.state,
        JSON.stringify(contract.params),
        contract.createdAt,
        contract.label ?? null,
        contract.metadata ? JSON.stringify(contract.metadata) : null
      ]
    );
  }
  async deleteContract(script) {
    await this.ensureInit();
    await this.db.run(`DELETE FROM ${this.table} WHERE script = ?`, [script]);
  }
  // ── Helpers ─────────────────────────────────────────────────────────
  addFilterCondition(conditions, params, column, value) {
    if (value === void 0) return;
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      const placeholders = value.map(() => "?").join(", ");
      conditions.push(`${column} IN (${placeholders})`);
      params.push(...value);
    } else {
      conditions.push(`${column} = ?`);
      params.push(value);
    }
  }
};
var SAFE_PREFIX2 = /^[a-zA-Z0-9_]+$/;
function sanitizePrefix2(prefix) {
  if (!SAFE_PREFIX2.test(prefix)) {
    throw new Error(
      `Invalid table prefix "${prefix}": only letters, digits, and underscores are allowed`
    );
  }
  return prefix;
}
function contractRowToDomain(row) {
  const contract = {
    script: row.script,
    address: row.address,
    type: row.type,
    state: row.state,
    params: JSON.parse(row.params_json),
    createdAt: row.created_at
  };
  if (row.label !== null) {
    contract.label = row.label;
  }
  if (row.metadata_json !== null) {
    contract.metadata = JSON.parse(row.metadata_json);
  }
  return contract;
}

export { SQLiteContractRepository, SQLiteWalletRepository };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map