/**
 * The `vhtlc-v2` handler: deriving {@link VHTLC.ScriptV2} from a persisted row,
 * and offering only the leaves a wallet holding one participant key can spend.
 *
 * Two properties carry the weight here. First, that a ScriptV2 lockup can be
 * REGISTERED at all — `ContractManager` derives the script from `params` and
 * refuses any row whose supplied `script` disagrees, so a handler that built
 * the wrong version would make the whole registration path unusable rather than
 * subtly wrong. Second, that the offered leaf set stays the four a caller can
 * actually satisfy: offering `refund` or `unilateralRefund` would hand back a
 * leaf needing the counterparty's signature, which this protocol has no way to
 * ask for.
 */
import { describe, it, expect, vi } from "vitest";
import { hex } from "@scure/base";

import {
    ContractManager,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    VHTLC,
    isContractGenericallySpendable,
    scriptFromTapLeafScript,
    type Contract,
} from "../../src";
import { contractHandlers } from "../../src/contracts/handlers";
import { VHTLCContractHandler } from "../../src/contracts/handlers/vhtlc";
import { VHTLCV2ContractHandler } from "../../src/contracts/handlers/vhtlcV2";
import { deriveContractTapscripts } from "../../src/wallet/utils";
import { createMockIndexerProvider, createMockVtxo } from "./helpers";

const SENDER = "0192e796452d6df9697c280542e1560557bcf79a347d925895043136225c7cb4";
const RECEIVER = "1e1bb85455fe3f5aed60d101aa4dbdb9e7714f6226769a97a17a5331dadcd53b";
const SERVER = "aad52d58162e9eefeafc7ad8a1cdca8060b5f01df1e7583362d052e266208f88";
const EMULATOR = "f8352deebdf5658d95875d89656112b1dd150f176c702eea4f91a91527e48e26";
/** HASH160 output — VHTLC validates this at exactly 20 bytes. */
const HASH = "4d487dd3753a89bc9fe98401d1196523058251fc";

/** `OP_1 <32-byte program>`; anything else fails `isP2trPkScript`. */
const p2tr = (programHex: string): string => `5120${programHex}`;
const RECEIVER_PK_SCRIPT = p2tr(RECEIVER);
const SENDER_PK_SCRIPT = p2tr(SENDER);

/** Every param the swap corridor's lockup carries — the eight-leaf contract. */
const fullParams = (over: Record<string, string> = {}): Record<string, string> => ({
    sender: SENDER,
    receiver: RECEIVER,
    server: SERVER,
    hash: HASH,
    refundLocktime: "800000",
    claimDelay: "10",
    refundDelay: "12",
    refundNoReceiverDelay: "14",
    nonInteractiveClaimReceiverPkScript: RECEIVER_PK_SCRIPT,
    nonInteractiveClaimEmulatorPubkey: EMULATOR,
    nonInteractiveRefundSenderPkScript: SENDER_PK_SCRIPT,
    nonInteractiveRefundEmulatorPubkey: EMULATOR,
    ...over,
});

const contractOf = (params: Record<string, string>): Contract => ({
    type: "vhtlc-v2",
    params,
    script: hex.encode(VHTLCV2ContractHandler.createScript(params).pkScript),
    address: "address",
    state: "active",
    createdAt: Date.now(),
});

/** The leaf's script bytes, so a selection can be named rather than compared
 * against an opaque `TapLeafScript` tuple. */
const leafHex = (leaf: { leaf: [unknown, Uint8Array] } | { leaf: unknown }): string =>
    hex.encode(scriptFromTapLeafScript((leaf as { leaf: never }).leaf));

describe("VHTLCV2ContractHandler", () => {
    it("is registered under its own type, alongside — not instead of — vhtlc", () => {
        expect(contractHandlers.has("vhtlc-v2")).toBe(true);
        expect(contractHandlers.get("vhtlc-v2")?.type).toBe("vhtlc-v2");
        // The V1 handler must survive registration of the V2 one: a registry
        // clash would have thrown at import time, but a silent overwrite would
        // not, and it would repoint every existing `vhtlc` row at a script
        // version that derives a different address.
        expect(contractHandlers.get("vhtlc")?.type).toBe("vhtlc");
        expect(contractHandlers.get("vhtlc")).toBe(VHTLCContractHandler);
    });

    it("derives exactly the ScriptV2 a caller built from the same options", () => {
        const params = fullParams();
        const expected = new VHTLC.ScriptV2({
            sender: hex.decode(SENDER),
            receiver: hex.decode(RECEIVER),
            server: hex.decode(SERVER),
            preimageHash: hex.decode(HASH),
            refundLocktime: 800000n,
            unilateralClaimDelay: { type: "blocks", value: 10n },
            unilateralRefundDelay: { type: "blocks", value: 12n },
            unilateralRefundWithoutReceiverDelay: { type: "blocks", value: 14n },
            nonInteractiveClaim: {
                receiverPkScript: hex.decode(RECEIVER_PK_SCRIPT),
                emulatorPubkey: hex.decode(EMULATOR),
            },
            nonInteractiveRefund: {
                senderPkScript: hex.decode(SENDER_PK_SCRIPT),
                emulatorPubkey: hex.decode(EMULATOR),
            },
        });

        const derived = VHTLCV2ContractHandler.createScript(params);
        expect(hex.encode(derived.pkScript)).toBe(hex.encode(expected.pkScript));
        // All eight leaves, so a row that round-trips cannot quietly lose the
        // covenant pair and still match on pkScript.
        expect(derived.nonInteractiveClaimScript).toBeDefined();
        expect(derived.nonInteractiveRefundScript).toBeDefined();
    });

    it("round-trips the covenant leaves through serialize/deserialize", () => {
        const params = fullParams();
        const typed = VHTLCV2ContractHandler.deserializeParams(params);
        expect(typed.nonInteractiveClaim).toBeDefined();
        expect(typed.nonInteractiveRefund).toBeDefined();

        const reserialized = VHTLCV2ContractHandler.serializeParams(typed);
        expect(reserialized).toEqual(params);
        expect(hex.encode(VHTLCV2ContractHandler.createScript(reserialized).pkScript)).toBe(
            hex.encode(VHTLCV2ContractHandler.createScript(params).pkScript),
        );
    });

    it("round-trips a bare six-leaf contract without inventing covenant keys", () => {
        const params = {
            sender: SENDER,
            receiver: RECEIVER,
            server: SERVER,
            hash: HASH,
            refundLocktime: "800000",
            claimDelay: "10",
            refundDelay: "12",
            refundNoReceiverDelay: "14",
        };
        const typed = VHTLCV2ContractHandler.deserializeParams(params);
        expect(typed.nonInteractiveClaim).toBeUndefined();
        expect(typed.nonInteractiveRefund).toBeUndefined();
        // No `"undefined"` string keys leaking into a persisted row.
        expect(VHTLCV2ContractHandler.serializeParams(typed)).toEqual(params);
        expect(
            VHTLCV2ContractHandler.createScript(params).nonInteractiveClaimScript,
        ).toBeUndefined();
    });

    it("refuses a half-specified covenant leaf by name", () => {
        const missingEmulator = fullParams();
        delete missingEmulator.nonInteractiveClaimEmulatorPubkey;
        expect(() => VHTLCV2ContractHandler.createScript(missingEmulator)).toThrow(
            /nonInteractiveClaim needs both/,
        );

        const missingDestination = fullParams();
        delete missingDestination.nonInteractiveRefundSenderPkScript;
        expect(() => VHTLCV2ContractHandler.createScript(missingDestination)).toThrow(
            /nonInteractiveRefund needs both/,
        );
    });

    it("cannot collide with a vhtlc row: the two versions derive different scripts", () => {
        const shared = {
            sender: SENDER,
            receiver: RECEIVER,
            server: SERVER,
            hash: HASH,
            refundLocktime: "800000",
            claimDelay: "10",
            refundDelay: "12",
            refundNoReceiverDelay: "14",
        };
        const v1 = hex.encode(VHTLCContractHandler.createScript(shared).pkScript);
        const v2 = hex.encode(VHTLCV2ContractHandler.createScript(shared).pkScript);
        expect(v2).not.toBe(v1);
    });

    it("derives annotation tapscripts rather than falling back to a forfeit() it lacks", () => {
        const params = fullParams();
        const contract = contractOf(params);
        const script = VHTLCV2ContractHandler.createScript(params);

        // The pipeline entry point, not just the handler method: this is the
        // call `annotateVtxos` makes, and the one that used to throw.
        const derived = deriveContractTapscripts(contract);
        expect(leafHex({ leaf: derived.intentTapLeafScript })).toBe(
            script.refundWithoutReceiverScript,
        );
        expect(leafHex({ leaf: derived.forfeitTapLeafScript })).toBe(
            script.refundWithoutReceiverScript,
        );
        expect(hex.encode(derived.tapTree)).toBe(hex.encode(script.encode()));
    });

    it("is never generically spendable — a live lockup is escrow", () => {
        const contract = contractOf(fullParams());
        expect(VHTLCV2ContractHandler.isGenericallySpendable?.(contract)).toBe(false);
        expect(isContractGenericallySpendable(contract)).toBe(false);
    });

    /**
     * The handler's own CLTV check has always been right, and the tests below
     * prove it by handing the context a `blockHeight` directly. What nothing
     * proved is that anything ever PUTS one there.
     *
     * `refundLocktime` here is 800000 — under `CLTV_HEIGHT_THRESHOLD`, so
     * height-typed — and `isCltvSatisfied` answers `false` outright when
     * `blockHeight` is missing. No construction site populated it, so through
     * the manager the sender's collaborative refund was unreachable at every
     * height, matured or not. This pins the wiring, not the arithmetic: same
     * contract, same maturity, the only variable is whether a tip is supplied.
     */
    describe("blockHeight reaches the handler through ContractManager", () => {
        const managerFor = async (chainTip?: () => Promise<number | undefined>) =>
            ContractManager.create({
                indexerProvider: createMockIndexerProvider(),
                contractRepository: new InMemoryContractRepository(),
                walletRepository: new InMemoryWalletRepository(),
                chainTip,
            });

        const refundLeafOffered = async (
            chainTip?: () => Promise<number | undefined>,
        ): Promise<boolean> => {
            const manager = await managerFor(chainTip);
            const contract = contractOf(fullParams());
            await manager.createContract(contract);
            const script = VHTLCV2ContractHandler.createScript(contract.params);
            const paths = await manager.getSpendablePaths({
                contractScript: contract.script,
                collaborative: true,
                walletPubKey: SENDER,
            });
            return paths.map(leafHex).includes(script.refundWithoutReceiverScript!);
        };

        it("withholds the matured refund leaf when no tip source is configured", async () => {
            expect(await refundLeafOffered(undefined)).toBe(false);
        });

        it("withholds it when the tip is below the locktime", async () => {
            expect(await refundLeafOffered(async () => 799_999)).toBe(false);
        });

        it("offers it once the tip reaches the locktime", async () => {
            expect(await refundLeafOffered(async () => 800_000)).toBe(true);
        });

        it("collapses concurrent cache misses onto a single tip read", async () => {
            let reads = 0;
            const manager = await managerFor(async () => {
                reads += 1;
                // Resolve on a later turn, so all three callers are waiting on
                // the same in-flight read rather than being served in sequence.
                await Promise.resolve();
                return 800_000;
            });
            const contract = contractOf(fullParams());
            await manager.createContract(contract);

            const query = () =>
                manager.getSpendablePaths({
                    contractScript: contract.script,
                    collaborative: true,
                    walletPubKey: SENDER,
                });
            const results = await Promise.all([query(), query(), query()]);

            expect(reads).toBe(1);
            const script = VHTLCV2ContractHandler.createScript(contract.params);
            for (const paths of results) {
                expect(paths.map(leafHex)).toContain(script.refundWithoutReceiverScript);
            }
        });

        it("treats an unreadable tip as unknown rather than failing the query", async () => {
            const paths = await (async () => {
                const manager = await managerFor(async () => {
                    throw new Error("provider down");
                });
                const contract = contractOf(fullParams());
                await manager.createContract(contract);
                return manager.getSpendablePaths({
                    contractScript: contract.script,
                    collaborative: true,
                    walletPubKey: SENDER,
                });
            })();
            // Resolved, not rejected — and the height-gated leaf stays out.
            const script = VHTLCV2ContractHandler.createScript(fullParams());
            expect(paths.map(leafHex)).not.toContain(script.refundWithoutReceiverScript);
        });
    });

    describe("path selection", () => {
        it("gives the sender refundWithoutReceiver only once the CLTV is satisfied", () => {
            const contract = contractOf(fullParams());
            const script = VHTLCV2ContractHandler.createScript(contract.params);

            const before = VHTLCV2ContractHandler.selectPath(script, contract, {
                collaborative: true,
                currentTime: Date.now(),
                blockHeight: 799_999,
                walletPubKey: SENDER,
            });
            expect(before).toBeNull();

            const after = VHTLCV2ContractHandler.selectPath(script, contract, {
                collaborative: true,
                currentTime: Date.now(),
                blockHeight: 800_000,
                walletPubKey: SENDER,
            });
            expect(after).not.toBeNull();
            expect(leafHex(after!)).toBe(script.refundWithoutReceiverScript);
        });

        it("gives the receiver the claim leaf, with the preimage as witness", () => {
            const contract = contractOf(fullParams({ preimage: "010203" }));
            const script = VHTLCV2ContractHandler.createScript(contract.params);

            const selected = VHTLCV2ContractHandler.selectPath(script, contract, {
                collaborative: true,
                currentTime: Date.now(),
                walletPubKey: RECEIVER,
            });
            expect(selected).not.toBeNull();
            expect(leafHex(selected!)).toBe(script.claimScript);
            expect(selected!.extraWitness).toEqual([hex.decode("010203")]);
        });

        it("gates the sender's unilateral leaf on its CSV", () => {
            const contract = contractOf(fullParams());
            const script = VHTLCV2ContractHandler.createScript(contract.params);
            const vtxo = createMockVtxo({
                status: { confirmed: true, block_height: 100, block_time: 1000 },
            });

            expect(
                VHTLCV2ContractHandler.getSpendablePaths(script, contract, {
                    collaborative: false,
                    currentTime: Date.now(),
                    blockHeight: 105,
                    walletPubKey: SENDER,
                    vtxo,
                }),
            ).toHaveLength(0);

            const mature = VHTLCV2ContractHandler.getSpendablePaths(script, contract, {
                collaborative: false,
                currentTime: Date.now(),
                blockHeight: 200,
                walletPubKey: SENDER,
                vtxo,
            });
            expect(mature).toHaveLength(1);
            expect(leafHex(mature[0])).toBe(script.unilateralRefundWithoutReceiverScript);
            expect(mature[0].sequence).toBe(14);
        });

        it("returns nothing for a wallet that is neither participant", () => {
            const contract = contractOf(fullParams({ preimage: "010203" }));
            const script = VHTLCV2ContractHandler.createScript(contract.params);
            const context = {
                collaborative: true,
                currentTime: Date.now(),
                blockHeight: 900_000,
                walletPubKey: EMULATOR,
            };
            expect(VHTLCV2ContractHandler.selectPath(script, contract, context)).toBeNull();
            expect(VHTLCV2ContractHandler.getAllSpendingPaths(script, contract, context)).toEqual(
                [],
            );
        });

        /**
         * The leaves a wallet holding ONE participant key cannot satisfy —
         * `refund` and `unilateralRefund` need the counterparty's signature,
         * and the two covenant leaves are the emulator's to push. Offering any
         * of them would turn a clean refusal into a transaction that is built
         * and then rejected, so the whole offered set is pinned.
         */
        it("never offers a leaf this wallet cannot sign", () => {
            const contract = contractOf(fullParams({ preimage: "010203" }));
            const script = VHTLCV2ContractHandler.createScript(contract.params);
            const unspendable = [
                script.refundScript,
                script.unilateralRefundScript,
                script.nonInteractiveClaimScript!,
                script.nonInteractiveRefundScript!,
            ];

            for (const role of ["sender", "receiver"] as const) {
                for (const collaborative of [true, false]) {
                    const offered = VHTLCV2ContractHandler.getAllSpendingPaths(script, contract, {
                        collaborative,
                        currentTime: Date.now(),
                        blockHeight: 900_000,
                        role,
                    }).map(leafHex);
                    for (const leaf of unspendable) {
                        expect(offered).not.toContain(leaf);
                    }
                }
            }
        });

        /**
         * The drift guard. V1 and V2 differ only in which preimage fragment the
         * claim leaves are built from, so their SELECTION must stay identical —
         * a fix applied to one and not the other is the realistic failure, and
         * naming the leaf by role rather than by bytes is what makes the two
         * comparable across different script versions.
         */
        it("selects the same leaf as the vhtlc handler for every role and context", () => {
            const shared = {
                sender: SENDER,
                receiver: RECEIVER,
                server: SERVER,
                hash: HASH,
                refundLocktime: "800000",
                claimDelay: "10",
                refundDelay: "12",
                refundNoReceiverDelay: "14",
                preimage: "010203",
            };
            const v1Script = VHTLCContractHandler.createScript(shared);
            const v2Script = VHTLCV2ContractHandler.createScript(shared);
            const v1Contract: Contract = {
                type: "vhtlc",
                params: shared,
                script: hex.encode(v1Script.pkScript),
                address: "address",
                state: "active",
                createdAt: Date.now(),
            };
            const v2Contract = contractOf(shared);

            // Named by leaf accessor so the comparison survives the two
            // versions producing different bytes for the same rung.
            const nameIn = (
                script: VHTLC.Script | VHTLC.ScriptV2,
                selection: { leaf: unknown } | null,
            ): string | null => {
                if (!selection) return null;
                const bytes = leafHex(selection);
                const named: [string, string][] = [
                    ["claim", script.claimScript],
                    ["refund", script.refundScript],
                    ["refundWithoutReceiver", script.refundWithoutReceiverScript],
                    ["unilateralClaim", script.unilateralClaimScript],
                    ["unilateralRefund", script.unilateralRefundScript],
                    [
                        "unilateralRefundWithoutReceiver",
                        script.unilateralRefundWithoutReceiverScript,
                    ],
                ];
                return named.find(([, hexBytes]) => hexBytes === bytes)?.[0] ?? bytes;
            };

            const vtxo = createMockVtxo({
                status: { confirmed: true, block_height: 100, block_time: 1000 },
            });
            for (const role of ["sender", "receiver"] as const) {
                for (const collaborative of [true, false]) {
                    for (const blockHeight of [105, 799_999, 800_001]) {
                        const context = {
                            collaborative,
                            currentTime: Date.now(),
                            blockHeight,
                            role,
                            vtxo,
                        };
                        expect(
                            nameIn(
                                v2Script,
                                VHTLCV2ContractHandler.selectPath(v2Script, v2Contract, context),
                            ),
                        ).toBe(
                            nameIn(
                                v1Script,
                                VHTLCContractHandler.selectPath(v1Script, v1Contract, context),
                            ),
                        );
                    }
                }
            }
        });
    });

    describe("registration through ContractManager", () => {
        const newManager = () =>
            ContractManager.create({
                indexerProvider: createMockIndexerProvider(),
                contractRepository: new InMemoryContractRepository(),
                walletRepository: new InMemoryWalletRepository(),
            });

        it("accepts a ScriptV2 lockup row", async () => {
            const manager = await newManager();
            const params = fullParams();
            const script = hex.encode(VHTLCV2ContractHandler.createScript(params).pkScript);

            const contract = await manager.createContract({
                type: "vhtlc-v2",
                params,
                script,
                address: "ark1lockup",
            });
            expect(contract.script).toBe(script);
            expect(await manager.getContracts({ type: "vhtlc-v2" })).toHaveLength(1);
            manager.dispose();
        });

        /**
         * Registration is worth nothing if the VTXOs are then dropped.
         *
         * `deriveContractTapscripts` falls back to `script.forfeit()` for any
         * handler that is not `TapscriptDeriving`, and no VHTLC script version
         * has one — so without `deriveTapscripts` this threw, `annotatableIn`
         * swallowed it into an annotation failure, and the lockup's VTXOs were
         * filtered out before ever being persisted. The row stayed watched
         * while its balance was permanently invisible, and the manager reported
         * `degraded` forever. This is the end-to-end proof they now survive.
         */
        it("syncs a registered lockup's vtxos instead of silently dropping them", async () => {
            const params = fullParams();
            const script = hex.encode(VHTLCV2ContractHandler.createScript(params).pkScript);
            const indexer = createMockIndexerProvider();
            (indexer.getVtxos as ReturnType<typeof vi.fn>).mockResolvedValue({
                vtxos: [createMockVtxo({ script, value: 5000 })],
                page: undefined,
            });

            const manager = await ContractManager.create({
                indexerProvider: indexer,
                contractRepository: new InMemoryContractRepository(),
                walletRepository: new InMemoryWalletRepository(),
            });
            await manager.createContract({
                type: "vhtlc-v2",
                params,
                script,
                address: "ark1lockup",
            });

            const [entry] = await manager.getContractsWithVtxos({ script });
            expect(entry.vtxos).toHaveLength(1);
            expect(entry.vtxos[0].value).toBe(5000);
            // Annotated with the leaf the sender can actually spend.
            expect(leafHex({ leaf: entry.vtxos[0].intentTapLeafScript })).toBe(
                VHTLCV2ContractHandler.createScript(params).refundWithoutReceiverScript,
            );
            // And the manager does not consider itself degraded.
            expect(manager.getSyncState().mode).toBe("online");
            manager.dispose();
        });

        /**
         * The blocker this handler exists to remove: the `vhtlc` handler builds
         * V1, so a ScriptV2 lockup registered under it derives a different
         * pkScript and `upsertContractRow` refuses the row outright.
         */
        it("still refuses that same lockup under the v1 vhtlc type", async () => {
            const manager = await newManager();
            const params = fullParams();
            const script = hex.encode(VHTLCV2ContractHandler.createScript(params).pkScript);

            await expect(
                manager.createContract({
                    type: "vhtlc",
                    params,
                    script,
                    address: "ark1lockup",
                }),
            ).rejects.toThrow(/mismatch/);
            manager.dispose();
        });
    });
});
