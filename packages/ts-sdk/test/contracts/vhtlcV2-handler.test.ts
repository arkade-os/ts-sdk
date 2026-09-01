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
import type { PathContext } from "../../src/contracts/types";
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
/** A genesis txid in canonical order — the leading 32 bytes of a serialized Asset ID. */
const ASSET_TXID = "b2".repeat(32);
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
            emulatorCovenants: {
                receiverPkScript: hex.decode(RECEIVER_PK_SCRIPT),
                senderPkScript: hex.decode(SENDER_PK_SCRIPT),
                emulatorPubkey: hex.decode(EMULATOR),
                // fullParams carries no nonInteractiveRefundWithoutReceiver
                // flag, and the flag's absence IS the legacy marker.
                legacy: "preTimelockedRefund",
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
        expect(typed.emulatorCovenants).toBeDefined();

        const reserialized = VHTLCV2ContractHandler.serializeParams(typed);
        expect(reserialized).toEqual(params);
        expect(hex.encode(VHTLCV2ContractHandler.createScript(reserialized).pkScript)).toBe(
            hex.encode(VHTLCV2ContractHandler.createScript(params).pkScript),
        );
    });

    it("round-trips the timelocked-refund flag, and a dropped flag would change the script", () => {
        const params = fullParams({ nonInteractiveRefundWithoutReceiver: "1" });
        const typed = VHTLCV2ContractHandler.deserializeParams(params);
        // Flag present → the full suite → no legacy marker.
        expect(typed.emulatorCovenants?.legacy).toBeUndefined();

        const reserialized = VHTLCV2ContractHandler.serializeParams(typed);
        expect(reserialized).toEqual(params);
        expect(reserialized.nonInteractiveRefundWithoutReceiver).toBe("1");

        // Dropping the flag must re-derive a DIFFERENT script — silently
        // re-deriving the eight-leaf script is the exact failure this
        // round-trip exists to prevent, which would otherwise surface only
        // as an opaque `Script mismatch` at registration.
        const withoutFlag = fullParams();
        expect(hex.encode(VHTLCV2ContractHandler.createScript(params).pkScript)).not.toBe(
            hex.encode(VHTLCV2ContractHandler.createScript(withoutFlag).pkScript),
        );
    });

    it("deserializes a flag-less row as legacy: 'preTimelockedRefund', and round-trips to the same eight-leaf script", () => {
        // The flag's ABSENCE is the legacy marker — the same encoding older
        // SDKs wrote for eight-leaf rows, so those rows read back unchanged.
        const params = fullParams();
        const typed = VHTLCV2ContractHandler.deserializeParams(params);
        expect(typed.emulatorCovenants?.legacy).toBe("preTimelockedRefund");

        const serialized = VHTLCV2ContractHandler.serializeParams(typed);
        // Omitted entirely — never a "false"/"undefined" string in a row.
        expect("nonInteractiveRefundWithoutReceiver" in serialized).toBe(false);
        expect(serialized).toEqual(params);

        // ...and the round-trip re-derives the SAME eight-leaf script: the
        // timelocked refund leaf withheld, everything else intact.
        const script = VHTLCV2ContractHandler.createScript(params);
        expect(script.scripts).toHaveLength(8);
        expect(script.nonInteractiveRefundWithoutReceiverScript).toBeUndefined();
        expect(hex.encode(VHTLCV2ContractHandler.createScript(serialized).pkScript)).toBe(
            hex.encode(script.pkScript),
        );
    });

    it("refuses the timelocked-refund flag without the emulator covenant keys it extends", () => {
        const params = {
            sender: SENDER,
            receiver: RECEIVER,
            server: SERVER,
            hash: HASH,
            refundLocktime: "800000",
            claimDelay: "10",
            refundDelay: "12",
            refundNoReceiverDelay: "14",
            nonInteractiveRefundWithoutReceiver: "1",
        };
        expect(() => VHTLCV2ContractHandler.deserializeParams(params)).toThrow(
            /without the emulator covenant keys it extends/,
        );
    });

    it('refuses a timelocked-refund flag value other than "1"', () => {
        expect(() =>
            VHTLCV2ContractHandler.deserializeParams(
                fullParams({ nonInteractiveRefundWithoutReceiver: "true" }),
            ),
        ).toThrow(/must be "1" when present/);
    });

    it("round-trips the ASSET, so a re-derived contract is not silently sat-only", () => {
        // The failure this closes was silent in the worst way. `ContractManager`
        // re-derives a contract from these params; with no `asset` key the
        // derivation produced the SAT-ONLY script, and registration died at
        // `upsertContractRow` with a `Script mismatch` naming two hex strings
        // and no cause. The same silent-drop class `validateOptions` refuses one
        // layer up.
        const params = fullParams({ assetTxid: ASSET_TXID, assetGroupIndex: "7" });
        const typed = VHTLCV2ContractHandler.deserializeParams(params);
        expect(typed.asset).toEqual({ txid: hex.decode(ASSET_TXID), groupIndex: 7 });
        expect(VHTLCV2ContractHandler.serializeParams(typed)).toEqual(params);

        // And the script it derives is the asset one, not the sat-only one —
        // the assertion the round-trip exists for. Comparing against the same
        // params minus the asset, so this cannot pass by both being equal.
        const satOnly = fullParams();
        expect(hex.encode(VHTLCV2ContractHandler.createScript(params).pkScript)).not.toBe(
            hex.encode(VHTLCV2ContractHandler.createScript(satOnly).pkScript),
        );
    });

    it("refuses a row carrying the REMOVED strict claim keys, instead of re-deriving loosely", () => {
        // The strict bound shipped in 0.4.67 and earlier and is gone now. A row
        // written in that window carries a claim covenant this build cannot
        // re-derive; reading the keys as absent would rebuild the DEFAULT
        // covenant — a different pkScript — and die at `upsertContractRow` with
        // an opaque `Script mismatch`. Either key alone names the row.
        expect(() =>
            VHTLCV2ContractHandler.deserializeParams(
                fullParams({
                    assetTxid: ASSET_TXID,
                    assetGroupIndex: "7",
                    strictClaimAmount: "50000",
                    strictClaimAssetAmount: "1234",
                }),
            ),
        ).toThrow(/strict claim params/);
        expect(() =>
            VHTLCV2ContractHandler.deserializeParams(
                fullParams({
                    assetTxid: ASSET_TXID,
                    assetGroupIndex: "7",
                    strictClaimAssetAmount: "1234",
                }),
            ),
        ).toThrow(/strict claim params/);
    });

    it("refuses half an asset rather than deriving a sat-only script from it", () => {
        // A txid without its group index names no asset and an index without a
        // txid names nothing at all. Reading either as "no asset" re-derives the
        // sat-only script — exactly the silent drop above, reached by a corrupt
        // row instead of a missing feature.
        for (const half of [{ assetTxid: ASSET_TXID }, { assetGroupIndex: "7" }]) {
            expect(() => VHTLCV2ContractHandler.deserializeParams(fullParams(half))).toThrow(
                /both be present or both absent/,
            );
        }
    });

    /**
     * The one malformed group index that does not announce itself.
     *
     * `VHTLC.ScriptV2` already refuses a non-integer, a negative, or anything
     * past `0xffff`, so `"abc"`, `"1.5"` and `"-1"` die one frame down with a
     * clear message. `Number("")`, `Number(" ")` and `Number("\t")` are all
     * **0** — a valid group index — so a blank field would name group 0 of the
     * same genesis transaction, which is a DIFFERENT asset, and the mismatch
     * would only surface as an opaque `Script mismatch` at registration.
     */
    it.each([
        ["blank", ""],
        ["a space", " "],
        ["a tab", "\t"],
        ["a leading zero", "007"],
        ["a trailing space", "7 "],
        ["a plus sign", "+7"],
        ["exponent form", "1e2"],
        ["a fraction", "1.5"],
        ["a negative", "-1"],
        ["not a number at all", "seven"],
    ])("refuses %s as an asset group index", (_why, assetGroupIndex) => {
        expect(() =>
            VHTLCV2ContractHandler.deserializeParams(
                fullParams({ assetTxid: ASSET_TXID, assetGroupIndex }),
            ),
        ).toThrow(/assetGroupIndex must be a canonical decimal integer/);
    });

    it("still accepts the boundaries of the range the script allows", () => {
        // 0 is legitimate — the point of the check above is that a BLANK field
        // must not become it — and 65535 is the last index a serialized Asset ID
        // can carry.
        for (const [raw, expected] of [
            ["0", 0],
            ["65535", 65_535],
        ] as const) {
            const typed = VHTLCV2ContractHandler.deserializeParams(
                fullParams({ assetTxid: ASSET_TXID, assetGroupIndex: raw }),
            );
            expect(typed.asset?.groupIndex).toBe(expected);
        }
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
        expect(typed.emulatorCovenants).toBeUndefined();
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

    it("refuses a row carrying only one side of the suite — the group is all-or-nothing", () => {
        // A row written by an older SDK could name one leaf's pair without the
        // other's. It has no group representation — building one would mean
        // inventing the missing half — so the handler refuses it by name.
        const claimOnly = fullParams();
        delete claimOnly.nonInteractiveRefundSenderPkScript;
        delete claimOnly.nonInteractiveRefundEmulatorPubkey;
        expect(() => VHTLCV2ContractHandler.deserializeParams(claimOnly)).toThrow(
            /emulator covenant params are all-or-nothing/,
        );

        const refundOnly = fullParams();
        delete refundOnly.nonInteractiveClaimReceiverPkScript;
        delete refundOnly.nonInteractiveClaimEmulatorPubkey;
        expect(() => VHTLCV2ContractHandler.deserializeParams(refundOnly)).toThrow(
            /emulator covenant params are all-or-nothing/,
        );
    });

    it("refuses a row naming two different emulator pubkeys", () => {
        // One key serves both covenant destinations in the group. A row naming
        // two was legal for an older SDK and is unrepresentable now — rebuilding
        // with either one would move the pkScript, so the handler names it.
        const divergent = fullParams({ nonInteractiveRefundEmulatorPubkey: SENDER });
        expect(() => VHTLCV2ContractHandler.deserializeParams(divergent)).toThrow(
            /two different emulator pubkeys/,
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

    /**
     * The two handlers must answer the contract-manager-facing questions the
     * same way, because the reasons are the same for both: a VHTLC of either
     * version is escrow, and neither script version has a `forfeit()` for
     * `deriveContractTapscripts` to fall back to.
     *
     * Pinned as a pair because they are easy to change one at a time, and one
     * at a time is exactly what is unsafe. V1 shipped for a while answering
     * `true` to the gate while deriving no annotation leaf at all — a
     * combination that was only safe because the missing derivation kept its
     * VTXOs out of the snapshot, so the open gate was never reached.
     */
    it("agrees with the vhtlc handler on annotation and on the spending gate", () => {
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

        // Both closed to generic selection, and closed rather than merely equal.
        expect(VHTLCContractHandler.isGenericallySpendable?.(v1Contract)).toBe(
            VHTLCV2ContractHandler.isGenericallySpendable?.(v2Contract),
        );
        expect(isContractGenericallySpendable(v1Contract)).toBe(false);
        expect(isContractGenericallySpendable(v2Contract)).toBe(false);

        // Both annotate off their own refundWithoutReceiver leaf, through the
        // shared entry point rather than the handler method.
        for (const [contract, script] of [
            [v1Contract, v1Script],
            [v2Contract, v2Script],
        ] as const) {
            const derived = deriveContractTapscripts(contract);
            expect(leafHex({ leaf: derived.intentTapLeafScript })).toBe(
                script.refundWithoutReceiverScript,
            );
            expect(leafHex({ leaf: derived.forfeitTapLeafScript })).toBe(
                script.refundWithoutReceiverScript,
            );
        }
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
    /**
     * The settle pre-flight. `isGenericallySpendable: false` keeps a lockup out
     * of generic selection and deliberately leaves `settle({ inputs })` open —
     * naming an outpoint is the intent that gate protects. Naming one before
     * the refund path opens is still a mistake, and without this it is one the
     * server reports, after the round trip, without saying which timelock was
     * short.
     *
     * The refusals are the easy half. The silences are the point: this must
     * never convert a spend the server would have accepted into a local throw.
     */
    describe("assertSpendableNow", () => {
        const contextAt = (over: Partial<PathContext> = {}): PathContext => ({
            collaborative: true,
            currentTime: Date.now(),
            walletPubKey: SENDER,
            ...over,
        });

        const check = (params: Record<string, string>, context: PathContext) =>
            VHTLCV2ContractHandler.assertSpendableNow!(
                VHTLCV2ContractHandler.createScript(params),
                contractOf(params),
                context,
            );

        it("refuses the sender's spend before the refund height, naming it", () => {
            expect(() => check(fullParams(), contextAt({ blockHeight: 799_999 }))).toThrow(
                /refund path opens at block 800000, now 799999/,
            );
        });

        it("allows it once the height is reached", () => {
            expect(() => check(fullParams(), contextAt({ blockHeight: 800_000 }))).not.toThrow();
        });

        it("refuses a seconds-typed locktime against the clock", () => {
            const future = Math.floor(Date.now() / 1000) + 3600;
            expect(() =>
                check(fullParams({ refundLocktime: String(future) }), contextAt()),
            ).toThrow(/cannot be spent yet/);
        });

        it("says nothing when the height is unknown — unreadable is not immature", () => {
            // The false-refusal case this design exists to avoid: height-typed
            // locktime, no chain tip. `isCltvSatisfied` reports false here, so
            // anything refusing on that alone would reject a mature lockup.
            expect(() => check(fullParams(), contextAt({ blockHeight: undefined }))).not.toThrow();
        });

        it("says nothing to the receiver, whose claim turns on a preimage", () => {
            expect(() =>
                check(fullParams(), contextAt({ walletPubKey: RECEIVER, blockHeight: 799_999 })),
            ).not.toThrow();
        });

        it("says nothing to a wallet that is neither party", () => {
            const stranger = "0".repeat(64);
            expect(() =>
                check(fullParams(), contextAt({ walletPubKey: stranger, blockHeight: 799_999 })),
            ).not.toThrow();
        });

        /**
         * A seconds-typed locktime must be judged against the chain, not the
         * host. The server matures these against median-time-past, which trails
         * wall clock, so a machine whose clock runs slow would otherwise refuse
         * a spend the chain already accepts — the same false refusal the
         * `unknown` state exists to prevent, arriving by a different door.
         */
        it("prefers chain time over the host clock for a seconds-typed locktime", () => {
            const locktime = Math.floor(Date.now() / 1000) + 3600;
            // Host clock says an hour short; the chain says matured.
            expect(() =>
                check(
                    fullParams({ refundLocktime: String(locktime) }),
                    contextAt({ chainTime: locktime + 1 }),
                ),
            ).not.toThrow();
            // And the reverse: chain behind, host ahead — still refused.
            expect(() =>
                check(
                    fullParams({ refundLocktime: String(locktime) }),
                    contextAt({
                        currentTime: (locktime + 3600) * 1000,
                        chainTime: locktime - 1,
                    }),
                ),
            ).toThrow(/cannot be spent yet/);
        });

        it("says nothing about a unilateral spend, which answers to its CSV", () => {
            expect(() =>
                check(fullParams(), contextAt({ collaborative: false, blockHeight: 799_999 })),
            ).not.toThrow();
        });

        it("is shared with the v1 handler, so the two cannot drift", () => {
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
            const v1Contract: Contract = {
                type: "vhtlc",
                params,
                script: hex.encode(VHTLCContractHandler.createScript(params).pkScript),
                address: "address",
                state: "active",
                createdAt: Date.now(),
            };
            expect(() =>
                VHTLCContractHandler.assertSpendableNow!(
                    VHTLCContractHandler.createScript(params),
                    v1Contract,
                    contextAt({ blockHeight: 799_999 }),
                ),
            ).toThrow(/refund path opens at block 800000/);
        });
    });

    describe("blockHeight reaches the handler through ContractManager", () => {
        type Tip = { height: number; time: number } | undefined;
        /** A tip at `height`; its time only matters to the seconds-typed cases. */
        const at =
            (height: number, time = 1_700_000_000): (() => Promise<Tip>) =>
            async () => ({
                height,
                time,
            });

        const managerFor = async (chainTip?: () => Promise<Tip>) =>
            ContractManager.create({
                indexerProvider: createMockIndexerProvider(),
                contractRepository: new InMemoryContractRepository(),
                walletRepository: new InMemoryWalletRepository(),
                chainTip,
            });

        const refundLeafOffered = async (chainTip?: () => Promise<Tip>): Promise<boolean> => {
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
            expect(await refundLeafOffered(at(799_999))).toBe(false);
        });

        it("offers it once the tip reaches the locktime", async () => {
            expect(await refundLeafOffered(at(800_000))).toBe(true);
        });

        it("collapses concurrent cache misses onto a single tip read", async () => {
            let reads = 0;
            const manager = await managerFor(async () => {
                reads += 1;
                // Resolve on a later turn, so all three callers are waiting on
                // the same in-flight read rather than being served in sequence.
                await Promise.resolve();
                return { height: 800_000, time: 1_700_000_000 };
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

        /**
         * The handler cases above prove the rule; these prove it is reachable.
         * The settle pre-flight calls `assertSpendableNow?.()` optionally — an
         * unimplemented manager is a valid "no opinion" — so a wiring break
         * here would not fail loudly, it would go quiet. That is the failure
         * mode worth a test of its own.
         */
        const assertThrough = async (tip: number | undefined) => {
            const manager = await managerFor(tip === undefined ? undefined : at(tip));
            const contract = contractOf(fullParams());
            await manager.createContract(contract);
            const vtxo = { txid: "a".repeat(64), vout: 0, script: contract.script };
            return manager.assertSpendableNow!([vtxo], async () => SENDER);
        };

        it("refuses an immature lockup through the manager, not just the handler", async () => {
            await expect(assertThrough(799_999)).rejects.toThrow(/cannot be spent yet/);
        });

        it("allows it through the manager once mature", async () => {
            await expect(assertThrough(800_000)).resolves.toBeUndefined();
        });

        it("stays silent when no tip is available", async () => {
            await expect(assertThrough(undefined)).resolves.toBeUndefined();
        });

        /**
         * A bare outpoint must not be published to handlers as a coin. It has
         * no `status`, and `isCsvSpendable` reads `vtxo.status.block_time`
         * unguarded — so a handler answering a CSV question would meet a
         * TypeError rather than a `false`. Asserted through the real dispatch
         * with a temporary handler, because the type system cannot say this:
         * every AssertSpendableInput structurally satisfies `isVirtualCoin`.
         */
        it("does not hand a handler a coin that has no status", async () => {
            const manager = await managerFor(at(799_999));
            const contract = contractOf(fullParams());
            await manager.createContract(contract);

            const real = contractHandlers.get("vhtlc-v2")!;
            let seen: PathContext | undefined;
            contractHandlers.unregister("vhtlc-v2");
            contractHandlers.register({
                ...real,
                assertSpendableNow: (_s: unknown, _c: unknown, ctx: PathContext) => {
                    seen = ctx;
                },
            } as never);
            try {
                await manager.assertSpendableNow!(
                    [{ txid: "c".repeat(64), vout: 0, script: contract.script }],
                    async () => SENDER,
                );
            } finally {
                contractHandlers.unregister("vhtlc-v2");
                contractHandlers.register(real as never);
            }

            expect(seen).toBeDefined();
            expect(seen!.vtxo).toBeUndefined();
        });

        const reasonsThrough = async (
            tip: number | undefined,
            walletPubKey = SENDER,
            vouts = [0],
        ) => {
            const manager = await managerFor(tip === undefined ? undefined : at(tip));
            const contract = contractOf(fullParams());
            await manager.createContract(contract);
            return manager.unspendableNowReasons!(
                vouts.map((vout) => ({ txid: "a".repeat(64), vout, script: contract.script })),
                async () => walletPubKey,
            );
        };

        it("reports the refusal against the outpoint instead of throwing", async () => {
            const refused = await reasonsThrough(799_999);
            expect([...refused.keys()]).toEqual([`${"a".repeat(64)}:0`]);
            expect(refused.get(`${"a".repeat(64)}:0`)).toMatch(/cannot be spent yet/);
        });

        it("reports every refused input, not just the first", async () => {
            const refused = await reasonsThrough(799_999, SENDER, [0, 1]);
            expect(refused.size).toBe(2);
        });

        it("reports nothing once mature, and nothing without a tip", async () => {
            expect(await reasonsThrough(800_000)).toEqual(new Map());
            expect(await reasonsThrough(undefined)).toEqual(new Map());
        });

        it("reports nothing for the receiver, whose claim it cannot judge", async () => {
            expect(await reasonsThrough(799_999, RECEIVER)).toEqual(new Map());
        });

        it("reports nothing for a key the covenant does not name", async () => {
            // The silent no-op the recovery filter risks: role resolution matches
            // the wallet's own key, so a lockup committing a derived sender is
            // never refused — the bound `unspendableNow` documents.
            expect(await reasonsThrough(799_999, SERVER)).toEqual(new Map());
        });

        /**
         * The v1 population is what #702 exposed to recovery, and dispatch is
         * by `contract.type` — so a `vhtlc` row reaching the same answer is the
         * half the v2 cases above cannot show.
         */
        it("reaches a v1 row through the same dispatch", async () => {
            const manager = await managerFor(at(799_999));
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
            const script = hex.encode(VHTLCContractHandler.createScript(params).pkScript);
            await manager.createContract({
                type: "vhtlc",
                params,
                script,
                address: "address",
            } as never);
            const vtxo = { txid: "d".repeat(64), vout: 0, script };

            const refused = await manager.unspendableNowReasons!([vtxo], async () => SENDER);

            expect(refused.get(`${"d".repeat(64)}:0`)).toMatch(/refund path opens at block 800000/);
            expect(await manager.unspendableNowReasons!([vtxo], async () => RECEIVER)).toEqual(
                new Map(),
            );
        });

        it("never reads a tip when no contract has an opinion", async () => {
            let reads = 0;
            const manager = await managerFor(async () => {
                reads += 1;
                return { height: 800_000, time: 1_700_000_000 };
            });
            // A `default` row: its handler implements no assertSpendableNow, so
            // the whole check must short-circuit before touching the provider.
            // Script derived, not invented — createContract refuses any row
            // whose script disagrees with its params.
            const defaultHandler = contractHandlers.get("default")!;
            const params = {
                pubKey: SENDER,
                serverPubKey: SERVER,
                csvTimelock: JSON.stringify({ type: "blocks", value: "144" }),
            };
            const script = hex.encode(defaultHandler.createScript(params).pkScript);
            await manager.createContract({
                type: "default",
                params,
                script,
                address: "address",
            } as never);
            await manager.assertSpendableNow!(
                [{ txid: "b".repeat(64), vout: 0, script }],
                async () => SENDER,
            );
            expect(reads).toBe(0);
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

        /**
         * A rejection is the easy failure; a socket that opens and then goes
         * quiet is the one `fetch` has no answer for. It never settles, so the
         * `catch` above never runs — and since every later query joins the same
         * in-flight read, one stalled tip would wedge path resolution for the
         * manager's lifetime rather than for one call.
         */
        it("gives up on a stalled tip read, and lets the next query start a fresh one", async () => {
            let reads = 0;
            const manager = await managerFor(() => {
                reads += 1;
                return new Promise<Tip>(() => {});
            });
            const contract = contractOf(fullParams());
            await manager.createContract(contract);
            const script = VHTLCV2ContractHandler.createScript(contract.params);
            const query = () =>
                manager.getSpendablePaths({
                    contractScript: contract.script,
                    collaborative: true,
                    walletPubKey: SENDER,
                });

            vi.useFakeTimers();
            try {
                const first = query();
                // Well past any bound, so the test does not encode the exact one.
                await vi.advanceTimersByTimeAsync(60_000);
                expect((await first).map(leafHex)).not.toContain(
                    script.refundWithoutReceiverScript,
                );

                const second = query();
                await vi.advanceTimersByTimeAsync(60_000);
                await second;
                // Not still joined to the first, dead read.
                expect(reads).toBe(2);
            } finally {
                vi.useRealTimers();
            }
        });

        it("does not wedge on a source that throws synchronously", async () => {
            let reads = 0;
            const manager = await managerFor(() => {
                reads += 1;
                if (reads === 1) throw new Error("provider not ready");
                return at(800_000)();
            });
            const contract = contractOf(fullParams());
            await manager.createContract(contract);
            const script = VHTLCV2ContractHandler.createScript(contract.params);
            const query = () =>
                manager.getSpendablePaths({
                    contractScript: contract.script,
                    collaborative: true,
                    walletPubKey: SENDER,
                });

            expect((await query()).map(leafHex)).not.toContain(script.refundWithoutReceiverScript);
            // The transient throw must not outlive itself: the provider has
            // recovered, so the matured leaf comes back.
            expect((await query()).map(leafHex)).toContain(script.refundWithoutReceiverScript);
        });

        it("does not read the tip for getAllSpendingPaths, which ignores timelocks", async () => {
            let reads = 0;
            const manager = await managerFor(async () => {
                reads += 1;
                return at(800_000)();
            });
            const contract = contractOf(fullParams());
            await manager.createContract(contract);

            await manager.getAllSpendingPaths({
                contractScript: contract.script,
                collaborative: true,
                walletPubKey: SENDER,
            });

            expect(reads).toBe(0);
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
