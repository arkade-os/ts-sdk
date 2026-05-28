'use strict';

var chunk5BLDMQED_cjs = require('../chunk-5BLDMQED.cjs');

// src/storage/asyncStorage.ts
var AsyncStorageAdapter = class {
  AsyncStorage;
  constructor() {
    try {
      this.AsyncStorage = chunk5BLDMQED_cjs.__require("@react-native-async-storage/async-storage").default;
    } catch (error) {
      throw new Error(
        "AsyncStorage is not available. Make sure @react-native-async-storage/async-storage is installed in React Native environment."
      );
    }
  }
  async getItem(key) {
    return await this.AsyncStorage.getItem(key);
  }
  async setItem(key, value) {
    try {
      await this.AsyncStorage.setItem(key, value);
    } catch (error) {
      console.error(`Failed to set item for key ${key}:`, error);
      throw error;
    }
  }
  async removeItem(key) {
    try {
      await this.AsyncStorage.removeItem(key);
    } catch (error) {
      console.error(`Failed to remove item for key ${key}:`, error);
      throw error;
    }
  }
  async clear() {
    try {
      await this.AsyncStorage.clear();
    } catch (error) {
      console.error("Failed to clear AsyncStorage:", error);
      throw error;
    }
  }
};

exports.AsyncStorageAdapter = AsyncStorageAdapter;
//# sourceMappingURL=asyncStorage.cjs.map
//# sourceMappingURL=asyncStorage.cjs.map