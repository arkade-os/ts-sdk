import { expect, describe, it, beforeEach } from "vitest";
import * as bip68 from "bip68";
import { base64, hex } from "@scure/base";
import { hash160 } from "@scure/btc-signer/utils.js";
import {
    ArkError,
    ArkErrorName,
    buildOffchainTx,
    ConditionWitness,
    CSVMultisigTapscript,
    EsploraProvider,
    Identity,
    isArkError,
    networks,
    OnchainWallet,
    RestArkProvider,
    RestIndexerProvider,
    setArkPsbtField,
    Unroll,
    VHTLC,
    Transaction,
} from "../../src";
import {
    arkdExec,
    beforeEachFaucet,
    createTestArkWallet,
    createTestIdentity,
    execCommand,
    faucetOffchain,
    mineBlocks,
    waitFor,
} from "./utils";
import { execSync } from "child_process";
import { beforeAll } from "vitest";

describe("vhtlc", () => {
    beforeEach(beforeEachFaucet, 20000);

    let X_ONLY_PUBLIC_KEY: Uint8Array;
    beforeAll(() => {
        const info = execSync("curl -fsS --max-time 5 http://localhost:7070/v1/info");
        const signerPubkey = JSON.parse(info.toString()).signerPubkey;
        X_ONLY_PUBLIC_KEY = hex.decode(signerPubkey).slice(1);
    });

    it("should claim", { timeout: 60000 }, async () => {
        const alice = createTestIdentity();
        const bob = createTestIdentity();

        const preimage = new TextEncoder().encode("preimage");
        const preimageHash = hash160(preimage);

        const vhtlcScript = new VHTLC.Script({
            preimageHash,
            sender: await alice.xOnlyPublicKey(),
            receiver: await bob.xOnlyPublicKey(),
            server: X_ONLY_PUBLIC_KEY,
            refundLocktime: BigInt(1000),
            unilateralClaimDelay: {
                type: "blocks",
                value: 100n,
            },
            unilateralRefundDelay: {
                type: "blocks",
                value: 50n,
            },
            unilateralRefundWithoutReceiverDelay: {
                type: "blocks",
                value: 50n,
            },
        });

        const address = vhtlcScript.address(networks.regtest.hrp, X_ONLY_PUBLIC_KEY).encode();

        // fund the vhtlc address
        const fundAmount = 1000;
        execCommand(
            `${arkdExec} ark send --to ${address} --amount ${fundAmount} --password secret`,
        );

        await new Promise((resolve) => setTimeout(resolve, 1000));

        // bob special identity to sign with the preimage
        const bobVHTLCIdentity: Identity = {
            sign: async (tx: Transaction, inputIndexes?: number[]) => {
                const cpy = tx.clone();
                setArkPsbtField(cpy, 0, ConditionWitness, [preimage]);
                return bob.sign(cpy, inputIndexes);
            },
            compressedPublicKey: bob.compressedPublicKey,
            xOnlyPublicKey: bob.xOnlyPublicKey,
            signerSession: bob.signerSession,
            signMessage: bob.signMessage,
        };

        const arkProvider = new RestArkProvider("http://localhost:7070");
        const indexerProvider = new RestIndexerProvider("http://localhost:7070");

        const spendableVtxosResponse = await indexerProvider.getVtxos({
            scripts: [hex.encode(vhtlcScript.pkScript)],
            spendableOnly: true,
        });
        expect(spendableVtxosResponse.vtxos).toHaveLength(1);

        const info = await arkProvider.getInfo();
        const rawCheckpointUnrollClosure = hex.decode(info.checkpointTapscript);
        const checkpointUnrollClosure = CSVMultisigTapscript.decode(rawCheckpointUnrollClosure);

        const vtxo = spendableVtxosResponse.vtxos[0];

        const { arkTx, checkpoints } = buildOffchainTx(
            [
                {
                    ...vtxo,
                    tapLeafScript: vhtlcScript.claim(),
                    tapTree: vhtlcScript.encode(),
                },
            ],
            [
                {
                    script: vhtlcScript.pkScript,
                    amount: BigInt(fundAmount),
                },
            ],
            checkpointUnrollClosure,
        );

        const signedArkTx = await bobVHTLCIdentity.sign(arkTx);
        const { arkTxid, finalArkTx, signedCheckpointTxs } = await arkProvider.submitTx(
            base64.encode(signedArkTx.toPSBT()),
            checkpoints.map((c) => base64.encode(c.toPSBT())),
        );

        expect(arkTxid).toBeDefined();
        expect(finalArkTx).toBeDefined();
        expect(signedCheckpointTxs).toBeDefined();
        expect(signedCheckpointTxs.length).toBe(checkpoints.length);

        const finalCheckpoints = await Promise.all(
            signedCheckpointTxs.map(async (c) => {
                const tx = Transaction.fromPSBT(base64.decode(c));
                const signedCheckpoint = await bobVHTLCIdentity.sign(tx, [0]);
                return base64.encode(signedCheckpoint.toPSBT());
            }),
        );

        await arkProvider.finalizeTx(arkTxid, finalCheckpoints);
    });

    it("should unilaterally claim", { timeout: 300_000 }, async () => {
        const alice = await createTestArkWallet();
        const amount = 5000;
        faucetOffchain(await alice.wallet.getAddress(), amount);

        await new Promise((resolve) => setTimeout(resolve, 1000));

        const bob = createTestIdentity();

        const preimage = new TextEncoder().encode("preimage");
        const preimageHash = hash160(preimage);

        const vhtlcScript = new VHTLC.Script({
            preimageHash,
            sender: await alice.identity.xOnlyPublicKey(),
            receiver: await bob.xOnlyPublicKey(),
            server: X_ONLY_PUBLIC_KEY,
            refundLocktime: BigInt(1000),
            unilateralClaimDelay: {
                type: "blocks",
                value: 9n,
            },
            unilateralRefundDelay: {
                type: "blocks",
                value: 50n,
            },
            unilateralRefundWithoutReceiverDelay: {
                type: "blocks",
                value: 50n,
            },
        });

        const address = vhtlcScript.address(networks.regtest.hrp, X_ONLY_PUBLIC_KEY).encode();

        // fund the vhtlc address with settle in order to reduce the chain size
        await alice.wallet.settle({
            inputs: await alice.wallet.getVtxos(),
            outputs: [
                {
                    address,
                    amount: BigInt(amount),
                },
            ],
        });

        const indexerProvider = new RestIndexerProvider("http://localhost:7070");

        await new Promise((resolve) => setTimeout(resolve, 5000));

        const spendableVtxosResponse = await indexerProvider.getVtxos({
            scripts: [hex.encode(vhtlcScript.pkScript)],
            spendableOnly: true,
        });
        expect(spendableVtxosResponse.vtxos).toHaveLength(1);

        const vtxo = spendableVtxosResponse.vtxos[0];
        const onchainBob = await OnchainWallet.create(bob, "regtest");

        execSync(`node regtest/regtest.mjs faucet ${onchainBob.address} 0.001 --confirm`);

        await new Promise((resolve) => setTimeout(resolve, 5000));

        const session = await Unroll.Session.create(
            vtxo,
            onchainBob,
            onchainBob.provider,
            indexerProvider,
        );

        for await (const done of session) {
            switch (done.type) {
                case Unroll.StepType.WAIT:
                case Unroll.StepType.UNROLL:
                    execSync(`node regtest/regtest.mjs mine 1`);
                    await new Promise((resolve) => setTimeout(resolve, 2000)); // give time for the checkpoint to be created
                    execSync(`node regtest/regtest.mjs mine 1`);
                    break;
            }
        }

        const tx = new Transaction();
        tx.addInput({
            index: vtxo.vout,
            txid: vtxo.txid,
            witnessUtxo: {
                amount: BigInt(vtxo.value),
                script: vhtlcScript.pkScript,
            },
            tapLeafScript: [vhtlcScript.unilateralClaim()],
            sequence: bip68.encode({ blocks: 9, seconds: undefined }),
        });
        tx.addOutputAddress(onchainBob.address, BigInt(vtxo.value) - 1000n, onchainBob.network);
        const signedTx = await bob.sign(tx);
        signedTx.finalize();

        const currentWitness = signedTx.getInput(0).finalScriptWitness;
        signedTx.updateInput(0, {
            finalScriptWitness: [currentWitness![0], preimage, ...currentWitness!.slice(1)],
        });

        // should fail now cause the utxo is locked by CSV
        await expect(onchainBob.provider.broadcastTransaction(signedTx.hex)).rejects.toThrow();

        // generate 10 blocks to make the exit path available
        execSync(`node regtest/regtest.mjs mine 10`);

        const txid = await onchainBob.provider.broadcastTransaction(signedTx.hex);
        expect(txid).toBeDefined();
    });

    // Regression for arkd #1146 (fixed in 0.9.14 by PR #1147). A CLTV tx refused
    // before its locktime used to poison its own txid: the offchain-tx aggregate
    // treated `Failed` as sticky, so the post-maturity retry — byte-identical, hence
    // the same txid — got a *success* response while event replay skipped the
    // projections, leaving the input spendable and no output created.
    it(
        "should refund without receiver on a post-maturity retry of a rejected CLTV tx",
        { timeout: 120_000 },
        async () => {
            const alice = createTestIdentity();
            const bob = createTestIdentity();

            const arkProvider = new RestArkProvider("http://localhost:7070");
            const indexerProvider = new RestIndexerProvider("http://localhost:7070");
            const onchainProvider = new EsploraProvider("http://localhost:3000/api");

            // A block-height CLTV matures deterministically under mineBlocks(); a
            // seconds-CLTV would need both wall-clock passage and a later block to
            // carry that time forward, so neither mining nor waiting alone gets there.
            //
            // The buffer is squeezed between two bounds. Below it, the locktime must
            // not already be matured against arkd's own nbxplorer-derived tip, which
            // is a separate indexing pipeline from the mempool/Fulcrum one `height`
            // comes from; a few blocks of slack cover that skew, and with
            // AUTOMINE_INTERVAL=0 (see .env.regtest) nothing advances the tip between
            // this read and the first submitTx below. Above it, the whole maturation
            // must fit inside the funding VTXO's batch lifetime —
            // ARKD_VTXO_TREE_EXPIRY=20 blocks — because an expired batch makes the
            // input recoverable-only, and the retry then fails VTXO_RECOVERABLE
            // instead of exercising the regression.
            const { height } = await onchainProvider.getChainTip();
            const refundLocktime = BigInt(height + 5);

            const preimageHash = hash160(new TextEncoder().encode("preimage"));
            const vhtlcScript = new VHTLC.Script({
                preimageHash,
                sender: await alice.xOnlyPublicKey(),
                receiver: await bob.xOnlyPublicKey(),
                server: X_ONLY_PUBLIC_KEY,
                refundLocktime,
                unilateralClaimDelay: { type: "blocks", value: 100n },
                unilateralRefundDelay: { type: "blocks", value: 50n },
                unilateralRefundWithoutReceiverDelay: { type: "blocks", value: 50n },
            });

            const address = vhtlcScript.address(networks.regtest.hrp, X_ONLY_PUBLIC_KEY).encode();
            const fundAmount = 1000;
            faucetOffchain(address, fundAmount);
            await new Promise((resolve) => setTimeout(resolve, 1000));

            const spendable = await indexerProvider.getVtxos({
                scripts: [hex.encode(vhtlcScript.pkScript)],
                spendableOnly: true,
            });
            expect(spendable.vtxos).toHaveLength(1);
            const vtxo = spendable.vtxos[0];

            const info = await arkProvider.getInfo();
            const checkpointUnrollClosure = CSVMultisigTapscript.decode(
                hex.decode(info.checkpointTapscript),
            );

            // Output goes back to the same script, as the claim test above does —
            // where the funds land is irrelevant to this regression.
            const buildRefund = () =>
                buildOffchainTx(
                    [
                        {
                            ...vtxo,
                            tapLeafScript: vhtlcScript.refundWithoutReceiver(),
                            tapTree: vhtlcScript.encode(),
                        },
                    ],
                    [{ script: vhtlcScript.pkScript, amount: BigInt(fundAmount) }],
                    checkpointUnrollClosure,
                );

            // Capture the txid client-side — a rejected submitTx throws, so there is
            // no response body to read it from.
            const first = buildRefund();
            const txid1 = first.arkTx.id;
            const signedFirst = await alice.sign(first.arkTx);

            const rejection = await arkProvider
                .submitTx(
                    base64.encode(signedFirst.toPSBT()),
                    first.checkpoints.map((c) => base64.encode(c.toPSBT())),
                )
                .then(
                    () => {
                        throw new Error(
                            "submitTx accepted a CLTV spend before its locktime matured",
                        );
                    },
                    (e: unknown) => e,
                );
            expect(isArkError(rejection, ArkErrorName.FORFEIT_CLOSURE_LOCKED)).toBe(true);
            expect((rejection as ArkError).metadata?.type).toBe("height");

            mineBlocks(6);
            await waitFor(
                async () => (await onchainProvider.getChainTip()).height >= Number(refundLocktime),
            );

            // Rebuild from the same VTXO, as a real client retrying later would —
            // don't stash and replay the signed payload.
            const second = buildRefund();

            // Test-validity guard, not a nicety: the identical txid *is* #1146. A
            // retry carrying a different txid never touches the sticky-`Failed`
            // aggregate, so it would pass vacuously against a broken server. Stable by
            // construction — a taproot txid is computed pre-witness, and everything it
            // commits to here is fixed, with no nonce anywhere.
            expect(second.arkTx.id).toBe(txid1);

            const signedSecond = await alice.sign(second.arkTx);

            // arkd reads the tip through nbxplorer, which lags the mined block by a
            // moment. Retry only while it still reports the CLTV immature — the
            // retry-after-maturity behaviour under test; anything else fails.
            const deadline = Date.now() + 30_000;
            let submitted: Awaited<ReturnType<typeof arkProvider.submitTx>> | undefined;
            while (!submitted) {
                try {
                    submitted = await arkProvider.submitTx(
                        base64.encode(signedSecond.toPSBT()),
                        second.checkpoints.map((c) => base64.encode(c.toPSBT())),
                    );
                } catch (e) {
                    if (!isArkError(e, ArkErrorName.FORFEIT_CLOSURE_LOCKED)) throw e;
                    if (Date.now() > deadline) throw e;
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                }
            }

            expect(submitted.arkTxid).toBe(txid1);

            const finalCheckpoints = await Promise.all(
                submitted.signedCheckpointTxs.map(async (c) => {
                    const signed = await alice.sign(Transaction.fromPSBT(base64.decode(c)), [0]);
                    return base64.encode(signed.toPSBT());
                }),
            );
            await arkProvider.finalizeTx(submitted.arkTxid, finalCheckpoints);

            // The regression itself: the old server reported success above while
            // dropping these projections.
            await waitFor(async () => {
                const { vtxos } = await indexerProvider.getVtxos({
                    outpoints: [{ txid: vtxo.txid, vout: vtxo.vout }],
                });
                return vtxos[0]?.isSpent === true;
            });

            await waitFor(async () => {
                const { vtxos } = await indexerProvider.getVtxos({
                    scripts: [hex.encode(vhtlcScript.pkScript)],
                });
                return vtxos.some((v) => v.txid === txid1 && !v.isSpent);
            });
        },
    );
});
