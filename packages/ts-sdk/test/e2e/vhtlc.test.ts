import { expect, describe, it, beforeEach } from "vitest";
import * as bip68 from "bip68";
import { base64, hex } from "@scure/base";
import { hash160 } from "@scure/btc-signer/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
    ArkError,
    ArkErrorName,
    buildOffchainTx,
    ConditionWitness,
    contractPreimage,
    CSVMultisigTapscript,
    EsploraProvider,
    Identity,
    isArkError,
    IWallet,
    networks,
    OnchainWallet,
    provisionClaimSecret,
    RestArkProvider,
    RestIndexerProvider,
    setArkPsbtField,
    SingleKey,
    Unroll,
    VHTLC,
    Transaction,
} from "../../src";
import {
    arkdExec,
    beforeEachFaucet,
    coreBlockCount,
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

    it(
        "should claim with a preimage re-derived from a static wallet's seed and salt",
        { timeout: 60000 },
        async () => {
            // The property the salted arm exists for, proved against a real
            // covenant: a static wallet stores NOTHING secret, and a restore
            // holding only the record's public fields still claims.
            //
            // Two things only chain execution can settle. The record commits to
            // `sha256(P)` while the covenant commits to `ripemd160(sha256(P))`,
            // so a derived P has to satisfy a hash form the record never names;
            // and the claim leaf pins OP_SIZE 32, which a 32-byte derivation
            // output meets only by construction.
            const alice = createTestIdentity();

            // A static wallet: one key, no descriptor surface, its identity is
            // its whole policy.
            const key = SingleKey.fromRandomBytes();
            const seedHex = key.toHex();
            const secret = await provisionClaimSecret({ identity: key } as unknown as IWallet);

            // Nothing secret is at rest, and the salt is what replaced it.
            expect(secret.mustPersistPreimage).toBe(false);
            expect(secret.preimageSalt).toHaveLength(32);

            // What a consumer persists — every field public.
            const record = {
                signingDescriptor: secret.descriptor,
                preimageSaltHex: hex.encode(secret.preimageSalt!),
                paymentHash: hex.encode(secret.paymentHash),
            };

            const vhtlcScript = new VHTLC.Script({
                // The corridor's hash form, not the record's.
                preimageHash: hash160(secret.preimage),
                sender: await alice.xOnlyPublicKey(),
                // The leg we claim: the provisioned key receives it.
                receiver: secret.pubkey,
                server: X_ONLY_PUBLIC_KEY,
                refundLocktime: BigInt(1000),
                unilateralClaimDelay: { type: "blocks", value: 100n },
                unilateralRefundDelay: { type: "blocks", value: 50n },
                unilateralRefundWithoutReceiverDelay: { type: "blocks", value: 50n },
            });

            const address = vhtlcScript.address(networks.regtest.hrp, X_ONLY_PUBLIC_KEY).encode();
            const fundAmount = 1000;
            execCommand(
                `${arkdExec} ark send --to ${address} --amount ${fundAmount} --password secret`,
            );
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // ── The restore. Everything but `record` and the seed is gone. ──
            const restored = SingleKey.fromHex(seedHex);
            const wallet = { identity: restored } as unknown as IWallet;
            const preimage = await contractPreimage(wallet, record.signingDescriptor, {
                salt: hex.decode(record.preimageSaltHex),
            });

            expect(hex.encode(preimage)).toBe(hex.encode(secret.preimage));
            expect(hex.encode(sha256(preimage))).toBe(record.paymentHash);
            // The seam: the derived P satisfies the hash the covenant pins.
            expect(hex.encode(hash160(preimage))).toBe(
                hex.encode(vhtlcScript.options.preimageHash),
            );

            const claimIdentity: Identity = {
                sign: async (tx: Transaction, inputIndexes?: number[]) => {
                    const cpy = tx.clone();
                    setArkPsbtField(cpy, 0, ConditionWitness, [preimage]);
                    return restored.sign(cpy, inputIndexes);
                },
                compressedPublicKey: () => restored.compressedPublicKey(),
                xOnlyPublicKey: () => restored.xOnlyPublicKey(),
                signerSession: () => restored.signerSession(),
                signMessage: (message, signatureType) =>
                    restored.signMessage(message, signatureType),
            };

            const arkProvider = new RestArkProvider("http://localhost:7070");
            const indexerProvider = new RestIndexerProvider("http://localhost:7070");

            const spendable = await indexerProvider.getVtxos({
                scripts: [hex.encode(vhtlcScript.pkScript)],
                spendableOnly: true,
            });
            expect(spendable.vtxos).toHaveLength(1);

            const info = await arkProvider.getInfo();
            const checkpointUnrollClosure = CSVMultisigTapscript.decode(
                hex.decode(info.checkpointTapscript),
            );

            const { arkTx, checkpoints } = buildOffchainTx(
                [
                    {
                        ...spendable.vtxos[0],
                        tapLeafScript: vhtlcScript.claim(),
                        tapTree: vhtlcScript.encode(),
                    },
                ],
                [{ script: vhtlcScript.pkScript, amount: BigInt(fundAmount) }],
                checkpointUnrollClosure,
            );

            const signedArkTx = await claimIdentity.sign(arkTx);
            const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
                base64.encode(signedArkTx.toPSBT()),
                checkpoints.map((c) => base64.encode(c.toPSBT())),
            );
            expect(arkTxid).toBeDefined();

            const finalCheckpoints = await Promise.all(
                signedCheckpointTxs.map(async (c) => {
                    const signed = await claimIdentity.sign(
                        Transaction.fromPSBT(base64.decode(c)),
                        [0],
                    );
                    return base64.encode(signed.toPSBT());
                }),
            );
            // The server accepting this is the assertion: a covenant funded
            // before the restore, unlocked by a preimage that existed nowhere
            // in between.
            await arkProvider.finalizeTx(arkTxid, finalCheckpoints);
        },
    );

    it(
        "should give two swaps on one static wallet unrelated covenants",
        { timeout: 60000 },
        async () => {
            // The collision this design exists to avoid, at the address level:
            // one key, two swaps, and nothing they share is claimable twice.
            const alice = await createTestIdentity().xOnlyPublicKey();
            const key = SingleKey.fromRandomBytes();
            const wallet = { identity: key } as unknown as IWallet;

            const scriptFor = async () => {
                const secret = await provisionClaimSecret(wallet);
                return {
                    secret,
                    address: new VHTLC.Script({
                        preimageHash: hash160(secret.preimage),
                        sender: alice,
                        receiver: secret.pubkey,
                        server: X_ONLY_PUBLIC_KEY,
                        refundLocktime: BigInt(1000),
                        unilateralClaimDelay: { type: "blocks", value: 100n },
                        unilateralRefundDelay: { type: "blocks", value: 50n },
                        unilateralRefundWithoutReceiverDelay: { type: "blocks", value: 50n },
                    })
                        .address(networks.regtest.hrp, X_ONLY_PUBLIC_KEY)
                        .encode(),
                };
            };

            const first = await scriptFor();
            const second = await scriptFor();

            // Same wallet key on both covenants — that is the static policy.
            expect(hex.encode(second.secret.pubkey)).toBe(hex.encode(first.secret.pubkey));
            expect(second.secret.descriptor).toBe(first.secret.descriptor);
            // Everything derived from the salt differs, so one counterparty
            // learning its own preimage learns nothing about the other.
            expect(second.address).not.toBe(first.address);
            expect(hex.encode(second.secret.preimage)).not.toBe(hex.encode(first.secret.preimage));
        },
    );

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
            // The baseline comes from Bitcoin Core, not from an indexer. arkd matures
            // the CLTV against its nbxplorer-derived tip, and every indexer in the
            // stack trails Core by an unbounded amount: the preceding test mines 10
            // blocks and returns, so an EsploraProvider tip read here can still be
            // those 10 blocks stale — a locktime built on it is then *already* matured
            // against arkd, and the premature-rejection assertion below fails. Core's
            // count is an upper bound on every indexer, so `+5` is immature everywhere.
            //
            // The buffer stays small because the whole maturation must fit inside the
            // funding VTXO's batch lifetime — ARKD_VTXO_TREE_EXPIRY=20 blocks — an
            // expired batch makes the input recoverable-only, and the retry then fails
            // VTXO_RECOVERABLE instead of exercising the regression. With
            // AUTOMINE_INTERVAL=0 (see .env.regtest) nothing advances the tip between
            // this read and the first submitTx below.
            const refundLocktime = BigInt(coreBlockCount() + 5);

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
