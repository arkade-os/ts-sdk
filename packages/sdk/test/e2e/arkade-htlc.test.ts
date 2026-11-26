// Needs an arkd with ArkLabsHQ/arkd#127, which CI's public images lack: the client has no
// emulator, so arkd alone co-signs each covenant leaf, on its key tweaked by that covenant.
import { describe, it, expect, beforeEach } from "vitest";
import { base64, hex } from "@scure/base";
import { hash160 } from "@scure/btc-signer/utils.js";
import {
    arkade,
    ArkadeHTLC,
    ArkadeTweak,
    asset as assetExt,
    getArkPsbtFields,
    networks,
    RestIndexerProvider,
    RestOperatorProvider,
    SingleKey,
    type VirtualCoin,
} from "../../src";
import type { Identity } from "../../src/identity";
import {
    beforeEachFaucet,
    createTestArkWallet,
    faucetOffchain,
    randomP2TR,
    waitFor,
} from "./utils";

const OPERATOR_URL = "http://localhost:7070";
const AMOUNT = 10_000n;
const ASSET_LOCKED = 500n;
const ASSET_SHORT = 200n;

describe("ArkadeHTLC co-signed by arkd alone", () => {
    const arkProvider = new RestOperatorProvider(OPERATOR_URL);
    const indexerProvider = new RestIndexerProvider(OPERATOR_URL);

    beforeEach(beforeEachFaucet, 60000);

    function connect(identity?: Identity): Promise<arkade.Arkade> {
        return arkade.Arkade.connect({
            arkade: arkProvider,
            indexer: indexerProvider,
            identity,
            network: networks.regtest,
        });
    }

    /** A lockup whose receiver is the client's identity, or a random key without one. */
    async function lockup(ark: arkade.Arkade, asset?: ArkadeHTLC.Options["asset"]) {
        const preimage = crypto.getRandomValues(new Uint8Array(32));
        const receiverPkScript = randomP2TR();
        const senderPkScript = randomP2TR();
        const options: ArkadeHTLC.Options = {
            sender: await SingleKey.fromRandomBytes().xOnlyPublicKey(),
            receiver: ark.userKey ?? (await SingleKey.fromRandomBytes().xOnlyPublicKey()),
            server: ark.serverKey,
            preimageHash: hash160(preimage),
            refundLocktime: 2_000_000_000n,
            unilateralClaimDelay: { type: "blocks", value: 100n },
            unilateralRefundDelay: { type: "blocks", value: 50n },
            unilateralRefundWithoutReceiverDelay: { type: "blocks", value: 50n },
            receiverScript: receiverPkScript.slice(2),
            senderScript: senderPkScript.slice(2),
            amount: AMOUNT,
            asset,
        };
        const contract = ark.contract(ArkadeHTLC.program, ArkadeHTLC.args(options));
        expect(hex.encode(contract.pkScript)).toBe(hex.encode(ArkadeHTLC.script(options).pkScript));
        return {
            contract,
            receiverPkScript,
            senderPkScript,
            nonInteractiveClaim: (coin: VirtualCoin) =>
                contract.functions.nonInteractiveClaim({ tapscript: [preimage] }).from(coin),
            nonInteractiveRefund: (coin: VirtualCoin) =>
                contract.functions.nonInteractiveRefund().from(coin),
            claim: (coin: VirtualCoin) =>
                contract.functions.claim({ tapscript: [preimage] }).from(coin),
        };
    }

    async function vtxosAt(pkScript: Uint8Array, count = 1): Promise<VirtualCoin[]> {
        let vtxos: VirtualCoin[] = [];
        await waitFor(
            async () => {
                ({ vtxos } = await indexerProvider.getVtxos({
                    scripts: [hex.encode(pkScript)],
                    spendableOnly: true,
                }));
                return vtxos.length >= count;
            },
            { timeout: 30_000, interval: 1000 },
        );
        return vtxos;
    }

    async function fund(contract: arkade.ArkadeContract, sats: bigint): Promise<VirtualCoin> {
        faucetOffchain(contract.address, Number(sats));
        const [coin] = await vtxosAt(contract.pkScript);
        return coin;
    }

    /** arkd's signer ran the covenant, which failed at `opcode`. */
    function refusedAt(spend: Promise<unknown>, opcode: string) {
        return expect(spend).rejects.toMatchObject({
            name: "INVALID_ARK_PSBT",
            message: expect.stringMatching(
                new RegExp(`failed to execute arkade script: .*opcode=${opcode} `),
            ),
        });
    }

    it("co-signs a claim of the whole coin to the receiver, and refuses a misdirected or skimmed one", {
        timeout: 120000,
    }, async () => {
        const htlc = await lockup(await connect());
        const coin = await fund(htlc.contract, AMOUNT + 2_000n);

        await refusedAt(
            htlc
                .nonInteractiveClaim(coin)
                .to(randomP2TR(), AMOUNT + 2_000n)
                .send(),
            "OP_EQUALVERIFY",
        );
        // `amount` is met but the input is not, so max(input, amount) refuses it.
        await refusedAt(
            htlc
                .nonInteractiveClaim(coin)
                .to([
                    { script: htlc.receiverPkScript, amount: AMOUNT },
                    { script: randomP2TR(), amount: 2_000n },
                ])
                .send(),
            "OP_VERIFY",
        );

        const { txid } = await htlc
            .nonInteractiveClaim(coin)
            .to(htlc.receiverPkScript, AMOUNT + 2_000n)
            .send();
        const [paid] = await vtxosAt(htlc.receiverPkScript);
        expect(paid).toMatchObject({ txid, value: Number(AMOUNT + 2_000n) });
    });

    it("refuses a claim below amount, and co-signs only a whole-coin refund to the sender", {
        timeout: 120000,
    }, async () => {
        const htlc = await lockup(await connect(SingleKey.fromRandomBytes()));
        const coin = await fund(htlc.contract, AMOUNT - 4_000n);

        await refusedAt(
            htlc
                .nonInteractiveClaim(coin)
                .to(htlc.receiverPkScript, AMOUNT - 4_000n)
                .send(),
            "OP_VERIFY",
        );
        await refusedAt(
            htlc
                .nonInteractiveRefund(coin)
                .to(randomP2TR(), AMOUNT - 4_000n)
                .send(),
            "OP_EQUALVERIFY",
        );
        await refusedAt(
            htlc
                .nonInteractiveRefund(coin)
                .to([
                    { script: htlc.senderPkScript, amount: AMOUNT - 5_000n },
                    { script: randomP2TR(), amount: 1_000n },
                ])
                .send(),
            "OP_VERIFY",
        );

        const { txid } = await htlc
            .nonInteractiveRefund(coin)
            .to(htlc.senderPkScript, AMOUNT - 4_000n)
            .send();
        const [refunded] = await vtxosAt(htlc.senderPkScript);
        expect(refunded).toMatchObject({ txid, value: Number(AMOUNT - 4_000n) });
    });

    it("spends the claim leaf on arkd's plain key, revealing both covenant hashes", {
        timeout: 120000,
    }, async () => {
        const receiver = SingleKey.fromRandomBytes();
        const htlc = await lockup(await connect(receiver));
        const coin = await fund(htlc.contract, AMOUNT);
        const claim = () => htlc.claim(coin).to(htlc.receiverPkScript, AMOUNT);

        const { arkTx, checkpoints } = await claim().build();
        const covenants = ["nonInteractiveClaim", "nonInteractiveRefund"].map((name) =>
            hex.encode(
                arkade.arkadeScriptHash(
                    htlc.contract.vtxoScript.functionByName(name)!.arkadeScript!,
                ),
            ),
        );
        const revealed = getArkPsbtFields(arkTx, 0, ArkadeTweak);
        expect(revealed.map((hashes) => hashes.map(hex.encode).sort())).toEqual([covenants.sort()]);

        // Without the reveal, the covenant leaves name no key arkd knows as its own.
        const unknown = arkTx.getInput(0).unknown!;
        arkTx.updateInput(0, { unknown: undefined }, true);
        arkTx.updateInput(0, { unknown: unknown.filter((u) => ArkadeTweak.decode(u) === null) });
        const signed = await receiver.sign(arkTx, [0]);
        await expect(
            arkProvider.submitTx(
                base64.encode(signed.toPSBT()),
                checkpoints.map((c) => base64.encode(c.toPSBT())),
            ),
        ).rejects.toMatchObject({
            name: "INVALID_VTXO_SCRIPT",
            message: expect.stringContaining("signer pubkey not found"),
        });

        const { txid } = await claim().send();
        const [paid] = await vtxosAt(htlc.receiverPkScript);
        expect(paid).toMatchObject({ txid, value: Number(AMOUNT) });
    });

    it("tunnels the whole asset to the receiver or the sender, and refuses a drop or a short claim", {
        timeout: 180000,
    }, async () => {
        const alice = await createTestArkWallet();
        faucetOffchain((await alice.wallet.getAddress())!, 50_000);
        await waitFor(async () => (await alice.wallet.getBalance()).total >= 50_000);
        const { assetId } = await alice.wallet.assetManager.issue({
            amount: ASSET_LOCKED + ASSET_SHORT,
        });
        const held = async () => assetBalance(await alice.wallet.getBalance(), assetId);
        await waitFor(async () => (await held()) === ASSET_LOCKED + ASSET_SHORT);

        const { txid, groupIndex } = assetExt.AssetId.fromString(assetId);
        const htlc = await lockup(await connect(SingleKey.fromRandomBytes()), {
            txid,
            groupIndex,
            amount: ASSET_LOCKED,
        });
        const address = htlc.contract.address;
        await alice.wallet.send({
            address,
            amount: Number(AMOUNT),
            assets: [{ assetId, amount: ASSET_LOCKED }],
        });
        await waitFor(async () => (await held()) === ASSET_SHORT);
        await alice.wallet.send({
            address,
            amount: Number(AMOUNT),
            assets: [{ assetId, amount: ASSET_SHORT }],
        });
        const coins = await vtxosAt(htlc.contract.pkScript, 2);
        const holding = (units: bigint) =>
            coins.find((c) => c.assets?.some((a) => BigInt(a.amount) === units))!;
        const [full, short] = [holding(ASSET_LOCKED), holding(ASSET_SHORT)];
        const route = (amount: bigint, vouts: number[]) => ({
            assetId,
            inputs: [{ vin: 0, amount }],
            outputs: vouts.map((vout) => ({ vout, amount })),
        });

        // Dropping means burning: output i takes the whole input, so no other output has sats.
        await refusedAt(
            htlc
                .nonInteractiveClaim(full)
                .withAsset(route(ASSET_LOCKED, []))
                .to(htlc.receiverPkScript, AMOUNT)
                .send(),
            "OP_TUNNEL",
        );
        await refusedAt(
            htlc
                .nonInteractiveRefund(full)
                .withAsset(route(ASSET_LOCKED, []))
                .to(htlc.senderPkScript, AMOUNT)
                .send(),
            "OP_TUNNEL",
        );
        // OP_TUNNEL trusts the packet; arkd's asset check holds the packet to the coin.
        await expect(
            htlc
                .nonInteractiveRefund(full)
                .withAsset(route(ASSET_SHORT, [0]))
                .to(htlc.senderPkScript, AMOUNT)
                .send(),
        ).rejects.toMatchObject({
            name: "ASSET_INPUT_INVALID",
            message: expect.stringContaining("amount mismatch"),
        });
        // Tunnelled whole, but below assetAmount.
        await refusedAt(
            htlc
                .nonInteractiveClaim(short)
                .withAsset(route(ASSET_SHORT, [0]))
                .to(htlc.receiverPkScript, AMOUNT)
                .send(),
            "OP_VERIFY",
        );

        const claimed = await htlc
            .nonInteractiveClaim(full)
            .withAsset(route(ASSET_LOCKED, [0]))
            .to(htlc.receiverPkScript, AMOUNT)
            .send();
        const refunded = await htlc
            .nonInteractiveRefund(short)
            .withAsset(route(ASSET_SHORT, [0]))
            .to(htlc.senderPkScript, AMOUNT)
            .send();
        const [paid] = await vtxosAt(htlc.receiverPkScript);
        const [returned] = await vtxosAt(htlc.senderPkScript);
        expect(paid).toMatchObject({
            txid: claimed.txid,
            assets: [{ assetId, amount: ASSET_LOCKED }],
        });
        expect(returned).toMatchObject({
            txid: refunded.txid,
            assets: [{ assetId, amount: ASSET_SHORT }],
        });
    });
});

function assetBalance(
    balance: { assets?: { assetId: string; amount: bigint | number }[] },
    assetId: string,
): bigint {
    return BigInt(balance.assets?.find((a) => a.assetId === assetId)?.amount ?? 0);
}
