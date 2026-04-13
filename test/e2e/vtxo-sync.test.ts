import { expect, describe, it } from "vitest";
import {
    Wallet,
    EsploraProvider,
    SingleKey,
    ArkNote,
    InMemoryWalletRepository,
    InMemoryContractRepository,
} from "../../src";
import { waitFor } from "./utils";
import { execSync } from "child_process";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const generateBlocks = (n: number) => execSync(`nigiri rpc --generate ${n}`);
const arkdContainer = (() => {
    try {
        execSync("docker inspect arkd", { stdio: "ignore" });
        return "arkd";
    } catch {
        return "ark";
    }
})();

function createWallet(settlementConfig: false | undefined = false) {
    return Wallet.create({
        identity: SingleKey.fromRandomBytes(),
        arkServerUrl: "http://localhost:7070",
        onchainProvider: new EsploraProvider("http://localhost:3000", {
            forcePolling: true,
            pollingInterval: 2000,
        }),
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
        settlementConfig,
    });
}

/**
 * This test verifies that after VtxoManager's auto-settlement round the
 * wallet sees exactly one spendable VTXO.
 *
 * KNOWN BUG: when prior tests in a suite shift the block-based round
 * timer, generateBlocks(10) can trigger a round at an offset that gives
 * VtxoManager time to auto-register the settled VTXO for a second
 * round.  The indexer then returns BOTH the old VTXO (committed to the
 * pending round) and the new preconfirmed one as non-spent.  The
 * wallet picks the stale VTXO for coin selection and arkd rejects it
 * with INVALID_PSBT_INPUT (5): missing tapscript spend sig.
 *
 * This test passes in isolation (single round, 1 VTXO) but exposes the
 * bug when run after other e2e tests that advance the block height.
 * See: https://github.com/arkade-os/boltz-swap — the full boltz-swap
 * suite reliably triggers the multi-VTXO condition.
 */
describe("VTXO sync after VtxoManager auto-settlement", () => {
    it(
        "wallet sees only one spendable VTXO after auto-settlement",
        { timeout: 60_000 },
        async () => {
            const funder = await createWallet(false);
            const funderAddr = await funder.getAddress();
            const noteStr = execSync(
                `docker exec -t ${arkdContainer} arkd note --amount 10000`
            )
                .toString()
                .trim();
            await funder.settle({
                inputs: [ArkNote.fromString(noteStr)],
                outputs: [{ address: funderAddr, amount: BigInt(10000) }],
            });
            await waitFor(
                async () => (await funder.getBalance()).available > 0
            );

            const wallet = await createWallet(undefined);

            try {
                const address = await wallet.getAddress();
                await funder.send({ address, amount: 5000 });
                await waitFor(
                    async () => (await wallet.getBalance()).available > 0
                );

                await sleep(1000);
                generateBlocks(10);
                await sleep(5000);

                await wallet.clearSyncCursors();
                const vtxos = await wallet.getVtxos();

                expect(
                    vtxos.length,
                    `Expected 1 spendable VTXO but got ${vtxos.length}: ` +
                        vtxos
                            .map(
                                (v) =>
                                    `${v.txid.slice(0, 8)} ` +
                                    `${v.virtualStatus.state} ` +
                                    `val=${v.value}`
                            )
                            .join(", ")
                ).toBe(1);
            } finally {
                await wallet.dispose();
                await funder.dispose();
            }
        }
    );
});
