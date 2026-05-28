import '../chunk-NSBPE2FW.js';

// src/storage/localStorage.ts
var LocalStorageAdapter = class {
  getSafeLocalStorage() {
    try {
      if (typeof window === "undefined" || !window.localStorage) {
        return null;
      }
      window.localStorage.length;
      return window.localStorage;
    } catch {
      return null;
    }
  }
  async getItem(key) {
    const localStorage = this.getSafeLocalStorage();
    if (!localStorage) {
      throw new Error("localStorage is not available in this environment");
    }
    return localStorage.getItem(key);
  }
  async setItem(key, value) {
    const localStorage = this.getSafeLocalStorage();
    if (!localStorage) {
      throw new Error("localStorage is not available in this environment");
    }
    localStorage.setItem(key, value);
  }
  async removeItem(key) {
    const localStorage = this.getSafeLocalStorage();
    if (!localStorage) {
      throw new Error("localStorage is not available in this environment");
    }
    localStorage.removeItem(key);
  }
  async clear() {
    const localStorage = this.getSafeLocalStorage();
    if (!localStorage) {
      throw new Error("localStorage is not available in this environment");
    }
    localStorage.clear();
  }
};

export { LocalStorageAdapter };
//# sourceMappingURL=localStorage.js.map
//# sourceMappingURL=localStorage.js.map