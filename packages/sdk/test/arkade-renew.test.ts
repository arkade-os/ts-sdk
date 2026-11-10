import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@scure/btc-signer/utils.js";
import { arkade, CSVMultisigTapscript, networks, type VirtualCoin } from "../src";
import { Transaction } from "../src/utils/transaction";
import { ConditionWitness, getArkPsbtFields } from "../src/utils/unknownFields";
import { SettlementEventType } from "../src/providers/ark";
import { createArkadeBatchHandler } from "../src/arkade/batch";
import { getVirtualTxs, mintCoin } from "./helpers/prevArkTx";

// The real handler by default; a test stubs it to drive a batch without real trees.
vi.mock("../src/arkade/batch", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/arkade/batch")>();
    return { ...actual, createArkadeBatchHandler: vi.fn(actual.createArkadeBatchHandler) };
});

const xOnly = () => schnorr.getPublicKey(schnorr.utils.randomSecretKey());
const renewable = arkade.programFromArtifact(
    JSON.parse(
        readFileSync(
            new URL("./fixtures/arkadec/renewable.artifact.json", import.meta.url),
            "utf8",
        ),
    ),
);

/** `renewable` whose `renew` leaf also requires `tapscript` (a condition, a timelock, ...). */
function renewableWith(
    tapscript: Partial<arkade.TapscriptSegment>,
    params: arkade.InputDef[] = [],
) {
    const renew = renewable.functions.renew;
    return {
        ...renewable,
        params: [...(renewable.params ?? []), ...params],
        functions: {
            ...renewable.functions,
            renew: { ...renew, tapscript: { ...renew.tapscript, ...tapscript } },
        },
    } as arkade.Program;
}

const PREIMAGE = new Uint8Array(32).fill(9);
const hashlocked = renewableWith({ asm: ["SHA256", "$hash", "EQUAL"], witness: ["$preimage"] }, [
    { name: "hash", type: "bytes32" },
    { name: "preimage", type: "bytes" },
]);

/** A keeper's client whose server serves `stream` and advertises `info` on top of the basics. */
async function keeper(
    stream: (signal: AbortSignal) => AsyncIterableIterator<never>,
    info: Record<string, unknown> = {},
) {
    const server = xOnly();
    const registerIntent = vi.fn(async () => "intent-1");
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
                    ...info,
                } as any;
            },
            registerIntent,
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
    return { ark, target: { contract, coin }, registerIntent };
}

describe("renewProgramContractOutputs", () => {
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
            arkade.renewProgramContractOutputs(ark, [target], { signal: caller.signal }),
        ).rejects.toThrow(/aborted before the batch completed/);
        expect(streams[0]?.aborted).toBe(true);
    });

    it("refuses a covenant leaf that needs a key besides the server's", async () => {
        const { ark, registerIntent } = await keeper(() => {
            throw new Error("no stream expected");
        });
        const ownerSigned = {
            version: 1,
            params: [
                { name: "owner", type: "pubkey" },
                { name: "server", type: "pubkey" },
            ],
            functions: {
                renew: {
                    tapscript: { signers: ["$server", "$owner"], asm: [] },
                    arkadeScript: { asm: ["INSPECTVERSION", 2, "NUMEQUAL"] },
                },
            },
        } satisfies arkade.Program;
        const contract = ark.contract(ownerSigned, { owner: xOnly() });
        const coin = {
            ...mintCoin(5000),
            script: hex.encode(contract.pkScript),
            status: { confirmed: true },
        } as unknown as VirtualCoin;

        await expect(arkade.renewProgramContractOutputs(ark, [{ contract, coin }])).rejects.toThrow(
            /needs a signature besides the server's/,
        );
        expect(registerIntent).not.toHaveBeenCalled();
    });

    it("registers no intent when the caller aborts while the proof is being signed", async () => {
        const { ark, target, registerIntent } = await keeper(() => {
            throw new Error("no stream expected");
        });
        const caller = new AbortController();
        (ark.emulator as { submitIntent: unknown }).submitIntent = async ({
            proof,
        }: {
            proof: string;
        }) => {
            caller.abort();
            return proof;
        };

        await expect(
            arkade.renewProgramContractOutputs(ark, [target], { signal: caller.signal }),
        ).rejects.toThrow(/aborted before the batch completed/);
        expect(registerIntent).not.toHaveBeenCalled();
    });

    it("refuses a coin listed twice", async () => {
        const { ark, target, registerIntent } = await keeper(() => {
            throw new Error("no stream expected");
        });

        await expect(arkade.renewProgramContractOutputs(ark, [target, target])).rejects.toThrow(
            /listed twice/,
        );
        expect(registerIntent).not.toHaveBeenCalled();
    });

    it("registers no intent when the caller's signal is already aborted", async () => {
        const { ark, target, registerIntent } = await keeper(() => {
            throw new Error("no stream expected");
        });

        await expect(
            arkade.renewProgramContractOutputs(ark, [target], { signal: AbortSignal.abort() }),
        ).rejects.toThrow(/aborted before the batch completed/);
        expect(registerIntent).not.toHaveBeenCalled();
    });

    it("subscribes to batch events before registering the intent", async () => {
        const order: string[] = [];
        const { ark, target, registerIntent } = await keeper(() =>
            (async function* () {
                order.push("subscribed");
                throw new Error("stream closed");
            })(),
        );
        registerIntent.mockImplementation(async () => {
            order.push("registered");
            return "intent-1";
        });

        await expect(arkade.renewProgramContractOutputs(ark, [target])).rejects.toThrow(
            /stream closed/,
        );
        expect(order).toEqual(["subscribed", "registered"]);
    });

    it("refuses a renewal the server would charge a fee for", async () => {
        const { ark, target, registerIntent } = await keeper(
            () => {
                throw new Error("no stream expected");
            },
            { fees: { intentFee: { offchainInput: "100.0" }, txFeeRate: "0" } },
        );

        await expect(arkade.renewProgramContractOutputs(ark, [target])).rejects.toThrow(
            /charges 100 sats/,
        );
        expect(ark.emulator!.submitIntent).not.toHaveBeenCalled();
        expect(registerIntent).not.toHaveBeenCalled();
    });

    it("renews when the server's fee program charges these coins nothing", async () => {
        const { ark, target, registerIntent } = await keeper(
            () =>
                (async function* () {
                    throw new Error("stream closed");
                })(),
            {
                fees: {
                    intentFee: { offchainInput: "amount > 10000.0 ? 100.0 : 0.0" },
                    txFeeRate: "0",
                },
            },
        );

        await expect(arkade.renewProgramContractOutputs(ark, [target])).rejects.toThrow(
            /stream closed/,
        );
        expect(registerIntent).toHaveBeenCalledTimes(1);
    });

    it("carries the renew leaf's condition witness on the proof", async () => {
        const { ark, registerIntent } = await keeper(() =>
            (async function* () {
                throw new Error("stream closed");
            })(),
        );
        const contract = ark.contract(hashlocked, {
            owner: xOnly(),
            hash: sha256(PREIMAGE),
            preimage: PREIMAGE,
        });
        const coin = {
            ...mintCoin(5000),
            script: hex.encode(contract.pkScript),
            status: { confirmed: true },
        } as unknown as VirtualCoin;

        await expect(arkade.renewProgramContractOutputs(ark, [{ contract, coin }])).rejects.toThrow(
            /stream closed/,
        );
        const { proof } = (registerIntent.mock.calls[0] as unknown[])[0] as { proof: string };
        const tx = Transaction.fromPSBT(base64.decode(proof));
        expect(getArkPsbtFields(tx, 1, ConditionWitness)).toEqual([[PREIMAGE]]);
    });

    it("refuses a renew leaf whose witness needs a call argument", async () => {
        const { ark, registerIntent } = await keeper(() => {
            throw new Error("no stream expected");
        });
        const program = renewableWith(
            { asm: ["SHA256", "$hash", "EQUAL"], witness: ["preimage"] },
            [{ name: "hash", type: "bytes32" }],
        );
        const contract = ark.contract(program, { owner: xOnly(), hash: sha256(PREIMAGE) });
        const coin = {
            ...mintCoin(5000),
            script: hex.encode(contract.pkScript),
            status: { confirmed: true },
        } as unknown as VirtualCoin;

        await expect(arkade.renewProgramContractOutputs(ark, [{ contract, coin }])).rejects.toThrow(
            /needs call arguments/,
        );
        expect(ark.emulator!.submitIntent).not.toHaveBeenCalled();
        expect(registerIntent).not.toHaveBeenCalled();
    });

    it("refuses a renew leaf with a CSV timelock, which arkd refuses as a forfeit", async () => {
        const { ark, registerIntent } = await keeper(() => {
            throw new Error("no stream expected");
        });
        const program = renewableWith({ csv: { type: "blocks", value: 10n } });
        const contract = ark.contract(program, { owner: xOnly() });
        const coin = {
            ...mintCoin(5000),
            script: hex.encode(contract.pkScript),
            status: { confirmed: true },
        } as unknown as VirtualCoin;

        await expect(arkade.renewProgramContractOutputs(ark, [{ contract, coin }])).rejects.toThrow(
            /CSV timelock/,
        );
        expect(registerIntent).not.toHaveBeenCalled();
    });

    it("returns the commitment when the caller aborts while the forfeits are sent", async () => {
        const caller = new AbortController();
        vi.mocked(createArkadeBatchHandler).mockReturnValueOnce({
            onBatchStarted: async () => ({ skip: false }),
            onTreeSigningStarted: async () => ({ skip: false }),
            onTreeNonces: async () => ({ fullySigned: true }),
            // arkd can commit the batch from here on, whatever the caller does.
            onBatchFinalization: async () => caller.abort(),
        });
        const node = new Transaction();
        node.addInput({ txid: new Uint8Array(32), index: 0 });
        node.addOutput({ script: new Uint8Array([0x51]), amount: 1000n });
        const { ark, target } = await keeper(
            () =>
                (async function* () {
                    yield { type: SettlementEventType.BatchStarted };
                    yield {
                        type: SettlementEventType.TreeTx,
                        batchIndex: 0,
                        chunk: { txid: node.id, tx: base64.encode(node.toPSBT()), children: {} },
                    };
                    yield { type: SettlementEventType.TreeSigningStarted };
                    yield { type: SettlementEventType.TreeNonces };
                    yield { type: SettlementEventType.BatchFinalization };
                    // A tick for an honoured abort to reject the renewal before this arrives.
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    yield { type: SettlementEventType.BatchFinalized, commitmentTxid: "commit-1" };
                })() as AsyncIterableIterator<never>,
        );

        await expect(
            arkade.renewProgramContractOutputs(ark, [target], { signal: caller.signal }),
        ).resolves.toEqual({ commitmentTxid: "commit-1", intentId: "intent-1" });
    });

    it("leaves no listener on the caller's signal", async () => {
        const { ark, target } = await keeper(() =>
            (async function* () {
                throw new Error("stream closed");
            })(),
        );
        const caller = new AbortController();

        await expect(
            arkade.renewProgramContractOutputs(ark, [target], { signal: caller.signal }),
        ).rejects.toThrow(/stream closed/);
        expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    });
});
