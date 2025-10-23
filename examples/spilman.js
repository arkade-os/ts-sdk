// This example shows how to create a virtual Spilman Channel
//
// The Spilman Taproot Script is a contract that allows two parties to create a unidirectional payment channel.

// Alice updates the channel state by signing virtual transactions without submitting them to the Arkade Server.
// Bob can close the channel at any time by signing the last virtual tx and submitting it to the Arkade Server.
//
// Usage:
// node examples/spilman.js
//
import {
    SingleKey,
    Wallet,
    RestArkProvider,
    RestIndexerProvider,
    buildOffchainTx,
    VtxoScript,
    MultisigTapscript,
    CLTVMultisigTapscript,
    CSVMultisigTapscript,
    networks,
} from "../dist/esm/index.js";
import { base64, hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { execSync } from "child_process";

const SERVER_PUBLIC_KEY = hex.decode(
    "e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdb"
);

const arkdExec = process.argv[2] || "docker exec -t arkd";

const alice = SingleKey.fromRandomBytes();
const bob = SingleKey.fromRandomBytes();

console.log("Creating Spilman Channel between Alice and Bob");
console.log("Alice's public key:", hex.encode(await alice.xOnlyPublicKey()));
console.log("Bob's public key:", hex.encode(await bob.xOnlyPublicKey()));

async function main() {
    console.log("\nInitializing Bob's wallet...");
    const bobWallet = await Wallet.create({
        identity: bob,
        esploraUrl: "http://localhost:3000",
        arkServerUrl: "http://localhost:7070",
    });

    const aliceWallet = await Wallet.create({
        identity: alice,
        esploraUrl: "http://localhost:3000",
        arkServerUrl: "http://localhost:7070",
    });

    console.log("Fetching current chain tip...");
    const chainTip = await fetch(
        "http://localhost:3000/blocks/tip/height"
    ).then((res) => res.json());
    console.log("Chain tip:", chainTip);

    // offchain paths:
    //   update: (Alice + Bob + Ark Server)
    //   refund: (Alice + Ark Server at chainTip + 10 blocks)
    //
    // onchain paths:
    //   unilateralUpdate: (Alice + Bob after 1 block)
    //   unilateralRefund: (Alice + Bob after 2 blocks)
    //
    //   unilateralUpdate's timelock should be smaller than unilateralRefund's timelock.
    //   this ensures that a unilateralUpdate is always possible before a unilateralRefund.
    //
    const updateScript = MultisigTapscript.encode({
        pubkeys: [
            await alice.xOnlyPublicKey(),
            await bob.xOnlyPublicKey(),
            SERVER_PUBLIC_KEY,
        ],
    }).script;

    const refundScript = CLTVMultisigTapscript.encode({
        pubkeys: [await alice.xOnlyPublicKey(), SERVER_PUBLIC_KEY],
        absoluteTimelock: BigInt(chainTip + 10),
    }).script;

    const unilateralUpdateScript = CSVMultisigTapscript.encode({
        pubkeys: [await alice.xOnlyPublicKey(), await bob.xOnlyPublicKey()],
        timelock: { type: "blocks", value: 100n },
    }).script;

    const unilateralRefundScript = CSVMultisigTapscript.encode({
        pubkeys: [await alice.xOnlyPublicKey()],
        timelock: { type: "blocks", value: 102n },
    }).script;

    const virtualSpilmanChannel = new VtxoScript([
        updateScript,
        refundScript,
        unilateralUpdateScript,
        unilateralRefundScript,
    ]);

    const address = virtualSpilmanChannel
        .address(networks.regtest.hrp, SERVER_PUBLIC_KEY)
        .encode();
    console.log("\nSpilman Channel Address:", address);

    // Use faucet to fund the Spilman Channel address
    // in a real scenario, it should be funded by Alice herself
    const channelCapacity = 10_000;
    await fundAddress(address, channelCapacity);

    // Get the virtual coins for the Spilman Channel address
    console.log("Fetching virtual coins...");
    const arkProvider = new RestArkProvider("http://localhost:7070");
    const indexerProvider = new RestIndexerProvider("http://localhost:7070");
    const spendableVtxos = await indexerProvider.getVtxos({
        scripts: [hex.encode(virtualSpilmanChannel.pkScript)],
        spendableOnly: true,
    });

    if (spendableVtxos.vtxos.length === 0) {
        throw new Error("No spendable virtual coins found");
    }

    const vtxo = spendableVtxos.vtxos[0];
    const input = {
        ...vtxo,
        tapLeafScript: virtualSpilmanChannel.findLeaf(
            hex.encode(updateScript)
        ),
        tapTree: virtualSpilmanChannel.encode(),
    };

    console.log("Alice's balance:", vtxo.value, "sats");
    console.log("Bob's balance:", "0 sats");

    // Bob's receiving address
    const bobAddress = await bobWallet.getAddress();
    console.log("\nBob's receiving address:", bobAddress);

    // Alice's receiving address
    const aliceAddress = await aliceWallet.getAddress();
    console.log("\nAlice's receiving address:", aliceAddress);

    // Bob has to keep track of the channel states
    // it means he has to store the list of virtual txs signed by Alice
    const bobChannelStates = [];

    const infos = await arkProvider.getInfo();

    const serverUnrollScript = CSVMultisigTapscript.decode(
        hex.decode(infos.checkpointTapscript)
    );

    console.log("\nStarting channel updates...");
    // Alice sends 1000 to bob
    console.log("Alice sends 1000 sats to Bob");
    const { arkTx: tx1, checkpoints } = buildOffchainTx(
        [input],
        [
            {
                amount: BigInt(1000),
                script: virtualSpilmanChannel.pkScript,
            },
            {
                amount: BigInt(channelCapacity - 1000),
                script: virtualSpilmanChannel.pkScript,
            },
        ],
        serverUnrollScript
    );
    const signedTx1 = await alice.sign(tx1);
    const signedCheckpointsByAlice = await Promise.all(
        checkpoints.map(async (c) => {
            return alice.sign(c, [0]);
        })
    );
    console.log("Alice signed transaction 1");
    bobChannelStates.push(await bob.sign(signedTx1));
    console.log("Bob signed transaction 1");

    // Alice updates the state, sending 500 sats more to Bob
    console.log("\nAlice sends 500 more sats to Bob");
    const { arkTx: tx2 } = buildOffchainTx(
        [input],
        [
            {
                amount: BigInt(1500),
                script: virtualSpilmanChannel.pkScript,
            },
            {
                amount: BigInt(channelCapacity - 1500),
                script: virtualSpilmanChannel.pkScript,
            },
        ],
        serverUnrollScript
    );
    const signedTx2 = await alice.sign(tx2);
    console.log("Alice signed transaction 2");
    bobChannelStates.push(await bob.sign(signedTx2));
    console.log("Bob signed transaction 2");

    const action = Math.random() > 0.5 ? "close" : "refund";

    if (action === "close") {
        // to close the channel, Alice or Bob can submit the last virtual tx to the server
        console.log("\nClosing channel...");
        const lastState = bobChannelStates[bobChannelStates.length - 1];
        const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
            base64.encode(lastState.toPSBT()),
            checkpoints.map((c) => base64.encode(c.toPSBT()))
        );

        console.log(
            "Successfully submitted channel close! Transaction ID:",
            arkTxid
        );

        const finalCheckpoints = await Promise.all(
            signedCheckpointTxs.map(async (c) => {
                const tx = Transaction.fromPSBT(base64.decode(c), {
                    allowUnknown: true,
                });
                const signedCheckpoint = await bob.sign(tx, [0]);
                // add alice's signature
                const aliceCheckpoint =
                    signedCheckpointsByAlice[signedCheckpointTxs.indexOf(c)];
                signedCheckpoint.updateInput(0, {
                    tapScriptSig: [
                        ...aliceCheckpoint.getInput(0).tapScriptSig,
                        ...signedCheckpoint.getInput(0).tapScriptSig,
                    ],
                });
                return base64.encode(signedCheckpoint.toPSBT());
            })
        );

        await arkProvider.finalizeTx(arkTxid, finalCheckpoints);
        console.log("Successfully finalized channel close!");

        console.log("\nFinal Balances:");
        console.log("Alice's final balance:", channelCapacity - 1500, "sats");
        console.log("Bob's final balance:", 1500, "sats");

        console.log("\nChannel Summary:");
        console.log("Initial capacity:", channelCapacity, "sats");
        console.log("Final amount sent to Bob:", 1500, "sats");
        console.log("Number of state updates:", bobChannelStates.length);
    } else {
        execSync(`nigiri rpc --generate 200`);

        console.log("\nRefunding channel...");
        // after 10 blocks, Alice can spend without Bob's signature
        const { arkTx, checkpoints } = buildOffchainTx(
            [
                {
                    ...input,
                    tapLeafScript: virtualSpillmanChannel.findLeaf(
                        hex.encode(refundScript)
                    ),
                },
            ],
            [
                {
                    amount: BigInt(channelCapacity),
                    script: virtualSpilmanChannel.pkScript,
                },
            ],
            serverUnrollScript
        );
        const signedTx = await alice.sign(arkTx);
        console.log("Alice signed the refund transaction");

        const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
            base64.encode(signedTx.toPSBT()),
            checkpoints.map((c) => base64.encode(c.toPSBT()))
        );

        console.log(
            "Successfully submitted channel refund! Transaction ID:",
            arkTxid
        );

        const finalCheckpoints = await Promise.all(
            signedCheckpointTxs.map(async (c) => {
                const tx = Transaction.fromPSBT(base64.decode(c), {
                    allowUnknown: true,
                });
                const signedCheckpoint = await alice.sign(tx, [0]);
                return base64.encode(signedCheckpoint.toPSBT());
            })
        );

        await arkProvider.finalizeTx(arkTxid, finalCheckpoints);
        console.log("Successfully finalized channel refund!");

        console.log("\nFinal Balances:");
        console.log("Alice's final balance:", channelCapacity, "sats");
        console.log("Bob's final balance:", 0, "sats");
    }
}

async function fundAddress(address, amount) {
    console.log(`\nFunding address with ${amount} sats...`);
    execSync(
        `${arkdExec} ark send --to ${address} --amount ${amount} --password secret`
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
}

main().catch(console.error);
