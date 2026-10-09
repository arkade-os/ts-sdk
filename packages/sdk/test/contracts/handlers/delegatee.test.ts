import { describe, it, expect, vi } from "vitest";
import { hex } from "@scure/base";
import {
    contractHandlers,
    ContractManager,
    DelegateeContractHandler,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    networks,
    watchDelegateeContracts,
    type Contract,
    type DelegateeDefault,
} from "../../../src";
import { resolveUnilateralPath } from "../../../src/wallet/exit/path";
import { ArkAddress } from "../../../src/script/address";
import vectors from "../../fixtures/delegatee/vectors.json";
import { createMockIndexerProvider, createMockVtxo } from "../helpers";

const keys = {
    delegatePubkey: vectors.delegatePubkey,
    serverPubkey: vectors.serverPubkey,
    emulatorPubkey: vectors.emulatorPubkey,
};
const serverXOnly = hex.decode(vectors.serverPubkey).subarray(1);
// the variables of the vectors: 512 s and 1024 s in BIP 68, a day, 500 sats
const delegation = {
    exitDelay: 0x400001,
    renewalWindow: 86400,
    maxFee: 500,
    boardingExitDelay: 0x400002,
};

const params = (template: DelegateeDefault): Record<string, string> => ({
    template,
    owner: vectors.owner,
    exitDelay: String(delegation.exitDelay),
    renewalWindow: String(delegation.renewalWindow),
    maxFee: String(delegation.maxFee),
    ...(template === "boarding" ? { boardingExitDelay: String(delegation.boardingExitDelay) } : {}),
    delegatePubKey: vectors.delegatePubkey,
    serverPubKey: vectors.serverPubkey,
    emulatorPubKey: vectors.emulatorPubkey,
});

const contractOf = (template: DelegateeDefault): Contract => {
    const script = DelegateeContractHandler.createScript(params(template));
    return {
        type: "delegatee",
        params: params(template),
        script: hex.encode(script.pkScript),
        address: script.address("tark", serverXOnly).encode(),
        state: "active",
        createdAt: 0,
    };
};

const leaves = (template: DelegateeDefault) =>
    vectors[template].tapscripts.map((s) => hex.decode(s));
const script = (leaf: [unknown, Uint8Array]) => leaf[1].subarray(0, -1);

describe("DelegateeContractHandler", () => {
    it("is registered under type 'delegatee'", () => {
        expect(contractHandlers.get("delegatee")).toBe(DelegateeContractHandler);
    });

    it("derives the renewal leaves and Ark address of the Go engine", () => {
        const s = DelegateeContractHandler.createScript(params("renewal"));
        expect(s.scripts.map((l) => hex.encode(l))).toEqual(vectors.renewal.tapscripts);
        expect(hex.encode(s.pkScript)).toBe(vectors.renewal.pkScript);
        expect(s.address("tark", serverXOnly).encode()).toBe(vectors.renewal.address);
    });

    it("derives the boarding leaves and on-chain address of the Go engine", () => {
        const s = DelegateeContractHandler.createScript(params("boarding"));
        expect(s.scripts.map((l) => hex.encode(l))).toEqual(vectors.boarding.tapscripts);
        expect(s.onchainAddress(networks.regtest)).toBe(vectors.boarding.address);
    });

    it("round-trips its params and refuses unknown templates, x-only keys and bad numbers", () => {
        for (const template of ["renewal", "boarding"] as const) {
            const p = params(template);
            const typed = DelegateeContractHandler.deserializeParams(p);
            expect(DelegateeContractHandler.serializeParams(typed)).toEqual(p);
        }
        const p = params("renewal");
        expect(() =>
            DelegateeContractHandler.deserializeParams({ ...p, template: "renewal_watch" }),
        ).toThrow(/unknown delegatee template/);
        expect(() =>
            DelegateeContractHandler.deserializeParams({ ...p, owner: vectors.owner.slice(2) }),
        ).toThrow(/compressed/);
        expect(() => DelegateeContractHandler.deserializeParams({ ...p, maxFee: "-1" })).toThrow(
            /maxFee/,
        );
        expect(() =>
            DelegateeContractHandler.deserializeParams({
                ...params("boarding"),
                boardingExitDelay: "",
            }),
        ).toThrow(/boardingExitDelay/);
    });

    it.each(["renewal", "boarding"] as const)(
        "spends %s through forfeit with the server and exit alone, never the covenant",
        (template) => {
            const contract = contractOf(template);
            const s = DelegateeContractHandler.createScript(contract.params);
            const [forfeit, exit, covenant] = leaves(template);
            const all = (collaborative: boolean) =>
                DelegateeContractHandler.getAllSpendingPaths(s, contract, {
                    collaborative,
                    currentTime: 0,
                }).map((p) => script(p.leaf));

            expect(all(true)).toEqual([forfeit, exit]);
            expect(all(false)).toEqual([exit]);
            expect([...all(true), ...all(false)]).not.toContainEqual(covenant);
            const selected = DelegateeContractHandler.selectPath(s, contract, {
                collaborative: true,
                currentTime: 0,
            });
            expect(selected && script(selected.leaf)).toEqual(forfeit);
        },
    );

    it("gates the exit on its CSV", () => {
        const contract = contractOf("renewal");
        const s = DelegateeContractHandler.createScript(contract.params);
        const confirmedAt = 1_700_000_000;
        const at = (seconds: number) => ({
            collaborative: false,
            currentTime: (confirmedAt + seconds) * 1000,
            chainTime: confirmedAt + seconds,
            vtxo: createMockVtxo({
                status: { confirmed: true, block_time: confirmedAt, block_height: 100 },
            }),
        });
        expect(DelegateeContractHandler.selectPath(s, contract, at(10))).toBeNull();
        const path = DelegateeContractHandler.selectPath(s, contract, at(600));
        expect(path && script(path.leaf)).toEqual(leaves("renewal")[1]);
        expect(path?.sequence).toBe(delegation.exitDelay);
    });

    it("annotates VTXOs with the forfeit leaf and counts them as generic spending", () => {
        const contract = contractOf("renewal");
        const s = DelegateeContractHandler.createScript(contract.params);
        const derived = DelegateeContractHandler.deriveTapscripts(s, contract);
        expect(script(derived.forfeitTapLeafScript)).toEqual(leaves("renewal")[0]);
        expect(script(derived.intentTapLeafScript)).toEqual(leaves("renewal")[0]);
        expect(DelegateeContractHandler.isGenericallySpendable?.(contract)).toBe(true);
    });

    it("pre-signs an unroll of a delegated coin through the owner exit", async () => {
        const contract = contractOf("renewal");
        const repository = new InMemoryContractRepository();
        await repository.saveContract(contract);
        const resolved = await resolveUnilateralPath({
            vtxo: { txid: "00".repeat(32), vout: 0, tapTree: new Uint8Array() },
            scriptHex: contract.script,
            contractRepository: repository,
            currentTime: Date.now(),
        });
        expect(script(resolved.selection.leaf)).toEqual(leaves("renewal")[1]);
        expect(resolved.selection.sequence).toBe(delegation.exitDelay);
    });
});

describe("watchDelegateeContracts", () => {
    it("registers the wallet's renewal and boarding contracts, which then hold its VTXOs", async () => {
        const indexerProvider = createMockIndexerProvider();
        const delegated = createMockVtxo({ script: vectors.renewal.pkScript, value: 4321 });
        indexerProvider.getVtxos = vi
            .fn()
            .mockImplementation(async ({ scripts }: { scripts?: string[] }) => ({
                vtxos: scripts?.includes(vectors.renewal.pkScript) ? [delegated] : [],
            }));
        const manager = await ContractManager.create({
            indexerProvider,
            contractRepository: new InMemoryContractRepository(),
            walletRepository: new InMemoryWalletRepository(),
        });
        const wallet = {
            identity: { compressedPublicKey: async () => hex.decode(vectors.owner) },
            getAddress: async () =>
                new ArkAddress(serverXOnly, new Uint8Array(32).fill(1), "tark").encode(),
            getContractManager: async () => manager,
        } as unknown as Parameters<typeof watchDelegateeContracts>[0];

        const contracts = await watchDelegateeContracts(wallet, keys, delegation);
        expect(contracts.map((c) => c.script)).toEqual([
            vectors.renewal.pkScript,
            vectors.boarding.pkScript,
        ]);
        expect(contracts[0].address).toBe(vectors.renewal.address);
        await expect(watchDelegateeContracts(wallet, keys, delegation)).resolves.toHaveLength(2);
        const { boardingExitDelay: _, ...renewalOnly } = delegation;
        await expect(watchDelegateeContracts(wallet, keys, renewalOnly)).resolves.toHaveLength(1);

        const held = await manager.getContractsWithVtxos({ script: vectors.renewal.pkScript });
        expect(held[0].vtxos.map((v) => v.value)).toEqual([4321]);
        expect(script(held[0].vtxos[0].forfeitTapLeafScript)).toEqual(leaves("renewal")[0]);
        manager.dispose();
    });
});
