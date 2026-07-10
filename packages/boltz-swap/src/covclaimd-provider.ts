import { hex, base64 } from "@scure/base";

type PubKeys = { covclaimdPubKey: Uint8Array; emulatorPubKey: Uint8Array };

export class CovclaimdProvider {
    private readonly baseUrl: string;
    private cachedKeys?: PubKeys;

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl.replace(/\/$/, "");
    }

    async getPubKeys(): Promise<PubKeys> {
        if (this.cachedKeys) return this.cachedKeys;
        const res = await fetch(`${this.baseUrl}/v1/preimage/covclaimd-pubkey`);
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
            }),
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => "");
            throw new Error(`covclaimd reveal failed: ${res.status} ${detail}`);
        }
    }
}
