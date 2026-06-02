'use strict';

var chunkGVJ5NNTJ_cjs = require('../chunk-GVJ5NNTJ.cjs');
require('../chunk-ISZA7V2J.cjs');
require('../chunk-JH7WWDEA.cjs');
require('../chunk-4QHMS5XH.cjs');
require('../chunk-5BLDMQED.cjs');

// src/storage/indexedDB.ts
var IndexedDBStorageAdapter = class {
  dbName;
  version;
  db = null;
  constructor(dbName, version = chunkGVJ5NNTJ_cjs.DB_VERSION) {
    this.dbName = dbName;
    this.version = version;
  }
  async getDB() {
    if (this.db) return this.db;
    const globalObject = typeof window === "undefined" ? self : window;
    if (!(globalObject && "indexedDB" in globalObject)) {
      throw new Error("IndexedDB is not available in this environment");
    }
    return new Promise((resolve, reject) => {
      const request = globalObject.indexedDB.open(this.dbName, this.version);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("storage")) {
          db.createObjectStore("storage");
        }
      };
    });
  }
  async getItem(key) {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(["storage"], "readonly");
        const store = transaction.objectStore("storage");
        const request = store.get(key);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          resolve(request.result || null);
        };
      });
    } catch (error) {
      console.error(`Failed to get item for key ${key}:`, error);
      return null;
    }
  }
  async setItem(key, value) {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(["storage"], "readwrite");
        const store = transaction.objectStore("storage");
        const request = store.put(value, key);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
      });
    } catch (error) {
      console.error(`Failed to set item for key ${key}:`, error);
      throw error;
    }
  }
  async removeItem(key) {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(["storage"], "readwrite");
        const store = transaction.objectStore("storage");
        const request = store.delete(key);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
      });
    } catch (error) {
      console.error(`Failed to remove item for key ${key}:`, error);
    }
  }
  async clear() {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(["storage"], "readwrite");
        const store = transaction.objectStore("storage");
        const request = store.clear();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
      });
    } catch (error) {
      console.error("Failed to clear storage:", error);
    }
  }
};

exports.IndexedDBStorageAdapter = IndexedDBStorageAdapter;
//# sourceMappingURL=indexedDB.cjs.map
//# sourceMappingURL=indexedDB.cjs.map