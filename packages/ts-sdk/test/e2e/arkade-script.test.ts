import { expect, describe, it, beforeEach } from "vitest";
import { base64, hex } from "@scure/base";
import { p2tr, SigHash } from "@scure/btc-signer";

import {
    arkade,
    asset,
    buildOffchainTx,
    ArkAddress,
    EsploraProvider,
    networks,
    PrevoutTxField,
    RestArkProvider,
    RestIndexerProvider,
    setArkPsbtField,
    SingleKey,
    Transaction,
    Intent,
    Batch,
    RestEmulatorProvider,
    Extension,
    EmulatorPacket,
} from "../../src";
import type { Identity } from "../../src/identity";
import {
    addEmulatorPacket,
    beforeEachFaucet,
    createTestArkWallet,
    createTestIdentity,
    faucetOffchain,
    faucetOnchain,
    waitForUtxo,
} from "./utils";

/**
 * Creates an Extension OP_RETURN output containing an EmulatorPacket.
 * Optionally merges with other ExtensionPackets (e.g., asset packets).
 */
function makeEmulatorExtensionOutput(
    vin: number,
    scriptBytes: Uint8Array,
    ...extraPackets: import("../../src/extension").ExtensionPacket[]
) {
    const packet = EmulatorPacket.create([
        { vin, script: scriptBytes, witness: new Uint8Array(0) },
    ]);
    return Extension.create([...extraPackets, packet]).txOut();
}

const EMULATOR_URL = "http://localhost:7073";
const ARK_SERVER_URL = "http://localhost:7070";
// mempool serves the Esplora REST API under `/api`; the root path is the HTML UI.
const ESPLORA_URL = "http://localhost:3000/api";
const FUNDING_SATS = 1_000_000;
const FUNDING_AMOUNT = 1_000_000n;
const FEE_AMOUNT = 500n;
const SPEND_AMOUNT = FUNDING_AMOUNT - FEE_AMOUNT;

// =========================================================================
// Arkade contract programs (mirror the hand-built VtxoScript trees)
// =========================================================================

// The arkade script `checkOutputToReceiver` checks output 0's scriptPubKey is
// taproot (v1) and equals `$receiver` (the 32-byte witness program). The index 0
// is pushed by the script itself, so the arkade witness stack is empty. The
// `WithAsset` variants add asset-group introspection: exactly one group whose
// output sum equals `$assetAmount`.

// Plain offchain covenant: user + server + arkade-tweaked emulator.
const offchainProgram = {
    version: 0,
    params: ["server", "user"],
    functions: {
        send: {
            tapscript: { signers: ["$user", "$server"] },
            arkadeScript: {
                asm: [0, "INSPECTOUTPUTSCRIPTPUBKEY", 1, "EQUALVERIFY", "$receiver", "EQUAL"],
            },
        },
    },
} satisfies arkade.Program;

// Offchain covenant with asset introspection.
const assetOffchainProgram = {
    version: 0,
    params: ["server", "user"],
    functions: {
        send: {
            tapscript: { signers: ["$user", "$server"] },
            arkadeScript: {
                asm: [
                    0,
                    "INSPECTOUTPUTSCRIPTPUBKEY",
                    1,
                    "EQUALVERIFY",
                    "$receiver",
                    "EQUALVERIFY",
                    "INSPECTNUMASSETGROUPS",
                    1,
                    "EQUALVERIFY",
                    0, // group index
                    1, // source = outputs
                    "INSPECTASSETGROUPSUM",
                    "$assetAmount",
                    "EQUAL",
                ],
            },
        },
    },
} satisfies arkade.Program;

// Settlement contract: arkade covenant + a server+user CSV exit leaf.
const settlementProgram = {
    version: 0,
    params: ["server", "user"],
    functions: {
        settle: {
            tapscript: { signers: ["$user", "$server"] },
            arkadeScript: {
                asm: [0, "INSPECTOUTPUTSCRIPTPUBKEY", 1, "EQUALVERIFY", "$receiver", "EQUAL"],
            },
        },
        exit: {
            tapscript: { signers: ["$user", "$server"], csv: { type: "blocks", value: 5120n } },
        },
    },
} satisfies arkade.Program;

// Settle/mint contracts with asset introspection (used by TestSettlementWithAsset).
const settleAssetProgram = {
    version: 0,
    params: ["server", "user"],
    functions: {
        settle: {
            tapscript: { signers: ["$user", "$server"] },
            arkadeScript: {
                asm: [
                    0,
                    "INSPECTOUTPUTSCRIPTPUBKEY",
                    1,
                    "EQUALVERIFY",
                    "$receiver",
                    "EQUALVERIFY",
                    "INSPECTNUMASSETGROUPS",
                    1,
                    "EQUALVERIFY",
                    0, // group index
                    1, // source = outputs
                    "INSPECTASSETGROUPSUM",
                    "$assetAmount",
                    "EQUAL",
                ],
            },
        },
        exit: {
            tapscript: { signers: ["$user", "$server"], csv: { type: "blocks", value: 5120n } },
        },
    },
} satisfies arkade.Program;

// On-chain spend contract: a 2-of-2 multisig [$bob, $alice] plus the
// arkade-tweaked emulator, guarding a pay-to covenant. The arkade body (token
// form of `enforcePayTo`) forces output 0 to pay `$amount` to `$receiver`; the
// leading DUP consumes the witness's `[0]`.
const spendProgram = {
    version: 0,
    functions: {
        spend: {
            tapscript: { signers: ["$bob", "$alice"] },
            arkadeScript: {
                asm: [
                    "DUP",
                    "INSPECTOUTPUTSCRIPTPUBKEY",
                    1,
                    "EQUALVERIFY",
                    "$receiver",
                    "EQUALVERIFY",
                    "INSPECTOUTPUTVALUE",
                    "$amount",
                    "EQUAL",
                ],
            },
        },
    },
} satisfies arkade.Program;

const mintAssetProgram = {
    version: 0,
    params: ["server", "user"],
    functions: {
        mint: {
            tapscript: { signers: ["$user", "$server"] },
            arkadeScript: {
                asm: [
                    0,
                    "INSPECTOUTPUTSCRIPTPUBKEY",
                    1,
                    "EQUALVERIFY",
                    "$receiver",
                    "EQUALVERIFY",
                    "INSPECTNUMASSETGROUPS",
                    1,
                    "EQUALVERIFY",
                    0, // group index
                    1, // source = outputs
                    "INSPECTASSETGROUPSUM",
                    "$assetAmount",
                    "EQUAL",
                ],
            },
        },
    },
} satisfies arkade.Program;

describe("arkade", () => {
    const emulator = new RestEmulatorProvider(EMULATOR_URL);
    const arkProvider = new RestArkProvider(ARK_SERVER_URL);
    const indexerProvider = new RestIndexerProvider(ARK_SERVER_URL);
    const explorer = new EsploraProvider(ESPLORA_URL);

    /** Connect an Arkade client bound to the given signing identity. */
    function connect(identity: Identity): Promise<arkade.Arkade> {
        return arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            indexer: indexerProvider,
            identity,
            network: networks.regtest,
        });
    }

    beforeEach(beforeEachFaucet, 60000);

    // =========================================================================
    // Helpers
    // =========================================================================

    /** Get witness program (32-byte x-only pubkey) from an ark address */
    function getWitnessProgram(address: string): Uint8Array {
        return ArkAddress.decode(address).pkScript.subarray(2);
    }

    /** Wait for a VTXO to appear at the given pkScript */
    async function waitForVtxo(pkScript: Uint8Array, expectedCount = 1, timeout = 15000) {
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
        const ark = await connect(bob);

        const aliceAddress = await alice.wallet.getAddress();
        const aliceWP = getWitnessProgram(aliceAddress);

        // The covenant forces output 0 to pay Alice.
        const contract = ark.contract(offchainProgram, {
            receiver: aliceWP,
        });

        // Fund the contract.
        const fundAmount = 10000;
        faucetOffchain(contract.address, fundAmount);
        await waitForVtxo(contract.pkScript);

        // Spend through the high-level builder: Bob (user) signs the ark tx and
        // checkpoint inputs, and the emulator — last non-arkd signer — signs with
        // its tweaked key and finalizes with arkd internally.
        const alicePkScript = ArkAddress.decode(aliceAddress).pkScript;
        const { signedArkTx } = await contract.functions
            .send()
            .to(alicePkScript, BigInt(fundAmount))
            .send();
        expect(signedArkTx).toBeTruthy();
    });

    // Settlement flow via intent + batch session (using arkade script)
    it("TestSettlement", { timeout: 120000 }, async () => {
        const alice = await createTestArkWallet();
        const bob = createTestIdentity();
        const ark = await connect(bob);

        const aliceAddress = await alice.wallet.getAddress();
        const aliceWP = getWitnessProgram(aliceAddress);
        const alicePkScript = ArkAddress.decode(aliceAddress).pkScript;

        // Derive the contract (arkade covenant + CSV exit) from the program.
        const contract = ark.contract(settlementProgram, {
            receiver: aliceWP,
        });
        const arkadeScriptBytes = arkade.resolveAsm(
            settlementProgram.functions.settle.arkadeScript.asm,
            { receiver: aliceWP },
        );
        const arkadeLeaf = contract.leafScript(0); // the arkade covenant leaf
        const tapTree = contract.tapTree;

        // Fund the contract
        const fundAmount = 10000;
        faucetOffchain(contract.address, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Get the VTXO
        const vtxos = await waitForVtxo(contract.pkScript);
        expect(vtxos).toHaveLength(1);
        const vtxo = vtxos[0];

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

        const intentProof = Intent.create(
            message,
            [coin],
            [...outputs, makeEmulatorExtensionOutput(1, arkadeScriptBytes)],
        );

        // Bob signs the intent
        const signedProof = await bob.sign(intentProof);

        // Submit to emulator
        const signedProofB64 = base64.encode(signedProof.toPSBT());
        const introSignedProof = await emulator.submitIntent({
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
            emulator,
            networks.regtest,
        );

        // Join the batch session
        const topics = [sessionPubKey, `${vtxo.txid}:${vtxo.vout}`];
        const abortController = new AbortController();

        try {
            const eventStream = arkProvider.getEventStream(abortController.signal, topics);
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
        const ark = await connect(bob);

        const aliceAddress = await alice.wallet.getAddress();
        const aliceWP = getWitnessProgram(aliceAddress);
        const alicePkScript = ArkAddress.decode(aliceAddress).pkScript;

        const arkInfo = await arkProvider.getInfo();
        const boardingExitDelay = Number(arkInfo.boardingExitDelay);

        // Boarding contract: arkade covenant + a bob-only CSV exit. The exit
        // delay is the server-provided boarding delay, so the program is built
        // inline rather than as a module constant.
        const boardingProgram = {
            version: 0,
            params: ["server", "user"],
            functions: {
                board: {
                    tapscript: { signers: ["$user", "$server"] },
                    arkadeScript: {
                        asm: [
                            0,
                            "INSPECTOUTPUTSCRIPTPUBKEY",
                            1,
                            "EQUALVERIFY",
                            "$receiver",
                            "EQUAL",
                        ],
                    },
                },
                exit: {
                    tapscript: {
                        signers: ["$user"],
                        csv: { type: "blocks", value: BigInt(boardingExitDelay) },
                    },
                },
            },
        } satisfies arkade.Program;

        const contract = ark.contract(boardingProgram, {
            receiver: aliceWP,
        });
        const arkadeScriptBytes = arkade.resolveAsm(
            boardingProgram.functions.board.arkadeScript.asm,
            { receiver: aliceWP },
        );
        const arkadeLeaf = contract.leafScript(0);
        const tapTree = contract.tapTree;

        // Get onchain taproot address (regtest uses bcrt1 prefix)
        const btcSigner = await import("@scure/btc-signer");
        const regtestNetwork = {
            ...btcSigner.TEST_NETWORK,
            bech32: "bcrt",
        };
        const btcAddress = btcSigner.Address(regtestNetwork).encode({
            type: "tr",
            pubkey: contract.vtxoScript.tweakedPublicKey,
        });

        // Fund on-chain via faucet
        const fundAmount = 10000;
        faucetOnchain(btcAddress, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // Create tree signer session
        const session = bob.signerSession();
        const sessionPubKey = hex.encode(await session.getPublicKey());

        // We need to find the funded UTXO on-chain
        // Use esplora to find the tx
        // mempool serves the Esplora REST API under `/api` (root path is the HTML UI).
        const utxoResp = await fetch(`http://localhost:3000/api/address/${btcAddress}/utxo`);
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
        };

        const intentProof = Intent.create(
            message,
            [coin],
            [...outputs, makeEmulatorExtensionOutput(1, arkadeScriptBytes)],
        );

        const signedProof = await bob.sign(intentProof);
        const signedProofB64 = base64.encode(signedProof.toPSBT());

        const introSignedProof = await emulator.submitIntent({
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
            emulator,
            networks.regtest,
        );

        const topics = [sessionPubKey, `${utxo.txid}:${utxo.vout}`];
        const abortController = new AbortController();

        try {
            const eventStream = arkProvider.getEventStream(abortController.signal, topics);
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
        const ark = await connect(bob);

        const aliceAddress = await alice.wallet.getAddress();
        const aliceWP = getWitnessProgram(aliceAddress);
        const alicePkScript = ArkAddress.decode(aliceAddress).pkScript;

        const assetAmount = 1000;

        // Derive the asset covenant contract. The issuance asset packet (assetId
        // = null) is not expressible via the builder's `.withAsset()`, so the
        // offchain tx is assembled manually from the contract's script.
        const contract = ark.contract(assetOffchainProgram, {
            receiver: aliceWP,
            assetAmount,
        });
        const arkadeScriptBytes = arkade.resolveAsm(
            assetOffchainProgram.functions.send.arkadeScript.asm,
            {
                receiver: aliceWP,
                assetAmount,
            },
        );
        const tapLeafScript = contract.leafScript(0);
        const tapTree = contract.tapTree;

        // Fund the contract
        const fundAmount = 10000;
        faucetOffchain(contract.address, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        const vtxos = await waitForVtxo(contract.pkScript);
        expect(vtxos).toHaveLength(1);
        const vtxo = vtxos[0];

        // Create issuance asset packet
        const assetPacket = asset.Packet.create([
            asset.AssetGroup.create(
                null, // null = issuance
                null,
                [], // no inputs for issuance
                [asset.AssetOutput.create(0, assetAmount)],
                [],
            ),
        ]);

        // Build offchain tx outputs (combined Extension with asset + emulator packets)
        const outputs = [
            { script: alicePkScript, amount: BigInt(fundAmount) },
            makeEmulatorExtensionOutput(0, arkadeScriptBytes, assetPacket),
        ];

        const { arkTx, checkpoints } = buildOffchainTx(
            [{ ...vtxo, tapLeafScript, tapTree }],
            outputs,
            ark.checkpoint,
        );

        // Bob signs the arkTx and checkpoints; emulator auto-finalizes via
        // arkd because it's the last non-arkd signer.
        const bobSignedArkTx = await bob.sign(arkTx);
        const bobSignedCheckpoints = await Promise.all(checkpoints.map((c) => bob.sign(c)));

        const introResult = await emulator.submitTx(
            base64.encode(bobSignedArkTx.toPSBT()),
            bobSignedCheckpoints.map((c) => base64.encode(c.toPSBT())),
        );
        expect(introResult.signedArkTx).toBeTruthy();
    });

    // Settlement flow with asset introspection
    it("TestSettlementWithAsset", { timeout: 180000 }, async () => {
        const alice = await createTestArkWallet();
        const bob = createTestIdentity();
        const ark = await connect(bob);

        const aliceAddress = await alice.wallet.getAddress();
        const aliceWP = getWitnessProgram(aliceAddress);
        const alicePkScript = ArkAddress.decode(aliceAddress).pkScript;

        const assetAmount = 1000;
        const fundAmount = 10000;

        // === Phase 1: Mint ===

        // Settle contract: forces the spend to Alice + 1 asset group summing to
        // assetAmount; plus a server+user CSV exit.
        const settleContract = ark.contract(settleAssetProgram, {
            receiver: aliceWP,
            assetAmount,
        });
        const settleArkadeScript = arkade.resolveAsm(
            settleAssetProgram.functions.settle.arkadeScript.asm,
            {
                receiver: aliceWP,
                assetAmount,
            },
        );
        const settleWP = getWitnessProgram(settleContract.address);

        // Mint contract: forces the spend to the settle contract + 1 asset group.
        const mintContract = ark.contract(mintAssetProgram, {
            receiver: settleWP,
            assetAmount,
        });
        const mintArkadeScript = arkade.resolveAsm(
            mintAssetProgram.functions.mint.arkadeScript.asm,
            {
                receiver: settleWP,
                assetAmount,
            },
        );

        // Fund the mint contract
        faucetOffchain(mintContract.address, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        const mintVtxos = await waitForVtxo(mintContract.pkScript);
        expect(mintVtxos).toHaveLength(1);
        const mintVtxo = mintVtxos[0];

        const mintTapLeaf = mintContract.leafScript(0);
        const settleContractPkScript = settleContract.pkScript;

        // Create issuance asset packet
        const issuancePacket = asset.Packet.create([
            asset.AssetGroup.create(null, null, [], [asset.AssetOutput.create(0, assetAmount)], []),
        ]);

        const { arkTx: mintTx, checkpoints: mintCheckpoints } = buildOffchainTx(
            [
                {
                    ...mintVtxo,
                    tapLeafScript: mintTapLeaf,
                    tapTree: mintContract.tapTree,
                },
            ],
            [
                {
                    script: settleContractPkScript,
                    amount: BigInt(fundAmount),
                },
                makeEmulatorExtensionOutput(0, mintArkadeScript, issuancePacket),
            ],
            ark.checkpoint,
        );

        // Bob signs the mint tx and checkpoints; emulator auto-finalizes via
        // arkd because it's the last non-arkd signer.
        const bobSignedMintTx = await bob.sign(mintTx);
        const bobSignedMintCheckpoints = await Promise.all(mintCheckpoints.map((c) => bob.sign(c)));

        const introMintResult = await emulator.submitTx(
            base64.encode(bobSignedMintTx.toPSBT()),
            bobSignedMintCheckpoints.map((c) => base64.encode(c.toPSBT())),
        );
        // Extract the mint txid from the emulator-finalized PSBT.
        const mintTxid = Transaction.fromPSBT(base64.decode(introMintResult.signedArkTx)).id;
        expect(mintTxid).toBeTruthy();

        // === Phase 2: Settle via intent ===

        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Get the settle VTXO
        const settleVtxos = await waitForVtxo(settleContract.pkScript);
        expect(settleVtxos).toHaveLength(1);
        const settleVtxo = settleVtxos[0];

        const settleArkadeLeaf = settleContract.leafScript(0);
        const settleTapTree = settleContract.tapTree;

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
                [],
            ),
        ]);

        const outputs = [
            {
                script: alicePkScript,
                amount: BigInt(fundAmount),
            },
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
            [...outputs, makeEmulatorExtensionOutput(1, settleArkadeScript, transferPacket)],
        );

        const signedSettleProof = await bob.sign(settleIntentProof);
        const signedSettleProofB64 = base64.encode(signedSettleProof.toPSBT());

        const introSettleProof = await emulator.submitIntent({
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
            emulator,
            networks.regtest,
        );

        const topics = [sessionPubKey, `${settleVtxo.txid}:${settleVtxo.vout}`];
        const abortController = new AbortController();

        try {
            const eventStream = arkProvider.getEventStream(abortController.signal, topics);
            const commitmentTxid = await Batch.join(eventStream, handler, {
                abortController,
            });
            expect(commitmentTxid).toBeDefined();
        } finally {
            abortController.abort();
        }
    });

    // On-chain spend: emulator co-signs a SubmitOnchainTx and the tx broadcasts
    // after the third signature.
    it("TestSubmitOnchainTx", { timeout: 120000 }, async () => {
        // No identity: every signer is a `$param`, so the contract is used purely
        // to derive scripts/addresses; bob/alice sign the PSBTs directly.
        const ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            network: networks.regtest,
        });

        const bob = SingleKey.fromRandomBytes();
        const alice = SingleKey.fromRandomBytes();
        const bobX = await bob.xOnlyPublicKey();
        const aliceX = await alice.xOnlyPublicKey();
        const bobP2TR = p2tr(bobX, undefined, networks.regtest).script;
        const receiver = bobP2TR.slice(2);

        const contract = ark.contract(spendProgram, {
            bob: bobX,
            alice: aliceX,
            receiver,
            amount: SPEND_AMOUNT,
        });
        const arkadeScript = arkade.resolveAsm(spendProgram.functions.spend.arkadeScript.asm, {
            receiver,
            amount: SPEND_AMOUNT,
        });
        const vtxoScript = contract.vtxoScript;
        const tapLeafScript = contract.leafScript(0);

        // fund the contract address on-chain
        faucetOnchain(vtxoScript.onchainAddress(networks.regtest), FUNDING_SATS);
        const utxo = await waitForUtxo(vtxoScript.onchainAddress(networks.regtest));
        const rawFundingTx = hex.decode(await fetchTxHex(utxo.txid));

        // build the unsigned 1-in/1-out spend PSBT with all required arkade fields
        const tx = new Transaction({ version: 2 });
        tx.addInput({
            txid: hex.decode(utxo.txid),
            index: utxo.vout,
            sequence: 0xffffffff,
            witnessUtxo: { amount: FUNDING_AMOUNT, script: vtxoScript.pkScript },
            tapLeafScript: [tapLeafScript],
            sighashType: SigHash.DEFAULT,
        });
        tx.addOutput({ script: bobP2TR, amount: SPEND_AMOUNT });
        setArkPsbtField(tx, 0, PrevoutTxField, rawFundingTx);
        addEmulatorPacket(tx, [
            {
                vin: 0,
                script: arkadeScript,
                // single empty push for output_index = 0
                witness: new Uint8Array([0x01, 0x00]),
            },
        ]);

        // bob signs, then the emulator co-signs
        const bobSigned = await bob.sign(tx, [0]);
        const result = await emulator.submitOnchainTx(base64.encode(bobSigned.toPSBT()));

        const parsed = Transaction.fromPSBT(base64.decode(result.signedTx));
        const sigs = parsed.getInput(0)?.tapScriptSig ?? [];
        expect(sigs.length).toBeGreaterThanOrEqual(2);

        // alice adds the final signature to complete the multisig and broadcast
        const aliceSigned = await alice.sign(parsed, [0]);
        aliceSigned.finalize();
        const broadcastTxid = await explorer.broadcastTransaction(
            hex.encode(aliceSigned.extract()),
        );
        expect(broadcastTxid).toBeTruthy();
    });
});

/** Fetch the raw hex of a transaction from the Esplora REST API */
async function fetchTxHex(txid: string): Promise<string> {
    const resp = await fetch(`${ESPLORA_URL}/tx/${txid}/hex`);
    if (!resp.ok) {
        throw new Error(`fetchTxHex failed: ${resp.statusText}`);
    }
    return resp.text();
}
