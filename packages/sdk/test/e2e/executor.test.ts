import { beforeAll, describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import {
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestArkProvider,
    RestExecutorProvider,
    SingleKey,
    Wallet,
    type ExecutorWatchRegistration,
} from "../../src";
import { ArkAddress } from "../../src/script/address";
import { ESPLORA_API_URL, faucetOnchain, waitFor } from "./utils";

// The Executor of the sdk-executor stack (arkade-regtest `executor` profile), which seeds and
// trusts its default templates at startup.
const EXECUTOR_URL = process.env.EXECUTOR_URL ?? "http://localhost:7280";
const ESPLORA_URL = process.env.ESPLORA_URL ?? ESPLORA_API_URL;
const options = { renewalWindow: 256, maxFee: 100 };

const reachable = await fetch(`${EXECUTOR_URL}/v1/info`)
    .then((r) => r.ok)
    .catch(() => false);
if (!reachable) console.warn(`Executor e2e skipped: no Executor at ${EXECUTOR_URL}`);

const createWallet = (identity = SingleKey.fromRandomBytes()) =>
    Wallet.create({
        identity,
        arkProvider: new RestArkProvider("http://localhost:7070"),
        onchainProvider: new EsploraProvider(ESPLORA_URL, {
            forcePolling: true,
            pollingInterval: 2000,
        }),
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
        settlementConfig: false,
        // the Executor stack's arkd runs short regtest delays
        minBatchExpirySeconds: 1n,
        executorProvider: new RestExecutorProvider(EXECUTOR_URL),
    });

// The steps share one wallet and run in order: each starts from the previous one's coins.
describe.skipIf(!reachable).sequential("Executor non-interactive boarding", () => {
    let identity: SingleKey;
    let alice: Wallet;
    let watch: ExecutorWatchRegistration;
    let renewalScript = "";

    const atRenewal = async () =>
        (await alice.getVtxos()).filter((v) => v.script === renewalScript && !v.isSpent);

    beforeAll(async () => {
        identity = SingleKey.fromRandomBytes();
        alice = await createWallet(identity);
    }, 60_000);

    it("registers a boarding watch at the address the daemon derives", {
        timeout: 60_000,
    }, async () => {
        const manager = (await alice.getExecutorManager())!;
        await manager.defaultTemplates();
        const own = await alice.getAddress();
        watch = await manager.registerBoarding(options);

        const daemon = new RestExecutorProvider(EXECUTOR_URL);
        expect((await daemon.getDelegation(watch.address)).delegation.address).toBe(watch.address);
        expect(watch.delegation.status).toBe("active");
        expect(await alice.getBoardingAddress()).toBe(watch.address);
        // boarding only: receives stay at the wallet's own address
        expect(await alice.getAddress()).toBe(own);
        // registering again returns the same watch
        expect((await manager.registerBoarding(options)).delegation.id).toBe(watch.delegation.id);

        const cm = await alice.getContractManager();
        const [renewal] = (await cm.getContracts({ type: ["executor"] })).filter(
            (c) => c.params.template === "renewal",
        );
        renewalScript = renewal.script;
    });

    it("boards a deposit into the renewal contract, counted as the wallet's own", {
        timeout: 180_000,
    }, async () => {
        faucetOnchain(watch.address, 10_000);
        await waitFor(async () => (await alice.getBalance()).available === 10_000, {
            timeout: 170_000,
            interval: 2_000,
        });
        expect((await atRenewal()).map((v) => v.value)).toEqual([10_000]);
    });

    it("spends a boarded coin with a normal send", { timeout: 60_000 }, async () => {
        const bob = await createWallet();
        await alice.send({ recipients: [{ address: await bob.getAddress(), amount: 4_000 }] });
        await waitFor(async () => (await bob.getBalance()).available === 4_000, {
            timeout: 50_000,
        });
        expect(await atRenewal()).toHaveLength(0);
    });

    it("renews a boarded coin into the wallet's own address", { timeout: 240_000 }, async () => {
        faucetOnchain(watch.address, 8_000);
        await waitFor(async () => (await atRenewal()).length === 1, {
            timeout: 170_000,
            interval: 2_000,
        });
        await (await alice.getVtxoManager()).renewVtxos();
        await waitFor(async () => (await atRenewal()).length === 0, { timeout: 60_000 });
        const own = hex.encode(ArkAddress.decode(await alice.getAddress()).pkScript);
        const unspent = (await alice.getVtxos()).filter((v) => !v.isSpent);
        expect(unspent.map((v) => v.script)).toEqual([own]);
        expect((await alice.getBalance()).available).toBe(14_000);
    });

    it("finds the boarded coins from the key alone, after registering again", {
        timeout: 120_000,
    }, async () => {
        faucetOnchain(watch.address, 5_000);
        await waitFor(async () => (await atRenewal()).length === 1, {
            timeout: 110_000,
            interval: 2_000,
        });
        const restored = await createWallet(identity);
        const again = await (await restored.getExecutorManager())!.registerBoarding(options);
        expect(again.address).toBe(watch.address);
        await waitFor(async () => (await restored.getBalance()).available === 19_000, {
            timeout: 30_000,
        });
    });
});
