import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { hex } from "@scure/base";
import { getNetwork, retiredDelegatePubKeys, type Network } from "../src/networks";
import { DelegateContractHandler, delegateDiscoveryKeys } from "../src/contracts/handlers/delegate";
import { DefaultVtxo } from "../src/script/default";
import { DelegateVtxo } from "../src/script/delegate";
import { deriveDescriptorLeafPubKey } from "../src/identity/descriptor";
import {
    installRestoreHarness,
    installRestoreHarnessWithInfo,
    teardownRestoreHarness,
    makeStaticWalletForTest,
    makeHdWalletForTest,
    awaitWalletBooted,
    makeUnreachableExecutor,
    mockArkInfo,
} from "./helpers/restoreWallet";

const MUTINYNET_SIGNER = "03301078808e4f7bc0dadfe29e34b1df8eaf0108ef06b1722274075ebc107a127a";
const MUTINYNET_DEPRECATED_SIGNER =
    "03fa73c6e4876ffb2dfc961d763cca9abc73d4b88efcb8f5e7ff92dc55e9aa553d";
const MUTINYNET_RETIRED_DELEGATE =
    "2903b15efe236d9609da10e536fb32cdf1d144778797bbf32a9b94e86601be6a";
const BITCOIN_SIGNER = "038202bebddeb1f7442803897a85eaf3ce9254d07df0172fc3725ab5f0d097779c";
const BITCOIN_RETIRED_DELEGATE = "6d7d45360014bce9a8ad30a10c28dd1571a22a2e90c9682268404d37b5b114a6";
const FOREIGN_SIGNER = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

const keysHex = (keys: Uint8Array[]) => keys.map((k) => hex.encode(k));

describe("retiredDelegatePubKeys", () => {
    const mutinynet = getNetwork("mutinynet");

    it("matches by the current signer", () => {
        expect(keysHex(retiredDelegatePubKeys(mutinynet, [MUTINYNET_SIGNER]))).toEqual([
            MUTINYNET_RETIRED_DELEGATE,
        ]);
        expect(keysHex(retiredDelegatePubKeys(getNetwork("bitcoin"), [BITCOIN_SIGNER]))).toEqual([
            BITCOIN_RETIRED_DELEGATE,
        ]);
    });

    it("matches by a deprecated signer only", () => {
        expect(
            keysHex(
                retiredDelegatePubKeys(mutinynet, [FOREIGN_SIGNER, MUTINYNET_DEPRECATED_SIGNER]),
            ),
        ).toEqual([MUTINYNET_RETIRED_DELEGATE]);
    });

    it("matches compressed and x-only signer hex", () => {
        expect(retiredDelegatePubKeys(mutinynet, [MUTINYNET_SIGNER.slice(2)])).toHaveLength(1);
    });

    it("is empty for a foreign operator", () => {
        expect(retiredDelegatePubKeys(mutinynet, [FOREIGN_SIGNER])).toEqual([]);
    });

    it("does not match another network's operator", () => {
        expect(retiredDelegatePubKeys(mutinynet, [BITCOIN_SIGNER])).toEqual([]);
    });

    it("is empty for regtest and for an unnamed Network", () => {
        expect(retiredDelegatePubKeys(getNetwork("regtest"), [MUTINYNET_SIGNER])).toEqual([]);
        const { name: _, ...unnamed } = mutinynet;
        expect(retiredDelegatePubKeys(unnamed as Network, [MUTINYNET_SIGNER])).toEqual([]);
    });

    it("skips malformed signers and still matches the others", () => {
        expect(
            keysHex(retiredDelegatePubKeys(mutinynet, ["", "zz", "abcd", MUTINYNET_SIGNER])),
        ).toEqual([MUTINYNET_RETIRED_DELEGATE]);
    });
});

describe("DelegateContractHandler with retired keys", () => {
    const pkHex = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const server = hex.decode("c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5");
    const deprecated = hex.decode(
        "e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13",
    );
    const configured = hex.decode(
        "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
    );
    const retired = hex.decode(MUTINYNET_RETIRED_DELEGATE);
    const descriptor = `tr(${pkHex})`;
    const timelocks = [
        DefaultVtxo.Script.DEFAULT_TIMELOCK,
        { value: 288n, type: "blocks" as const },
    ];
    const base = { network: { hrp: "tark" }, serverPubKey: server, csvTimelocks: timelocks };

    it("dedupes the configured key against the retired ones", () => {
        expect(
            delegateDiscoveryKeys({
                delegatePubKey: retired,
                retiredDelegatePubKeys: [retired, configured],
            }).map((k) => hex.encode(k)),
        ).toEqual([MUTINYNET_RETIRED_DELEGATE, hex.encode(configured)]);
    });

    it("yields one candidate per key × signer × timelock", () => {
        const out = DelegateContractHandler.candidatesAt!(0, descriptor, {
            ...base,
            deprecatedSignerPubKeys: [deprecated],
            delegatePubKey: configured,
            retiredDelegatePubKeys: [retired],
        });
        expect(out).toHaveLength(2 * 2 * 2);
        expect(new Set(out.map((c) => c.script)).size).toBe(8);
        const retiredRows = out.filter(
            (c) => c.params.delegatePubKey === MUTINYNET_RETIRED_DELEGATE,
        );
        expect(retiredRows).toHaveLength(4);
        const [row] = retiredRows;
        expect(row.script).toBe(
            hex.encode(
                DelegateContractHandler.createScript(row.params as Record<string, string>).pkScript,
            ),
        );
    });

    it("finds retired-key candidates without a configured delegator", () => {
        const out = DelegateContractHandler.candidatesAt!(0, descriptor, {
            ...base,
            retiredDelegatePubKeys: [retired],
        });
        expect(out).toHaveLength(2);
        expect(out.every((c) => c.params.delegatePubKey === MUTINYNET_RETIRED_DELEGATE)).toBe(true);
    });

    it("a configured key equal to the retired one yields no duplicate", () => {
        const out = DelegateContractHandler.candidatesAt!(0, descriptor, {
            ...base,
            delegatePubKey: retired,
            retiredDelegatePubKeys: [retired],
        });
        expect(out).toHaveLength(2);
    });

    it("answers every index with [] when there is no key", async () => {
        const probes: string[][] = [];
        const out = await DelegateContractHandler.discoverRange!(
            [
                { index: 0, descriptor },
                { index: 1, descriptor },
            ],
            {
                ...base,
                indexerProvider: {
                    async getVtxos(opts: { scripts: string[] }) {
                        probes.push(opts.scripts);
                        return { vtxos: [] };
                    },
                } as never,
                onchainProvider: {} as never,
                retiredDelegatePubKeys: [],
            },
        );
        expect([...out.entries()]).toEqual([
            [0, []],
            [1, []],
        ]);
        expect(probes).toEqual([]);
    });
});

describe("Wallet discovery of retired delegate contracts", () => {
    const arkadeInfo = { ...mockArkInfo, signerPubkey: MUTINYNET_SIGNER };

    afterEach(() => {
        teardownRestoreHarness();
    });

    const retiredScript = (
        pubKey: Uint8Array,
        serverPubKey: Uint8Array,
        csvTimelock: DelegateVtxo.Options["csvTimelock"],
    ) =>
        new DelegateVtxo.Script({
            pubKey,
            serverPubKey,
            delegatePubKey: hex.decode(MUTINYNET_RETIRED_DELEGATE),
            csvTimelock,
        });

    const delegateRows = async (wallet: {
        getContractManager(): Promise<{
            getContracts(f: { type: string }): Promise<{ params: Record<string, string> }[]>;
        }>;
    }) => (await wallet.getContractManager()).getContracts({ type: "delegate" });

    describe("on Arkade's operator, with an Executor", () => {
        beforeEach(() => installRestoreHarnessWithInfo(arkadeInfo));

        it("creates the retired delegate rows at index 0 on boot", async () => {
            const { wallet } = await makeStaticWalletForTest(new Set(), new Set(), {
                executorProvider: makeUnreachableExecutor(),
            });
            try {
                await awaitWalletBooted(wallet);
                const rows = await delegateRows(wallet);
                const pubKey = hex.encode(await wallet.identity.xOnlyPublicKey());
                expect(rows).toHaveLength(wallet.walletContractTimelocks.length);
                for (const row of rows) {
                    expect(row.params.delegatePubKey).toBe(MUTINYNET_RETIRED_DELEGATE);
                    expect(row.params.pubKey).toBe(pubKey);
                }
            } finally {
                await wallet.dispose();
            }
        });

        it("restores a coin at a retired delegate contract, spendable through its forfeit leaf", async () => {
            const { wallet, indexer } = await makeStaticWalletForTest(new Set(), new Set(), {
                executorProvider: makeUnreachableExecutor(),
            });
            try {
                const script = retiredScript(
                    await wallet.identity.xOnlyPublicKey(),
                    wallet.offchainTapscript.options.serverPubKey,
                    wallet.walletContractTimelocks[0],
                );
                indexer.usedScripts.add(hex.encode(script.pkScript));

                await wallet.restore();

                expect((await wallet.getBalance()).total).toBeGreaterThan(0);
                const [vtxo] = await wallet.getVtxos();
                expect(vtxo.script).toBe(hex.encode(script.pkScript));
                // The forfeit leaf is the wallet + operator 2-of-2: no delegator needed.
                expect(vtxo.forfeitTapLeafScript).toEqual(script.forfeit());
                const leaf = hex.encode(vtxo.forfeitTapLeafScript[1]);
                expect(leaf).not.toContain(MUTINYNET_RETIRED_DELEGATE);
            } finally {
                await wallet.dispose();
            }
        });

        it("restores a coin at a retired delegate contract at an HD index", async () => {
            const { wallet, indexer, hdProvider } = await makeHdWalletForTest(
                new Set(),
                new Set(),
                { executorProvider: makeUnreachableExecutor() },
            );
            try {
                const script = retiredScript(
                    deriveDescriptorLeafPubKey(hdProvider.materializeDescriptorAt(3)),
                    wallet.offchainTapscript.options.serverPubKey,
                    wallet.walletContractTimelocks[0],
                );
                indexer.usedScripts.add(hex.encode(script.pkScript));

                await wallet.restore({ gapLimit: 5 });

                expect((await wallet.getBalance()).total).toBeGreaterThan(0);
                expect((await wallet.getVtxos()).map((v) => v.script)).toContain(
                    hex.encode(script.pkScript),
                );
            } finally {
                await wallet.dispose();
            }
        }, 20_000);

        it("feeds the retired keys to the look-ahead band", async () => {
            const { wallet } = await makeHdWalletForTest(new Set(), new Set(), {
                executorProvider: makeUnreachableExecutor(),
            });
            try {
                const deps = (
                    wallet as unknown as {
                        receiveCandidateDeps(): { retiredDelegatePubKeys?: Uint8Array[] };
                    }
                ).receiveCandidateDeps();
                expect(keysHex(deps.retiredDelegatePubKeys ?? [])).toEqual([
                    MUTINYNET_RETIRED_DELEGATE,
                ]);
            } finally {
                await wallet.dispose();
            }
        });
    });

    describe("on Arkade's operator, without an Executor", () => {
        beforeEach(() => installRestoreHarnessWithInfo(arkadeInfo));

        it("creates no delegate rows on boot", async () => {
            const { wallet } = await makeStaticWalletForTest();
            try {
                await awaitWalletBooted(wallet);
                expect(await delegateRows(wallet)).toEqual([]);
            } finally {
                await wallet.dispose();
            }
        });

        it("restores nothing at a retired delegate contract", async () => {
            const { wallet, indexer } = await makeStaticWalletForTest();
            try {
                const script = retiredScript(
                    await wallet.identity.xOnlyPublicKey(),
                    wallet.offchainTapscript.options.serverPubKey,
                    wallet.walletContractTimelocks[0],
                );
                indexer.usedScripts.add(hex.encode(script.pkScript));

                await wallet.restore();

                expect(await wallet.getVtxos()).toEqual([]);
                expect(await delegateRows(wallet)).toEqual([]);
            } finally {
                await wallet.dispose();
            }
        });

        it("feeds no retired keys to the look-ahead band", async () => {
            const { wallet } = await makeHdWalletForTest();
            try {
                const deps = (
                    wallet as unknown as {
                        receiveCandidateDeps(): { retiredDelegatePubKeys?: Uint8Array[] };
                    }
                ).receiveCandidateDeps();
                expect(deps.retiredDelegatePubKeys).toEqual([]);
            } finally {
                await wallet.dispose();
            }
        });
    });

    it("matches Arkade's operator by a deprecated signer", async () => {
        installRestoreHarnessWithInfo({
            ...mockArkInfo,
            deprecatedSigners: [{ pubkey: MUTINYNET_DEPRECATED_SIGNER, cutoffDate: 0n }],
        });
        const { wallet } = await makeStaticWalletForTest(new Set(), new Set(), {
            executorProvider: makeUnreachableExecutor(),
        });
        try {
            await awaitWalletBooted(wallet);
            const rows = await delegateRows(wallet);
            // Fanned over the current and the deprecated signer.
            expect(rows).toHaveLength(2 * wallet.walletContractTimelocks.length);
            expect(rows.every((r) => r.params.delegatePubKey === MUTINYNET_RETIRED_DELEGATE)).toBe(
                true,
            );
        } finally {
            await wallet.dispose();
        }
    });

    it("creates no delegate rows on another operator", async () => {
        installRestoreHarness();
        const { wallet } = await makeStaticWalletForTest(new Set(), new Set(), {
            executorProvider: makeUnreachableExecutor(),
        });
        try {
            await awaitWalletBooted(wallet);
            expect(await delegateRows(wallet)).toEqual([]);
        } finally {
            await wallet.dispose();
        }
    });
});
