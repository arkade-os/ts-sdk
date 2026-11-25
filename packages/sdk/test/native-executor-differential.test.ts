import { readdirSync, readFileSync } from "node:fs";
import { base64, hex } from "@scure/base";
import { sha256 } from "@scure/btc-signer/utils.js";
import { describe, expect, it, vi } from "vitest";
import {
    ContractManager,
    CSVMultisigTapscript,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    networks,
    Transaction,
    type ArkadeInfo,
    type IWallet,
} from "../src";
import { Arkade } from "../src/arkade";
import { NativeExecutor } from "../src/nativeExecutor";
import { nativeOffchainTx } from "../src/arkade/executor";
import { compile, decode, instantiate } from "../src/arkade/template";
import { decodeArtifact } from "../src/arkade/template/abi";
import { createMockIndexerProvider } from "./contracts/helpers";

// The executor's own BuildOffchain + forEmulator (af8d9eb) over each vector's watch instance, source
// and dust, with a 10-block checkpoint under the server key: sha256 of each PSBT's per-section
// key/value maps, ark tx first. btcd and scure order the fields differently, so bytes would not do.
const GO: Record<string, string[]> = {
    "example-vhtlc-non-interactive-claim": [
        "77a70dfdb1203486d3395fe5feb45f73c7ca4f7e1d4dd28a165cd6e8c9cef179",
        "8d3d16edd6fc00c7ba0bf2ea8889279482a3e9fee9163c810ae9e63336e35fe0",
    ],
    "example-vhtlc-non-interactive-refund-without-receiver": [
        "ffd5cd92ba2cbbaa7e221576481f66edb213ea3e4790ad643c8c21fe916b8cf7",
        "35e7c4af582c166795684813c2845c049d9fdac23ebc3c56a01100d8a8150d0b",
    ],
    locktime: [
        "3e470bddad26ab420f1766dbb9f1674d45e4b2c9b2a309303648c8715be3dee6",
        "e201b8f41c366245881c4db711394e961cbd603511d38bf7aa5c2f6f90a7d3d0",
    ],
    "splice-locking": [
        "77a70dfdb1203486d3395fe5feb45f73c7ca4f7e1d4dd28a165cd6e8c9cef179",
        "8d3d16edd6fc00c7ba0bf2ea8889279482a3e9fee9163c810ae9e63336e35fe0",
    ],
    "supplied-taptree": [
        "77a70dfdb1203486d3395fe5feb45f73c7ca4f7e1d4dd28a165cd6e8c9cef179",
        "8d3d16edd6fc00c7ba0bf2ea8889279482a3e9fee9163c810ae9e63336e35fe0",
    ],
    "supplied-taptree-undelegated": [
        "77a70dfdb1203486d3395fe5feb45f73c7ca4f7e1d4dd28a165cd6e8c9cef179",
        "8d3d16edd6fc00c7ba0bf2ea8889279482a3e9fee9163c810ae9e63336e35fe0",
    ],
    "vhtlc-claim": [
        "77a70dfdb1203486d3395fe5feb45f73c7ca4f7e1d4dd28a165cd6e8c9cef179",
        "8d3d16edd6fc00c7ba0bf2ea8889279482a3e9fee9163c810ae9e63336e35fe0",
    ],
    "vhtlc-claim-plaintext": [
        "77a70dfdb1203486d3395fe5feb45f73c7ca4f7e1d4dd28a165cd6e8c9cef179",
        "8d3d16edd6fc00c7ba0bf2ea8889279482a3e9fee9163c810ae9e63336e35fe0",
    ],
    "virtual-plain-leaf": [
        "eb7c373e68f44ead9aa1bb54876bf34420f26d00bc458271a16b6bcb59f240e5",
        "e86be62e78d7674c672769e252b8a5bd24ffffbaea2ecdf0e49bec5e1fe59f98",
    ],
    "witness-order": [
        "a6f511a341e3426657fea42a5fd8c5daab4e97b3ca579f07e48fd5f3500f9868",
        "8f7ebda2d8011edfbbce4d57fc26a126b44669b38a772e62bbeaa4d18e6a8b93",
    ],
};

const DIR = new URL("./fixtures/template-v1/", import.meta.url);
const utf8 = new TextEncoder();
const vectors = readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ name: f.slice(0, -5), ...JSON.parse(readFileSync(new URL(f, DIR), "utf8")) }))
    .filter((v) => v.template?.type === "virtual" && !v.expected.error);

function digest(psbt: Uint8Array): string {
    let at = 5;
    const size = () => {
        const b = psbt[at++];
        if (b < 0xfd) return b;
        const n = b === 0xfd ? 2 : b === 0xfe ? 4 : 8;
        let v = 0;
        for (let k = n - 1; k >= 0; k--) v = v * 256 + psbt[at + k];
        at += n;
        return v;
    };
    const bytes = () => {
        const n = size();
        at += n;
        return hex.encode(psbt.subarray(at - n, at));
    };
    const sections: [string, string][][] = [];
    while (at < psbt.length) {
        const entries: [string, string][] = [];
        for (let key = bytes(); key !== ""; key = bytes()) entries.push([key, bytes()]);
        sections.push(entries.sort());
    }
    return hex.encode(sha256(utf8.encode(JSON.stringify(sections))));
}

const keysOf = (v: any) =>
    Object.fromEntries(
        Object.entries(v.bindings.keys as Record<string, string>)
            .filter(([, h]) => h)
            .map(([k, h]) => [k, hex.decode(h)]),
    );

// natively a sealed variable is its plaintext, where Go decrypts the fixture's ciphertext
const variablesOf = (v: any) =>
    Object.fromEntries(
        Object.entries(v.bindings.variables as Record<string, string>).map(([n, h]) => [
            n,
            v.request.decryption?.[h] ?? h,
        ]),
    );

const checkpointOf = (server: Uint8Array) =>
    CSVMultisigTapscript.encode({ timelock: { type: "blocks", value: 10n }, pubkeys: [server] });

describe("native execution matches the Go executor", () => {
    it("covers every virtual build vector", () => {
        expect(vectors.map((v) => v.name).sort()).toEqual(Object.keys(GO).sort());
    });

    it.each(vectors.map((v) => [v.name, v]))("%s: ark tx and checkpoints", (name, v: any) => {
        const d = decode(utf8.encode(JSON.stringify(v.template)));
        const artifacts = v.artifacts ?? {};
        const t = compile(
            d,
            new Map(
                d.artifactIds.map((id) => [
                    id,
                    decodeArtifact(utf8.encode(JSON.stringify(artifacts[id]))),
                ]),
            ),
        );
        const keys = keysOf(v);
        const variables = Object.fromEntries(
            Object.entries(variablesOf(v)).map(([n, h]) => [n, hex.decode(h as string)]),
        );
        const [s] = v.request.sources;
        const tx = hex.decode(s.tx_hex);
        const action = instantiate(t, { keys, variables }).build(
            [{ txid: s.txid, vout: s.vout, tx, amount: BigInt(s.amount) }],
            { dust: BigInt(v.request.fee.dust) },
        );
        const coin = { txid: s.txid, vout: s.vout, value: Number(s.amount), tx };
        const { arkTx, checkpoints } = nativeOffchainTx(
            action,
            [coin],
            checkpointOf(keys.server.subarray(1)),
        );
        expect([arkTx, ...checkpoints].map((p) => digest(p.toPSBT()))).toEqual(GO[name]);
    });

    it("executes the locktime vector into the Go executor's ark tx and checkpoint", async () => {
        const v = vectors.find((x) => x.name === "locktime");
        const keys = keysOf(v);
        const indexer = createMockIndexerProvider();
        const contractManager = await ContractManager.create({
            indexerProvider: indexer,
            contractRepository: new InMemoryContractRepository(),
            walletRepository: new InMemoryWalletRepository(),
        });
        const submitTx = vi.fn(async (arkTx: string, checkpointTxs: string[]) => ({
            signedArkTx: arkTx,
            signedCheckpointTxs: checkpointTxs,
        }));
        const arkade = await Arkade.connect({
            arkade: {
                getInfo: async () =>
                    ({
                        signerPubkey: v.bindings.keys.server,
                        dust: 330n,
                        checkpointTapscript: hex.encode(
                            checkpointOf(keys.server.subarray(1)).script,
                        ),
                    }) as ArkadeInfo,
            },
            emulator: { submitTx } as never,
            emulatorPubkey: v.bindings.keys.emulator,
            network: networks.regtest,
            indexer,
            contractManager,
        });
        const wallet = { getContractManager: async () => contractManager };
        const executor = new NativeExecutor(arkade, wallet as unknown as IWallet);
        const execution = await executor.importTemplate(v.template, {
            variables: variablesOf(v),
        });
        const [s] = v.request.sources;
        const source = Transaction.fromRaw(hex.decode(s.tx_hex));
        vi.mocked(indexer.getVirtualTxs).mockResolvedValue({
            txs: [base64.encode(source.toPSBT())],
        });
        vi.spyOn(contractManager, "refreshOutpoints").mockResolvedValue(undefined);
        vi.spyOn(contractManager, "refreshVtxos").mockResolvedValue(undefined);
        vi.spyOn(execution.contract, "getUtxos").mockResolvedValue([
            {
                txid: s.txid,
                vout: s.vout,
                value: Number(s.amount),
                script: hex.encode(execution.contract.pkScript),
                createdAt: new Date(0),
                isUnrolled: false,
                status: { confirmed: false },
            },
        ]);
        const result = await executor.execute(execution, s);
        const [arkTx, checkpointTxs] = submitTx.mock.calls[0];
        expect([arkTx, ...checkpointTxs].map((p) => digest(base64.decode(p)))).toEqual(GO.locktime);
        expect(result.txid).toBe(Transaction.fromPSBT(base64.decode(arkTx)).id);
        contractManager.dispose();
    });
});
