/**
 * The trader's own covclaimd registration, against a LIVE covclaimd.
 *
 * This exists to close `claimPacket.ts`'s standing TODO. The sealing there was
 * pinned only by vectors this package generated for itself, which proves the
 * implementation is self-consistent and nothing about whether covclaimd can
 * open what it produces. Those are very different claims, and only the second
 * one matters: a packet covclaimd cannot decrypt fails at the moment a trader
 * has gone offline trusting it, which is the worst possible time to find out.
 *
 * A 200 from `/v1/reveal` is the assertion. covclaimd decrypts the packet
 * before it will register anything — a packet sealed to the wrong key dies at
 * the AEAD tag with a 400, and a taptree that does not hash to `swap_address`
 * is refused as well — so acceptance means the ECIES construction, the wire
 * layout, the preimage-to-condition binding and the taptree derivation are all
 * right together. Nothing here mocks covclaimd, because a mock would only
 * re-assert this package's own understanding of the protocol.
 *
 * Needs a covclaimd (default `http://localhost:7271`, override with
 * `COVCLAIMD_URL`) and an arkd (`ARK_SERVER_URL`) to read the real server key
 * from. Skipped, loudly, when they are not reachable: this is an integration
 * test and pretending otherwise would let the TODO silently reopen.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { hex, base64 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { ArkAddress } from "@arkade-os/sdk";
import { sealClaimPacket } from "../../src/claimPacket";
import { CovclaimdProvider } from "../../src/covclaimd";
import { receiveVtxoScript } from "../../src/rfq";

const COVCLAIMD_URL = process.env.COVCLAIMD_URL ?? "http://localhost:7271";
const ARK_SERVER_URL = process.env.ARK_SERVER_URL ?? "http://localhost:7070";

const reachable = async (url: string): Promise<boolean> => {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
        return response.ok;
    } catch {
        return false;
    }
};

/** arkd's own signer key — the covenant's `server` role, which covclaimd matches its closure against. */
const serverPubkey = async (): Promise<Uint8Array> => {
    const response = await fetch(`${ARK_SERVER_URL.replace(/\/$/, "")}/v1/info`, {
        signal: AbortSignal.timeout(5000),
    });
    const body = (await response.json()) as { signerPubkey?: string; signer_pubkey?: string };
    const key = body.signerPubkey ?? body.signer_pubkey;
    if (!key) throw new Error("arkd /v1/info reported no signer pubkey");
    // arkd reports it compressed; the covenant wants x-only.
    const bytes = hex.decode(key);
    return bytes.length === 33 ? bytes.slice(1) : bytes;
};

describe("covclaimd registration, live", () => {
    let up = false;

    beforeAll(async () => {
        up =
            (await reachable(`${COVCLAIMD_URL}/v1/preimage/covclaimd-pubkey`)) &&
            (await reachable(`${ARK_SERVER_URL}/v1/info`));
        if (!up) {
            // eslint-disable-next-line no-console
            console.warn(
                `[covclaimd e2e] SKIPPED — need covclaimd at ${COVCLAIMD_URL} and arkd at ${ARK_SERVER_URL}`,
            );
        }
    });

    it("accepts a packet this package sealed, against a taptree it derived", async () => {
        if (!up) return;

        const covclaimd = new CovclaimdProvider(COVCLAIMD_URL);
        const keys = await covclaimd.getPubKeys();
        expect(keys.covclaimdPubKey).toHaveLength(33);
        expect(keys.emulatorPubKey).toHaveLength(33);

        // A swap that could exist: the trader is `receiver`, the solver `sender`,
        // and `nonInteractiveClaim` is pinned to the trader's own payout script —
        // the leaf covclaimd looks for and the destination it pays.
        const preimage = crypto.getRandomValues(new Uint8Array(32));
        const paymentHash = hex.encode(sha256(preimage));
        const traderKey = schnorr.utils.randomSecretKey();
        const traderPubkey = schnorr.getPublicKey(traderKey);
        const solverKey = schnorr.utils.randomSecretKey();
        const payoutAddress = new ArkAddress(keys.emulatorPubKey.slice(1), traderPubkey, "ark");
        const payoutPkScript = payoutAddress.pkScript;

        const script = receiveVtxoScript({
            paymentHash,
            serverPubkey: await serverPubkey(),
            emulatorPubkey: keys.emulatorPubKey,
            solverPubkey: schnorr.getPublicKey(solverKey),
            solverRefundPkScript: payoutPkScript,
            payoutPubkey: traderPubkey,
            payoutPkScript,
            refundLocktime: Math.floor(Date.now() / 1000) + 7200,
            claimDelay: 1024,
        });

        const sealed = await sealClaimPacket({
            preimage,
            covclaimdPubkey: keys.covclaimdPubKey,
        });

        // THE ASSERTION. Not throwing means covclaimd decrypted a packet this
        // package sealed, and matched it to a taptree this package derived.
        await expect(
            covclaimd.reveal({
                swapAddress: script.address("ark", await serverPubkey()).encode(),
                ciphertext: base64.decode(sealed.ciphertext),
                arkadeScript: script.nonInteractiveClaimArkadeScript ?? new Uint8Array(),
                taptree: script.encode(),
            }),
        ).resolves.toBeUndefined();
    });

    it("refuses a packet sealed to the wrong key, rather than registering it", async () => {
        if (!up) return;

        // The negative control the positive case needs to mean anything: if
        // covclaimd accepted this too, a 200 above would say nothing about the
        // sealing at all.
        const covclaimd = new CovclaimdProvider(COVCLAIMD_URL);
        const keys = await covclaimd.getPubKeys();
        const preimage = crypto.getRandomValues(new Uint8Array(32));
        const wrongKey = schnorr.utils.randomSecretKey();
        const sealed = await sealClaimPacket({
            preimage,
            covclaimdPubkey: hex.decode(`02${hex.encode(schnorr.getPublicKey(wrongKey))}`),
        });

        const script = receiveVtxoScript({
            paymentHash: hex.encode(sha256(preimage)),
            serverPubkey: await serverPubkey(),
            emulatorPubkey: keys.emulatorPubKey,
            solverPubkey: schnorr.getPublicKey(schnorr.utils.randomSecretKey()),
            solverRefundPkScript: new ArkAddress(
                keys.emulatorPubKey.slice(1),
                schnorr.getPublicKey(schnorr.utils.randomSecretKey()),
                "ark",
            ).pkScript,
            payoutPubkey: schnorr.getPublicKey(schnorr.utils.randomSecretKey()),
            payoutPkScript: new ArkAddress(
                keys.emulatorPubKey.slice(1),
                schnorr.getPublicKey(schnorr.utils.randomSecretKey()),
                "ark",
            ).pkScript,
            refundLocktime: Math.floor(Date.now() / 1000) + 7200,
            claimDelay: 1024,
        });

        await expect(
            covclaimd.reveal({
                swapAddress: script.address("ark", await serverPubkey()).encode(),
                ciphertext: base64.decode(sealed.ciphertext),
                arkadeScript: new Uint8Array(),
                taptree: script.encode(),
            }),
        ).rejects.toThrow();
    });
});
