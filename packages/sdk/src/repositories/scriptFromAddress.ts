import { hex } from "@scure/base";
import { ArkAddress } from "../index";

/**
 * Compute the hex-encoded `scriptPubKey` locking a VTXO from its owning Ark
 * address. Used by repository-layer migrations to backfill `script` on legacy
 * rows that pre-date the column (the indexer now guarantees the field, so new
 * rows never go through this path). The `script` field is required by the
 * domain type, so backfill must produce the same value the indexer would
 * have returned — which is the hex of the address's `pkScript`.
 */
export function scriptFromArkAddress(address: string): string {
    return hex.encode(ArkAddress.decode(address).pkScript);
}
