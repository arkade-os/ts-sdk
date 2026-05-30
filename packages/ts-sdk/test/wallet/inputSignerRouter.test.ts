import { describe, it, expect, vi } from "vitest";
import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { InputSignerRouter, InputSigningJob } from "../../src/wallet/inputSignerRouter";
import { SingleKey } from "../../src/identity/singleKey";
import { InMemoryContractRepository } from "../../src/repositories/inMemory/contractRepository";
import { ContractRepository } from "../../src/repositories/contractRepository";
import { Contract } from "../../src/contracts/types";
import {
    DescriptorSigningProviderMissingError,
    MissingSigningDescriptorError,
} from "../../src/wallet/signingErrors";

const identity = SingleKey.fromHex(
    "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2",
);

// Distinct 32-byte pseudo-pubkeys used to build distinct test scripts.
// The router never validates these as taproot keys — it only hex-encodes
// them for repo lookup — so we deliberately use easy-to-read fillers.
const BOARDING_PUBKEY = "1111111111111111111111111111111111111111111111111111111111111111";
const UNKNOWN_PUBKEY = "2222222222222222222222222222222222222222222222222222222222222222";
const ROTATED_A_PUBKEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ROTATED_B_PUBKEY = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const VHTLC_PUBKEY = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const BASELINE_REUSE_PUBKEY = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const DELEGATE_BASELINE_PUBKEY = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const DELEGATE_ROTATED_PUBKEY = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

const taprootScript = (pubKeyHex: string) => new Uint8Array([0x51, 0x20, ...hex.decode(pubKeyHex)]);

const boardingPkScript = taprootScript(BOARDING_PUBKEY);

const makeContract = (
    overrides: Partial<Contract> & Pick<Contract, "script" | "type" | "params">,
): Contract => ({
    address: "ark1qtest",
    state: "active",
    createdAt: 0,
    metadata: {},
    ...overrides,
});

// Build a Transaction with placeholder inputs. The router only consults
// each job's `lookupScript` for routing — it never reads the tx's
// witnessUtxo — so we attach inputs without scripts to side-step the
// taproot pkScript validation in `Transaction.addInput`.
const stubTxWithInputs = (count: number): Transaction => {
    const tx = new Transaction();
    for (let i = 0; i < count; i++) {
        tx.addInput({
            txid: new Uint8Array(32).fill(0),
            index: i,
        });
    }
    return tx;
};

describe("InputSignerRouter", async () => {
    const baselinePubKey = hex.encode(await identity.xOnlyPublicKey());

    const createRouter = (deps: Partial<any> = {}) =>
        new InputSignerRouter({
            identity,
            contractRepository: new InMemoryContractRepository(),
            boardingPkScript,
            ...deps,
        });

    it("returns the transaction unchanged if no jobs are provided", async () => {
        const router = createRouter();
        const tx = new Transaction();
        const result = await router.sign(tx, []);
        expect(result).toBe(tx);
    });

    it("routes boarding script with no contract to identity", async () => {
        const mockIdentity = {
            xOnlyPublicKey: vi.fn().mockResolvedValue(hex.decode(BASELINE_REUSE_PUBKEY)),
            sign: vi.fn().mockImplementation((tx) => tx),
        };
        const router = createRouter({ identity: mockIdentity });

        const tx = stubTxWithInputs(1);

        await router.sign(tx, [{ index: 0, lookupScript: boardingPkScript }]);

        expect(mockIdentity.sign).toHaveBeenCalledWith(tx, [0]);
    });

    it("skips unknown script with no contract and no boarding match", async () => {
        const mockIdentity = {
            xOnlyPublicKey: vi.fn().mockResolvedValue(hex.decode(BASELINE_REUSE_PUBKEY)),
            sign: vi.fn().mockImplementation((tx) => tx),
        };
        const router = createRouter({ identity: mockIdentity });

        const unknownScript = taprootScript(UNKNOWN_PUBKEY);
        const tx = stubTxWithInputs(1);

        await router.sign(tx, [{ index: 0, lookupScript: unknownScript }]);

        expect(mockIdentity.sign).not.toHaveBeenCalled();
    });

    it("routes default baseline-owner contract to identity", async () => {
        const contractRepo = new InMemoryContractRepository();
        const script = taprootScript(BASELINE_REUSE_PUBKEY);
        await contractRepo.saveContract(
            makeContract({
                script: hex.encode(script),
                type: "default",
                params: { pubKey: baselinePubKey },
            }),
        );

        const signSpy = vi.fn().mockImplementation((tx) => tx);
        const mockIdentity = {
            xOnlyPublicKey: () => Promise.resolve(hex.decode(baselinePubKey)),
            sign: signSpy,
        };
        const router = createRouter({
            identity: mockIdentity,
            contractRepository: contractRepo,
        });

        const tx = stubTxWithInputs(1);
        await router.sign(tx, [{ index: 0, lookupScript: script }]);

        expect(signSpy).toHaveBeenCalledWith(tx, [0]);
    });

    it("routes baseline-owner contract to identity when pubKey is stored uppercase", async () => {
        // A migration or custom repo adapter could persist
        // `params.pubKey` in uppercase. The router must still recognize
        // it as baseline and route to identity (legacy behaviour was
        // case-insensitive); otherwise it would try descriptor signing
        // and throw MissingSigningDescriptorError.
        const contractRepo = new InMemoryContractRepository();
        const script = taprootScript(BASELINE_REUSE_PUBKEY);
        await contractRepo.saveContract(
            makeContract({
                script: hex.encode(script),
                type: "default",
                params: { pubKey: baselinePubKey.toUpperCase() },
            }),
        );

        const signSpy = vi.fn().mockImplementation((tx) => tx);
        const mockIdentity = {
            xOnlyPublicKey: () => Promise.resolve(hex.decode(baselinePubKey)),
            sign: signSpy,
        };
        const router = createRouter({
            identity: mockIdentity,
            contractRepository: contractRepo,
        });

        const tx = stubTxWithInputs(1);
        await router.sign(tx, [{ index: 0, lookupScript: script }]);

        expect(signSpy).toHaveBeenCalledWith(tx, [0]);
    });

    it("routes delegate baseline-owner contract to identity", async () => {
        const contractRepo = new InMemoryContractRepository();
        const script = taprootScript(DELEGATE_BASELINE_PUBKEY);
        await contractRepo.saveContract(
            makeContract({
                script: hex.encode(script),
                type: "delegate",
                params: { pubKey: baselinePubKey },
            }),
        );

        const signSpy = vi.fn().mockImplementation((tx) => tx);
        const mockIdentity = {
            xOnlyPublicKey: () => Promise.resolve(hex.decode(baselinePubKey)),
            sign: signSpy,
        };
        const router = createRouter({
            identity: mockIdentity,
            contractRepository: contractRepo,
        });

        const tx = stubTxWithInputs(1);
        await router.sign(tx, [{ index: 0, lookupScript: script }]);

        expect(signSpy).toHaveBeenCalledWith(tx, [0]);
    });

    it("routes rotated default contract with descriptor to descriptor provider", async () => {
        const contractRepo = new InMemoryContractRepository();
        const script = taprootScript(ROTATED_A_PUBKEY);
        const descriptor = "tr(rotated-default)";
        await contractRepo.saveContract(
            makeContract({
                script: hex.encode(script),
                type: "default",
                params: { pubKey: ROTATED_A_PUBKEY },
                metadata: { signingDescriptor: descriptor },
            }),
        );

        const signWithDescriptor = vi.fn().mockImplementation((reqs) => [reqs[0].tx]);
        const router = createRouter({
            contractRepository: contractRepo,
            descriptorProvider: { signWithDescriptor },
        });

        const tx = stubTxWithInputs(1);
        await router.sign(tx, [{ index: 0, lookupScript: script }]);

        expect(signWithDescriptor).toHaveBeenCalledWith([{ tx, descriptor, inputIndexes: [0] }]);
    });

    it("routes rotated delegate contract with descriptor to descriptor provider", async () => {
        const contractRepo = new InMemoryContractRepository();
        const script = taprootScript(DELEGATE_ROTATED_PUBKEY);
        const descriptor = "tr(rotated-delegate)";
        await contractRepo.saveContract(
            makeContract({
                script: hex.encode(script),
                type: "delegate",
                params: { pubKey: DELEGATE_ROTATED_PUBKEY },
                metadata: { signingDescriptor: descriptor },
            }),
        );

        const signWithDescriptor = vi.fn().mockImplementation((reqs) => [reqs[0].tx]);
        const router = createRouter({
            contractRepository: contractRepo,
            descriptorProvider: { signWithDescriptor },
        });

        const tx = stubTxWithInputs(1);
        await router.sign(tx, [{ index: 0, lookupScript: script }]);

        expect(signWithDescriptor).toHaveBeenCalledWith([{ tx, descriptor, inputIndexes: [0] }]);
    });

    it("throws MissingSigningDescriptorError if rotated contract is missing descriptor", async () => {
        const contractRepo = new InMemoryContractRepository();
        const script = taprootScript(ROTATED_A_PUBKEY);
        await contractRepo.saveContract(
            makeContract({
                script: hex.encode(script),
                type: "default",
                params: { pubKey: ROTATED_A_PUBKEY },
                metadata: {},
            }),
        );

        const router = createRouter({ contractRepository: contractRepo });
        const tx = stubTxWithInputs(1);

        await expect(router.sign(tx, [{ index: 0, lookupScript: script }])).rejects.toThrow(
            MissingSigningDescriptorError,
        );
    });

    it("throws DescriptorSigningProviderMissingError if descriptor route needed but no provider", async () => {
        const contractRepo = new InMemoryContractRepository();
        const script = taprootScript(ROTATED_A_PUBKEY);
        await contractRepo.saveContract(
            makeContract({
                script: hex.encode(script),
                type: "default",
                params: { pubKey: ROTATED_A_PUBKEY },
                metadata: { signingDescriptor: "tr(rotated)" },
            }),
        );

        const router = createRouter({
            contractRepository: contractRepo,
            descriptorProvider: undefined,
        });
        const tx = stubTxWithInputs(1);

        await expect(router.sign(tx, [{ index: 0, lookupScript: script }])).rejects.toThrow(
            DescriptorSigningProviderMissingError,
        );
    });

    it("routes non-default/non-delegate contract (vhtlc) to identity", async () => {
        const contractRepo = new InMemoryContractRepository();
        const script = taprootScript(VHTLC_PUBKEY);
        await contractRepo.saveContract(
            makeContract({
                script: hex.encode(script),
                type: "vhtlc",
                params: { pubKey: VHTLC_PUBKEY },
            }),
        );

        const signSpy = vi.fn().mockImplementation((tx) => tx);
        const mockIdentity = {
            xOnlyPublicKey: () => Promise.resolve(hex.decode(baselinePubKey)),
            sign: signSpy,
        };
        const router = createRouter({
            identity: mockIdentity,
            contractRepository: contractRepo,
        });

        const tx = stubTxWithInputs(1);
        await router.sign(tx, [{ index: 0, lookupScript: script }]);

        expect(signSpy).toHaveBeenCalledWith(tx, [0]);
    });

    it("threads identity and descriptor jobs through one accumulated transaction in sorted descriptor order", async () => {
        const contractRepo = new InMemoryContractRepository();

        // Job 0: boarding -> identity
        const script0 = boardingPkScript;

        // Job 1: rotated default with descriptor B
        const script1 = taprootScript(ROTATED_B_PUBKEY);
        const descriptorB = "tr(B)";
        await contractRepo.saveContract(
            makeContract({
                script: hex.encode(script1),
                type: "default",
                params: { pubKey: ROTATED_B_PUBKEY },
                metadata: { signingDescriptor: descriptorB },
            }),
        );

        // Job 2: rotated default with descriptor A (lex-smaller than B)
        const script2 = taprootScript(ROTATED_A_PUBKEY);
        const descriptorA = "tr(A)";
        await contractRepo.saveContract(
            makeContract({
                script: hex.encode(script2),
                type: "default",
                params: { pubKey: ROTATED_A_PUBKEY },
                metadata: { signingDescriptor: descriptorA },
            }),
        );

        const cloneTx = (tx: Transaction): Transaction => {
            const next = new Transaction();
            for (let i = 0; i < tx.inputsLength; i++) {
                next.addInput(tx.getInput(i));
            }
            return next;
        };

        const mockIdentity = {
            xOnlyPublicKey: () => Promise.resolve(hex.decode(baselinePubKey)),
            sign: vi.fn().mockImplementation((tx) => {
                const next = cloneTx(tx) as any;
                next._signedByIdentity = true;
                return next;
            }),
        };

        const mockDescriptorProvider = {
            signWithDescriptor: vi.fn().mockImplementation((reqs) => {
                const tx = reqs[0].tx as any;
                const next = cloneTx(tx) as any;
                next._signedByDescriptor = tx._signedByDescriptor
                    ? [...tx._signedByDescriptor]
                    : [];
                next._signedByDescriptor.push(reqs[0].descriptor);
                if (tx._signedByIdentity) next._signedByIdentity = true;
                return [next];
            }),
        };

        const router = createRouter({
            identity: mockIdentity,
            contractRepository: contractRepo,
            descriptorProvider: mockDescriptorProvider,
        });

        const tx = stubTxWithInputs(3);

        const jobs: InputSigningJob[] = [
            { index: 0, lookupScript: script0 },
            { index: 1, lookupScript: script1 },
            { index: 2, lookupScript: script2 },
        ];

        const result: any = await router.sign(tx, jobs);

        expect(mockIdentity.sign).toHaveBeenCalledOnce();
        expect(mockIdentity.sign).toHaveBeenCalledWith(expect.anything(), [0]);

        expect(mockDescriptorProvider.signWithDescriptor).toHaveBeenCalledTimes(2);
        expect(mockDescriptorProvider.signWithDescriptor.mock.calls[0][0][0].descriptor).toBe(
            descriptorA,
        );
        expect(mockDescriptorProvider.signWithDescriptor.mock.calls[0][0][0].inputIndexes).toEqual([
            2,
        ]);
        expect(mockDescriptorProvider.signWithDescriptor.mock.calls[1][0][0].descriptor).toBe(
            descriptorB,
        );
        expect(mockDescriptorProvider.signWithDescriptor.mock.calls[1][0][0].inputIndexes).toEqual([
            1,
        ]);

        expect(result._signedByIdentity).toBe(true);
        expect(result._signedByDescriptor).toEqual([descriptorA, descriptorB]);
    });

    describe("canBatch", () => {
        it("returns true when every job resolves to the baseline identity", async () => {
            const contractRepo = new InMemoryContractRepository();
            const script = taprootScript(BASELINE_REUSE_PUBKEY);
            await contractRepo.saveContract(
                makeContract({
                    script: hex.encode(script),
                    type: "default",
                    params: { pubKey: baselinePubKey },
                }),
            );

            const router = createRouter({ contractRepository: contractRepo });

            const jobs: InputSigningJob[] = [
                { index: 0, lookupScript: boardingPkScript },
                { index: 1, lookupScript: script },
            ];

            expect(await router.canBatch(jobs)).toBe(true);
        });

        it("returns false when any job routes to the descriptor provider", async () => {
            const contractRepo = new InMemoryContractRepository();
            const baselineScript = taprootScript(BASELINE_REUSE_PUBKEY);
            const rotatedScript = taprootScript(ROTATED_A_PUBKEY);
            await contractRepo.saveContract(
                makeContract({
                    script: hex.encode(baselineScript),
                    type: "default",
                    params: { pubKey: baselinePubKey },
                }),
            );
            await contractRepo.saveContract(
                makeContract({
                    script: hex.encode(rotatedScript),
                    type: "default",
                    params: { pubKey: ROTATED_A_PUBKEY },
                    metadata: { signingDescriptor: "tr(rotated)" },
                }),
            );

            const router = createRouter({ contractRepository: contractRepo });

            const jobs: InputSigningJob[] = [
                { index: 0, lookupScript: baselineScript },
                { index: 1, lookupScript: rotatedScript },
            ];

            expect(await router.canBatch(jobs)).toBe(false);
        });

        it("returns true for an empty job list (degenerate batch is trivially batchable)", async () => {
            const router = createRouter();
            expect(await router.canBatch([])).toBe(true);
        });

        it("propagates MissingSigningDescriptorError so pre-flight catches the same failure as sign()", async () => {
            const contractRepo = new InMemoryContractRepository();
            const script = taprootScript(ROTATED_A_PUBKEY);
            await contractRepo.saveContract(
                makeContract({
                    script: hex.encode(script),
                    type: "default",
                    params: { pubKey: ROTATED_A_PUBKEY },
                    metadata: {},
                }),
            );

            const router = createRouter({ contractRepository: contractRepo });

            await expect(router.canBatch([{ index: 0, lookupScript: script }])).rejects.toThrow(
                MissingSigningDescriptorError,
            );
        });
    });

    it("keeps the first contract when the repo yields duplicates for one script", async () => {
        const script = taprootScript(ROTATED_A_PUBKEY);
        const scriptHex = hex.encode(script);

        const firstDescriptor = "tr(first)";
        const stubRepo: ContractRepository = {
            version: 1,
            clear: async () => {},
            getContracts: async () => [
                makeContract({
                    script: scriptHex,
                    type: "default",
                    params: { pubKey: ROTATED_A_PUBKEY },
                    metadata: { signingDescriptor: firstDescriptor },
                }),
                makeContract({
                    script: scriptHex,
                    type: "default",
                    params: { pubKey: ROTATED_A_PUBKEY },
                    metadata: { signingDescriptor: "tr(second)" },
                }),
            ],
            saveContract: async () => {},
            deleteContract: async () => {},
            [Symbol.asyncDispose]: async () => {},
        };

        const signWithDescriptor = vi.fn().mockImplementation((reqs) => [reqs[0].tx]);
        const router = createRouter({
            contractRepository: stubRepo,
            descriptorProvider: { signWithDescriptor },
        });

        const tx = stubTxWithInputs(1);
        await router.sign(tx, [{ index: 0, lookupScript: script }]);

        expect(signWithDescriptor).toHaveBeenCalledWith([
            { tx, descriptor: firstDescriptor, inputIndexes: [0] },
        ]);
    });
});
