import * as fs from "fs/promises";
import * as path from "path";

export interface StorageAdapter {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
    clear(): Promise<void>;
}

export class FileSystemStorageAdapter implements StorageAdapter {
    constructor(private dirPath: string) {}

    private getFilePath(key: string): string {
        // Sanitize key for filesystem use
        const sanitizedKey = key.replace(/[^a-zA-Z0-9.-]/g, "_");
        return path.join(this.dirPath, sanitizedKey);
    }

    private async ensureDirectory(): Promise<void> {
        try {
            await fs.access(this.dirPath);
        } catch {
            await fs.mkdir(this.dirPath, { recursive: true });
        }
    }

    async getItem(key: string): Promise<string | null> {
        try {
            const filePath = this.getFilePath(key);
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
            const filePath = this.getFilePath(key);
            await fs.writeFile(filePath, value, "utf-8");
        } catch (error) {
            console.error(`Failed to write file for key ${key}:`, error);
            throw error;
        }
    }

    async removeItem(key: string): Promise<void> {
        try {
            const filePath = this.getFilePath(key);
            await fs.unlink(filePath);
        } catch (error: any) {
            if (error.code !== "ENOENT") {
                console.error(`Failed to remove file for key ${key}:`, error);
            }
        }
    }

    async clear(): Promise<void> {
        try {
            const files = await fs.readdir(this.dirPath);
            await Promise.all(
                files.map((file) => fs.unlink(path.join(this.dirPath, file)))
            );
        } catch (error) {
            console.error("Failed to clear storage directory:", error);
        }
    }
}
