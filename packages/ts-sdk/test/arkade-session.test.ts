import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    arkade,
    ContractManager,
    CSVMultisigTapscript,
    DefaultVtxo,
    DelegateVtxo,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    networks,
    RestIndexerProvider,
    type ContractArtifact,
    type IContractManager,
} from "../src";
import { openArkadeClient } from "../src/wallet/arkadeClient";

function xOnly(): Uint8Array {
    return schnorr.getPublicKey(schnorr.utils.randomSecretKey());
}

function arkProvider(server: Uint8Array, serverUrl?: string) {
    const checkpointTapscript = hex.encode(
        CSVMultisigTapscript.encode({
            timelock: { type: "blocks", value: 10n },
            pubkeys: [server],
        }).script,
    );
    return {
        ...(serverUrl ? { serverUrl } : {}),
        async getInfo() {
            return {
                signerPubkey: "02" + hex.encode(server),
                checkpointTapscript,
                network: "regtest",
            } as any;
        },
        async submitTx() {
            throw new Error("not used");
        },
        async finalizeTx() {},
    };
}

const spendArtifact = {
    contractName: "T",
    constructorInputs: [],
    functions: [
        { name: "spend", leaves: [{ name: "spend", asm: ["<SERVER_KEY>", "OP_CHECKSIG"] }] },
    ],
} as ContractArtifact;

describe("Arkade.connect", () => {
    const server = xOnly();

    it("builds the indexer from the operator URL", async () => {
        const client = await arkade.Arkade.connect({
            arkade: arkProvider(server, "http://ark.example"),
            network: networks.regtest,
        });
        expect(client.indexer).toBeInstanceOf(RestIndexerProvider);
        expect((client.indexer as RestIndexerProvider).serverUrl).toBe("http://ark.example");
        expect(client.contractManager).toBeUndefined();
    });

    it("refuses a server URL and an injected operator together", async () => {
        await expect(
            arkade.Arkade.connect({
                serverUrl: "http://ark.example",
                arkade: arkProvider(server),
            }),
        ).rejects.toThrow(/serverUrl/);
    });

    it("refuses a single repository", async () => {
        await expect(
            arkade.Arkade.connect({
                arkade: arkProvider(server),
                contractRepository: new InMemoryContractRepository(),
            }),
        ).rejects.toThrow(/walletRepository/);
    });

    it("starts one manager from the repositories and the derived indexer", async () => {
        const client = await arkade.Arkade.connect({
            arkade: arkProvider(server, "http://ark.example"),
            network: networks.regtest,
            contractRepository: new InMemoryContractRepository(),
            walletRepository: new InMemoryWalletRepository(),
        });
        expect(client.contractManager).toBeInstanceOf(ContractManager);
        expect(client.indexer).toBeInstanceOf(RestIndexerProvider);
        client.dispose();
    });

    it("does not replace a manager it was given", async () => {
        const manager = { dispose() {} } as IContractManager;
        const indexer = {
            async getVtxos() {
                return { vtxos: [] };
            },
            getVirtualTxs: async () => [],
        };
        const client = await arkade.Arkade.connect({
            arkade: arkProvider(server),
            indexer: indexer as any,
            network: networks.regtest,
            contractManager: manager,
        });
        expect(client.contractManager).toBe(manager);
        client.dispose();
        expect(client.contractManager).toBe(manager);
    });

    it("compiles an artifact and the program it reads into the same contract", async () => {
        const client = await arkade.Arkade.connect({
            arkade: arkProvider(server),
            network: networks.regtest,
        });
        const fromArtifact = client.contract(spendArtifact);
        const fromProgram = client.contract(arkade.programFromArtifact(spendArtifact));
        expect(fromArtifact.address).toBe(fromProgram.address);
        expect(hex.encode(fromArtifact.pkScript)).toBe(hex.encode(fromProgram.pkScript));
    });
});

describe("wallet.arkade", () => {
    it("binds the client to the wallet's manager and indexer", async () => {
        const server = xOnly();
        const user = xOnly();
        const manager = { dispose() {} } as IContractManager;
        const indexer = {
            async getVtxos() {
                return { vtxos: [] };
            },
        };
        const client = await openArkadeClient({
            identity: {
                async xOnlyPublicKey() {
                    return user;
                },
                async sign(tx: any) {
                    return tx;
                },
                async signMessage() {
                    return new Uint8Array(64);
                },
                async signerSession() {
                    throw new Error("not used");
                },
            },
            network: networks.regtest,
            getContractManager: async () => manager,
            arkProvider: arkProvider(server),
            indexerProvider: indexer as any,
        });
        expect(client.contractManager).toBe(manager);
        expect(client.indexer).toBe(indexer);
        expect(hex.encode(client.userKey!)).toBe(hex.encode(user));
    });
});

describe("builtin programs", () => {
    const user = xOnly();
    const server = xOnly();
    const delegate = xOnly();

    it("compiles the receive program to the default vtxo script", () => {
        for (const csvTimelock of [
            { type: "blocks" as const, value: 144n },
            { type: "seconds" as const, value: 605184n },
        ]) {
            const legacy = new DefaultVtxo.Script({
                pubKey: user,
                serverPubKey: server,
                csvTimelock,
            });
            const compiled = new arkade.ArkadeProgramScript(
                arkade.forfeitExitProgram(csvTimelock.type),
                { user, server, exitDelay: csvTimelock.value },
                { serverKey: server, userKey: user },
            );
            expect(hex.encode(compiled.pkScript)).toBe(hex.encode(legacy.pkScript));
        }
    });

    it("compiles the delegate program to the delegate vtxo script", () => {
        const csvTimelock = { type: "blocks" as const, value: 144n };
        const legacy = new DelegateVtxo.Script({
            pubKey: user,
            serverPubKey: server,
            delegatePubKey: delegate,
            csvTimelock,
        });
        const compiled = new arkade.ArkadeProgramScript(
            arkade.delegateProgram("blocks"),
            { user, server, delegate, exitDelay: csvTimelock.value },
            { serverKey: server, userKey: user },
        );
        expect(hex.encode(compiled.pkScript)).toBe(hex.encode(legacy.pkScript));
    });
});
