/**
 * The override matrix: default, replaced and `null` for every
 * `CorridorOverrides` key, plus the two deps that reach `MissingCorridorDep` by
 * another door — the arkade repository, which has no default to fall back to,
 * and the co-signer key, which is required on the networks nobody pinned.
 *
 * Called through `resolveCorridorDeps` rather than through a quote: "at quote
 * time" names an entry point a later milestone owns, and this milestone's
 * promise is that the refusal lands at dep resolution, before funding.
 */
import {
    BITCOIN_EMULATOR_PUBKEY,
    ESPLORA_URL,
    ProviderUnavailableError,
    REGTEST_EMULATOR_PUBKEY,
    type ArkadeInfo,
    type IWallet,
} from "@arkade-os/sdk";
import { describe, expect, it, vi } from "vitest";
import { decodeBolt11 } from "../../../src/client/corridors/bolt11";
import {
    resolveCorridorBase,
    resolveCorridorDeps,
    type CorridorOverrides,
} from "../../../src/client/corridors/deps";
import { MissingCorridorDep, OperatorUnreachable } from "../../../src/client/errors";
import type { AssetSwapRepository } from "../../../src/repository";
import type { SwapOperator } from "../../../src/refund";
import { OPERATOR_SIGNER, corridorBaseFor } from "./fixtures";

const repository = {} as AssetSwapRepository;

describe("resolveCorridorDeps", () => {
    describe("the lightning decoder", () => {
        it("defaults to the built-in", () => {
            expect(
                resolveCorridorDeps("lightning", undefined, corridorBaseFor("regtest")).decode,
            ).toBe(decodeBolt11);
        });

        it("takes a replacement", () => {
            const decode = vi.fn();
            const overrides: CorridorOverrides = { lightning: { decode } };
            expect(
                resolveCorridorDeps("lightning", overrides, corridorBaseFor("regtest")).decode,
            ).toBe(decode);
        });

        it("refuses `null` — the shape `need()` cannot see", () => {
            // `undefined` takes the default; `null` is a caller saying "not
            // this one", and a guard that tests `value === undefined` passes it
            // straight through to whatever needed it.
            expect(() =>
                resolveCorridorDeps(
                    "lightning",
                    { lightning: { decode: null } },
                    corridorBaseFor("regtest"),
                ),
            ).toThrow(MissingCorridorDep);
            expect(() =>
                resolveCorridorDeps(
                    "lightning",
                    { lightning: { decode: null } },
                    corridorBaseFor("regtest"),
                ),
            ).toThrow(/the lightning corridor has no bolt11 decoder/);
        });
    });

    describe("the covclaimd deployment key", () => {
        it("defaults to absent, which is the internal ephemeral seal", () => {
            expect(
                resolveCorridorDeps("lightning", undefined, corridorBaseFor("regtest")).covclaimd,
            ).toBe(undefined);
        });

        it("takes a deployment key", () => {
            const covclaimd = { pubkey: `02${"11".repeat(32)}` };
            expect(
                resolveCorridorDeps(
                    "lightning",
                    { lightning: { covclaimd } },
                    corridorBaseFor("regtest"),
                ).covclaimd,
            ).toEqual(covclaimd);
        });

        it("refuses `null`", () => {
            expect(() =>
                resolveCorridorDeps(
                    "lightning",
                    { lightning: { covclaimd: null } },
                    corridorBaseFor("regtest"),
                ),
            ).toThrow(/the lightning corridor has no covclaimd deployment key/);
        });
    });

    describe("the onchain chain source", () => {
        it("defaults to one built on `ESPLORA_URL[network]`", () => {
            const fetchImpl = vi.fn(async () =>
                Response.json([{ id: "b", height: 101, mediantime: 1_700_000_000 }]),
            );
            const base = corridorBaseFor("regtest", { fetchImpl: fetchImpl as never });
            const { chain } = resolveCorridorDeps("onchain", undefined, base);
            return chain.getMtp().then((mtp) => {
                expect(mtp).toBe(1_700_000_000);
                expect(fetchImpl).toHaveBeenCalledWith(`${ESPLORA_URL.regtest}/blocks`);
            });
        });

        it("takes an esplora URL — the override is the URL, not a ChainSource", () => {
            // There is no wallet-held provider to substitute: `onchainProvider`
            // is a field of the concrete wallet and never of `IWallet`.
            const fetchImpl = vi.fn(async () =>
                Response.json([{ id: "b", height: 7, mediantime: 42 }]),
            );
            const base = corridorBaseFor("regtest", { fetchImpl: fetchImpl as never });
            const { chain } = resolveCorridorDeps(
                "onchain",
                { onchain: { chain: { esploraUrl: "http://elsewhere/api" } } },
                base,
            );
            return chain.getMtp().then(() => {
                expect(fetchImpl).toHaveBeenCalledWith("http://elsewhere/api/blocks");
            });
        });

        it("refuses `null`", () => {
            expect(() =>
                resolveCorridorDeps(
                    "onchain",
                    { onchain: { chain: null } },
                    corridorBaseFor("regtest"),
                ),
            ).toThrow(/the onchain corridor has no chain source/);
        });
    });

    describe("the arkade repository", () => {
        it("has no default yet, so an absent one stays absent", () => {
            expect(
                resolveCorridorDeps("arkade", undefined, corridorBaseFor("regtest")).repository,
            ).toBe(undefined);
        });

        it("takes a replacement", () => {
            expect(
                resolveCorridorDeps(
                    "arkade",
                    { arkade: { repository } },
                    corridorBaseFor("regtest"),
                ).repository,
            ).toBe(repository);
        });

        it("refuses `null`", () => {
            expect(() =>
                resolveCorridorDeps(
                    "arkade",
                    { arkade: { repository: null } },
                    corridorBaseFor("regtest"),
                ),
            ).toThrow(/the arkade corridor has no repository/);
        });
    });

    describe("the covenant co-signer", () => {
        it("resolves from the network name, never from the operator's self-report", () => {
            expect(
                resolveCorridorDeps("arkade", undefined, corridorBaseFor("regtest")).emulatorPubkey,
            ).toBe(REGTEST_EMULATOR_PUBKEY);
            expect(
                resolveCorridorDeps("arkade", undefined, corridorBaseFor("bitcoin")).emulatorPubkey,
            ).toBe(BITCOIN_EMULATOR_PUBKEY);
        });

        it("is required on the networks nobody pinned, and its absence is typed", () => {
            // `EMULATOR_PUBKEYS` pins bitcoin, mutinynet and regtest only. The
            // v2 id vocabulary admits testnet and signet, where the override is
            // the only source — and a bare `Error` escaping the module is what
            // this converts.
            for (const network of ["testnet", "signet"] as const) {
                expect(() =>
                    resolveCorridorDeps("arkade", undefined, corridorBaseFor(network)),
                ).toThrow(MissingCorridorDep);
                expect(() =>
                    resolveCorridorDeps("arkade", undefined, corridorBaseFor(network)),
                ).toThrow(new RegExp(`covenant co-signer key \\(none is pinned for ${network}`));
            }
        });

        it("takes the override on an unpinned network", () => {
            const emulatorPubkey = `03${"ab".repeat(32)}`;
            expect(
                resolveCorridorDeps(
                    "arkade",
                    undefined,
                    corridorBaseFor("signet", { emulatorPubkey }),
                ).emulatorPubkey,
            ).toBe(emulatorPubkey);
        });

        it("leaves a malformed override to core's own refusal", () => {
            // Core refuses rather than passing it into a leaf, and a typo here
            // would otherwise surface as an unspendable contract much later.
            expect(() =>
                resolveCorridorDeps(
                    "arkade",
                    undefined,
                    corridorBaseFor("regtest", { emulatorPubkey: "nope" }),
                ),
            ).toThrow(/33-byte compressed secp256k1 hex/);
        });
    });

    it("carries both seams onto the arkade module, and neither replaces the other", () => {
        // The wallet answers *who and where* — only it can make the live,
        // fail-closed info read, since `SwapOperator.getInfo()` takes no
        // options — and the operator seam answers *submit and finalize*.
        const wallet = {} as IWallet;
        const operator = {} as SwapOperator;
        const deps = resolveCorridorDeps(
            "arkade",
            undefined,
            corridorBaseFor("regtest", { wallet, operator }),
        );
        expect(deps.wallet).toBe(wallet);
        expect(deps.operator).toBe(operator);
    });

    it("resolves one corridor without touching another's deps", () => {
        // `MissingCorridorDep`'s own boundary note: a missing dep for a
        // corridor nobody uses is not an error.
        const overrides: CorridorOverrides = {
            onchain: { chain: null },
            arkade: { repository: null },
        };
        expect(resolveCorridorDeps("lightning", overrides, corridorBaseFor("regtest")).decode).toBe(
            decodeBolt11,
        );
    });
});

describe("resolveCorridorBase", () => {
    const info = { network: "regtest", signerPubkey: OPERATOR_SIGNER, deprecatedSigners: [] };
    const walletAnswering = (getArkadeInfo: IWallet["getArkadeInfo"]): IWallet =>
        ({ getArkadeInfo }) as IWallet;

    it("reads live, and derives the network and signer set from that one read", async () => {
        const getArkadeInfo = vi.fn(async () => info as unknown as ArkadeInfo);
        const base = await resolveCorridorBase({
            wallet: walletAnswering(getArkadeInfo),
            operator: {} as SwapOperator,
        });
        // A snapshot would bind a covenant to a signer key the operator may no
        // longer co-sign for.
        expect(getArkadeInfo).toHaveBeenCalledWith({ requireLive: true });
        expect(base.networkName).toBe("regtest");
        expect(base.network.hrp).toBe("tark");
        expect(base.signerSet.active).toBe(OPERATOR_SIGNER);
    });

    it("wraps every shape the live read can throw", async () => {
        // `requireLive` re-throws the provider's raw error unwrapped, so the
        // shape depends on how the read failed. A `catch` on a matched subset
        // would let exactly these through untyped.
        const shapes: unknown[] = [
            new ProviderUnavailableError("offline"),
            new TypeError("fetch failed"),
            new Error("boom"),
            Object.assign(new Error("aborted"), { name: "TimeoutError" }),
            // Across the service-worker boundary the error is a fresh `Error`
            // whose only branchable identity is `cause.name`.
            new Error("Failed to get arkade info: Error", {
                cause: Object.assign(new Error("offline"), { name: "ProviderUnavailableError" }),
            }),
            "a thrown string",
        ];
        for (const shape of shapes) {
            const thrown = await resolveCorridorBase({
                wallet: walletAnswering(async () => {
                    throw shape;
                }),
                operator: {} as SwapOperator,
            }).catch((error: unknown) => error);
            expect(thrown).toBeInstanceOf(OperatorUnreachable);
            expect((thrown as OperatorUnreachable).cause).toBe(shape);
        }
    });

    it("fails closed even when the snapshot would have answered", async () => {
        // `requireLive` is the whole point: a snapshot binds a covenant to a
        // signer key the operator may no longer co-sign for, so a wallet that
        // could answer from cache still refuses here.
        const getArkadeInfo = vi.fn(async (opts?: { requireLive?: boolean }) => {
            if (opts?.requireLive) throw new ProviderUnavailableError("offline");
            return info as unknown as ArkadeInfo;
        });
        await expect(
            resolveCorridorBase({
                wallet: walletAnswering(getArkadeInfo as IWallet["getArkadeInfo"]),
                operator: {} as SwapOperator,
            }),
        ).rejects.toBeInstanceOf(OperatorUnreachable);
        await expect(
            (walletAnswering(getArkadeInfo as IWallet["getArkadeInfo"]) as IWallet).getArkadeInfo(),
        ).resolves.toMatchObject({ network: "regtest" });
    });

    it("leaves core's fail-closed network narrowing alone", async () => {
        // An operator answering with a network this SDK does not know is not
        // unreachable, and resolving it to mainnet parameters is the failure
        // `getNetwork` exists to prevent.
        const thrown = await resolveCorridorBase({
            wallet: walletAnswering(async () => ({ ...info, network: "elsewhere" }) as never),
            operator: {} as SwapOperator,
        }).catch((error: unknown) => error);
        expect(thrown).not.toBeInstanceOf(OperatorUnreachable);
        expect((thrown as Error).message).toMatch(/Unsupported network/);
    });
});
