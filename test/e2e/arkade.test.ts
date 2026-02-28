import { expect, describe, it, beforeEach, beforeAll } from "vitest";
import { base64, hex } from "@scure/base";
import { execSync } from "child_process";

import {
    arkade,
    asset,
    ArkadeScriptField,
    setArkPsbtField,
    buildOffchainTx,
    MultisigTapscript,
    CSVMultisigTapscript,
    ArkAddress,
    networks,
    RestArkProvider,
    RestIndexerProvider,
    Transaction,
    Intent,
    Batch,
    RestIntrospectorProvider,
} from "../../src";
import {
    beforeEachFaucet,
    createTestArkWallet,
    createTestIdentity,
    faucetOffchain,
} from "./utils";

const INTROSPECTOR_URL = "http://localhost:7073";
const ARK_SERVER_URL = "http://localhost:7070";

/**
 * Merge introspector + server checkpoint signatures, then counter-sign.
 */
async function mergeAndSignCheckpoints(
    serverCheckpoints: string[],
    introCheckpoints: string[],
    signer: ReturnType<typeof createTestIdentity>
): Promise<string[]> {
    return Promise.all(
        serverCheckpoints.map(async (serverCp, i) => {
            const serverTx = Transaction.fromPSBT(base64.decode(serverCp));
            const introTx = Transaction.fromPSBT(
                base64.decode(introCheckpoints[i])
            );
            serverTx.combine(introTx);
            const signed = await signer.sign(serverTx, [0]);
            return base64.encode(signed.toPSBT());
        })
    );
}

describe("arkade", () => {
    const introspector = new RestIntrospectorProvider(INTROSPECTOR_URL);
    const arkProvider = new RestArkProvider(ARK_SERVER_URL);
    const indexerProvider = new RestIndexerProvider(ARK_SERVER_URL);

    let serverXOnlyPubkey: Uint8Array;
    let introspectorPubkey: Uint8Array; // full compressed (33 bytes with 02/03 prefix)
    let checkpointUnrollClosure: CSVMultisigTapscript.Type;

    beforeAll(async () => {
        const arkInfo = await arkProvider.getInfo();
        serverXOnlyPubkey = hex.decode(arkInfo.signerPubkey).slice(1);
        checkpointUnrollClosure = CSVMultisigTapscript.decode(
            hex.decode(arkInfo.checkpointTapscript)
        );

        const introInfo = await introspector.getInfo();
        introspectorPubkey = hex.decode(introInfo.signerPubkey);
    });

    beforeEach(beforeEachFaucet, 20000);

    // =========================================================================
    // Helpers
    // =========================================================================

    /** Build arkade script: check output `index` scriptPubKey == witnessProgram (taproot v1) */
    function buildCheckOutputScript(
        outputIndex: number,
        witnessProgram: Uint8Array
    ): Uint8Array {
        return arkade.ArkadeScript.encode([
            outputIndex, // push output index
            "INSPECTOUTPUTSCRIPTPUBKEY", // → [witnessProgram, version]
            1, // push 1 (taproot version)
            "EQUALVERIFY", // check version == 1
            witnessProgram, // push expected witness program
            "EQUAL", // check witness program matches
        ]);
    }

    /** Get witness program (32-byte x-only pubkey) from an ark address */
    function getWitnessProgram(address: string): Uint8Array {
        return ArkAddress.decode(address).pkScript.subarray(2);
    }

    /** Wait for a VTXO to appear at the given pkScript */
    async function waitForVtxo(
        pkScript: Uint8Array,
        expectedCount = 1,
        timeout = 15000
    ) {
        let vtxos: any[] = [];
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const resp = await indexerProvider.getVtxos({
                scripts: [hex.encode(pkScript)],
                spendableOnly: true,
            });
            vtxos = resp.vtxos;
            if (vtxos.length >= expectedCount) break;
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        return vtxos;
    }

    // Offchain transaction with arkade script
    it("TestOffchain", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const bob = createTestIdentity();
        const bobPubkey = await bob.xOnlyPublicKey();

        const aliceAddress = await alice.wallet.getAddress();
        const aliceWitnessProgram = getWitnessProgram(aliceAddress);

        // Build arkade script: check output 0 goes to Alice
        const arkadeScriptBytes = buildCheckOutputScript(
            0,
            aliceWitnessProgram
        );

        // Create VtxoScript with arkade multisig
        const vtxoScript = new arkade.ArkadeVtxoScript(
            [
                {
                    arkadeScript: arkadeScriptBytes,
                    tapscript: MultisigTapscript.encode({
                        pubkeys: [bobPubkey, serverXOnlyPubkey],
                    }),
                },
            ],
            { introspectorPubkey }
        );
        const contractAddress = vtxoScript
            .address(networks.regtest.hrp, serverXOnlyPubkey)
            .encode();

        // Fund the contract
        const fundAmount = 10000;
        faucetOffchain(contractAddress, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Get the VTXO
        const vtxos = await waitForVtxo(vtxoScript.pkScript);
        expect(vtxos).toHaveLength(1);
        const vtxo = vtxos[0];

        // Find the arkade multisig leaf
        const multisig = MultisigTapscript.encode({
            pubkeys: [
                bobPubkey,
                serverXOnlyPubkey,
                arkade.computeArkadeScriptPublicKey(
                    introspectorPubkey,
                    arkadeScriptBytes
                ),
            ],
        });
        const tapLeafScript = vtxoScript.findLeaf(hex.encode(multisig.script));
        const tapTree = vtxoScript.encode();

        // Build offchain tx: output goes to Alice
        const alicePkScript = ArkAddress.decode(aliceAddress).pkScript;
        const { arkTx, checkpoints } = buildOffchainTx(
            [{ ...vtxo, tapLeafScript, tapTree }],
            [{ script: alicePkScript, amount: BigInt(fundAmount) }],
            checkpointUnrollClosure
        );

        // Set ArkadeScript PSBT field on input 0
        setArkPsbtField(arkTx, 0, ArkadeScriptField, arkadeScriptBytes);

        // Bob signs the arkTx
        const bobSignedArkTx = await bob.sign(arkTx);

        // Submit to introspector (signs with tweaked key)
        const introResult = await introspector.submitTx(
            base64.encode(bobSignedArkTx.toPSBT()),
            checkpoints.map((c) => base64.encode(c.toPSBT()))
        );

        // Submit to server (signs with server key)
        const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
            introResult.signedArkTx,
            introResult.signedCheckpointTxs
        );
        expect(arkTxid).toBeDefined();

        // Merge introspector + server checkpoint signatures, then Bob counter-signs
        const finalCheckpoints = await mergeAndSignCheckpoints(
            signedCheckpointTxs,
            introResult.signedCheckpointTxs,
            bob
        );

        // Finalize
        await arkProvider.finalizeTx(arkTxid, finalCheckpoints);
    });

    // Settlement flow via intent + batch session (using arkade script)
    it("TestSettlement", { timeout: 120000 }, async () => {
        const alice = await createTestArkWallet();
        const bob = createTestIdentity();
        const bobPubkey = await bob.xOnlyPublicKey();

        const aliceAddress = await alice.wallet.getAddress();
        const aliceWP = getWitnessProgram(aliceAddress);
        const alicePkScript = ArkAddress.decode(aliceAddress).pkScript;

        // Build arkade script: check output 0 goes to Alice
        const arkadeScriptBytes = buildCheckOutputScript(0, aliceWP);

        // Create VtxoScript with arkade closure + CSV exit
        const vtxoScript = new arkade.ArkadeVtxoScript(
            [
                {
                    arkadeScript: arkadeScriptBytes,
                    tapscript: MultisigTapscript.encode({
                        pubkeys: [bobPubkey, serverXOnlyPubkey],
                    }),
                },
                CSVMultisigTapscript.encode({
                    timelock: { type: "blocks", value: BigInt(5120) },
                    pubkeys: [bobPubkey, serverXOnlyPubkey],
                }).script,
            ],
            { introspectorPubkey }
        );
        const contractAddress = vtxoScript
            .address(networks.regtest.hrp, serverXOnlyPubkey)
            .encode();

        // Fund the contract
        const fundAmount = 10000;
        faucetOffchain(contractAddress, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Get the VTXO
        const vtxos = await waitForVtxo(vtxoScript.pkScript);
        expect(vtxos).toHaveLength(1);
        const vtxo = vtxos[0];

        // Get the arkade closure leaf
        const multisig = MultisigTapscript.encode({
            pubkeys: [
                bobPubkey,
                serverXOnlyPubkey,
                arkade.computeArkadeScriptPublicKey(
                    introspectorPubkey,
                    arkadeScriptBytes
                ),
            ],
        });
        const arkadeLeaf = vtxoScript.findLeaf(hex.encode(multisig.script));
        const tapTree = vtxoScript.encode();

        // Create tree signer session
        const session = bob.signerSession();
        const sessionPubKey = hex.encode(await session.getPublicKey());

        // Build intent: output goes to Alice
        const outputs = [
            {
                script: alicePkScript,
                amount: BigInt(fundAmount),
            },
        ];

        const message: Intent.RegisterMessage = {
            type: "register",
            onchain_output_indexes: [],
            valid_at: 0,
            expire_at: 0,
            cosigners_public_keys: [sessionPubKey],
        };

        // Create the intent proof
        const coin = {
            txid: vtxo.txid,
            vout: vtxo.vout,
            value: vtxo.value,
            tapTree,
            forfeitTapLeafScript: arkadeLeaf,
            intentTapLeafScript: arkadeLeaf,
            status: vtxo.status,
            isSpent: vtxo.isSpent,
            virtualStatus: vtxo.virtualStatus,
        };

        const intentProof = Intent.create(message, [coin], outputs);

        // Set ArkadeScript field on input 1 (the VTXO input, input 0 is the message input)
        setArkPsbtField(intentProof, 1, ArkadeScriptField, arkadeScriptBytes);

        // Bob signs the intent
        const signedProof = await bob.sign(intentProof);

        // Submit to introspector
        const signedProofB64 = base64.encode(signedProof.toPSBT());
        const introSignedProof = await introspector.submitIntent({
            proof: signedProofB64,
            message,
        });

        // Register intent with server
        const intentId = await arkProvider.registerIntent({
            proof: introSignedProof,
            message,
        });

        expect(intentId).toBeDefined();

        // Create batch handler for arkade settlement
        const handler = arkade.createArkadeBatchHandler(
            intentId,
            [{ ...coin, arkadeScriptBytes }],
            bob,
            introSignedProof,
            message,
            session,
            arkProvider,
            introspector,
            networks.regtest
        );

        // Join the batch session
        const topics = [sessionPubKey, `${vtxo.txid}:${vtxo.vout}`];
        const abortController = new AbortController();

        try {
            const eventStream = arkProvider.getEventStream(
                abortController.signal,
                topics
            );
            const commitmentTxid = await Batch.join(eventStream, handler, {
                abortController,
            });
            expect(commitmentTxid).toBeDefined();
        } finally {
            abortController.abort();
        }
    });

    // Boarding flow via intent + batch session (using arkade script)
    it("TestBoarding", { timeout: 120000 }, async () => {
        const alice = await createTestArkWallet();
        const bob = createTestIdentity();
        const bobPubkey = await bob.xOnlyPublicKey();

        const aliceAddress = await alice.wallet.getAddress();
        const aliceWP = getWitnessProgram(aliceAddress);
        const alicePkScript = ArkAddress.decode(aliceAddress).pkScript;

        const arkInfo = await arkProvider.getInfo();
        const boardingExitDelay = Number(arkInfo.boardingExitDelay);

        // Build arkade script
        const arkadeScriptBytes = buildCheckOutputScript(0, aliceWP);

        // Create boarding VtxoScript: arkade closure + bob-only CSV exit
        const vtxoScript = new arkade.ArkadeVtxoScript(
            [
                {
                    arkadeScript: arkadeScriptBytes,
                    tapscript: MultisigTapscript.encode({
                        pubkeys: [bobPubkey, serverXOnlyPubkey],
                    }),
                },
                CSVMultisigTapscript.encode({
                    timelock: {
                        type: "blocks",
                        value: BigInt(boardingExitDelay),
                    },
                    pubkeys: [bobPubkey],
                }).script,
            ],
            { introspectorPubkey }
        );

        // Get onchain taproot address (regtest uses bcrt1 prefix)
        const btcSigner = await import("@scure/btc-signer");
        const regtestNetwork = {
            ...btcSigner.TEST_NETWORK,
            bech32: "bcrt",
        };
        const btcAddress = btcSigner.Address(regtestNetwork).encode({
            type: "tr",
            pubkey: vtxoScript.tweakedPublicKey,
        });

        // Fund on-chain via faucet
        const fundAmountBtc = 0.0001; // 10000 sats
        const fundAmount = 10000;
        execSync(`nigiri faucet ${btcAddress} ${fundAmountBtc.toFixed(8)}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // Get the arkade closure leaf
        const multisig = MultisigTapscript.encode({
            pubkeys: [
                bobPubkey,
                serverXOnlyPubkey,
                arkade.computeArkadeScriptPublicKey(
                    introspectorPubkey,
                    arkadeScriptBytes
                ),
            ],
        });
        const arkadeLeaf = vtxoScript.findLeaf(hex.encode(multisig.script));
        const tapTree = vtxoScript.encode();

        // Create tree signer session
        const session = bob.signerSession();
        const sessionPubKey = hex.encode(await session.getPublicKey());

        // We need to find the funded UTXO on-chain
        // Use esplora to find the tx
        const utxoResp = await fetch(
            `http://localhost:3000/address/${btcAddress}/utxo`
        );
        const utxos = await utxoResp.json();
        expect(utxos.length).toBeGreaterThan(0);
        const utxo = utxos[0];

        // Build intent
        const outputs = [
            {
                script: alicePkScript,
                amount: BigInt(fundAmount),
            },
        ];

        const message: Intent.RegisterMessage = {
            type: "register",
            onchain_output_indexes: [],
            valid_at: 0,
            expire_at: 0,
            cosigners_public_keys: [sessionPubKey],
        };

        const coin = {
            txid: utxo.txid,
            vout: utxo.vout,
            value: utxo.value,
            tapTree,
            forfeitTapLeafScript: arkadeLeaf,
            intentTapLeafScript: arkadeLeaf,
            status: {
                confirmed: utxo.status?.confirmed ?? false,
                block_time: 0,
            },
            isSpent: false,
            virtualStatus: {
                state: "settled" as const,
                batchExpiry: 0,
                batchTxid: "",
            },
        };

        const intentProof = Intent.create(message, [coin], outputs);
        setArkPsbtField(intentProof, 1, ArkadeScriptField, arkadeScriptBytes);

        const signedProof = await bob.sign(intentProof);
        const signedProofB64 = base64.encode(signedProof.toPSBT());

        const introSignedProof = await introspector.submitIntent({
            proof: signedProofB64,
            message,
        });

        const intentId = await arkProvider.registerIntent({
            proof: introSignedProof,
            message,
        });
        expect(intentId).toBeDefined();

        // Create batch handler (auto-detects boarding input)
        const handler = arkade.createArkadeBatchHandler(
            intentId,
            [{ ...coin, arkadeScriptBytes }],
            bob,
            introSignedProof,
            message,
            session,
            arkProvider,
            introspector,
            networks.regtest
        );

        const topics = [sessionPubKey, `${utxo.txid}:${utxo.vout}`];
        const abortController = new AbortController();

        try {
            const eventStream = arkProvider.getEventStream(
                abortController.signal,
                topics
            );
            const commitmentTxid = await Batch.join(eventStream, handler, {
                abortController,
            });
            expect(commitmentTxid).toBeDefined();
        } finally {
            abortController.abort();
        }
    });

    // Offchain transaction with asset introspection
    it("TestOffchainTxWithAsset", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const bob = createTestIdentity();
        const bobPubkey = await bob.xOnlyPublicKey();

        const aliceAddress = await alice.wallet.getAddress();
        const aliceWP = getWitnessProgram(aliceAddress);
        const alicePkScript = ArkAddress.decode(aliceAddress).pkScript;

        const assetAmount = 1000;

        // Build arkade script with asset introspection
        const scriptOps: arkade.ArkadeScriptType = [
            // Check output 0 address == Alice
            0,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            1,
            "EQUALVERIFY",
            aliceWP,
            "EQUALVERIFY",
            // Check: 1 asset group
            "INSPECTNUMASSETGROUPS",
            1,
            "EQUALVERIFY",
            // Check: sum of outputs for group 0 equals assetAmount
            0, // group index
            1, // source = outputs
            "INSPECTASSETGROUPSUM",
            assetAmount,
            "EQUAL",
        ];
        const arkadeScriptBytes = arkade.ArkadeScript.encode(scriptOps);

        const vtxoScript = new arkade.ArkadeVtxoScript(
            [
                {
                    arkadeScript: arkadeScriptBytes,
                    tapscript: MultisigTapscript.encode({
                        pubkeys: [bobPubkey, serverXOnlyPubkey],
                    }),
                },
            ],
            { introspectorPubkey }
        );
        const contractAddress = vtxoScript
            .address(networks.regtest.hrp, serverXOnlyPubkey)
            .encode();

        // Fund the contract
        const fundAmount = 10000;
        faucetOffchain(contractAddress, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        const vtxos = await waitForVtxo(vtxoScript.pkScript);
        expect(vtxos).toHaveLength(1);
        const vtxo = vtxos[0];

        const multisig = MultisigTapscript.encode({
            pubkeys: [
                bobPubkey,
                serverXOnlyPubkey,
                arkade.computeArkadeScriptPublicKey(
                    introspectorPubkey,
                    arkadeScriptBytes
                ),
            ],
        });
        const tapLeafScript = vtxoScript.findLeaf(hex.encode(multisig.script));
        const tapTree = vtxoScript.encode();

        // Create issuance asset packet
        const assetPacket = asset.Packet.create([
            asset.AssetGroup.create(
                null, // null = issuance
                null,
                [], // no inputs for issuance
                [asset.AssetOutput.create(0, assetAmount)],
                []
            ),
        ]);

        // Build offchain tx outputs (asset packet before P2A anchor)
        const outputs = [
            { script: alicePkScript, amount: BigInt(fundAmount) },
            assetPacket.txOut(),
        ];

        const { arkTx, checkpoints } = buildOffchainTx(
            [{ ...vtxo, tapLeafScript, tapTree }],
            outputs,
            checkpointUnrollClosure
        );

        setArkPsbtField(arkTx, 0, ArkadeScriptField, arkadeScriptBytes);

        const bobSignedArkTx = await bob.sign(arkTx);

        const introResult = await introspector.submitTx(
            base64.encode(bobSignedArkTx.toPSBT()),
            checkpoints.map((c) => base64.encode(c.toPSBT()))
        );

        const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
            introResult.signedArkTx,
            introResult.signedCheckpointTxs
        );
        expect(arkTxid).toBeDefined();

        const finalCheckpoints = await mergeAndSignCheckpoints(
            signedCheckpointTxs,
            introResult.signedCheckpointTxs,
            bob
        );

        await arkProvider.finalizeTx(arkTxid, finalCheckpoints);
    });

    // Settlement flow with asset introspection
    it("TestSettlementWithAsset", { timeout: 180000 }, async () => {
        const alice = await createTestArkWallet();
        const bob = createTestIdentity();
        const bobPubkey = await bob.xOnlyPublicKey();

        const aliceAddress = await alice.wallet.getAddress();
        const aliceWP = getWitnessProgram(aliceAddress);
        const alicePkScript = ArkAddress.decode(aliceAddress).pkScript;

        const assetAmount = 1000;
        const fundAmount = 10000;

        // === Phase 1: Mint ===

        // Settle contract script: checks output goes to Alice + 1 asset group + sum
        const settleScriptOps: arkade.ArkadeScriptType = [
            0,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            1,
            "EQUALVERIFY",
            aliceWP,
            "EQUALVERIFY",
            "INSPECTNUMASSETGROUPS",
            1,
            "EQUALVERIFY",
            0,
            1,
            "INSPECTASSETGROUPSUM",
            assetAmount,
            "EQUAL",
        ];
        const settleArkadeScript = arkade.ArkadeScript.encode(settleScriptOps);

        // Create settle contract VtxoScript with CSV exit
        const settleVtxoScript = new arkade.ArkadeVtxoScript(
            [
                {
                    arkadeScript: settleArkadeScript,
                    tapscript: MultisigTapscript.encode({
                        pubkeys: [bobPubkey, serverXOnlyPubkey],
                    }),
                },
                CSVMultisigTapscript.encode({
                    timelock: { type: "blocks", value: BigInt(5120) },
                    pubkeys: [bobPubkey, serverXOnlyPubkey],
                }).script,
            ],
            { introspectorPubkey }
        );
        const settleContractAddress = settleVtxoScript
            .address(networks.regtest.hrp, serverXOnlyPubkey)
            .encode();
        const settleWP = getWitnessProgram(settleContractAddress);

        // Mint contract script: checks output goes to settle contract + 1 asset group + sum
        const mintScriptOps: arkade.ArkadeScriptType = [
            0,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            1,
            "EQUALVERIFY",
            settleWP,
            "EQUALVERIFY",
            "INSPECTNUMASSETGROUPS",
            1,
            "EQUALVERIFY",
            0,
            1,
            "INSPECTASSETGROUPSUM",
            assetAmount,
            "EQUAL",
        ];
        const mintArkadeScript = arkade.ArkadeScript.encode(mintScriptOps);

        const mintVtxoScript = new arkade.ArkadeVtxoScript(
            [
                {
                    arkadeScript: mintArkadeScript,
                    tapscript: MultisigTapscript.encode({
                        pubkeys: [bobPubkey, serverXOnlyPubkey],
                    }),
                },
            ],
            { introspectorPubkey }
        );
        const mintContractAddress = mintVtxoScript
            .address(networks.regtest.hrp, serverXOnlyPubkey)
            .encode();

        // Fund the mint contract
        faucetOffchain(mintContractAddress, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        const mintVtxos = await waitForVtxo(mintVtxoScript.pkScript);
        expect(mintVtxos).toHaveLength(1);
        const mintVtxo = mintVtxos[0];

        // Build offchain tx: mint VTXO → settle contract
        const mintMultisig = MultisigTapscript.encode({
            pubkeys: [
                bobPubkey,
                serverXOnlyPubkey,
                arkade.computeArkadeScriptPublicKey(
                    introspectorPubkey,
                    mintArkadeScript
                ),
            ],
        });
        const mintTapLeaf = mintVtxoScript.findLeaf(
            hex.encode(mintMultisig.script)
        );

        const settleContractPkScript = ArkAddress.decode(
            settleContractAddress
        ).pkScript;

        // Create issuance asset packet
        const issuancePacket = asset.Packet.create([
            asset.AssetGroup.create(
                null,
                null,
                [],
                [asset.AssetOutput.create(0, assetAmount)],
                []
            ),
        ]);

        const { arkTx: mintTx, checkpoints: mintCheckpoints } = buildOffchainTx(
            [
                {
                    ...mintVtxo,
                    tapLeafScript: mintTapLeaf,
                    tapTree: mintVtxoScript.encode(),
                },
            ],
            [
                {
                    script: settleContractPkScript,
                    amount: BigInt(fundAmount),
                },
                issuancePacket.txOut(),
            ],
            checkpointUnrollClosure
        );

        setArkPsbtField(mintTx, 0, ArkadeScriptField, mintArkadeScript);

        const bobSignedMintTx = await bob.sign(mintTx);

        const introMintResult = await introspector.submitTx(
            base64.encode(bobSignedMintTx.toPSBT()),
            mintCheckpoints.map((c) => base64.encode(c.toPSBT()))
        );

        const { arkTxid: mintTxid, signedCheckpointTxs: mintSignedCPs } =
            await arkProvider.submitTx(
                introMintResult.signedArkTx,
                introMintResult.signedCheckpointTxs
            );
        expect(mintTxid).toBeDefined();

        const finalMintCPs = await mergeAndSignCheckpoints(
            mintSignedCPs,
            introMintResult.signedCheckpointTxs,
            bob
        );
        await arkProvider.finalizeTx(mintTxid, finalMintCPs);

        // === Phase 2: Settle via intent ===

        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Get the settle VTXO
        const settleVtxos = await waitForVtxo(settleVtxoScript.pkScript);
        expect(settleVtxos).toHaveLength(1);
        const settleVtxo = settleVtxos[0];

        const settleMultisig = MultisigTapscript.encode({
            pubkeys: [
                bobPubkey,
                serverXOnlyPubkey,
                arkade.computeArkadeScriptPublicKey(
                    introspectorPubkey,
                    settleArkadeScript
                ),
            ],
        });
        const settleArkadeLeaf = settleVtxoScript.findLeaf(
            hex.encode(settleMultisig.script)
        );
        const settleTapTree = settleVtxoScript.encode();

        // Create tree signer session
        const session = bob.signerSession();
        const sessionPubKey = hex.encode(await session.getPublicKey());

        // Create transfer asset packet (referencing minted asset)
        const transferPacket = asset.Packet.create([
            asset.AssetGroup.create(
                asset.AssetId.create(mintTxid, 0),
                null,
                [asset.AssetInput.create(1, assetAmount)], // vin 1 = the VTXO input
                [asset.AssetOutput.create(0, assetAmount)],
                []
            ),
        ]);

        const outputs = [
            {
                script: alicePkScript,
                amount: BigInt(fundAmount),
            },
            transferPacket.txOut(),
        ];

        const settleMessage: Intent.RegisterMessage = {
            type: "register",
            onchain_output_indexes: [],
            valid_at: 0,
            expire_at: 0,
            cosigners_public_keys: [sessionPubKey],
        };

        const settleCoin = {
            txid: settleVtxo.txid,
            vout: settleVtxo.vout,
            value: settleVtxo.value,
            tapTree: settleTapTree,
            forfeitTapLeafScript: settleArkadeLeaf,
            intentTapLeafScript: settleArkadeLeaf,
            status: settleVtxo.status,
            isSpent: settleVtxo.isSpent,
            virtualStatus: settleVtxo.virtualStatus,
        };

        const settleIntentProof = Intent.create(
            settleMessage,
            [settleCoin],
            outputs
        );
        setArkPsbtField(
            settleIntentProof,
            1,
            ArkadeScriptField,
            settleArkadeScript
        );

        const signedSettleProof = await bob.sign(settleIntentProof);
        const signedSettleProofB64 = base64.encode(signedSettleProof.toPSBT());

        const introSettleProof = await introspector.submitIntent({
            proof: signedSettleProofB64,
            message: settleMessage,
        });

        const settleIntentId = await arkProvider.registerIntent({
            proof: introSettleProof,
            message: settleMessage,
        });
        expect(settleIntentId).toBeDefined();

        const handler = arkade.createArkadeBatchHandler(
            settleIntentId,
            [{ ...settleCoin, arkadeScriptBytes: settleArkadeScript }],
            bob,
            introSettleProof,
            settleMessage,
            session,
            arkProvider,
            introspector,
            networks.regtest
        );

        const topics = [sessionPubKey, `${settleVtxo.txid}:${settleVtxo.vout}`];
        const abortController = new AbortController();

        try {
            const eventStream = arkProvider.getEventStream(
                abortController.signal,
                topics
            );
            const commitmentTxid = await Batch.join(eventStream, handler, {
                abortController,
            });
            expect(commitmentTxid).toBeDefined();
        } finally {
            abortController.abort();
        }
    });
});
