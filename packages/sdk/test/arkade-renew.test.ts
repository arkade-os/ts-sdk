import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { arkade, CSVMultisigTapscript, networks, type VirtualCoin } from "../src";
import { getVirtualTxs, mintCoin } from "./helpers/prevArkTx";

const xOnly = () => schnorr.getPublicKey(schnorr.utils.randomSecretKey());
const renewable = arkade.programFromArtifact(
    JSON.parse(
        readFileSync(
            new URL("./fixtures/arkadec/renewable.artifact.json", import.meta.url),
            "utf8",
        ),
    ),
);

/** A keeper's client whose server serves `stream` once the intent is registered. */
async function keeper(stream: (signal: AbortSignal) => AsyncIterableIterator<never>) {
    const server = xOnly();
    const ark = await arkade.Arkade.connect({
        arkade: {
            async getInfo() {
                const checkpoint = CSVMultisigTapscript.encode({
                    timelock: { type: "blocks", value: 10n },
                    pubkeys: [server],
                }).script;
                return {
                    signerPubkey: "02" + hex.encode(server),
                    checkpointTapscript: hex.encode(checkpoint),
                    unilateralExitDelay: 20n,
                } as any;
            },
            registerIntent: vi.fn(async () => "intent-1"),
            getEventStream: stream,
        } as any,
        emulator: { submitIntent: vi.fn(async ({ proof }) => proof) } as any,
        indexer: { getVtxos: vi.fn(), getVirtualTxs },
        network: networks.regtest,
    });
    const contract = ark.contract(renewable, { owner: xOnly() });
    const coin = {
        ...mintCoin(5000),
        script: hex.encode(contract.pkScript),
        status: { confirmed: true },
    } as unknown as VirtualCoin;
    return { ark, target: { contract, coin } };
}

describe("renewArkadeVtxos", () => {
    it("gives up when the caller's signal aborts before a batch starts", async () => {
        const streams: AbortSignal[] = [];
        const { ark, target } = await keeper((signal) => {
            streams.push(signal);
            return (async function* () {
                await new Promise((resolve) => signal.addEventListener("abort", resolve));
            })();
        });
        const caller = new AbortController();
        setTimeout(() => caller.abort(), 50);

        await expect(
            arkade.renewArkadeVtxos(ark, [target], { signal: caller.signal }),
        ).rejects.toThrow(/aborted before the batch completed/);
        expect(streams[0]?.aborted).toBe(true);
    });

    it("leaves no listener on the caller's signal", async () => {
        const { ark, target } = await keeper(() =>
            (async function* () {
                throw new Error("stream closed");
            })(),
        );
        const caller = new AbortController();

        await expect(
            arkade.renewArkadeVtxos(ark, [target], { signal: caller.signal }),
        ).rejects.toThrow(/stream closed/);
        expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    });
});
