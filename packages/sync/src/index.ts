export {
    CSE_V1_SCHEME,
    deriveKwk,
    seal,
    open,
    type RandomBytes,
    type SealOptions,
} from "./crypto/cseV1";

export {
    BucketSyncClient,
    BucketSyncAuthError,
    BucketSyncHttpError,
    type BucketSyncClientOptions,
} from "./protocol/client";
export { authMessage, type SchnorrSigner } from "./protocol/auth";
export type {
    ChallengeResponse,
    TokenResponse,
    HeadResponse,
    EntryDto,
    EntriesResponse,
    WriteOpDto,
    CommitRequest,
    ConflictDto,
    CommitResponse,
    DiffResponse,
    ChangesResponse,
} from "./protocol/types";

export {
    BucketSync,
    SyncConflictError,
    localWins,
    type BucketApi,
    type BucketSyncOptions,
    type ConflictResolver,
    type ApplyFn,
} from "./sync/bucketSync";

export {
    type SyncSource,
    ContractSource,
    WalletStateSource,
    CONTRACT_PREFIX,
    WALLET_STATE_KEY,
} from "./sync/sources";
export { WalletSync, type WalletSyncOptions } from "./sync/walletSync";
export { SyncedContractRepository } from "./repositories/syncedContractRepository";
