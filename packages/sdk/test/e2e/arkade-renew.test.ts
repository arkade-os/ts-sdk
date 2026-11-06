import { readFileSync } from "node:fs";
import { expect, describe, it, beforeEach } from "vitest";
import { hex } from "@scure/base";
import {
    arkade,
    networks,
    RestArkProvider,
    RestEmulatorProvider,
    RestIndexerProvider,
    type VirtualCoin,
} from "../../src";
import {
    beforeEachFaucet,
    createTestArkWallet,
    createTestIdentity,
    faucetOffchain,
    waitFor,
} from "./utils";

const ARK_SERVER_URL = "http://localhost:7070";
const EMULATOR_URL = "http://localhost:7073";

describe("renewArkadeVtxos", () => {
    const arkProvider = new RestArkProvider(ARK_SERVER_URL);
    const indexer = new RestIndexerProvider(ARK_SERVER_URL);
    const emulator = new RestEmulatorProvider(EMULATOR_URL);
    const renewable = arkade.programFromArtifact(
        JSON.parse(
            readFileSync(
                new URL("../fixtures/arkadec/renewable.artifact.json", import.meta.url),
                "utf8",
            ),
        ),
    );

    beforeEach(beforeEachFaucet, 60000);

    /** A keeper's client: no identity, so nothing it renews can depend on a user key. */
    async function renewableContract() {
        const keeper = await arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            indexer,
            network: networks.regtest,
        });
        const owner = await createTestIdentity().xOnlyPublicKey();
        return { keeper, contract: keeper.contract(renewable, { owner }) };
    }

    async function spendableAt(pkScript: Uint8Array, count: number, exclude: string[] = []) {
        let coins: VirtualCoin[] = [];
        await waitFor(async () => {
            const { vtxos } = await indexer.getVtxos({
                scripts: [hex.encode(pkScript)],
                spendableOnly: true,
            });
            coins = vtxos.filter((v) => !exclude.includes(`${v.txid}:${v.vout}`));
            return coins.length >= count;
        });
        return coins;
    }

    it("renews two covenant coins with no owner key", { timeout: 120000 }, async () => {
        const { keeper, contract } = await renewableContract();
        faucetOffchain(contract.address, 5000);
        faucetOffchain(contract.address, 7000);
        const coins = await spendableAt(contract.pkScript, 2);

        const { commitmentTxid } = await arkade.renewArkadeVtxos(
            keeper,
            coins.map((coin) => ({ contract, coin })),
        );

        const outpoints = coins.map((c) => `${c.txid}:${c.vout}`);
        const renewed = await spendableAt(contract.pkScript, 2, outpoints);
        expect(renewed.map((c) => c.value).sort((a, b) => a - b)).toEqual([5000, 7000]);
        const { vtxos: old } = await indexer.getVtxos({
            outpoints: coins.map(({ txid, vout }) => ({ txid, vout })),
        });
        expect(old.map((v) => v.settledBy)).toEqual([commitmentTxid, commitmentTxid]);
    });

    it("renews a coin that carries an asset", { timeout: 180000 }, async () => {
        const { keeper, contract } = await renewableContract();
        const alice = await createTestArkWallet();
        faucetOffchain(await alice.wallet.getAddress(), 20_000);
        await waitFor(async () => (await alice.wallet.getBalance()).total >= 20_000);
        const { assetId } = await alice.wallet.assetManager.issue({ amount: 1000n });
        await waitFor(async () =>
            (await alice.wallet.getVtxos()).some((v) =>
                v.assets?.some((a) => a.assetId === assetId),
            ),
        );
        await alice.wallet.send({
            address: contract.address,
            amount: 2000,
            assets: [{ assetId, amount: 1000n }],
        });
        const [coin] = await spendableAt(contract.pkScript, 1);

        await arkade.renewArkadeVtxos(keeper, [{ contract, coin }]);

        const [renewed] = await spendableAt(contract.pkScript, 1, [`${coin.txid}:${coin.vout}`]);
        expect(renewed.value).toBe(2000);
        expect(renewed.assets).toEqual([{ assetId, amount: 1000n }]);
    });

    it("refuses a function that is not a covenant", { timeout: 60000 }, async () => {
        const { keeper, contract } = await renewableContract();
        faucetOffchain(contract.address, 5000);
        const [coin] = await spendableAt(contract.pkScript, 1);

        await expect(
            arkade.renewArkadeVtxos(keeper, [{ contract, coin, fn: "unilateral" }]),
        ).rejects.toThrow(/unilateral is not a covenant function/);
    });
});
