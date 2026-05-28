import '../chunk-NSBPE2FW.js';
import * as fs from 'fs/promises';
import * as path from 'path';

var FileSystemStorageAdapter = class {
  basePath;
  constructor(dirPath) {
    this.basePath = path.resolve(dirPath).replace(/[/\\]+$/, "");
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
    const resolved = path.resolve(this.basePath, normalizedKey);
    const relative2 = path.relative(this.basePath, resolved);
    if (relative2.startsWith("..") || relative2.includes(path.sep + "..")) {
      throw new Error("Invalid key: directory traversal is not allowed");
    }
    return resolved;
  }
  async ensureDirectory() {
    try {
      await fs.access(this.basePath);
    } catch {
      await fs.mkdir(this.basePath, { recursive: true });
    }
  }
  async getItem(key) {
    try {
      const filePath = this.validateAndGetFilePath(key);
      const data = await fs.readFile(filePath, "utf-8");
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
      await fs.writeFile(filePath, value, "utf-8");
    } catch (error) {
      console.error(`Failed to write file for key ${key}:`, error);
      throw error;
    }
  }
  async removeItem(key) {
    try {
      const filePath = this.validateAndGetFilePath(key);
      await fs.unlink(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error(`Failed to remove file for key ${key}:`, error);
      }
    }
  }
  async clear() {
    try {
      const entries = await fs.readdir(this.basePath);
      await Promise.all(
        entries.map(async (entry) => {
          const entryPath = path.join(this.basePath, entry);
          await fs.rm(entryPath, { recursive: true, force: true });
        })
      );
    } catch (error) {
      console.error("Failed to clear storage directory:", error);
    }
  }
};

export { FileSystemStorageAdapter };
//# sourceMappingURL=fileSystem.js.map
//# sourceMappingURL=fileSystem.js.map