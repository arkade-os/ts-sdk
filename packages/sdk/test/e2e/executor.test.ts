import { beforeAll, describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    MnemonicIdentity,
    RestArkProvider,
    RestExecutorProvider,
    SingleKey,
    type Identity,
    Wallet,
    timelockToSequence,
    watchExecutorContracts,
    type ExecutorWatchRegistration,
} from "../../src";
import { ArkAddress } from "../../src/script/address";
import { ESPLORA_API_URL, faucetOnchain, waitFor } from "./utils";

// The Executor of the sdk-executor stack (arkade-regtest `executor` profile), which seeds and
// trusts its default templates at startup.
const EXECUTOR_URL = process.env.EXECUTOR_URL ?? "http://localhost:7280";
const ESPLORA_URL = process.env.ESPLORA_URL ?? ESPLORA_API_URL;
const options = { renewalWindow: 256, maxFee: 100 };
// the renewal delegation's own window: the daemon's opens 256 s before the wallet's fallback
const renewalOptions = { renewalWindow: 512, maxFee: 100 };

const reachable = await fetch(`${EXECUTOR_URL}/v1/info`)
    .then((r) => r.ok)
    .catch(() => false);
if (!reachable) {
    // the sdk-executor stack runs one: only a local run may skip
    if (process.env.CI) throw new Error(`no Executor at ${EXECUTOR_URL}`);
    console.warn(`Executor e2e skipped: no Executor at ${EXECUTOR_URL}`);
}

const createWallet = (
    identity: Identity = SingleKey.fromRandomBytes(),
    extra: { walletMode?: "hd" } = {},
) =>
    Wallet.create({
        identity,
        ...extra,
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
        expect((await daemon.getDelegation(watch.address)).delegation.inputs[0].address).toBe(
            watch.address,
        );
        expect(watch.delegation?.status).toBe("active");
        expect(await alice.getBoardingAddress()).toBe(watch.address);
        // boarding only: receives stay at the wallet's own address
        expect(await alice.getAddress()).toBe(own);
        // registering again returns the same watch, from the stored row
        const again = await manager.registerBoarding(options);
        expect(again.address).toBe(watch.address);
        expect(again.delegation).toBeUndefined();

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
        // the renewal row is local here, so the change goes to the wallet's own address
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

// An HD wallet rotates its boarding key once a deposit is boarded, and each key needs a watch of
// its own: what only the daemon, arkd and the indexer can confirm is that the daemon derives the
// rotated key's address, boards there, accepts the child key's renewal and is found by restore().
describe.skipIf(!reachable).sequential("Executor boarding on an HD wallet", () => {
    const mnemonic = generateMnemonic(wordlist);
    const hd = () =>
        createWallet(MnemonicIdentity.fromMnemonic(mnemonic, { isMainnet: false }), {
            walletMode: "hd",
        });
    const daemon = new RestExecutorProvider(EXECUTOR_URL);
    let alice: Wallet;
    let first = "";
    let second = "";

    const atExecutor = async (wallet: Wallet) => {
        const cm = await wallet.getContractManager();
        const scripts = new Set(
            (await cm.getContracts({ type: ["executor"] })).map((c) => c.script),
        );
        return (await wallet.getVtxos()).filter((v) => !v.isSpent && scripts.has(v.script));
    };

    beforeAll(async () => {
        alice = await hd();
    }, 60_000);

    it("rotates to a key the daemon watches once it boards a deposit", {
        timeout: 240_000,
    }, async () => {
        first = (await (await alice.getExecutorManager())!.registerBoarding(options)).address;
        faucetOnchain(first, 10_000);
        await waitFor(async () => (await alice.getBalance()).available === 10_000, {
            timeout: 170_000,
            interval: 2_000,
        });
        // the rotation registers the new key's watch before it swaps the displayed address
        await waitFor(async () => (await alice.getBoardingAddress()) !== first, {
            timeout: 60_000,
        });
        second = await alice.getBoardingAddress();
        expect((await daemon.getDelegation(second)).delegation.inputs[0].address).toBe(second);
    });

    it("boards a deposit at the rotated address", { timeout: 180_000 }, async () => {
        faucetOnchain(second, 7_000);
        await waitFor(async () => (await alice.getBalance()).available === 17_000, {
            timeout: 170_000,
            interval: 2_000,
        });
    });

    it("finds the coins of both keys from the seed, after registering again", {
        timeout: 120_000,
    }, async () => {
        const restored = await hd();
        await (await restored.getExecutorManager())!.registerBoarding(options);
        await restored.restore();
        await waitFor(async () => (await restored.getBalance()).available === 17_000, {
            timeout: 60_000,
        });
        // each coin sits at its own key's renewal contract
        expect(new Set((await atExecutor(restored)).map((v) => v.script)).size).toBe(2);

        // renewing spends both through the keys' own descriptors
        await (await restored.getVtxoManager()).renewVtxos();
        await waitFor(async () => (await atExecutor(restored)).length === 0, { timeout: 60_000 });
        expect((await restored.getBalance()).available).toBe(17_000);
    });
});

// The Executor renews a delegated coin in place while the wallet is offline: what only the
// daemon can confirm is that it does, on its own (the template re-spends into the same
// contract), before the wallet's fallback margin opens.
describe.skipIf(!reachable).sequential("Executor renewal delegation", () => {
    let alice: Wallet;
    let renewal: ExecutorWatchRegistration;
    let renewalScript = "";

    const atRenewal = async () =>
        (await alice.getVtxos()).find((v) => v.script === renewalScript && !v.isSpent);

    beforeAll(async () => {
        alice = await createWallet();
    }, 60_000);

    it("registers a renewal watch at the address the daemon derives", {
        timeout: 60_000,
    }, async () => {
        renewal = await (await alice.getExecutorManager())!.registerRenewal(renewalOptions);
        expect(renewal.delegation?.status).toBe("active");
        const daemon = new RestExecutorProvider(EXECUTOR_URL);
        expect((await daemon.getDelegation(renewal.address)).delegation.inputs[0].address).toBe(
            renewal.address,
        );
        // the delegated contract is watched, and is not the wallet's own address yet
        const cm = await alice.getContractManager();
        const [row] = (await cm.getContracts({ type: ["executor"] })).filter(
            (c) => c.params.template === "renewal",
        );
        renewalScript = row.script;
        expect(await alice.getAddress()).not.toBe(renewal.address);
    });

    // covers every wait below: two funding waits of 170 s and the renewal wait of 600 s
    it("holds a coin at the renewal contract, which the daemon renews in place", {
        timeout: 1_000_000,
    }, async () => {
        // the wallet funds its own delegated address, so the coin is its own to watch
        faucetOnchain(await alice.getBoardingAddress(), 10_000);
        await waitFor(async () => (await alice.getBalance()).boarding.confirmed === 10_000, {
            timeout: 170_000,
            interval: 2_000,
        });
        await alice.settle();
        // all of it: an own change coin would be renewed into this contract too
        await alice.send({ address: renewal.address, amount: 10_000 });
        await waitFor(async () => (await atRenewal()) !== undefined, {
            timeout: 170_000,
            interval: 2_000,
        });
        const held = (await atRenewal())!;
        const outpoint = `${held.txid}:${held.vout}`;
        const expiresAt = held.expiresAt!.getTime();

        // inside the delegation's window the wallet's own renewal leaves the coin alone
        await (await alice.getVtxoManager()).renewVtxos().catch(() => undefined);
        const untouched = (await atRenewal())!;
        expect(`${untouched.txid}:${untouched.vout}`).toBe(outpoint);
        expect(untouched.expiresAt!.getTime()).toBe(expiresAt);

        // the daemon's window opens 512 s before expiry: it re-spends the coin into the same
        // contract with a later expiry, well before the wallet's 256 s fallback margin
        // one read per poll: mid-renewal the old coin can read as spent before the new one lands
        await waitFor(
            async () => {
                const current = await atRenewal();
                return current !== undefined && `${current.txid}:${current.vout}` !== outpoint;
            },
            { timeout: 600_000, interval: 5_000 },
        );
        const renewed = (await atRenewal())!;
        expect(renewed.script).toBe(renewalScript);
        expect(renewed.expiresAt!.getTime()).toBeGreaterThan(expiresAt);
    });

    // no second wait for the daemon: the test above pins its in-place renewal
    it("keeps the change of a send at the renewal contract", { timeout: 120_000 }, async () => {
        const own = await alice.getAddress();
        const held = (await atRenewal())!;
        const bob = await createWallet();
        // named, so an own coin expiring sooner is not spent with it and the change keeps the
        // renewed expiry, clear of the wallet's fallback margin
        await alice.send({
            recipients: [{ address: await bob.getAddress(), amount: 3_000 }],
            selectedVtxos: [held],
        });
        await waitFor(async () => (await bob.getBalance()).available === 3_000, {
            timeout: 50_000,
        });

        await waitFor(async () => {
            const change = await atRenewal();
            return change !== undefined && change.txid !== held.txid;
        });
        expect(await alice.getAddress()).toBe(own);

        // still the daemon's to renew: the wallet's own renewal leaves it alone
        const change = (await atRenewal())!;
        expect(change.value).toBe(held.value - 3_000);
        await (await alice.getVtxoManager()).renewVtxos().catch(() => undefined);
        const untouched = (await atRenewal())!;
        expect(`${untouched.txid}:${untouched.vout}`).toBe(`${change.txid}:${change.vout}`);
    });
});

// A watch no Executor serves: made-up cosigner and emulator keys, so no daemon boards its deposits
// and the wallet's own hold-back and fallback can be seen.
describe.skipIf(!reachable).sequential("Executor boarding fallback", () => {
    let alice: Wallet;
    let address = "";
    let script = "";

    beforeAll(async () => {
        alice = await createWallet();
        const info = await alice.getOperatorInfo({ requireLive: true });
        const seq = (delay: bigint) =>
            Number(timelockToSequence({ value: delay, type: delay < 512n ? "blocks" : "seconds" }));
        const keys = {
            batchCosignerPubkey: hex.encode(
                await SingleKey.fromRandomBytes().compressedPublicKey(),
            ),
            operatorPubkey: info.signerPubkey,
            emulatorPubkey: hex.encode(await SingleKey.fromRandomBytes().compressedPublicKey()),
        };
        const contracts = await watchExecutorContracts(
            alice,
            keys,
            {
                ...options,
                exitDelay: seq(info.unilateralExitDelay),
                boardingExitDelay: seq(info.boardingExitDelay),
            },
            { template: "boarding", status: "active", expiresAt: 0 },
        );
        const boarding = contracts.find((c) => c.params.template === "boarding")!;
        script = boarding.script;
        address = await alice.getBoardingAddress();
    }, 60_000);

    it("shows a deposit at a live watch and leaves it to the Executor", {
        timeout: 60_000,
    }, async () => {
        // the live watch is the wallet's boarding address
        expect(address).not.toBe(alice.ownBoardingAddress());
        faucetOnchain(address, 6_000);
        await waitFor(async () => (await alice.getBalance()).boarding.confirmed === 6_000, {
            timeout: 50_000,
            interval: 2_000,
        });
        await expect(alice.settle()).rejects.toThrow("No inputs found");
    });

    it("boards the deposit itself once the watch ends", { timeout: 120_000 }, async () => {
        const cm = await alice.getContractManager();
        const [row] = await cm.getContracts({ script });
        await cm.updateContract(script, {
            metadata: { ...row.metadata, delegationStatus: "cancelled" },
        });
        expect(await alice.getBoardingAddress()).toBe(alice.ownBoardingAddress());
        await alice.settle();
        await waitFor(async () => (await alice.getBalance()).available === 6_000, {
            timeout: 60_000,
        });
        // the boarding getter lists a settle's inputs until the chain shows them spent
        await waitFor(async () => (await alice.getBalance()).boarding.total === 0, {
            timeout: 50_000,
            interval: 2_000,
        });
    });
});
