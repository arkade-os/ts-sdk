import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";

export function vtxoReservationScope(operatorUrl: string, publicKey: Uint8Array): string {
    const url = new URL(operatorUrl);
    return hex.encode(
        sha256(
            new TextEncoder().encode(
                `${url.origin}${url.pathname.replace(/\/$/, "")}|${hex.encode(publicKey)}`,
            ),
        ),
    );
}
