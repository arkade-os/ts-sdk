import { expect, describe, it } from "vitest";
import { hex } from "@scure/base";
import { p2tr } from "@scure/btc-signer";
import {
    arkade,
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    networks,
    OnchainWallet,
    Ramps,
    RestArkProvider,
    RestEmulatorProvider,
    SingleKey,
    Transaction,
    Unroll,
    Wallet,
    type ExtendedCoin,
} from "../../src";
import {
    ESPLORA_API_URL,
    createTestOnchainWallet,
    faucetOnchain,
    mineBlocks,
    waitFor,
    waitForUtxo,
} from "./utils";

const ARK_SERVER_URL = "http://localhost:7070";
const EMULATOR_URL = "http://localhost:7073";
const BOARDING_SATS = 100_000;
const COVENANT_SATS = 100_000;
const COVENANT_SPEND = 99_500n;
const FEE = 1_000;

const arkProvider = new RestArkProvider(ARK_SERVER_URL);
const emulator = new RestEmulatorProvider(EMULATOR_URL);
const explorer = new EsploraProvider(ESPLORA_API_URL);

// No $server signer: the emulator's onchain endpoint refuses leaves containing it.
const covenantProgram = {
    version: 0,
    params: ["receiver", "amount", "user"],
    functions: {
        spend: {
            tapscript: { signers: ["$user"] },
            arkadeScript: {
                asm: [
                    0,
                    "INSPECTOUTPUTSCRIPTPUBKEY",
                    1,
                    "EQUALVERIFY",
                    "$receiver",
                    "EQUALVERIFY",
                    0,
                    "INSPECTOUTPUTVALUE",
                    "$amount",
                    "EQUAL",
                ],
            },
        },
    },
} satisfies arkade.Program;

async function createWallet(): Promise<Wallet> {
    return Wallet.create({
        identity: SingleKey.fromRandomBytes(),
        arkServerUrl: ARK_SERVER_URL,
        onchainProvider: new EsploraProvider(ESPLORA_API_URL, {
            forcePolling: true,
            pollingInterval: 2000,
        }),
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
        settlementConfig: false,
        emulator,
    });
}

async function externalAddress(): Promise<string> {
    const key = await SingleKey.fromRandomBytes().xOnlyPublicKey();
    return p2tr(key, undefined, networks.regtest).address!;
}

async function fundBoarding(wallet: Wallet): Promise<ExtendedCoin> {
    faucetOnchain(await wallet.getBoardingAddress(), BOARDING_SATS);
    let coin: ExtendedCoin | undefined;
    await waitFor(async () => {
        coin = (await wallet.getBoardingUtxos()).find((u) => u.status.confirmed);
        return coin !== undefined;
    });
    return coin!;
}

async function confirm(txid: string): Promise<void> {
    await waitFor(async () =>
        explorer.getTxStatus(txid).then(
            () => true,
            () => false,
        ),
    );
    mineBlocks(1);
    await waitFor(async () => (await explorer.getTxStatus(txid)).confirmed);
}

async function storedRow(wallet: Wallet, outpoint: { txid: string; vout: number }) {
    const manager = await wallet.getContractManager();
    await manager.syncOnchain();
    const contracts = await manager.getContractsWithVtxos(undefined, undefined, {
        maxSyncAgeMs: Number.MAX_SAFE_INTEGER,
    });
    return contracts
        .flatMap((c) => c.vtxos)
        .find((v) => v.txid === outpoint.txid && v.vout === outpoint.vout);
}

async function fundCovenant(identity: SingleKey) {
    const ark = await arkade.Arkade.connect({
        arkade: arkProvider,
        emulator,
        onchain: explorer,
        identity,
        network: networks.regtest,
    });
    const receiverScript = p2tr(
        await SingleKey.fromRandomBytes().xOnlyPublicKey(),
        undefined,
        networks.regtest,
    ).script;
    const contract = ark.contract(covenantProgram, {
        receiver: receiverScript.slice(2),
        amount: COVENANT_SPEND,
    });
    const address = contract.vtxoScript.onchainAddress(networks.regtest);
    faucetOnchain(address, COVENANT_SATS);
    const utxo = await waitForUtxo(address);
    return { contract, receiverScript, utxo };
}

describe("onchain cosign", () => {
    it("sends a boarding coin to an external address", { timeout: 120_000 }, async () => {
        const wallet = await createWallet();
        const coin = await fundBoarding(wallet);
        const dest = await externalAddress();

        const txid = await wallet.sendOnchain({ outputs: [{ address: dest, amount: 50_000 }] });
        await confirm(txid);

        expect((await waitForUtxo(dest)).value).toBe(50_000);
        const row = await storedRow(wallet, coin);
        expect(row?.isSpent).toBe(true);
        expect(row?.spentBy).toBe(txid);
    });

    it("cosigns an external PSBT mixing a foreign input with a boarding coin", {
        timeout: 120_000,
    }, async () => {
        const wallet = await createWallet();
        const coin = await fundBoarding(wallet);
        const foreign = await createTestOnchainWallet();
        faucetOnchain(foreign.wallet.address, 50_000);
        const foreignCoin = await waitForUtxo(foreign.wallet.address);
        const dest = await externalAddress();

        const tx = new Transaction({ version: 2 });
        tx.addInput({
            txid: hex.decode(foreignCoin.txid),
            index: foreignCoin.vout,
            witnessUtxo: {
                amount: BigInt(foreignCoin.value),
                script: foreign.wallet.onchainP2TR.script,
            },
            tapInternalKey: foreign.wallet.onchainP2TR.tapInternalKey,
        });
        tx.addInput({
            txid: hex.decode(coin.txid),
            index: coin.vout,
            witnessUtxo: { amount: BigInt(coin.value), script: wallet.boardingTapscript.pkScript },
        });
        const amount = foreignCoin.value + coin.value - FEE;
        tx.addOutputAddress(dest, BigInt(amount), networks.regtest);
        const signed = await foreign.identity.sign(tx, [0]);
        signed.finalizeIdx(0);

        const txid = await wallet.cosignOnchainTx(signed);
        await confirm(txid);

        expect((await waitForUtxo(dest)).value).toBe(amount);
    });

    it("offboardExact pays from boarding funds without joining a batch", {
        timeout: 120_000,
    }, async () => {
        const wallet = await createWallet();
        await fundBoarding(wallet);
        const dest = await externalAddress();
        const { fees } = await wallet.arkProvider.getInfo();
        const events: unknown[] = [];

        const txid = await new Ramps(wallet).offboardExact({
            destinationAddress: dest,
            feeInfo: fees,
            amount: 40_000n,
            eventCallback: (e) => events.push(e),
        });
        await confirm(txid);

        expect(events).toHaveLength(0);
        expect((await waitForUtxo(dest)).value).toBe(40_000);
    });

    // Requires arkd #134 (cosigning unrolled VTXO outputs).
    it("sweeps an unrolled VTXO before its exit matures", { timeout: 240_000 }, async () => {
        const wallet = await createWallet();
        const boarding = await fundBoarding(wallet);
        await wallet.settle({
            inputs: [boarding],
            outputs: [{ address: await wallet.getAddress(), amount: BigInt(boarding.value) }],
        });
        mineBlocks(1);
        await waitFor(async () => (await wallet.getVtxos()).length > 0);
        const [vtxo] = await wallet.getVtxos();

        const bumper = await OnchainWallet.create(wallet.identity, "regtest");
        faucetOnchain(bumper.address, 100_000);
        await waitForUtxo(bumper.address);
        const session = await Unroll.sessionFor(wallet, vtxo, bumper);
        for await (const step of session) {
            if (step.type === Unroll.StepType.WAIT || step.type === Unroll.StepType.UNROLL) {
                mineBlocks(1);
            }
        }
        const [unrolled] = await wallet.getVtxos({ withUnrolled: true });
        expect(unrolled.isUnrolled).toBe(true);
        const dest = await externalAddress();

        const txid = await wallet.sendOnchain({
            outputs: [],
            inputs: [{ txid: unrolled.txid, vout: unrolled.vout }],
            sweepTo: dest,
        });
        await confirm(txid);

        expect((await waitForUtxo(dest)).value).toBeGreaterThan(0);
        expect((await storedRow(wallet, unrolled))?.isSpent).toBe(true);
    });

    it("spends an Arkade covenant UTXO through builder.sendOnchain", {
        timeout: 120_000,
    }, async () => {
        const { contract, receiverScript, utxo } = await fundCovenant(SingleKey.fromRandomBytes());

        const txid = await contract.functions
            .spend()
            .from(utxo)
            .to(receiverScript, COVENANT_SPEND)
            .onchainFee(BigInt(utxo.value) - COVENANT_SPEND)
            .sendOnchain();
        await confirm(txid);

        const tx = Transaction.fromRaw(await explorer.getRawTransaction(txid));
        expect(tx.getOutput(0).amount).toBe(COVENANT_SPEND);
    });

    it("cosigns a covenant UTXO and a boarding coin in one PSBT", {
        timeout: 180_000,
    }, async () => {
        const wallet = await createWallet();
        const coin = await fundBoarding(wallet);
        const covenantUser = SingleKey.fromRandomBytes();
        const { contract, receiverScript, utxo } = await fundCovenant(covenantUser);
        const dest = await externalAddress();

        const tx = await contract.functions
            .spend()
            .from(utxo)
            .to(receiverScript, COVENANT_SPEND)
            .onchainFee(BigInt(utxo.value) - COVENANT_SPEND)
            .buildOnchain();
        tx.addInput({
            txid: hex.decode(coin.txid),
            index: coin.vout,
            witnessUtxo: { amount: BigInt(coin.value), script: wallet.boardingTapscript.pkScript },
        });
        tx.addOutputAddress(dest, BigInt(coin.value - FEE), networks.regtest);
        const signed = await covenantUser.sign(tx, [0]);

        // If arkd rejects the finalized emulator input, this flips to a client-side rejection per spec.
        const txid = await wallet.cosignOnchainTx(signed);
        await confirm(txid);

        expect((await waitForUtxo(dest)).value).toBe(coin.value - FEE);
    });
});
