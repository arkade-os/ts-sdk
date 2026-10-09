import { beforeAll, describe, expect, it } from "vitest";
import {
    RestArkProvider,
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestDelegateeProvider,
    SingleKey,
    Wallet,
    timelockToSequence,
    type DelegateProvider,
    type DelegationParams,
    type WalletConfig,
} from "../../src";
import { ArkAddress } from "../../src/script/address";
import { hex } from "@scure/base";
import { ESPLORA_API_URL, faucetOnchain, waitFor } from "./utils";

// The delegatee of the sdk-delegatee stack (arkade-regtest `delegatee` profile), which seeds and
// trusts its default templates at startup.
const DELEGATEE_URL = process.env.DELEGATEE_URL ?? "http://localhost:7280";
const ESPLORA_URL = process.env.ESPLORA_URL ?? ESPLORA_API_URL;
// less than the stack's VTXO lifetime, so coins come due during the test
const RENEWAL_WINDOW = Number(process.env.DELEGATEE_RENEWAL_WINDOW ?? 256);

const reachable = await fetch(`${DELEGATEE_URL}/v1/info`)
    .then((r) => r.ok)
    .catch(() => false);
if (!reachable) console.warn(`delegatee e2e skipped: no delegatee at ${DELEGATEE_URL}`);

async function delegationParams(): Promise<DelegationParams> {
    const info = await (await fetch("http://localhost:7070/v1/info")).json();
    const seq = (delay: string) =>
        Number(
            timelockToSequence({
                value: BigInt(delay),
                type: BigInt(delay) < 512n ? "blocks" : "seconds",
            }),
        );
    return {
        exitDelay: seq(info.unilateralExitDelay),
        boardingExitDelay: seq(info.boardingExitDelay),
        renewalWindow: RENEWAL_WINDOW,
        maxFee: 100,
    };
}

const createWallet = (delegatee: boolean, overrides: Partial<WalletConfig> = {}) =>
    Wallet.create({
        identity: SingleKey.fromRandomBytes(),
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
        // the delegatee stack's arkd runs short regtest delays
        minCheckpointExitDelaySeconds: 1n,
        minBatchExpirySeconds: 1n,
        ...(delegatee ? { delegateeProvider: new RestDelegateeProvider(DELEGATEE_URL) } : {}),
        ...overrides,
    });

const scriptOf = (address: string) => hex.encode(ArkAddress.decode(address).pkScript);

// The steps share one delegating wallet and run in order: each starts from the previous one's coins.
describe.skipIf(!reachable).sequential("Delegatee default templates", () => {
    let params: DelegationParams;
    let alice: Wallet;
    let bob: Wallet;
    let renewal = "";

    beforeAll(async () => {
        params = await delegationParams();
        alice = await createWallet(true);
        bob = await createWallet(false);
    }, 60_000);

    const atRenewal = async () =>
        (await alice.getVtxos()).filter((v) => v.script === scriptOf(renewal));

    it("delegates to watch addresses that equal the daemon's", { timeout: 60_000 }, async () => {
        const manager = (await alice.getDelegateeManager())!;
        await manager.defaultTemplates();
        const renewalWatch = await manager.registerRenewal(params);
        const boardingWatch = await manager.registerBoarding(params);
        const daemon = new RestDelegateeProvider(DELEGATEE_URL);
        expect((await daemon.getDelegation(renewalWatch.address)).delegation.address).toBe(
            renewalWatch.address,
        );
        renewal = renewalWatch.address;

        // with delegation on, the defaults are the delegated contracts
        expect(await alice.getAddress()).toBe(renewalWatch.address);
        expect(await alice.getBoardingAddress()).toBe(boardingWatch.address);
    });

    it("receives a payment and keeps a send's change at the renewal address", {
        timeout: 120_000,
    }, async () => {
        faucetOnchain(await bob.getBoardingAddress(), 20_000);
        await waitFor(async () => (await bob.getBoardingUtxos()).length > 0, { timeout: 60_000 });
        await bob.settle();

        await bob.send({ address: await alice.getAddress(), amount: 10_000 });
        await waitFor(async () => (await alice.getBalance()).available === 10_000);
        expect((await atRenewal()).map((v) => v.value)).toEqual([10_000]);

        await alice.send({ address: await bob.getAddress(), amount: 3_000 });
        await waitFor(async () => (await alice.getBalance()).available === 7_000);
        expect((await atRenewal()).map((v) => v.value)).toEqual([7_000]);
    });

    it("is renewed in place by the daemon, at the same balance", { timeout: 900_000 }, async () => {
        const [before] = await atRenewal();
        await waitFor(
            async () => {
                expect((await alice.getBalance()).total).toBe(7_000);
                const [now] = await atRenewal();
                return now !== undefined && now.txid !== before.txid;
            },
            { timeout: 840_000, interval: 5_000 },
        );
        expect((await atRenewal()).map((v) => v.value)).toEqual([7_000]);
    });

    it("spends a delegated coin with a normal send", { timeout: 60_000 }, async () => {
        const bobBefore = (await bob.getBalance()).available;
        await alice.send({ address: await bob.getAddress(), amount: 2_000 });
        await waitFor(async () => (await bob.getBalance()).available === bobBefore + 2_000);
        await waitFor(async () => (await alice.getBalance()).available === 5_000);
        expect((await atRenewal()).map((v) => v.value)).toEqual([5_000]);
    });

    // the daemon may hold a deposit up to BOARDING_MAX_WAIT (10 min) to join a planned renewal
    it("boards an onchain deposit into the renewal address", { timeout: 660_000 }, async () => {
        faucetOnchain(await alice.getBoardingAddress(), 10_000);
        await waitFor(async () => (await alice.getBalance()).available === 15_000, {
            timeout: 640_000,
            interval: 2_000,
        });
        expect((await atRenewal()).map((v) => v.value).sort()).toEqual([10_000, 5_000].sort());
    });
});

// An old wallet holds coins at its own default contract and at the retired delegator's
// contract; the updated wallet, on the same key and storage, moves them to the delegatee.
describe.skipIf(!reachable).sequential("Delegatee migration of an old wallet", () => {
    // the retired delegator only lends its key to the DelegateVtxo leaf
    const legacyDelegator: DelegateProvider = {
        getDelegateInfo: async () => ({
            pubkey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
            fee: "0",
            delegateAddress: "",
        }),
        delegate: async () => {
            throw new Error("the retired delegator is offline");
        },
    };

    it("sends the old coins to the renewal address and retires the old contracts", {
        timeout: 240_000,
    }, async () => {
        const params = await delegationParams();
        const funder = await createWallet(false);
        faucetOnchain(await funder.getBoardingAddress(), 20_000);
        await waitFor(async () => (await funder.getBoardingUtxos()).length > 0, {
            timeout: 60_000,
        });
        await funder.settle();

        const identity = SingleKey.fromRandomBytes();
        const storage = {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        };
        const delegatorEra = await createWallet(false, {
            identity,
            storage,
            delegateProvider: legacyDelegator,
        });
        await funder.send({ address: await delegatorEra.getAddress(), amount: 4_000 });
        await waitFor(async () => (await delegatorEra.getBalance()).available === 4_000);
        await delegatorEra.dispose();

        const plain = await createWallet(false, { identity, storage });
        const oldAddress = await plain.getAddress();
        await funder.send({ address: oldAddress, amount: 3_000 });
        await waitFor(async () => (await plain.getBalance()).available === 7_000);
        await plain.dispose();

        const updated = await createWallet(true, { identity, storage });
        const manager = (await updated.getDelegateeManager())!;
        const migration = await manager.delegateVtxos(params);
        expect(migration.txid).toBeDefined();
        const atRenewal = async () =>
            (await updated.getVtxos())
                .filter((v) => v.script === scriptOf(migration.address))
                .map((v) => v.value)
                .sort((a, b) => a - b);
        await waitFor(async () => (await atRenewal()).join() === "7000");
        expect((await updated.getBalance()).total).toBe(7_000);
        expect(await updated.getAddress()).toBe(migration.address);

        const old = await (await updated.getContractManager()).getContracts({
            type: ["default", "delegate"],
        });
        expect(new Set(old.map((c) => c.type))).toEqual(new Set(["default", "delegate"]));
        expect(old.every((c) => c.state === "inactive")).toBe(true);

        // a payment to the retired address still counts, and the next run moves it
        await funder.send({ address: oldAddress, amount: 1_000 });
        await waitFor(async () => (await updated.getBalance()).available === 8_000);
        expect((await manager.delegateVtxos(params)).txid).toBeDefined();
        await waitFor(async () => (await atRenewal()).join() === "1000,7000");
    });
});
