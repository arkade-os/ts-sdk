// HTLC Cross-Asset Swap Example
//
// This example demonstrates an atomic swap of two different assets using VHTLCs.
// It follows the same pattern as Lightning Network HTLCs, but operates on Ark VTXOs
// that carry different assets (identified via OP_RETURN asset packets).
//
// Scenario:
//   Alice holds USD tokens and wants CHF tokens.
//   Bob holds CHF tokens and wants USD tokens.
//   They agree on an exchange rate and perform an atomic swap.
//
// Flow:
//   1. Alice generates a secret and computes its hash
//   2. Alice issues USD and Bob issues CHF assets on their wallets
//   3. Alice locks USD on HTLC-1 (Bob can claim with preimage, Alice can refund after timeout)
//   4. Bob sees HTLC-1 on-chain, locks CHF on HTLC-2 using the same hash
//      (Alice can claim with preimage, Bob can refund after timeout)
//   5. Alice claims CHF from HTLC-2 by revealing the preimage
//   6. The preimage is now public — Bob extracts it from Alice's claim witness
//      and uses it to claim USD from HTLC-1
//
// The atomicity guarantee: either both swaps complete, or neither does.
// If Alice doesn't claim, both HTLCs expire and funds return to their owners.
//
// Usage:
//   node examples/htlc-asset-swap.js [arkdExec]
//
import {
    SingleKey,
    Wallet,
    VHTLC,
    setArkPsbtField,
    ConditionWitness,
    RestArkProvider,
    RestIndexerProvider,
    buildOffchainTx,
    networks,
    CSVMultisigTapscript,
} from "../dist/esm/index.js";
import { asset } from "../dist/esm/index.js";
import { hash160, randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import { base64, hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { execSync } from "child_process";

const { AssetGroup, AssetId, AssetInput, AssetOutput, Packet } = asset;

const SERVER_PUBLIC_KEY = hex.decode(
    "e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdb"
);

const arkdExec = process.argv[2] || "docker exec -t arkd";
const ARK_SERVER_URL = "http://localhost:7070";
const ESPLORA_URL = "http://localhost:3000";

// ----- Keys -----
const alice = SingleKey.fromHex(hex.encode(randomPrivateKeyBytes()));
const bob = SingleKey.fromHex(hex.encode(randomPrivateKeyBytes()));

// ----- The secret that locks both HTLCs -----
const secret = crypto.getRandomValues(new Uint8Array(32));
const preimageHash = hash160(secret);

// ----- Swap parameters -----
const USD_AMOUNT = 100n; // Alice sends 100 USD to Bob
const CHF_AMOUNT = 90n; // Bob sends 90 CHF to Alice (agreed exchange rate)
const VTXO_SATS = 1000; // sats backing each VTXO

async function main() {
    console.log("=== HTLC Cross-Asset Swap ===\n");
    console.log(
        "Alice pubkey:",
        hex.encode(await alice.xOnlyPublicKey())
    );
    console.log(
        "Bob pubkey:  ",
        hex.encode(await bob.xOnlyPublicKey())
    );
    console.log("Preimage hash:", hex.encode(preimageHash));

    const arkProvider = new RestArkProvider(ARK_SERVER_URL);
    const indexerProvider = new RestIndexerProvider(ARK_SERVER_URL);
    const infos = await arkProvider.getInfo();
    const serverUnrollScript = CSVMultisigTapscript.decode(
        hex.decode(infos.checkpointTapscript)
    );

    const chainTip = await fetch(`${ESPLORA_URL}/blocks/tip/height`).then(
        (res) => res.json()
    );
    console.log("Chain tip:", chainTip);

    // ====================================================================
    // Step 1: Issue assets
    // ====================================================================
    console.log("\n--- Step 1: Issue assets ---");

    // Create wallets for Alice and Bob to issue assets
    const aliceWallet = await Wallet.create({
        identity: alice,
        esploraUrl: ESPLORA_URL,
        arkServerUrl: ARK_SERVER_URL,
    });

    const bobWallet = await Wallet.create({
        identity: bob,
        esploraUrl: ESPLORA_URL,
        arkServerUrl: ARK_SERVER_URL,
    });

    // Fund Alice and Bob wallets
    const aliceAddr = await aliceWallet.getAddress();
    const bobAddr = await bobWallet.getAddress();
    console.log("Alice address:", aliceAddr);
    console.log("Bob address:", bobAddr);

    await fundAddress(aliceAddr, VTXO_SATS);
    await fundAddress(bobAddr, VTXO_SATS);

    // Alice issues USD
    const usdResult = await aliceWallet.assetManager.issue({
        amount: Number(USD_AMOUNT),
        metadata: { ticker: "USD", name: "US Dollar stablecoin" },
    });
    console.log("Alice issued USD — asset ID:", usdResult.assetId);

    // Bob issues CHF
    const chfResult = await bobWallet.assetManager.issue({
        amount: Number(CHF_AMOUNT),
        metadata: { ticker: "CHF", name: "Swiss Franc stablecoin" },
    });
    console.log("Bob issued CHF — asset ID:", chfResult.assetId);

    // ====================================================================
    // Step 2: Alice creates HTLC-1 (locks USD for Bob)
    // ====================================================================
    console.log("\n--- Step 2: Alice locks USD on HTLC-1 ---");

    // HTLC-1: Bob can claim USD with preimage, Alice can refund after timeout
    const htlc1 = new VHTLC.Script({
        preimageHash,
        sender: await alice.xOnlyPublicKey(),
        receiver: await bob.xOnlyPublicKey(),
        server: SERVER_PUBLIC_KEY,
        refundLocktime: BigInt(chainTip + 20), // Alice can refund after 20 blocks
        unilateralClaimDelay: { type: "blocks", value: 100n },
        unilateralRefundDelay: { type: "blocks", value: 102n },
        unilateralRefundWithoutReceiverDelay: { type: "blocks", value: 103n },
    });

    const htlc1Address = htlc1
        .address(networks.regtest.hrp, SERVER_PUBLIC_KEY)
        .encode();
    console.log("HTLC-1 address (USD):", htlc1Address);

    // Alice sends her USD VTXO to the HTLC-1 address
    // First, get Alice's vtxos that hold USD
    const aliceVtxos = await indexerProvider.getVtxos({
        scripts: [hex.encode(aliceWallet.defaultVtxoScript.pkScript)],
        spendableOnly: true,
    });

    if (aliceVtxos.vtxos.length === 0) {
        throw new Error("Alice has no VTXOs after issuance");
    }

    const aliceUsdVtxo = aliceVtxos.vtxos[0];
    console.log("Alice's VTXO:", aliceUsdVtxo.txid, "value:", aliceUsdVtxo.value);

    // Build tx: Alice sends USD to HTLC-1
    // Input: Alice's USD VTXO
    // Output 0: HTLC-1 script (holds USD for Bob)
    // Output 1: OP_RETURN asset packet (maps USD asset from input to output 0)
    const aliceTapLeafScript = aliceWallet.defaultVtxoScript.forfeit();
    const aliceTapTree = aliceWallet.defaultVtxoScript.encode();

    // Build the asset packet for HTLC-1 funding
    // The input is Alice's VTXO (vin=0), it holds USD_AMOUNT of USD
    // The output is HTLC-1 (vout=0), it receives USD_AMOUNT of USD
    const htlc1AssetPacket = Packet.create([
        AssetGroup.create(
            AssetId.fromString(usdResult.assetId),
            null,
            [AssetInput.create(0, USD_AMOUNT)],
            [AssetOutput.create(0, USD_AMOUNT)],
            []
        ),
    ]);

    const htlc1FundingTx = buildOffchainTx(
        [
            {
                ...aliceUsdVtxo,
                tapLeafScript: aliceTapLeafScript,
                tapTree: aliceTapTree,
            },
        ],
        [
            {
                amount: BigInt(aliceUsdVtxo.value),
                script: htlc1.pkScript,
            },
            htlc1AssetPacket.txOut(),
        ],
        serverUnrollScript
    );

    const signedHtlc1Funding = await alice.sign(htlc1FundingTx.arkTx);
    const { arkTxid: htlc1Txid, signedCheckpointTxs: htlc1Checkpoints } =
        await arkProvider.submitTx(
            base64.encode(signedHtlc1Funding.toPSBT()),
            htlc1FundingTx.checkpoints.map((c) => base64.encode(c.toPSBT()))
        );

    const htlc1FinalCheckpoints = await Promise.all(
        htlc1Checkpoints.map(async (c) => {
            const tx = Transaction.fromPSBT(base64.decode(c), {
                allowUnknown: true,
            });
            const signed = await alice.sign(tx, [0]);
            return base64.encode(signed.toPSBT());
        })
    );
    await arkProvider.finalizeTx(htlc1Txid, htlc1FinalCheckpoints);
    console.log("HTLC-1 funded! Tx:", htlc1Txid);
    console.log("  Locked:", Number(USD_AMOUNT), "USD for Bob");

    // ====================================================================
    // Step 3: Bob sees HTLC-1, creates HTLC-2 (locks CHF for Alice)
    // ====================================================================
    console.log("\n--- Step 3: Bob locks CHF on HTLC-2 ---");

    // HTLC-2: Alice can claim CHF with preimage, Bob can refund after timeout
    // Bob's timeout must be SHORTER than Alice's — this ensures Alice must claim
    // before Bob can refund, giving Bob time to use the revealed preimage on HTLC-1
    const htlc2 = new VHTLC.Script({
        preimageHash, // same hash as HTLC-1!
        sender: await bob.xOnlyPublicKey(),
        receiver: await alice.xOnlyPublicKey(),
        server: SERVER_PUBLIC_KEY,
        refundLocktime: BigInt(chainTip + 10), // Bob can refund after 10 blocks (shorter than Alice's 20)
        unilateralClaimDelay: { type: "blocks", value: 100n },
        unilateralRefundDelay: { type: "blocks", value: 102n },
        unilateralRefundWithoutReceiverDelay: { type: "blocks", value: 103n },
    });

    const htlc2Address = htlc2
        .address(networks.regtest.hrp, SERVER_PUBLIC_KEY)
        .encode();
    console.log("HTLC-2 address (CHF):", htlc2Address);

    // Get Bob's CHF vtxos
    const bobVtxos = await indexerProvider.getVtxos({
        scripts: [hex.encode(bobWallet.defaultVtxoScript.pkScript)],
        spendableOnly: true,
    });

    if (bobVtxos.vtxos.length === 0) {
        throw new Error("Bob has no VTXOs after issuance");
    }

    const bobChfVtxo = bobVtxos.vtxos[0];
    console.log("Bob's VTXO:", bobChfVtxo.txid, "value:", bobChfVtxo.value);

    // Build tx: Bob sends CHF to HTLC-2
    const bobTapLeafScript = bobWallet.defaultVtxoScript.forfeit();
    const bobTapTree = bobWallet.defaultVtxoScript.encode();

    const htlc2AssetPacket = Packet.create([
        AssetGroup.create(
            AssetId.fromString(chfResult.assetId),
            null,
            [AssetInput.create(0, CHF_AMOUNT)],
            [AssetOutput.create(0, CHF_AMOUNT)],
            []
        ),
    ]);

    const htlc2FundingTx = buildOffchainTx(
        [
            {
                ...bobChfVtxo,
                tapLeafScript: bobTapLeafScript,
                tapTree: bobTapTree,
            },
        ],
        [
            {
                amount: BigInt(bobChfVtxo.value),
                script: htlc2.pkScript,
            },
            htlc2AssetPacket.txOut(),
        ],
        serverUnrollScript
    );

    const signedHtlc2Funding = await bob.sign(htlc2FundingTx.arkTx);
    const { arkTxid: htlc2Txid, signedCheckpointTxs: htlc2Checkpoints } =
        await arkProvider.submitTx(
            base64.encode(signedHtlc2Funding.toPSBT()),
            htlc2FundingTx.checkpoints.map((c) => base64.encode(c.toPSBT()))
        );

    const htlc2FinalCheckpoints = await Promise.all(
        htlc2Checkpoints.map(async (c) => {
            const tx = Transaction.fromPSBT(base64.decode(c), {
                allowUnknown: true,
            });
            const signed = await bob.sign(tx, [0]);
            return base64.encode(signed.toPSBT());
        })
    );
    await arkProvider.finalizeTx(htlc2Txid, htlc2FinalCheckpoints);
    console.log("HTLC-2 funded! Tx:", htlc2Txid);
    console.log("  Locked:", Number(CHF_AMOUNT), "CHF for Alice");

    // ====================================================================
    // Step 4: Alice claims CHF from HTLC-2 (reveals preimage)
    // ====================================================================
    console.log("\n--- Step 4: Alice claims CHF from HTLC-2 (reveals preimage) ---");

    // Get the HTLC-2 VTXO
    const htlc2Vtxos = await indexerProvider.getVtxos({
        scripts: [hex.encode(htlc2.pkScript)],
        spendableOnly: true,
    });

    if (htlc2Vtxos.vtxos.length === 0) {
        throw new Error("No HTLC-2 VTXOs found");
    }

    const htlc2Vtxo = htlc2Vtxos.vtxos[0];

    // Alice claims using the claim path (preimage + Alice's signature + server)
    // She reveals the secret in the witness
    const aliceClaimIdentity = {
        sign: async (tx, inputIndexes) => {
            const cpy = tx.clone();
            setArkPsbtField(cpy, 0, ConditionWitness, [secret]);
            return alice.sign(cpy, inputIndexes);
        },
        xOnlyPublicKey: alice.xOnlyPublicKey,
        signerSession: alice.signerSession,
    };

    // Alice's receiving address for the claimed CHF
    const aliceReceiveAddr = await aliceWallet.getAddress();

    // Build the claim asset packet: CHF moves from HTLC-2 input to Alice's output
    const claimChfPacket = Packet.create([
        AssetGroup.create(
            AssetId.fromString(chfResult.assetId),
            null,
            [AssetInput.create(0, CHF_AMOUNT)],
            [AssetOutput.create(0, CHF_AMOUNT)],
            []
        ),
    ]);

    const aliceClaimTx = buildOffchainTx(
        [
            {
                ...htlc2Vtxo,
                tapLeafScript: htlc2.claim(),
                tapTree: htlc2.encode(),
            },
        ],
        [
            {
                amount: BigInt(htlc2Vtxo.value),
                script: aliceWallet.defaultVtxoScript.pkScript,
            },
            claimChfPacket.txOut(),
        ],
        serverUnrollScript
    );

    const signedAliceClaim = await aliceClaimIdentity.sign(aliceClaimTx.arkTx);
    const {
        arkTxid: aliceClaimTxid,
        signedCheckpointTxs: aliceClaimCheckpoints,
    } = await arkProvider.submitTx(
        base64.encode(signedAliceClaim.toPSBT()),
        aliceClaimTx.checkpoints.map((c) => base64.encode(c.toPSBT()))
    );

    const aliceClaimFinalCheckpoints = await Promise.all(
        aliceClaimCheckpoints.map(async (c) => {
            const tx = Transaction.fromPSBT(base64.decode(c), {
                allowUnknown: true,
            });
            const signed = await aliceClaimIdentity.sign(tx, [0]);
            return base64.encode(signed.toPSBT());
        })
    );
    await arkProvider.finalizeTx(aliceClaimTxid, aliceClaimFinalCheckpoints);
    console.log("Alice claimed CHF! Tx:", aliceClaimTxid);
    console.log("  Alice revealed preimage:", hex.encode(secret));

    // ====================================================================
    // Step 5: Bob extracts preimage and claims USD from HTLC-1
    // ====================================================================
    console.log("\n--- Step 5: Bob claims USD from HTLC-1 (using revealed preimage) ---");

    // In a real scenario, Bob would watch for Alice's claim transaction
    // and extract the preimage from the witness data.
    // Here we simulate that Bob now knows the secret.
    console.log("Bob extracted preimage from Alice's claim:", hex.encode(secret));

    // Get the HTLC-1 VTXO
    const htlc1Vtxos = await indexerProvider.getVtxos({
        scripts: [hex.encode(htlc1.pkScript)],
        spendableOnly: true,
    });

    if (htlc1Vtxos.vtxos.length === 0) {
        throw new Error("No HTLC-1 VTXOs found");
    }

    const htlc1Vtxo = htlc1Vtxos.vtxos[0];

    // Bob claims using the preimage he extracted from Alice's claim
    const bobClaimIdentity = {
        sign: async (tx, inputIndexes) => {
            const cpy = tx.clone();
            setArkPsbtField(cpy, 0, ConditionWitness, [secret]);
            return bob.sign(cpy, inputIndexes);
        },
        xOnlyPublicKey: bob.xOnlyPublicKey,
        signerSession: bob.signerSession,
    };

    // Build the claim asset packet: USD moves from HTLC-1 input to Bob's output
    const claimUsdPacket = Packet.create([
        AssetGroup.create(
            AssetId.fromString(usdResult.assetId),
            null,
            [AssetInput.create(0, USD_AMOUNT)],
            [AssetOutput.create(0, USD_AMOUNT)],
            []
        ),
    ]);

    const bobClaimTx = buildOffchainTx(
        [
            {
                ...htlc1Vtxo,
                tapLeafScript: htlc1.claim(),
                tapTree: htlc1.encode(),
            },
        ],
        [
            {
                amount: BigInt(htlc1Vtxo.value),
                script: bobWallet.defaultVtxoScript.pkScript,
            },
            claimUsdPacket.txOut(),
        ],
        serverUnrollScript
    );

    const signedBobClaim = await bobClaimIdentity.sign(bobClaimTx.arkTx);
    const { arkTxid: bobClaimTxid, signedCheckpointTxs: bobClaimCheckpoints } =
        await arkProvider.submitTx(
            base64.encode(signedBobClaim.toPSBT()),
            bobClaimTx.checkpoints.map((c) => base64.encode(c.toPSBT()))
        );

    const bobClaimFinalCheckpoints = await Promise.all(
        bobClaimCheckpoints.map(async (c) => {
            const tx = Transaction.fromPSBT(base64.decode(c), {
                allowUnknown: true,
            });
            const signed = await bobClaimIdentity.sign(tx, [0]);
            return base64.encode(signed.toPSBT());
        })
    );
    await arkProvider.finalizeTx(bobClaimTxid, bobClaimFinalCheckpoints);
    console.log("Bob claimed USD! Tx:", bobClaimTxid);

    // ====================================================================
    // Summary
    // ====================================================================
    console.log("\n=== Swap Complete ===");
    console.log("Before swap:");
    console.log("  Alice: 100 USD, 0 CHF");
    console.log("  Bob:   0 USD, 90 CHF");
    console.log("After swap:");
    console.log("  Alice: 0 USD, 90 CHF");
    console.log("  Bob:   100 USD, 0 CHF");
    console.log("\nAtomicity: Both claims used the same preimage hash.");
    console.log("If Alice had not claimed, both HTLCs would expire and refund.");
}

async function fundAddress(address, amount) {
    console.log(`Funding ${address.slice(0, 20)}... with ${amount} sats`);
    execSync(
        `${arkdExec} ark send --to ${address} --amount ${amount} --password secret`
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
}

main().catch(console.error);
