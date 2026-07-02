import { describe, it, expect, beforeEach } from "vitest";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { numberToBytesBE } from "@noble/curves/utils.js";
import {
    arkade,
    asset,
    buildOffchainTx,
    EmulatorPacket,
    Extension,
    networks,
    RestArkProvider,
    RestEmulatorProvider,
    RestIndexerProvider,
    Transaction,
} from "../../src";
import type { ExtensionPacket } from "../../src/extension";
import { beforeEachFaucet, faucetOffchain, randomP2TR } from "./utils";

const EMULATOR_URL = "http://localhost:7073";
const ARK_SERVER_URL = "http://localhost:7070";
const CONTRACT_AMOUNT = 10_000;
const ASSET_AMOUNT = 1_000n;

const ORACLE_PRIV = hex.decode("1122334455667788112233445566778811223344556677881122334455667788");
const ORACLE_PUBKEY = schnorr.getPublicKey(ORACLE_PRIV);
const LIQUIDATION_PRICE = numberToBytesBE(50_000n, 32);

// Forces its spend to pay output 0 to `$receiver` — used to mint the asset into
// the liquidation contract.
const mintProgram = {
    version: 0,
    functions: {
        mint: {
            tapscript: { signers: ["server"] },
            arkadeScript: {
                asm: [0, "INSPECTOUTPUTSCRIPTPUBKEY", 1, "EQUALVERIFY", "$receiver", "EQUAL"],
            },
        },
    },
} satisfies arkade.Program;

// Burns the asset against a valid oracle signature over the liquidation price.
const liquidationProgram = {
    version: 0,
    functions: {
        liquidate: {
            inputs: [{ name: "signature", type: "sig" }],
            tapscript: { signers: ["server"] },
            arkadeScript: {
                asm: [
                    // CHECKSIGFROMSTACK pops oracle, price, signature (from witness)
                    "$price",
                    "$oracle",
                    "CHECKSIGFROMSTACK",
                    "VERIFY",
                    // one asset group whose output sum is 0 (fully burned)
                    "INSPECTNUMASSETGROUPS",
                    1,
                    "EQUALVERIFY",
                    0,
                    1,
                    "INSPECTASSETGROUPSUM",
                    0,
                    "EQUAL",
                ],
                witness: ["signature"],
            },
        },
    },
} satisfies arkade.Program;

describe("liquidation (oracle-signed asset burn)", () => {
    const emulator = new RestEmulatorProvider(EMULATOR_URL);
    const arkProvider = new RestArkProvider(ARK_SERVER_URL);
    const indexerProvider = new RestIndexerProvider(ARK_SERVER_URL);

    beforeEach(beforeEachFaucet, 20000);

    it("liquidate", { timeout: 120000 }, async () => {
        const ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            indexer: indexerProvider,
            network: networks.regtest,
        });

        const liquidation = ark.contract(liquidationProgram, {
            oracle: ORACLE_PUBKEY,
            price: LIQUIDATION_PRICE,
        });
        const liquidationWP = liquidation.pkScript.slice(2);

        // mint the asset into the liquidation contract
        const mint = ark.contract(mintProgram, { receiver: liquidationWP });
        const mintArkadeScript = arkade.resolveAsm(mintProgram.functions.mint.arkadeScript.asm, {
            receiver: liquidationWP,
        });

        faucetOffchain(mint.address, CONTRACT_AMOUNT);
        const [mintCoin] = await waitForVtxo(indexerProvider, mint.pkScript);

        const issuancePacket = asset.Packet.create([
            asset.AssetGroup.create(
                null,
                null,
                [],
                [asset.AssetOutput.create(0, ASSET_AMOUNT)],
                [],
            ),
        ]);

        const { arkTx: mintTx, checkpoints: mintCheckpoints } = buildOffchainTx(
            [{ ...mintCoin, tapLeafScript: mint.leafScript(0), tapTree: mint.tapTree }],
            [
                { script: liquidation.pkScript, amount: BigInt(CONTRACT_AMOUNT) },
                emulatorExtensionOut(0, mintArkadeScript, issuancePacket),
            ],
            ark.checkpoint,
        );

        const mintResult = await emulator.submitTx(
            base64.encode(mintTx.toPSBT()),
            mintCheckpoints.map((c) => base64.encode(c.toPSBT())),
        );
        const mintTxid = Transaction.fromPSBT(base64.decode(mintResult.signedArkTx)).id;

        const assetId = asset.AssetId.create(mintTxid, 0).toString();
        const burn = { assetId, inputs: [{ vin: 0, amount: ASSET_AMOUNT }], outputs: [] };

        const [liqCoin] = await waitForVtxo(indexerProvider, liquidation.pkScript);
        expect(liqCoin.value).toBe(CONTRACT_AMOUNT);

        // wrong price → rejected
        const wrongSig = schnorr.sign(numberToBytesBE(49_999n, 32), ORACLE_PRIV);
        await expect(
            liquidation.functions
                .liquidate(wrongSig)
                .from(liqCoin)
                .withAsset(burn)
                .to(randomP2TR(), BigInt(CONTRACT_AMOUNT))
                .send(),
        ).rejects.toThrow();

        // oracle signs the liquidation price → burn authorized
        const oracleSig = schnorr.sign(LIQUIDATION_PRICE, ORACLE_PRIV);
        const { txid } = await liquidation.functions
            .liquidate(oracleSig)
            .from(liqCoin)
            .withAsset(burn)
            .to(randomP2TR(), BigInt(CONTRACT_AMOUNT))
            .send();
        expect(txid).toBeTruthy();
    });
});

function emulatorExtensionOut(vin: number, script: Uint8Array, ...extra: ExtensionPacket[]) {
    const packet = EmulatorPacket.create([{ vin, script, witness: new Uint8Array(0) }]);
    return Extension.create([...extra, packet]).txOut();
}

async function waitForVtxo(indexer: RestIndexerProvider, pkScript: Uint8Array, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const resp = await indexer.getVtxos({
            scripts: [hex.encode(pkScript)],
            spendableOnly: true,
        });
        if (resp.vtxos.length > 0) return resp.vtxos;
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("waitForVtxo: timeout");
}
