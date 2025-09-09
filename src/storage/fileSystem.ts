import * as fs from "fs/promises";
import * as path from "path";
import type { StorageAdapter } from "./index";

export class FileSystemStorageAdapter implements StorageAdapter {
    private readonly basePath: string;

    constructor(dirPath: string) {
        // Normalize and resolve the storage base path once
        this.basePath = path.resolve(dirPath).replace(/[/\\]+$/, "");
    }

    private validateAndGetFilePath(key: string): string {
        // Reject dangerous keys
        if (key === "." || key === "..") {
            throw new Error("Invalid key: '.' and '..' are not allowed");
        }

        // Check for null bytes
        if (key.includes("\0")) {
            throw new Error("Invalid key: null bytes are not allowed");
        }

        // Check for path traversal attempts before normalization
        if (key.includes("..")) {
            throw new Error("Invalid key: directory traversal is not allowed");
        }

        // Check for reserved Windows names (case-insensitive)
        const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
        const keyWithoutExt = key.split(".")[0];
        if (reservedNames.test(keyWithoutExt)) {
            throw new Error(
                `Invalid key: '${key}' uses a reserved Windows name`
            );
        }

        // Check for trailing spaces or dots
        if (key.endsWith(" ") || key.endsWith(".")) {
            throw new Error(
                "Invalid key: trailing spaces or dots are not allowed"
            );
        }

        // Normalize path separators and sanitize key
        const normalizedKey = key
            .replace(/[/\\]/g, "_")
            .replace(/[^a-zA-Z0-9._-]/g, "_");

        // Resolve the full path and check for directory traversal
        const resolved = path.resolve(this.basePath, normalizedKey);
        const relative = path.relative(this.basePath, resolved);

        // Reject if trying to escape the base directory
        if (relative.startsWith("..") || relative.includes(path.sep + "..")) {
            throw new Error("Invalid key: directory traversal is not allowed");
        }

        return resolved;
    }

    private async ensureDirectory(): Promise<void> {
        try {
            await fs.access(this.basePath);
        } catch {
            await fs.mkdir(this.basePath, { recursive: true });
        }
    }

    async getItem(key: string): Promise<string | null> {
        try {
            const filePath = this.validateAndGetFilePath(key);
            const data = await fs.readFile(filePath, "utf-8");
            return data;
        } catch (error: any) {
            if (error.code === "ENOENT") {
                return null;
            }
            console.error(`Failed to read file for key ${key}:`, error);
            return null;
        }
    }

    async setItem(key: string, value: string): Promise<void> {
        try {
            await this.ensureDirectory();
            const filePath = this.validateAndGetFilePath(key);
            await fs.writeFile(filePath, value, "utf-8");
        } catch (error) {
            console.error(`Failed to write file for key ${key}:`, error);
            throw error;
        }
    }

    async removeItem(key: string): Promise<void> {
        try {
            const filePath = this.validateAndGetFilePath(key);
            await fs.unlink(filePath);
        } catch (error: any) {
            if (error.code !== "ENOENT") {
                console.error(`Failed to remove file for key ${key}:`, error);
            }
        }
    }

    async clear(): Promise<void> {
        try {
            const entries = await fs.readdir(this.basePath);
            await Promise.all(
                entries.map(async (entry) => {
                    const entryPath = path.join(this.basePath, entry);
                    // Use fs.rm with recursive option to handle both files and directories
                    await fs.rm(entryPath, { recursive: true, force: true });
                })
            );
        } catch (error) {
            console.error("Failed to clear storage directory:", error);
        }
    }
}
