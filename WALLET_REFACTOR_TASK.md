# Wallet Refactoring Task: Repository Pattern with Async Create

## Objective

Refactor the `Wallet` and `ServiceWorkerWallet` classes to use a unified async `create()` pattern with a Repository pattern for data persistence, removing `init()` methods and making Identity async-first.

## Architecture Overview

### Storage Layer (Low-level)

- **Interface**: `StorageAdapter` - Generic key-value storage interface
- **Implementations**: Platform-specific storage backends

### Repository Layer (Domain-specific)  

- **Interface**: `WalletRepository` - Wallet-specific data operations
- **Interface**: `ContractRepository` - Contract metadata for SDK users
- **Implementations**: Use `StorageAdapter` with caching and domain logic

### Identity Layer

- **Interface**: `Identity` - Async-first with deprecated sync methods
- **Implementations**: `SingleKey` (direct), `ServiceWorkerIdentity` (postMessage)

---

## Required Changes

### 1. Remove All `init()` Methods
- Remove `init()` from both `Wallet` and `ServiceWorkerWallet` classes
- Move all initialization logic to static `create()` methods

### 2. Create StorageAdapter Interface and Implementations

#### `src/storage/index.ts`
```typescript
export interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
}

export * from './inMemory';
export * from './localStorage';
export * from './fileSystem';
export * from './indexedDB';
export * from './asyncStorage';
```

#### `src/storage/inMemory.ts`
```typescript
import { StorageAdapter } from './index';

export class InMemoryStorageAdapter implements StorageAdapter {
  private store: Map<string, string> = new Map();

  async getItem(key: string): Promise<string | null> {
    return this.store.get(key) || null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}
```

#### `src/storage/localStorage.ts`
```typescript
import { StorageAdapter } from './index';

export class LocalStorageAdapter implements StorageAdapter {
  async getItem(key: string): Promise<string | null> {
    if (typeof window === 'undefined' || !window.localStorage) {
      throw new Error('localStorage is not available in this environment');
    }
    return window.localStorage.getItem(key);
  }

  async setItem(key: string, value: string): Promise<void> {
    if (typeof window === 'undefined' || !window.localStorage) {
      throw new Error('localStorage is not available in this environment');
    }
    window.localStorage.setItem(key, value);
  }

  async removeItem(key: string): Promise<void> {
    if (typeof window === 'undefined' || !window.localStorage) {
      throw new Error('localStorage is not available in this environment');
    }
    window.localStorage.removeItem(key);
  }

  async clear(): Promise<void> {
    if (typeof window === 'undefined' || !window.localStorage) {
      throw new Error('localStorage is not available in this environment');
    }
    window.localStorage.clear();
  }
}
```

#### `src/storage/fileSystem.ts`
```typescript
import { StorageAdapter } from './index';
import * as fs from 'fs/promises';
import * as path from 'path';

export class FileSystemStorageAdapter implements StorageAdapter {
  constructor(private dirPath: string) {}

  private getFilePath(key: string): string {
    // Sanitize key for filesystem use
    const sanitizedKey = key.replace(/[^a-zA-Z0-9.-]/g, '_');
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
      const data = await fs.readFile(filePath, 'utf-8');
      return data;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
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
      await fs.writeFile(filePath, value, 'utf-8');
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
      if (error.code !== 'ENOENT') {
        console.error(`Failed to remove file for key ${key}:`, error);
      }
    }
  }

  async clear(): Promise<void> {
    try {
      const files = await fs.readdir(this.dirPath);
      await Promise.all(files.map(file => 
        fs.unlink(path.join(this.dirPath, file))
      ));
    } catch (error) {
      console.error('Failed to clear storage directory:', error);
    }
  }
}
```

#### `src/storage/indexedDB.ts`
```typescript
import { StorageAdapter } from './index';

export class IndexedDBStorageAdapter implements StorageAdapter {
  private dbName: string;
  private version: number;
  private db: IDBDatabase | null = null;

  constructor(dbName: string, version: number = 1) {
    this.dbName = dbName;
    this.version = version;
  }

  private async getDB(): Promise<IDBDatabase> {
    if (this.db) return this.db;

    if (typeof window === 'undefined' || !window.indexedDB) {
      throw new Error('IndexedDB is not available in this environment');
    }

    return new Promise((resolve, reject) => {
      const request = window.indexedDB.open(this.dbName, this.version);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('storage')) {
          db.createObjectStore('storage');
        }
      };
    });
  }

  async getItem(key: string): Promise<string | null> {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(['storage'], 'readonly');
        const store = transaction.objectStore('storage');
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

  async setItem(key: string, value: string): Promise<void> {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(['storage'], 'readwrite');
        const store = transaction.objectStore('storage');
        const request = store.put(value, key);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
      });
    } catch (error) {
      console.error(`Failed to set item for key ${key}:`, error);
      throw error;
    }
  }

  async removeItem(key: string): Promise<void> {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(['storage'], 'readwrite');
        const store = transaction.objectStore('storage');
        const request = store.delete(key);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
      });
    } catch (error) {
      console.error(`Failed to remove item for key ${key}:`, error);
    }
  }

  async clear(): Promise<void> {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(['storage'], 'readwrite');
        const store = transaction.objectStore('storage');
        const request = store.clear();

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
      });
    } catch (error) {
      console.error('Failed to clear storage:', error);
    }
  }
}
```

#### `src/storage/asyncStorage.ts`
```typescript
import { StorageAdapter } from './index';

// Note: This requires @react-native-async-storage/async-storage to be installed
export class AsyncStorageAdapter implements StorageAdapter {
  private AsyncStorage: any;

  constructor() {
    try {
      // Dynamic import to avoid errors in non-React Native environments
      this.AsyncStorage = require('@react-native-async-storage/async-storage').default;
    } catch (error) {
      throw new Error('AsyncStorage is not available. Make sure @react-native-async-storage/async-storage is installed in React Native environment.');
    }
  }

  async getItem(key: string): Promise<string | null> {
    try {
      return await this.AsyncStorage.getItem(key);
    } catch (error) {
      console.error(`Failed to get item for key ${key}:`, error);
      return null;
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    try {
      await this.AsyncStorage.setItem(key, value);
    } catch (error) {
      console.error(`Failed to set item for key ${key}:`, error);
      throw error;
    }
  }

  async removeItem(key: string): Promise<void> {
    try {
      await this.AsyncStorage.removeItem(key);
    } catch (error) {
      console.error(`Failed to remove item for key ${key}:`, error);
    }
  }

  async clear(): Promise<void> {
    try {
      await this.AsyncStorage.clear();
    } catch (error) {
      console.error('Failed to clear AsyncStorage:', error);
    }
  }
}
```

### 3. Create Repository Interfaces

#### `src/repositories/index.ts`
```typescript
import { Vtxo } from '../types';

export interface WalletState {
  lastSyncTime?: number;
  settings?: Record<string, any>;
}

export interface Transaction {
  id: string;
  timestamp: number;
  amount: number;
  type: 'send' | 'receive';
  status: 'pending' | 'confirmed' | 'failed';
}

export interface WalletRepository {
  // VTXO management
  getVtxos(address: string): Promise<Vtxo[]>;
  saveVtxo(address: string, vtxo: Vtxo): Promise<void>;
  removeVtxo(address: string, vtxoId: string): Promise<void>;
  clearVtxos(address: string): Promise<void>;
  
  // Transaction history
  getTransactionHistory(address: string): Promise<Transaction[]>;
  saveTransaction(address: string, tx: Transaction): Promise<void>;
  
  // Wallet state
  getWalletState(): Promise<WalletState | null>;
  saveWalletState(state: WalletState): Promise<void>;
}

export interface ContractRepository {
  // Generic contract metadata (for SDK users like boltz-swap)
  getContractData<T>(contractId: string, key: string): Promise<T | null>;
  setContractData<T>(contractId: string, key: string, data: T): Promise<void>;
  deleteContractData(contractId: string, key: string): Promise<void>;
  
  // Contract collections (following boltz-swap pattern)
  getContractCollection<T>(contractType: string): Promise<T[]>;
  saveToContractCollection<T>(contractType: string, item: T, idField: string): Promise<void>;
  removeFromContractCollection(contractType: string, id: string, idField: string): Promise<void>;
}

export * from './walletRepository';
export * from './contractRepository';
```

#### `src/repositories/walletRepository.ts`
```typescript
import { StorageAdapter } from '../storage';
import { WalletRepository, WalletState, Transaction } from './index';
import { Vtxo } from '../types';

export class WalletRepositoryImpl implements WalletRepository {
  private storage: StorageAdapter;
  private cache: {
    vtxos: Map<string, Vtxo[]>;
    transactions: Map<string, Transaction[]>;
    walletState: WalletState | null;
    initialized: Set<string>;
  };

  constructor(storage: StorageAdapter) {
    this.storage = storage;
    this.cache = {
      vtxos: new Map(),
      transactions: new Map(),
      walletState: null,
      initialized: new Set()
    };
  }

  async getVtxos(address: string): Promise<Vtxo[]> {
    const cacheKey = `vtxos:${address}`;
    
    if (this.cache.vtxos.has(address)) {
      return this.cache.vtxos.get(address)!;
    }
    
    const stored = await this.storage.getItem(cacheKey);
    if (!stored) {
      this.cache.vtxos.set(address, []);
      return [];
    }
    
    try {
      const vtxos = JSON.parse(stored) as Vtxo[];
      this.cache.vtxos.set(address, vtxos);
      return vtxos;
    } catch (error) {
      console.error(`Failed to parse VTXOs for address ${address}:`, error);
      this.cache.vtxos.set(address, []);
      return [];
    }
  }

  async saveVtxo(address: string, vtxo: Vtxo): Promise<void> {
    const vtxos = await this.getVtxos(address);
    const existing = vtxos.findIndex(v => v.outpoint === vtxo.outpoint);
    
    if (existing !== -1) {
      vtxos[existing] = vtxo;
    } else {
      vtxos.push(vtxo);
    }
    
    this.cache.vtxos.set(address, vtxos);
    await this.storage.setItem(`vtxos:${address}`, JSON.stringify(vtxos));
  }

  async removeVtxo(address: string, vtxoId: string): Promise<void> {
    const vtxos = await this.getVtxos(address);
    const filtered = vtxos.filter(v => v.outpoint !== vtxoId);
    
    this.cache.vtxos.set(address, filtered);
    await this.storage.setItem(`vtxos:${address}`, JSON.stringify(filtered));
  }

  async clearVtxos(address: string): Promise<void> {
    this.cache.vtxos.set(address, []);
    await this.storage.removeItem(`vtxos:${address}`);
  }

  async getTransactionHistory(address: string): Promise<Transaction[]> {
    const cacheKey = `tx:${address}`;
    
    if (this.cache.transactions.has(address)) {
      return this.cache.transactions.get(address)!;
    }
    
    const stored = await this.storage.getItem(cacheKey);
    if (!stored) {
      this.cache.transactions.set(address, []);
      return [];
    }
    
    try {
      const transactions = JSON.parse(stored) as Transaction[];
      this.cache.transactions.set(address, transactions);
      return transactions;
    } catch (error) {
      console.error(`Failed to parse transactions for address ${address}:`, error);
      this.cache.transactions.set(address, []);
      return [];
    }
  }

  async saveTransaction(address: string, tx: Transaction): Promise<void> {
    const transactions = await this.getTransactionHistory(address);
    const existing = transactions.findIndex(t => t.id === tx.id);
    
    if (existing !== -1) {
      transactions[existing] = tx;
    } else {
      transactions.push(tx);
      // Sort by timestamp descending
      transactions.sort((a, b) => b.timestamp - a.timestamp);
    }
    
    this.cache.transactions.set(address, transactions);
    await this.storage.setItem(`tx:${address}`, JSON.stringify(transactions));
  }

  async getWalletState(): Promise<WalletState | null> {
    if (this.cache.walletState !== null || this.cache.initialized.has('walletState')) {
      return this.cache.walletState;
    }
    
    const stored = await this.storage.getItem('wallet:state');
    if (!stored) {
      this.cache.walletState = null;
      this.cache.initialized.add('walletState');
      return null;
    }
    
    try {
      const state = JSON.parse(stored) as WalletState;
      this.cache.walletState = state;
      this.cache.initialized.add('walletState');
      return state;
    } catch (error) {
      console.error('Failed to parse wallet state:', error);
      this.cache.walletState = null;
      this.cache.initialized.add('walletState');
      return null;
    }
  }

  async saveWalletState(state: WalletState): Promise<void> {
    this.cache.walletState = state;
    await this.storage.setItem('wallet:state', JSON.stringify(state));
  }
}
```

#### `src/repositories/contractRepository.ts`
```typescript
import { StorageAdapter } from '../storage';
import { ContractRepository } from './index';

export class ContractRepositoryImpl implements ContractRepository {
  private storage: StorageAdapter;
  private cache: Map<string, any> = new Map();

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  async getContractData<T>(contractId: string, key: string): Promise<T | null> {
    const storageKey = `contract:${contractId}:${key}`;
    const cached = this.cache.get(storageKey);
    if (cached !== undefined) return cached;
    
    const stored = await this.storage.getItem(storageKey);
    if (!stored) return null;
    
    try {
      const data = JSON.parse(stored) as T;
      this.cache.set(storageKey, data);
      return data;
    } catch (error) {
      console.error(`Failed to parse contract data for ${contractId}:${key}:`, error);
      return null;
    }
  }

  async setContractData<T>(contractId: string, key: string, data: T): Promise<void> {
    const storageKey = `contract:${contractId}:${key}`;
    this.cache.set(storageKey, data);
    await this.storage.setItem(storageKey, JSON.stringify(data));
  }

  async deleteContractData(contractId: string, key: string): Promise<void> {
    const storageKey = `contract:${contractId}:${key}`;
    this.cache.delete(storageKey);
    await this.storage.removeItem(storageKey);
  }

  async getContractCollection<T>(contractType: string): Promise<T[]> {
    const storageKey = `collection:${contractType}`;
    const cached = this.cache.get(storageKey);
    if (cached !== undefined) return cached;
    
    const stored = await this.storage.getItem(storageKey);
    if (!stored) {
      this.cache.set(storageKey, []);
      return [];
    }
    
    try {
      const collection = JSON.parse(stored) as T[];
      this.cache.set(storageKey, collection);
      return collection;
    } catch (error) {
      console.error(`Failed to parse contract collection ${contractType}:`, error);
      this.cache.set(storageKey, []);
      return [];
    }
  }

  async saveToContractCollection<T>(contractType: string, item: T, idField: string): Promise<void> {
    const collection = await this.getContractCollection<T>(contractType);
    const itemId = (item as any)[idField];
    const existing = collection.findIndex(i => (i as any)[idField] === itemId);
    
    if (existing !== -1) {
      collection[existing] = item;
    } else {
      collection.push(item);
    }
    
    const storageKey = `collection:${contractType}`;
    this.cache.set(storageKey, collection);
    await this.storage.setItem(storageKey, JSON.stringify(collection));
  }

  async removeFromContractCollection(contractType: string, id: string, idField: string): Promise<void> {
    const collection = await this.getContractCollection(contractType);
    const filtered = collection.filter(item => (item as any)[idField] !== id);
    
    const storageKey = `collection:${contractType}`;
    this.cache.set(storageKey, filtered);
    await this.storage.setItem(storageKey, JSON.stringify(filtered));
  }
}
```

### 4. Update Identity Interface and Implementations

#### Update `src/identity/index.ts`
```typescript
// Add to existing interface
export interface Identity {
  // New async-first methods
  getXOnlyPublicKey(): Promise<Uint8Array>;
  signAsync(message: Uint8Array): Promise<Uint8Array>;
  
  // Deprecated sync methods (print console.warn deprecation notices)
  xOnlyPublicKey(): Uint8Array;
  sign(message: Uint8Array): Uint8Array;
  
  // Existing methods (unchanged)
  signerSession(): SignerSession;
}

// Add new export
export * from './serviceWorker';
```

#### Update `src/identity/singleKey.ts`
Add to existing SingleKey class:
```typescript
export class SingleKey implements Identity {
  // ... existing code ...

  // New async methods
  async getXOnlyPublicKey(): Promise<Uint8Array> {
    return this.xOnlyPublicKey();
  }

  async signAsync(message: Uint8Array): Promise<Uint8Array> {
    return this.sign(message);
  }

  // Add deprecation warnings to existing methods
  xOnlyPublicKey(): Uint8Array {
    console.warn('SingleKey.xOnlyPublicKey() is deprecated. Use getXOnlyPublicKey() instead.');
    // ... existing implementation unchanged ...
  }

  sign(message: Uint8Array): Uint8Array {
    console.warn('SingleKey.sign() is deprecated. Use signAsync() instead.');
    // ... existing implementation unchanged ...
  }

  // ... rest of existing code unchanged ...
}
```

#### Create `src/identity/serviceWorker.ts`
```typescript
import { Identity, SignerSession } from './index';

export class ServiceWorkerIdentity implements Identity {
  private serviceWorker: ServiceWorker;

  constructor(serviceWorker: ServiceWorker) {
    this.serviceWorker = serviceWorker;
  }

  async getXOnlyPublicKey(): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const messageId = `getXOnlyPublicKey_${Date.now()}_${Math.random()}`;
      
      const handleMessage = (event: MessageEvent) => {
        if (event.data.type === 'IDENTITY_RESPONSE' && event.data.messageId === messageId) {
          this.serviceWorker.removeEventListener('message', handleMessage);
          if (event.data.error) {
            reject(new Error(event.data.error));
          } else {
            resolve(new Uint8Array(event.data.result));
          }
        }
      };

      this.serviceWorker.addEventListener('message', handleMessage);
      this.serviceWorker.postMessage({
        type: 'GET_XONLY_PUBLIC_KEY',
        messageId
      });

      // Timeout after 5 seconds
      setTimeout(() => {
        this.serviceWorker.removeEventListener('message', handleMessage);
        reject(new Error('Timeout waiting for service worker response'));
      }, 5000);
    });
  }

  async signAsync(message: Uint8Array): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const messageId = `sign_${Date.now()}_${Math.random()}`;
      
      const handleMessage = (event: MessageEvent) => {
        if (event.data.type === 'IDENTITY_RESPONSE' && event.data.messageId === messageId) {
          this.serviceWorker.removeEventListener('message', handleMessage);
          if (event.data.error) {
            reject(new Error(event.data.error));
          } else {
            resolve(new Uint8Array(event.data.result));
          }
        }
      };

      this.serviceWorker.addEventListener('message', handleMessage);
      this.serviceWorker.postMessage({
        type: 'SIGN_MESSAGE',
        messageId,
        message: Array.from(message)
      });

      // Timeout after 5 seconds
      setTimeout(() => {
        this.serviceWorker.removeEventListener('message', handleMessage);
        reject(new Error('Timeout waiting for service worker response'));
      }, 5000);
    });
  }

  // Sync methods throw errors (not supported in SW context)
  xOnlyPublicKey(): Uint8Array {
    throw new Error('Sync operations not supported in ServiceWorker context. Use getXOnlyPublicKey() instead.');
  }

  sign(message: Uint8Array): Uint8Array {
    throw new Error('Sync operations not supported in ServiceWorker context. Use signAsync() instead.');
  }

  signerSession(): SignerSession {
    throw new Error('SignerSession not supported in ServiceWorker context. Use async methods instead.');
  }
}
```

### 5. Refactor Wallet Classes

#### Update `src/wallet/wallet.ts`
Replace the existing class with this refactored version:
```typescript
import { IWallet } from './index';
import { Identity } from '../identity';
import { StorageAdapter, InMemoryStorageAdapter } from '../storage';
import { WalletRepository, ContractRepository, WalletRepositoryImpl, ContractRepositoryImpl } from '../repositories';
// ... other existing imports ...

export interface WalletCreateOptions {
  storage?: StorageAdapter;
  identity?: Identity;
  arkServerUrl?: string;
  network?: Network;
  // ... other existing options from current create method ...
}

export class Wallet implements IWallet {
  public readonly walletRepository: WalletRepository;
  public readonly contractRepository: ContractRepository;
  
  // ... existing private properties ...
  private identity: Identity;
  private arkProvider?: RestArkProvider;
  // ... other existing properties ...

  private constructor(
    walletRepository: WalletRepository,
    contractRepository: ContractRepository,
    identity: Identity,
    // ... other existing constructor parameters ...
  ) {
    this.walletRepository = walletRepository;
    this.contractRepository = contractRepository;
    this.identity = identity;
    // ... set other existing properties ...
  }

  static async create(options: WalletCreateOptions = {}): Promise<Wallet> {
    // Set defaults
    const storage = options.storage || new InMemoryStorageAdapter();
    
    // Create repositories
    const walletRepo = new WalletRepositoryImpl(storage);
    const contractRepo = new ContractRepositoryImpl(storage);
    
    // Initialize other components (move from existing create() method)
    let arkProvider: RestArkProvider | undefined;
    if (options.arkServerUrl) {
      arkProvider = new RestArkProvider(options.arkServerUrl);
      // ... existing ark provider initialization ...
    }

    // Require identity
    if (!options.identity) {
      throw new Error('Identity is required for wallet creation');
    }

    // ... other existing initialization logic from create() method ...

    return new Wallet(
      walletRepo,
      contractRepo,
      options.identity,
      // ... other constructor parameters ...
    );
  }

  // Update existing methods to use walletRepository
  async getVtxos(): Promise<Vtxo[]> {
    const address = await this.getAddress();
    return this.walletRepository.getVtxos(address);
  }

  // Update other VTXO-related methods
  private async saveVtxo(vtxo: Vtxo): Promise<void> {
    const address = await this.getAddress();
    await this.walletRepository.saveVtxo(address, vtxo);
  }

  private async removeVtxo(vtxoId: string): Promise<void> {
    const address = await this.getAddress();
    await this.walletRepository.removeVtxo(address, vtxoId);
  }

  // ... keep all other existing public methods unchanged ...
  // Just update internal storage calls to use repositories
}
```

#### Update `src/wallet/serviceWorker/wallet.ts`
Replace the existing class with this refactored version:
```typescript
import { IWallet } from '../index';
import { Identity, ServiceWorkerIdentity } from '../../identity';
import { StorageAdapter, IndexedDBStorageAdapter } from '../../storage';
import { WalletRepository, ContractRepository, WalletRepositoryImpl, ContractRepositoryImpl } from '../../repositories';
// ... other existing imports ...

export interface ServiceWorkerWalletCreateOptions {
  serviceWorker: ServiceWorker;
  storage?: StorageAdapter;
  identity?: Identity;
  arkServerUrl?: string;
  // ... other existing options ...
}

export class ServiceWorkerWallet implements IWallet, Identity {
  public readonly walletRepository: WalletRepository;
  public readonly contractRepository: ContractRepository;
  
  // ... existing private properties ...
  private serviceWorker: ServiceWorker;
  private identity: Identity;

  private constructor(
    serviceWorker: ServiceWorker,
    walletRepository: WalletRepository,
    contractRepository: ContractRepository,
    identity: Identity,
    // ... other existing constructor parameters ...
  ) {
    this.serviceWorker = serviceWorker;
    this.walletRepository = walletRepository;
    this.contractRepository = contractRepository;
    this.identity = identity;
    // ... set other existing properties ...
  }

  static async create(options: ServiceWorkerWalletCreateOptions): Promise<ServiceWorkerWallet> {
    // Default to IndexedDB for service worker context
    const storage = options.storage || new IndexedDBStorageAdapter('wallet-db');
    const identity = options.identity || new ServiceWorkerIdentity(options.serviceWorker);
    
    // Create repositories
    const walletRepo = new WalletRepositoryImpl(storage);
    const contractRepo = new ContractRepositoryImpl(storage);
    
    // ... existing initialization logic from init() method ...
    
    return new ServiceWorkerWallet(
      options.serviceWorker,
      walletRepo,
      contractRepo,
      identity,
      // ... other constructor parameters ...
    );
  }

  // Delegate Identity methods to the identity instance
  async getXOnlyPublicKey(): Promise<Uint8Array> {
    return this.identity.getXOnlyPublicKey();
  }

  async signAsync(message: Uint8Array): Promise<Uint8Array> {
    return this.identity.signAsync(message);
  }

  xOnlyPublicKey(): Uint8Array {
    return this.identity.xOnlyPublicKey();
  }

  sign(message: Uint8Array): Uint8Array {
    return this.identity.sign(message);
  }

  signerSession(): SignerSession {
    return this.identity.signerSession();
  }

  // ... implement other IWallet methods using repositories ...
  // Follow same pattern as Wallet class
}
```

---

## Implementation Guidelines

### Storage Adapters
- Check platform availability in methods, not during instantiation
- Handle errors gracefully with proper try/catch
- Use UTF-8 encoding for FileSystemStorageAdapter
- Create directories if they don't exist for FileSystemStorageAdapter
- Use proper IndexedDB object stores for IndexedDBStorageAdapter

### Repositories  
- Implement in-memory caching following boltz-swap pattern
- Use consistent key naming: `"vtxos:${address}"`, `"contract:${contractId}:${key}"`
- Handle JSON parse errors gracefully
- Lazy initialization of cache (load on first access)

### Error Handling
- Storage errors should not crash the application
- Log errors but provide fallback behavior
- Repository methods should return empty arrays/null on errors

### Backwards Compatibility
- All existing public API methods must remain unchanged
- Only internal implementation changes
- Deprecation warnings for sync Identity methods

---

## Expected Usage Examples

### Basic Wallet Creation
```typescript
import { Wallet, LocalStorageAdapter, SingleKey } from '@arkade/ts-sdk';

const wallet = await Wallet.create({
  storage: new LocalStorageAdapter(),
  identity: new SingleKey(privateKey),
  arkServerUrl: 'https://ark.example.com'
});

// Access repositories for advanced usage
const vtxos = await wallet.walletRepository.getVtxos(address);
await wallet.contractRepository.setContractData('htlc-123', 'preimage', 'abc123');
```

### Service Worker Wallet Creation
```typescript
import { ServiceWorkerWallet, IndexedDBStorageAdapter, ServiceWorkerIdentity } from '@arkade/ts-sdk';

const sw = await navigator.serviceWorker.register('/wallet-sw.js');
const swWallet = await ServiceWorkerWallet.create({
  serviceWorker: sw.active!,
  storage: new IndexedDBStorageAdapter('my-wallet'),
  identity: new ServiceWorkerIdentity(sw.active!),
  arkServerUrl: 'https://ark.example.com'
});
```

### SDK Usage (Boltz-like Contract)
```typescript
// Example: How boltz-swap would use the contract repository
class BoltzSwapRepository {
  constructor(private contractRepo: ContractRepository) {}

  async getPendingReverseSwaps(): Promise<PendingReverseSwap[]> {
    return this.contractRepo.getContractCollection<PendingReverseSwap>('reverseSwaps');
  }

  async savePendingReverseSwap(swap: PendingReverseSwap): Promise<void> {
    return this.contractRepo.saveToContractCollection('reverseSwaps', swap, 'response.id');
  }

  async getSwapPreimage(swapId: string): Promise<string | null> {
    return this.contractRepo.getContractData<string>(swapId, 'preimage');
  }
}

// Usage
const boltzRepo = new BoltzSwapRepository(wallet.contractRepository);
await boltzRepo.saveSwapPreimage('swap-123', 'preimage-hex');
```

---

## Testing Requirements

1. **Storage Adapter Tests**
   - Test all storage adapter implementations
   - Test error handling for platform unavailability
   - Test filesystem permissions and directory creation
   - Test IndexedDB quota limits

2. **Repository Tests**
   - Test repository caching behavior
   - Test data persistence across repository instances
   - Test concurrent access patterns
   - Test error recovery

3. **Wallet Creation Tests**
   - Test wallet creation with different combinations of options
   - Test default option handling
   - Test validation of required parameters

4. **Identity Tests**
   - Test Identity deprecation warnings
   - Test ServiceWorkerIdentity postMessage communication
   - Test async vs sync method compatibility

5. **Integration Tests**
   - Test wallet functionality with different storage backends
   - Test contract repository usage patterns
   - Test service worker wallet in browser environment

---

## Migration Guide

### Before (Old Pattern)
```typescript
const wallet = new Wallet();
await wallet.init({
  arkServerUrl: 'https://ark.example.com',
  // ... other options
});
```

### After (New Pattern)
```typescript
const wallet = await Wallet.create({
  storage: new LocalStorageAdapter(),
  identity: new SingleKey(privateKey),
  arkServerUrl: 'https://ark.example.com',
  // ... other options
});
```

### Breaking Changes
- `init()` method removed from both wallet classes
- Identity methods now async-first (sync methods deprecated)
- Storage is now explicitly provided via options
- Constructor is now private, must use `create()` method

### Non-Breaking Changes
- All existing public wallet methods remain unchanged
- Existing Identity sync methods still work (with deprecation warnings)
- Internal storage implementation is transparent to existing code
