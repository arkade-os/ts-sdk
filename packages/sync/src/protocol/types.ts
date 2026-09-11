/**
 * Wire DTOs for the bucket-sync protocol (v1). Field names are camelCase to
 * match the server's JSON (see the OpenAPI document in the bucket-sync-server
 * repo). `value` fields are base64 strings and opaque to the server; encryption
 * lives one layer up in the sync engine.
 */

export interface ChallengeResponse {
    nonce: string;
    expiresAt: string;
}

export interface TokenResponse {
    token: string;
    expiresAt: string;
}

export interface HeadResponse {
    currentSeq: number;
    contentHash: string;
}

/** A stored bucket entry as returned by get/diff/changes. `value` is base64. */
export interface EntryDto {
    key: string;
    version: number;
    seq: number;
    contentHash: string;
    scheme: string;
    deleted: boolean;
    value: string;
    updatedAt: string;
}

export interface EntriesResponse {
    entries: EntryDto[];
}

/** A single write in a commit batch. `value` is base64 (ignored when `delete` is true). */
export interface WriteOpDto {
    key: string;
    expectedVersion: number;
    scheme: string;
    value: string;
    delete: boolean;
}

export interface CommitRequest {
    ops: WriteOpDto[];
}

export interface ConflictDto {
    key: string;
    currentVersion: number;
}

/** Result of a commit. `committed:false` (HTTP 409) carries the conflicting keys. */
export interface CommitResponse {
    committed: boolean;
    newSeq: number;
    conflicts: ConflictDto[];
}

export interface DiffResponse {
    entries: EntryDto[];
    nextSeq: number;
    hasMore: boolean;
}

export interface ChangesResponse {
    entries: EntryDto[];
    nextSince: string;
    hasMore: boolean;
}
