/**
 * The two string aliases the v2 surface is written in.
 *
 * Aliases rather than branded types: they document what a field carries at the
 * places §3.1's `Quote` reads (`lock.hash`, `solver`) without making every
 * literal go through a constructor. Core exports neither, so nothing here is a
 * duplicate.
 */

/** Lowercase hex, no `0x` prefix — the encoding `@scure/base`'s `hex` emits. */
export type Hex = string;

/** A secp256k1 public key as {@link Hex}: x-only (32 bytes) or compressed (33). */
export type Pubkey = Hex;
