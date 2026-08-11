/**
 * covclaimd, from the TRADER's side.
 *
 * Lifted from `packages/boltz-swap/src/covclaimd-provider.ts` (arkade-os/ts-sdk#613)
 * rather than written again: that implementation already had the shape this one
 * wants — bytes rather than hex strings at the boundary, and the pubkeys cached
 * so a swap does not re-fetch them per call. Only the docs below are new. If
 * #613 lands, these two should become one module rather than two copies.
 *
 * WHY THE TRADER CALLS THIS AT ALL. `claimPacket.ts` seals `P` to covclaimd so
 * a trader can go offline after funding, but until now the packet reached
 * covclaimd only by being handed to the solver in the `rfq_request` — which
 * made the trader's ability to go offline depend on the solver having wired a
 * covclaimd, a dependency the trader can neither see nor verify. Its failure is
 * silent in the worst way: a solver that accepts the packet and never forwards
 * it is indistinguishable from one that forwarded it to a covclaimd that never
 * claimed.
 *
 * `reveal` is a REGISTRATION, not a claim instruction: covclaimd stores the
 * packet against the swap's script and claims when it sees the funding
 * transaction. So a trader may register BEFORE the solver funds — which is
 * exactly the window in which a trader who intends to go offline is still
 * online.
 *
 * Registering here and the solver also revealing is belt and braces rather than
 * a double spend: covclaimd keys registrations by pkScript, so the second
 * replaces the first, and a claim already made leaves nothing to spend.
 *
 * KNOWN LIMITS, worth reading before relying on it. covclaimd's registry is in
 * memory, capped, and expires — upstream at the time of writing: 10,000 entries
 * and a 15-minute TTL. So a covclaimd restart drops every pending registration
 * silently, and a swap funded more than the TTL after registering is not
 * claimed. The durable fix is to carry the packet ON the lockup transaction so
 * covclaimd rebuilds intent from the chain instead of from memory; that needs a
 * covclaimd change and is tracked separately.
 *
 * None of this is load-bearing for correctness. The trader holds the covenant's
 * `receiver` key and can always claim the lockup itself (`claim.ts`).
 */
import { hex, base64 } from "@scure/base";

/** covclaimd's advertised keys. `covclaimdPubKey` is what `sealClaimPacket` seals to. */
export type CovclaimdPubKeys = { covclaimdPubKey: Uint8Array; emulatorPubKey: Uint8Array };

export class CovclaimdProvider {
    private readonly baseUrl: string;
    private readonly timeoutMs: number;
    private cachedKeys?: CovclaimdPubKeys;

    constructor(baseUrl: string, timeoutMs = 30_000) {
        this.baseUrl = baseUrl.replace(/\/$/, "");
        this.timeoutMs = timeoutMs;
    }

    async getPubKeys(): Promise<CovclaimdPubKeys> {
        if (this.cachedKeys) return this.cachedKeys;
        const res = await fetch(`${this.baseUrl}/v1/preimage/covclaimd-pubkey`, {
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) throw new Error(`covclaimd getPubKeys failed: ${res.status}`);
        const body = (await res.json()) as { covclaimd_pub_key: string; emulator_pub_key: string };
        this.cachedKeys = {
            covclaimdPubKey: hex.decode(body.covclaimd_pub_key),
            emulatorPubKey: hex.decode(body.emulator_pub_key),
        };
        return this.cachedKeys;
    }

    async reveal(args: {
        swapAddress: string;
        ciphertext: Uint8Array;
        arkadeScript: Uint8Array;
        taptree: Uint8Array;
    }): Promise<void> {
        const res = await fetch(`${this.baseUrl}/v1/reveal`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                swap_address: args.swapAddress,
                packet: {
                    ciphertext: base64.encode(args.ciphertext),
                    arkade_script: base64.encode(args.arkadeScript),
                },
                taptree: hex.encode(args.taptree),
            }),
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => "");
            throw new Error(`covclaimd reveal failed: ${res.status} ${detail}`);
        }
    }
}
