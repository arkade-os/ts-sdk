// This example shows how to delegate VTXO refreshing to a third party
//
// Usage:
// node examples/delegate.js
//
import {
    SingleKey,
    Wallet,
    RestArkProvider,
    RestIndexerProvider,
    VtxoScript,
    CLTVMultisigTapscript,
    networks,
    buildForfeitTx,
} from "../dist/esm/index.js";
import { hex } from "@scure/base";
import { utils, Address, OutScript, SigHash } from "@scure/btc-signer";
import { execSync } from "child_process";

const SERVER_PUBLIC_KEY = hex.decode(
    "8a9bbb1fb2aa92b9557dd0b39a85f31d204f58b41c62ea112d6ad148a9881285"
);

const arkdExec = process.argv[2] || "docker exec -t arkd";

const alice = SingleKey.fromHex(hex.encode(utils.randomPrivateKeyBytes()));

console.log("Creating VTXO Refresh Delegation between Alice and Delegator");
console.log("Alice's public key:", hex.encode(alice.xOnlyPublicKey()));
console.log("Delegator's public key:", hex.encode(delegator.xOnlyPublicKey()));

async function main() {
    // create the special delegator identity
    const delegatorSingleKeyIdentity = SingleKey.fromHex(
        hex.encode(utils.randomPrivateKeyBytes())
    );
    const delegatorSignerSession = delegatorSingleKeyIdentity.signerSession();
    var forfeitTxAliceSignature = null;
    var vtxoTxid = "";

    const delegatorIdentity = {
        signerSession: () => delegatorSignerSession,
        xOnlyPublicKey: () => delegatorSingleKeyIdentity.xOnlyPublicKey(),
        sign: async (tx, inputIndexes) => {
            const signedTx = await delegatorSingleKeyIdentity.sign(
                tx,
                inputIndexes
            );
            // search for the vtxo in the transaction
            const vtxo = tx.inputs.find((input) => input.txid === vtxoTxid);
            if (!vtxo) {
                return signedTx;
            }

            // add the alice's signature to the input
            signedTx.updateInput(0, {
                tapScriptSig: [
                    ...signedTx.getInput(0).tapScriptSig,
                    ...forfeitTxAliceSignature,
                ],
            });
            return signedTx;
        },
    };

    console.log("\nInitializing Delegator's wallet...");
    const delegatorWallet = await Wallet.create({
        identity: delegatorIdentity,
        esploraUrl: "http://localhost:3000",
        arkServerUrl: "http://localhost:7070",
    });

    console.log("\nInitializing Alice's wallet...");
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

    console.log("Faucet alice's wallet with 1 VTXO...");
    await fundAddress(await aliceWallet.getAddress(), 10_000);

    const aliceVtxos = await aliceWallet.getVtxos();
    const aliceVtxo = aliceVtxos.vtxos[0];

    console.log(
        `Alice's VTXO: ${aliceVtxo.txid}:${aliceVtxo.vout}, ${aliceVtxo.value} sats`
    );

    const aliceScripts = aliceWallet.offchainTapscript.leaves.map(
        ([_, script]) => script
    );

    // the delegate vtxo script is composed of:
    // - The VTXO tapscripts paths
    // - The delegate script (A + D + S + CLTV(tip + 10))
    const delegateScript = CLTVMultisigTapscript.encode({
        absoluteTimelock: BigInt(chainTip + 10), // absolute timelock close to the VTXO expiry
        pubkeys: [
            alice.xOnlyPublicKey(),
            delegator.xOnlyPublicKey(),
            SERVER_PUBLIC_KEY,
        ],
    }).script;

    const vtxoDelegateScript = new VtxoScript([
        ...aliceScripts,
        delegateScript,
    ]);

    const address = vtxoDelegateScript
        .address(networks.regtest.hrp, SERVER_PUBLIC_KEY)
        .encode();
    console.log("\nVTXO Refresh Delegation Address:", address);

    // Alice sends the VTXO to the delegator address
    await aliceWallet.sendBitcoin({
        address: address,
        amount: aliceVtxo.value,
    });

    const indexerProvider = new RestIndexerProvider("http://localhost:7070");

    const vtxos = await indexerProvider.getVtxos({
        scripts: [hex.encode(vtxoDelegateScript.pkScript)],
        spendableOnly: true,
    });

    if (vtxos.vtxos.length === 0) {
        throw new Error("No VTXO found");
    }

    const delegatedVtxo = vtxos.vtxos[0];
    console.log(
        `Delegated VTXO: ${delegatedVtxo.txid}:${delegatedVtxo.vout}, ${delegatedVtxo.value} sats`
    );

    // Alice signs an intent to refresh the VTXO
    console.log("Alice signs an intent to refresh the VTXO");
    // TODO: add a way to commit the expiry to the intent
    const intent = await aliceWallet.makeRegisterIntentSignature(
        [delegatedVtxo],
        [
            {
                amount: delegatedVtxo.value,
                script: aliceWallet.offchainTapscript.pkScript,
            },
        ],
        [],
        [hex.encode(delegatorSignerSession.getPublicKey())]
    );

    const arkProvider = new RestArkProvider("http://localhost:7070");
    const infos = await arkProvider.getInfo();
    const forfeitOutputScript = OutScript.encode(
        Address.decode(infos.forfeitAddress)
    );

    console.log("Alice signs a 'partial' forfeit transaction");
    const forfeitTapLeafScript = vtxoDelegateScript.findLeaf(
        hex.encode(delegateScript)
    );

    // the forfeit transaction doesn't contain a connector input
    // Alice signs the transaction with ALL_ANYONECANPAY sighash type to allow the delegator to add the connector input
    const forfeitTx = buildForfeitTx(
        [
            {
                txid: delegatedVtxo.txid,
                index: delegatedVtxo.vout,
                witnessUtxo: {
                    amount: BigInt(delegatedVtxo.value),
                    script: VtxoScript.decode(delegatedVtxo.tapTree).pkScript,
                },
                sighashType: SigHash.ALL | SigHash.ALL_ANYONECANPAY,
                tapLeafScript: [forfeitTapLeafScript],
            },
        ],
        forfeitOutputScript
    );

    // TODO delegator settles with the partial forfeit transaction and the intent
}

async function fundAddress(address, amount) {
    console.log(`\nFunding address with ${amount} sats...`);
    execSync(
        `${arkdExec} ark send --to ${address} --amount ${amount} --password secret`
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
}

main().catch(console.error);
