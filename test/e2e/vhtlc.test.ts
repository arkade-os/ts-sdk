import { expect, describe, it, beforeEach } from "vitest";
import * as bip68 from "bip68";
import { base64, hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import {
    buildOffchainTx,
    ConditionWitness,
    CSVMultisigTapscript,
    Identity,
    networks,
    OnchainWallet,
    RestArkProvider,
    RestIndexerProvider,
    setArkPsbtField,
    Unroll,
    VHTLC,
} from "../../src";
import {
    arkdExec,
    beforeEachFaucet,
    createTestArkWallet,
    createTestIdentity,
    faucetOffchain,
    X_ONLY_PUBLIC_KEY,
} from "./utils";
import { hash160 } from "@scure/btc-signer/utils";
import { execSync } from "child_process";

describe("vhtlc", () => {
    beforeEach(beforeEachFaucet);

    it("should claim", { timeout: 60000 }, async () => {
        const alice = createTestIdentity();
        const bob = createTestIdentity();

        const preimage = new TextEncoder().encode("preimage");
        const preimageHash = hash160(preimage);

        const vhtlcScript = new VHTLC.Script({
            preimageHash,
            sender: alice.xOnlyPublicKey(),
            receiver: bob.xOnlyPublicKey(),
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

        const address = vhtlcScript
            .address(networks.regtest.hrp, X_ONLY_PUBLIC_KEY)
            .encode();

        // fund the vhtlc address
        const fundAmount = 1000;
        execSync(
            `${arkdExec} ark send --to ${address} --amount ${fundAmount} --password secret`
        );

        // bob special identity to sign with the preimage
        const bobVHTLCIdentity: Identity = {
            sign: async (tx: Transaction, inputIndexes?: number[]) => {
                const cpy = tx.clone();
                setArkPsbtField(cpy, 0, ConditionWitness, [preimage]);
                return bob.sign(cpy, inputIndexes);
            },
            xOnlyPublicKey: bob.xOnlyPublicKey,
            signerSession: bob.signerSession,
        };

        const arkProvider = new RestArkProvider("http://localhost:7070");
        const indexerProvider = new RestIndexerProvider(
            "http://localhost:7070"
        );

        const spendableVtxosResponse = await indexerProvider.getVtxos({
            scripts: [hex.encode(vhtlcScript.pkScript)],
            spendableOnly: true,
        });
        expect(spendableVtxosResponse.vtxos).toHaveLength(1);

        const infos = await arkProvider.getInfo();
        const serverUnrollScript = CSVMultisigTapscript.encode({
            timelock: {
                type: infos.unilateralExitDelay < 512 ? "blocks" : "seconds",
                value: infos.unilateralExitDelay,
            },
            pubkeys: [X_ONLY_PUBLIC_KEY],
        });

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
            serverUnrollScript
        );

        const signedArkTx = await bobVHTLCIdentity.sign(arkTx);
        const { arkTxid, finalArkTx, signedCheckpointTxs } =
            await arkProvider.submitTx(
                base64.encode(signedArkTx.toPSBT()),
                checkpoints.map((c) => base64.encode(c.toPSBT()))
            );

        expect(arkTxid).toBeDefined();
        expect(finalArkTx).toBeDefined();
        expect(signedCheckpointTxs).toBeDefined();
        expect(signedCheckpointTxs.length).toBe(checkpoints.length);

        const finalCheckpoints = await Promise.all(
            signedCheckpointTxs.map(async (c) => {
                const tx = Transaction.fromPSBT(base64.decode(c), {
                    allowUnknown: true,
                });
                const signedCheckpoint = await bobVHTLCIdentity.sign(tx, [0]);
                return base64.encode(signedCheckpoint.toPSBT());
            })
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
            sender: alice.identity.xOnlyPublicKey(),
            receiver: bob.xOnlyPublicKey(),
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

        const address = vhtlcScript
            .address(networks.regtest.hrp, X_ONLY_PUBLIC_KEY)
            .encode();

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

        const indexerProvider = new RestIndexerProvider(
            "http://localhost:7070"
        );

        await new Promise((resolve) => setTimeout(resolve, 1000));

        const spendableVtxosResponse = await indexerProvider.getVtxos({
            scripts: [hex.encode(vhtlcScript.pkScript)],
            spendableOnly: true,
        });
        expect(spendableVtxosResponse.vtxos).toHaveLength(1);

        const vtxo = spendableVtxosResponse.vtxos[0];
        const onchainBob = new OnchainWallet(bob, "regtest");

        execSync(`nigiri faucet ${onchainBob.address} 0.001`);

        await new Promise((resolve) => setTimeout(resolve, 5000));

        const session = await Unroll.Session.create(
            vtxo,
            onchainBob,
            onchainBob.provider,
            indexerProvider
        );

        for await (const done of session) {
            switch (done.type) {
                case Unroll.StepType.WAIT:
                case Unroll.StepType.UNROLL:
                    execSync(
                        `nigiri rpc generatetoaddress 1 $(nigiri rpc getnewaddress)`
                    );
                    await new Promise((resolve) => setTimeout(resolve, 2000)); // give time for the checkpoint to be created
                    execSync(
                        `nigiri rpc generatetoaddress 1 $(nigiri rpc getnewaddress)`
                    );
                    break;
            }
        }

        const tx = new Transaction({ allowUnknownInputs: true });
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
        tx.addOutputAddress(
            onchainBob.address,
            BigInt(vtxo.value) - 1000n,
            onchainBob.network
        );
        const signedTx = await bob.sign(tx);
        signedTx.finalize();

        const currentWitness = signedTx.getInput(0).finalScriptWitness;
        signedTx.updateInput(0, {
            finalScriptWitness: [
                currentWitness![0],
                preimage,
                ...currentWitness!.slice(1),
            ],
        });

        // should fail now cause the utxo is locked by CSV
        await expect(
            onchainBob.provider.broadcastTransaction(signedTx.hex)
        ).rejects.toThrow();

        // generate 10 blocks to make the exit path available
        execSync(`nigiri rpc generatetoaddress 10 $(nigiri rpc getnewaddress)`);

        const txid = await onchainBob.provider.broadcastTransaction(
            signedTx.hex
        );
        expect(txid).toBeDefined();
    });
});
