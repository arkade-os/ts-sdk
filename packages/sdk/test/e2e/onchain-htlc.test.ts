// Needs an arkd with ArkLabsHQ/arkd#127, which CI's public images lack: with no emulator, arkd
// alone co-signs each covenant leaf onchain, on its key tweaked by that covenant.
import { beforeAll, describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { hash160 } from "@scure/btc-signer/utils.js";
import {
    arkade,
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    networks,
    OnchainHTLC,
    RestIndexerProvider,
    RestOperatorProvider,
    SingleKey,
    Transaction,
    Wallet,
    type ExtendedCoin,
} from "../../src";
import type { Identity } from "../../src/identity";
import {
    ESPLORA_API_URL,
    OPERATOR_URL,
    execCommand,
    faucetOnchain,
    mineBlocks,
    randomP2TR,
    waitFor,
    waitForUtxo,
} from "./utils";

const AMOUNT = 10_000n;
const FEE = 1_000n;

describe("OnchainHTLC co-signed by arkd alone", () => {
    const arkProvider = new RestOperatorProvider(OPERATOR_URL);
    const explorer = new EsploraProvider(ESPLORA_API_URL);
    let exitDelay: bigint;

    beforeAll(async () => {
        exitDelay = (await arkProvider.getInfo()).boardingExitDelay;
        // Blocks, so mining can mature the CSV leaves; arkd allows them with a block-typed tree expiry.
        expect(exitDelay).toBeLessThan(512n);
    });

    function connect(identity?: Identity): Promise<arkade.Arkade> {
        return arkade.Arkade.connect({
            arkade: arkProvider,
            onchain: explorer,
            identity,
            network: networks.regtest,
        });
    }

    async function lockup(ark: arkade.Arkade, overrides: Partial<OnchainHTLC.Options> = {}) {
        const preimage = crypto.getRandomValues(new Uint8Array(32));
        const receiverPkScript = randomP2TR();
        const senderPkScript = randomP2TR();
        const options: OnchainHTLC.Options = {
            sender: await SingleKey.fromRandomBytes().xOnlyPublicKey(),
            receiver: await SingleKey.fromRandomBytes().xOnlyPublicKey(),
            server: ark.serverKey,
            preimageHash: hash160(preimage),
            refundLocktime: 2_000_000_000n,
            refundDelay: { type: "blocks", value: exitDelay },
            claimDelay: { type: "blocks", value: exitDelay + 10n },
            minExitDelay: { type: "blocks", value: exitDelay },
            receiverScript: receiverPkScript.slice(2),
            senderScript: senderPkScript.slice(2),
            amount: AMOUNT,
            fee: FEE,
            ...overrides,
        };
        const contract = ark.contract(OnchainHTLC.program, OnchainHTLC.args(options));
        expect(hex.encode(contract.pkScript)).toBe(
            hex.encode(OnchainHTLC.script(options).pkScript),
        );
        const address = contract.vtxoScript.onchainAddress(networks.regtest);
        return {
            contract,
            preimage,
            receiverPkScript,
            senderPkScript,
            fund: (sats: bigint) => {
                faucetOnchain(address, Number(sats));
                return waitForUtxo(address);
            },
        };
    }

    async function confirmedOutput(txid: string) {
        await waitFor(async () =>
            explorer.getTxStatus(txid).then(
                () => true,
                () => false,
            ),
        );
        mineBlocks(1);
        await waitFor(async () => (await explorer.getTxStatus(txid)).confirmed);
        return Transaction.fromRaw(await explorer.getRawTransaction(txid)).getOutput(0);
    }

    /** arkd's signer ran the covenant, which failed at `opcode`. */
    function refusedAt(spend: Promise<unknown>, opcode: string) {
        return expect(spend).rejects.toMatchObject({
            name: "OnchainCosignRejectedError",
            arkErrorName: "INVALID_ARK_PSBT",
            serverMessage: expect.stringMatching(
                new RegExp(`: input 0: failed to execute arkade script: .*opcode=${opcode} `),
            ),
        });
    }

    async function boardingWallet(): Promise<{ wallet: Wallet; coin: ExtendedCoin }> {
        const wallet = await Wallet.create({
            identity: SingleKey.fromRandomBytes(),
            arkProvider: new RestOperatorProvider(OPERATOR_URL),
            indexerProvider: new RestIndexerProvider(OPERATOR_URL),
            onchainProvider: new EsploraProvider(ESPLORA_API_URL, {
                forcePolling: true,
                pollingInterval: 2000,
            }),
            storage: {
                walletRepository: new InMemoryWalletRepository(),
                contractRepository: new InMemoryContractRepository(),
            },
            settlementConfig: false,
        });
        faucetOnchain(await wallet.getBoardingAddress(), 100_000);
        let coin: ExtendedCoin | undefined;
        await waitFor(async () => {
            coin = (await wallet.getBoardingUtxos()).find((u) => u.status.confirmed);
            return coin !== undefined;
        });
        return { wallet, coin: coin! };
    }

    it("co-signs a claim with the preimage and the receiver's signature", {
        timeout: 120_000,
    }, async () => {
        const ark = await connect(SingleKey.fromRandomBytes());
        const htlc = await lockup(ark, { receiver: ark.userKey });
        const coin = await htlc.fund(AMOUNT);

        const txid = await htlc.contract.functions
            .claim({ tapscript: [htlc.preimage] })
            .from(coin)
            .to(htlc.receiverPkScript, AMOUNT - FEE)
            .onchainFee(FEE)
            .sendOnchain();
        expect(await confirmedOutput(txid)).toMatchObject({
            script: htlc.receiverPkScript,
            amount: AMOUNT - FEE,
        });
    });

    it("co-signs a nonInteractiveClaim leaving the coin at most fee, and refuses one leaving more", {
        timeout: 120_000,
    }, async () => {
        const htlc = await lockup(await connect());
        const input = AMOUNT + 2_000n;
        const coin = await htlc.fund(input);
        const claim = (paid: bigint) =>
            htlc.contract.functions
                .nonInteractiveClaim({ tapscript: [htlc.preimage] })
                .from(coin)
                .to(htlc.receiverPkScript, paid)
                .onchainFee(input - paid)
                .sendOnchain();

        await refusedAt(claim(input - FEE - 1n), "OP_VERIFY");

        // payReceiver's OP_TUNNEL also passes: with no asset packet it compares nothing.
        const txid = await claim(input - FEE);
        expect(await confirmedOutput(txid)).toMatchObject({
            script: htlc.receiverPkScript,
            amount: input - FEE,
        });
    });

    it("co-signs a nonInteractiveRefundWithoutReceiver after refundLocktime, its fee from the pusher", {
        timeout: 180_000,
    }, async () => {
        const { mediantime } = JSON.parse(
            execCommand("node regtest/regtest.mjs rpc getblockchaininfo"),
        );
        const htlc = await lockup(await connect(), { refundLocktime: BigInt(mediantime - 1) });
        const coin = await htlc.fund(AMOUNT);
        const refund = () =>
            htlc.contract.functions.nonInteractiveRefundWithoutReceiver().from(coin);

        await refusedAt(
            refund()
                .to(htlc.senderPkScript, AMOUNT - FEE)
                .onchainFee(FEE)
                .sendOnchain(),
            "OP_VERIFY",
        );

        const pusher = await boardingWallet();
        const tx = await refund().to(htlc.senderPkScript, AMOUNT).onchainFee(0n).buildOnchain();
        tx.addInput({
            txid: hex.decode(pusher.coin.txid),
            index: pusher.coin.vout,
            witnessUtxo: {
                amount: BigInt(pusher.coin.value),
                script: pusher.wallet.boardingTapscript.pkScript,
            },
        });
        tx.addOutput({ script: randomP2TR(), amount: BigInt(pusher.coin.value) - FEE });

        const txid = await pusher.wallet.cosignOnchainTx(tx);
        expect(await confirmedOutput(txid)).toMatchObject({
            script: htlc.senderPkScript,
            amount: AMOUNT,
        });
    });

    it("lets the sender refund and the receiver claim alone, co-signing neither once refundDelay is in reach", {
        timeout: 240_000,
    }, async () => {
        const sender = await connect(SingleKey.fromRandomBytes());
        const receiver = await connect(SingleKey.fromRandomBytes());
        const refundable = await lockup(sender, { sender: sender.userKey });
        const claimable = await lockup(receiver, { receiver: receiver.userKey });
        const refundCoin = await refundable.fund(AMOUNT);
        const claimCoin = await claimable.fund(AMOUNT);
        mineBlocks(Number(exitDelay));

        const refunded = await refundable.contract.functions
            .unilateralRefundWithoutReceiver()
            .from(refundCoin)
            .to(refundable.senderPkScript, AMOUNT - FEE)
            .onchainFee(FEE)
            .sendOnchain();
        expect(await confirmedOutput(refunded)).toMatchObject({
            script: refundable.senderPkScript,
            amount: AMOUNT - FEE,
        });

        // After the refund confirms, so arkd's tip has caught up: a lagging one would co-sign.
        await expect(
            claimable.contract.functions
                .nonInteractiveClaim({ tapscript: [claimable.preimage] })
                .from(claimCoin)
                .to(claimable.receiverPkScript, AMOUNT - FEE)
                .onchainFee(FEE)
                .sendOnchain(),
        ).rejects.toMatchObject({
            name: "OnchainCosignRejectedError",
            arkErrorName: "INVALID_ARK_PSBT",
            serverMessage: expect.stringMatching(/: input 0 has an available exit closure$/),
        });

        mineBlocks(10);
        const claimed = await claimable.contract.functions
            .unilateralClaim({ tapscript: [claimable.preimage] })
            .from(claimCoin)
            .to(claimable.receiverPkScript, AMOUNT - FEE)
            .onchainFee(FEE)
            .sendOnchain();
        expect(await confirmedOutput(claimed)).toMatchObject({
            script: claimable.receiverPkScript,
            amount: AMOUNT - FEE,
        });
    });
});
