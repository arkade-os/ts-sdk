'use strict';

require('../chunk-5BLDMQED.cjs');
var fs = require('fs/promises');
var path = require('path');

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

var fs__namespace = /*#__PURE__*/_interopNamespace(fs);
var path__namespace = /*#__PURE__*/_interopNamespace(path);

var FileSystemStorageAdapter = class {
  basePath;
  constructor(dirPath) {
    this.basePath = path__namespace.resolve(dirPath).replace(/[/\\]+$/, "");
  }
  validateAndGetFilePath(key) {
    if (key === "." || key === "..") {
      throw new Error("Invalid key: '.' and '..' are not allowed");
    }
    if (key.includes("\0")) {
      throw new Error("Invalid key: null bytes are not allowed");
    }
    if (key.includes("..")) {
      throw new Error("Invalid key: directory traversal is not allowed");
    }
    const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
    const keyWithoutExt = key.split(".")[0];
    if (reservedNames.test(keyWithoutExt)) {
      throw new Error(`Invalid key: '${key}' uses a reserved Windows name`);
    }
    if (key.endsWith(" ") || key.endsWith(".")) {
      throw new Error("Invalid key: trailing spaces or dots are not allowed");
    }
    const normalizedKey = key.replace(/[/\\]/g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
    const resolved = path__namespace.resolve(this.basePath, normalizedKey);
    const relative2 = path__namespace.relative(this.basePath, resolved);
    if (relative2.startsWith("..") || relative2.includes(path__namespace.sep + "..")) {
      throw new Error("Invalid key: directory traversal is not allowed");
    }
    return resolved;
  }
  async ensureDirectory() {
    try {
      await fs__namespace.access(this.basePath);
    } catch {
      await fs__namespace.mkdir(this.basePath, { recursive: true });
    }
  }
  async getItem(key) {
    try {
      const filePath = this.validateAndGetFilePath(key);
      const data = await fs__namespace.readFile(filePath, "utf-8");
      return data;
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }
      console.error(`Failed to read file for key ${key}:`, error);
      return null;
    }
  }
  async setItem(key, value) {
    try {
      await this.ensureDirectory();
      const filePath = this.validateAndGetFilePath(key);
      await fs__namespace.writeFile(filePath, value, "utf-8");
    } catch (error) {
      console.error(`Failed to write file for key ${key}:`, error);
      throw error;
    }
  }
  async removeItem(key) {
    try {
      const filePath = this.validateAndGetFilePath(key);
      await fs__namespace.unlink(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error(`Failed to remove file for key ${key}:`, error);
      }
    }
  }
  async clear() {
    try {
      const entries = await fs__namespace.readdir(this.basePath);
      await Promise.all(
        entries.map(async (entry) => {
          const entryPath = path__namespace.join(this.basePath, entry);
          await fs__namespace.rm(entryPath, { recursive: true, force: true });
        })
      );
    } catch (error) {
      console.error("Failed to clear storage directory:", error);
    }
  }
};

exports.FileSystemStorageAdapter = FileSystemStorageAdapter;
//# sourceMappingURL=fileSystem.cjs.map
//# sourceMappingURL=fileSystem.cjs.map