/**
 * Does the emulator actually sign a spend of `nonInteractiveRefundWithoutReceiver`?
 *
 * That leaf (`VHTLC.ScriptV2.nonInteractiveRefundWithoutReceiver`) is new:
 * `CLTVMultisigTapscript.encode({ absoluteTimelock: refundLocktime, pubkeys:
 * [server, nirCosigner] })`, where `nirCosigner` is the emulator key tweaked
 * by `enforcePayTo(senderPkScript)` — the same covenant token sequence
 * `nonInteractiveRefund` uses, just gated by a CLTV instead of the receiver's
 * signature. `vhtlc-vectors.test.ts` pins its bytes and its position in the
 * nine-leaf tree; nothing before this file asked the emulator to sign a real
 * spend of it. This does three things a byte fixture cannot:
 *
 *  1. proves the hand-transcribed artifact below is byte-identical to what
 *     `VHTLC.ScriptV2` actually emits for this leaf's ArkadeScript, the same
 *     way `asset-covenant.test.ts` proves it for `nonInteractiveClaim`;
 *  2. funds it, matures the CLTV on a REAL regtest chain, and shows the
 *     emulator refuses a spend that misdirects the payout or shortchanges it
 *     — the covenant is load-bearing, not decorative;
 *  3. shows the emulator signs a spend that pays `senderPkScript` in full,
 *     and that the resulting VTXO lands there.
 *
 * THE TRAP THIS FILE EXISTS TO NAME: `refundLocktime` cannot be a small
 * block-height literal here, unlike every other VHTLC e2e fixture in this
 * suite (`vhtlc.test.ts` uses `1000` and `coreBlockCount() + 5`). Confirmed
 * against this repo's pinned arkd (v0.9.14): ANY vtxo script carrying a
 * block-typed CLTV leaf (< 500_000_000 — the same `CLTV_HEIGHT_THRESHOLD`
 * `src/contracts/handlers/helpers.ts` names) is refused at `submitTx` —
 * `INVALID_VTXO_SCRIPT (10): invalid forfeit closure, CLTV block type not
 * allowed` — for EVERY leaf in that script, not just the CLTV one.
 * Reproduced independently of this PR: `vhtlc.test.ts`'s
 * `should claim` (spends the unrelated `claim` leaf) and `should refund
 * without receiver on a post-maturity retry` both fail on it against the
 * same live stack, on `main`. So this file's `refundLocktime` is a
 * SECONDS-typed absolute timestamp (current chain median-time-past plus a
 * few seconds), matured by advancing the chain's own median-time-past — see
 * `matureAbsoluteLocktime` below — not by mining a fixed block count.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    arkade,
    VHTLC,
    networks,
    RestArkProvider,
    RestIndexerProvider,
    RestEmulatorProvider,
} from "../../src";
import { beforeEachFaucet, execCommand, faucetOffchain, mineBlocks, randomP2TR } from "./utils";

const EMULATOR_URL = "http://localhost:7073";
const ARK_SERVER_URL = "http://localhost:7070";
const CONTRACT_AMOUNT = 10_000n;
/** How far past the chain's current median-time-past the locktime sits at construction time — must be > 0 so the leaf is immature the moment it is built. */
const CLTV_OFFSET_SECONDS = 8n;

/**
 * `enforcePayTo(senderPkScript)` (see `src/script/vhtlc.ts`), transcribed
 * token for token — the same shape `asset-covenant.test.ts`'s
 * `scriptV2Shaped` uses for its sat clause, minus the asset half this leaf
 * doesn't carry. `resolveAsm`-equality against `VHTLC.ScriptV2`'s own output
 * (below) is what actually proves the transcription, not this comment.
 */
const nirWithoutReceiverProgram = (refundLocktime: bigint) =>
    ({
        version: 0,
        params: ["server", "sender"],
        functions: {
            refund: {
                tapscript: { signers: ["$server"], cltv: refundLocktime },
                arkadeScript: {
                    asm: [
                        "PUSHCURRENTINPUTINDEX",
                        "DUP",
                        "INSPECTOUTPUTSCRIPTPUBKEY",
                        1,
                        "EQUALVERIFY",
                        "$sender",
                        "EQUALVERIFY",
                        "INSPECTOUTPUTVALUE",
                        "PUSHCURRENTINPUTINDEX",
                        "INSPECTINPUTVALUE",
                        "GREATERTHANOREQUAL",
                    ],
                    witness: [],
                },
            },
        },
    }) satisfies arkade.Program;

/** `bitcoin-cli getblockchaininfo`, parsed — the chain height and its real median-time-past (not an indexer's, which trails it). */
function chainInfo(): { blocks: number; mediantime: number } {
    const raw = execCommand("node regtest/regtest.mjs rpc getblockchaininfo");
    return JSON.parse(raw);
}

/**
 * Advance the chain's median-time-past strictly past `targetUnix`.
 *
 * A CLTV leaf matures against MTP (the median of the last 11 blocks'
 * timestamps), not the wall clock or the tip's own time. Mining alone does
 * not help until real time has actually passed `targetUnix`: a freshly mined
 * regtest block is timestamped at `max(now, prevBlockTime + 1)`, so it can
 * never carry a timestamp ahead of the real clock. This sleeps only as long
 * as still needed (an already-stale MTP — the common case after any pause
 * between stack startup and this test — may need no sleep at all, since MTP
 * can already trail the wall clock by more than `CLTV_OFFSET_SECONDS`), then
 * mines enough blocks that the NEW timestamps dominate the 11-block median,
 * and verifies against a fresh read rather than assuming the wait sufficed.
 */
async function matureAbsoluteLocktime(targetUnix: bigint): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        const waitSec = Number(targetUnix) - Math.floor(Date.now() / 1000) + 2;
        if (waitSec > 0) {
            await new Promise((r) => setTimeout(r, Math.min(waitSec, 10) * 1000));
        }
        mineBlocks(11);
        if (chainInfo().mediantime > Number(targetUnix)) return;
    }
    throw new Error("matureAbsoluteLocktime: timed out waiting for chain MTP to mature");
}

describe("non-interactive refund without receiver (VHTLC.ScriptV2 covenant leaf)", () => {
    const emulator = new RestEmulatorProvider(EMULATOR_URL);
    const arkProvider = new RestArkProvider(ARK_SERVER_URL);
    const indexerProvider = new RestIndexerProvider(ARK_SERVER_URL);

    beforeEach(beforeEachFaucet, 20000);

    it("the emulator signs a matured spend paying senderPkScript, and refuses one that doesn't", {
        timeout: 180000,
    }, async () => {
        const senderPkScript = randomP2TR();
        const refundLocktime = BigInt(chainInfo().mediantime) + CLTV_OFFSET_SECONDS;

        // (0) THE PROOF. Same method `asset-covenant.test.ts` uses for
        // `nonInteractiveClaim`: compile the real leaf through the SDK and
        // compare its ArkadeScript, byte for byte, against `resolveAsm` on
        // the artifact above. Every other VHTLC.Options field is filler —
        // none of it reaches this leaf's ArkadeScript, only `senderPkScript`
        // does (see `enforcePayToMaybeAsset`).
        const fromSdk = new VHTLC.ScriptV2({
            preimageHash: new Uint8Array(20).fill(0x11),
            sender: schnorr.getPublicKey(new Uint8Array(32).fill(1)),
            receiver: schnorr.getPublicKey(new Uint8Array(32).fill(2)),
            server: schnorr.getPublicKey(new Uint8Array(32).fill(3)),
            refundLocktime,
            unilateralClaimDelay: { type: "seconds", value: 512n },
            unilateralRefundDelay: { type: "seconds", value: 1024n },
            unilateralRefundWithoutReceiverDelay: { type: "seconds", value: 1536n },
            nonInteractiveRefund: {
                senderPkScript,
                emulatorPubkey: schnorr.getPublicKey(new Uint8Array(32).fill(5)),
                withoutReceiver: true,
            },
        }).nonInteractiveRefundWithoutReceiverArkadeScript!;
        const program = nirWithoutReceiverProgram(refundLocktime);
        const fromArtifact = arkade.resolveAsm(program.functions.refund.arkadeScript.asm, {
            sender: senderPkScript.slice(2),
        });
        expect(hex.encode(fromArtifact)).toBe(hex.encode(fromSdk));

        // (1) Fund the covenant-CLTV contract. Immature the moment it
        // exists: `refundLocktime` sits strictly ahead of the MTP it was
        // read from.
        const ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            indexer: indexerProvider,
            network: networks.regtest,
        });
        const contract = ark.contract(program, { sender: senderPkScript.slice(2) });
        faucetOffchain(contract.address, Number(CONTRACT_AMOUNT));
        await waitForVtxo(indexerProvider, contract.pkScript);

        // (2) IMMATURE. Covenant satisfied in full (right destination,
        // right amount) — the CLTV is the only thing that can refuse this,
        // isolating arkd's own timelock gate on the new leaf from the
        // covenant the emulator evaluates.
        await expect(
            contract.functions.refund().to(senderPkScript, CONTRACT_AMOUNT).send(),
        ).rejects.toThrow();

        await matureAbsoluteLocktime(refundLocktime);

        // (3) MATURE, MISDIRECTED. Right amount, wrong destination — only
        // `INSPECTOUTPUTSCRIPTPUBKEY ... EQUALVERIFY` refuses this, now
        // that the CLTV can no longer be the reason.
        await expect(
            contract.functions.refund().to(randomP2TR(), CONTRACT_AMOUNT).send(),
        ).rejects.toThrow();

        // (4) MATURE, SHORTCHANGED. Right destination, but one sat short —
        // routed to a second output so the tx still balances — refused only
        // by `INSPECTOUTPUTVALUE ... GREATERTHANOREQUAL`. Mirrors the
        // wrong-amount case in `non-interactive-htlc.test.ts`.
        await expect(
            contract.functions
                .refund()
                .to([
                    { script: senderPkScript, amount: CONTRACT_AMOUNT - 1n },
                    { script: randomP2TR(), amount: 1n },
                ])
                .send(),
        ).rejects.toThrow();

        // (5) MATURE, CORRECT. The emulator signs for `nirCosigner`, arkd
        // accepts the now-matured CLTV tapscript, and the payout lands at
        // `senderPkScript` — the leaf this PR added, spent end to end.
        const { txid } = await contract.functions
            .refund()
            .to(senderPkScript, CONTRACT_AMOUNT)
            .send();

        const [vtxo] = await waitForVtxo(indexerProvider, senderPkScript);
        expect(vtxo.txid).toBe(txid);
    });
});

/** Wait for at least one VTXO at the given pkScript */
async function waitForVtxo(indexer: RestIndexerProvider, pkScript: Uint8Array, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const resp = await indexer.getVtxos({
            scripts: [hex.encode(pkScript)],
            spendableOnly: true,
        });
        if (resp.vtxos.length > 0) return resp.vtxos;
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("waitForVtxo: timeout");
}
