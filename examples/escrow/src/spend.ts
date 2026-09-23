import { base64, hex } from "@scure/base";

import {
    Arkade,
    type ArkadeContract,
    type Utxo,
} from "../../../packages/ts-sdk/src/arkade/contract.ts";
import type { Program } from "../../../packages/ts-sdk/src/arkade/program.ts";
import { SingleKey } from "../../../packages/ts-sdk/src/identity/singleKey.ts";
import { networks, type Network } from "../../../packages/ts-sdk/src/networks.ts";
import { RestArkProvider } from "../../../packages/ts-sdk/src/providers/ark.ts";
import { RestEmulatorProvider } from "../../../packages/ts-sdk/src/providers/emulator.ts";
import { RestIndexerProvider } from "../../../packages/ts-sdk/src/providers/indexer.ts";
import { ArkAddress } from "../../../packages/ts-sdk/src/script/address.ts";
import {
    assertSubmittedArkTxid,
    matchServerCheckpoints,
} from "../../../packages/ts-sdk/src/utils/arkTransaction.ts";
import { timelockToSequence } from "../../../packages/ts-sdk/src/utils/timelock.ts";
import { Transaction } from "../../../packages/ts-sdk/src/utils/transaction.ts";
import escrowProgram from "../escrow.program.json";
import { cancelOutputs, completeOutputs, unilateralOutputs, type PayOutput } from "./outputs.ts";

const program = escrowProgram as Program;

export const RELEASE_LABEL = "release-to-seller";

export interface DemoNetwork {
    name: "mutinynet" | "bitcoin";
    label: string;
    network: Network;
    arkUrl: string;
    emulatorUrl: string;
    walletUrl: string;
}

export const DEMO_NETWORKS: DemoNetwork[] = [
    {
        name: "mutinynet",
        label: "Mutinynet",
        network: networks.mutinynet,
        arkUrl: "https://mutinynet.arkade.sh",
        emulatorUrl: "https://emulator.mutinynet.arkade.sh",
        walletUrl: "https://mutinynet.arkade.money",
    },
    {
        name: "bitcoin",
        label: "Bitcoin",
        network: networks.bitcoin,
        arkUrl: "https://arkade.computer",
        emulatorUrl: "https://emulator.arkade.computer",
        walletUrl: "https://bitcoin.arkade.money",
    },
];

export interface DemoKeys {
    buyer: SingleKey;
    seller: SingleKey;
    oracle: SingleKey;
}

const KEY_STORAGE = "arkade-escrow-demo-keys";

export function loadKeys(): DemoKeys {
    const saved = localStorage.getItem(KEY_STORAGE);
    if (saved) {
        const parsed = JSON.parse(saved) as { buyer: string; seller: string; oracle: string };
        return {
            buyer: SingleKey.fromHex(parsed.buyer),
            seller: SingleKey.fromHex(parsed.seller),
            oracle: SingleKey.fromHex(parsed.oracle),
        };
    }
    const keys = {
        buyer: SingleKey.fromRandomBytes(),
        seller: SingleKey.fromRandomBytes(),
        oracle: SingleKey.fromRandomBytes(),
    };
    localStorage.setItem(
        KEY_STORAGE,
        JSON.stringify({
            buyer: keys.buyer.toHex(),
            seller: keys.seller.toHex(),
            oracle: keys.oracle.toHex(),
        }),
    );
    return keys;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/** 32-byte attestation. The contract commits sha256 of this, and the oracle signs it. */
export async function releaseMessage(): Promise<Uint8Array> {
    return sha256(new TextEncoder().encode(RELEASE_LABEL));
}

export interface Payout {
    /** 32-byte witness program the covenant compares. */
    program: Uint8Array;
    /** Output script that pays that program. */
    pkScript: Uint8Array;
}

export function payoutFromAddress(address: string, hrp: string, serverKey: Uint8Array): Payout {
    let decoded: ArkAddress;
    try {
        decoded = ArkAddress.decode(address.trim());
    } catch {
        throw new Error("that is not an Arkade address");
    }
    if (decoded.hrp !== hrp) {
        throw new Error(`that address is for ${decoded.hrp}, this operator uses ${hrp}`);
    }
    if (!equalBytes(decoded.serverPubKey, serverKey)) {
        throw new Error("that address belongs to a different Arkade operator");
    }
    return { program: decoded.vtxoTaprootKey, pkScript: decoded.pkScript };
}

export interface PreparedEscrow {
    demo: DemoNetwork;
    contract: ArkadeContract;
    ark: RestArkProvider;
    emulatorVersion: string;
    message: Uint8Array;
    oracle: SingleKey;
    buyer: SingleKey;
    seller: SingleKey;
    exit: bigint;
}

/** Operator unilateral exit delay. Public arkd requires the escrow exit to be at least this. */
export async function minimumExitDelay(demo: DemoNetwork): Promise<bigint> {
    return (await new RestArkProvider(demo.arkUrl).getInfo()).unilateralExitDelay;
}

export async function prepareEscrow(input: {
    demo: DemoNetwork;
    buyerAddress: string;
    sellerAddress: string;
    amount: bigint;
    timeoutAt: bigint;
    exit: bigint;
    keys: DemoKeys;
}): Promise<PreparedEscrow> {
    const ark = new RestArkProvider(input.demo.arkUrl);
    const indexer = new RestIndexerProvider(input.demo.arkUrl);
    const emulator = new RestEmulatorProvider(input.demo.emulatorUrl);
    const [client, emulatorInfo, message, info] = await Promise.all([
        Arkade.connect({
            arkade: ark,
            indexer,
            emulator,
            identity: input.keys.buyer,
            network: input.demo.network,
        }),
        fetch(`${input.demo.emulatorUrl}/v1/info`).then(async (response) => {
            if (!response.ok) throw new Error(`emulator info failed: ${response.status}`);
            return response.json() as Promise<{ version?: string }>;
        }),
        releaseMessage(),
        ark.getInfo(),
    ]);
    // Public arkd rejects a block CSV on an exit leaf, and a seconds delay
    // shorter than the operator's own unilateral exit.
    if (input.exit % 512n !== 0n) {
        throw new Error("unilateral delay must be a multiple of 512 seconds");
    }
    if (input.exit < info.unilateralExitDelay) {
        throw new Error(
            `unilateral delay must be at least ${info.unilateralExitDelay} seconds on this operator`,
        );
    }
    const buyer = payoutFromAddress(input.buyerAddress, input.demo.network.hrp, client.serverKey);
    const seller = payoutFromAddress(input.sellerAddress, input.demo.network.hrp, client.serverKey);
    const [buyerPk, sellerPk, oraclePk, messageHash] = await Promise.all([
        input.keys.buyer.xOnlyPublicKey(),
        input.keys.seller.xOnlyPublicKey(),
        input.keys.oracle.xOnlyPublicKey(),
        sha256(message),
    ]);
    const contract = client.contract(program, {
        partyAPk: buyerPk,
        partyBPk: sellerPk,
        oraclePk,
        oracleMessageHash: messageHash,
        partyAScript: buyer.program,
        partyBScript: seller.program,
        amount: input.amount,
        timeoutAt: input.timeoutAt,
        exit: input.exit,
    });
    return {
        demo: input.demo,
        contract,
        ark,
        emulatorVersion: emulatorInfo.version ?? "",
        message,
        oracle: input.keys.oracle,
        buyer: input.keys.buyer,
        seller: input.keys.seller,
        exit: input.exit,
    };
}

export async function spendComplete(
    prepared: PreparedEscrow,
    coin: Utxo,
    sellerScript: Uint8Array,
    buyerScript: Uint8Array,
    amount: bigint,
): Promise<string> {
    const signature = await prepared.oracle.signMessage(prepared.message, "schnorr");
    const outputs = completeOutputs(BigInt(coin.value), amount, sellerScript, buyerScript);
    const result = await prepared.contract.functions
        .complete(prepared.message, signature)
        .from(coin)
        .to(outputs)
        .send();
    return result.txid;
}

export async function spendCancel(
    prepared: PreparedEscrow,
    coin: Utxo,
    buyerScript: Uint8Array,
): Promise<string> {
    const outputs = cancelOutputs(BigInt(coin.value), buyerScript);
    const result = await prepared.contract.functions.cancel().from(coin).to(outputs).send();
    return result.txid;
}

/**
 * Both unilateral keys live in this page. The high-level sender has one
 * identity, so this signs the leaf with each key and submits the tapscript
 * the way `ArkadeTransactionBuilder.send` does for a covenant-less path.
 */
export async function spendUnilateral(
    prepared: PreparedEscrow,
    coin: Utxo,
    sellerScript: Uint8Array,
): Promise<string> {
    const outputs = unilateralOutputs(BigInt(coin.value), sellerScript);
    const sequence = timelockToSequence({ type: "seconds", value: prepared.exit });
    const built = await prepared.contract.functions.unilateral().from(coin).to(outputs).build();
    setSequence(built.arkTx, sequence);
    for (const checkpoint of built.checkpoints) setSequence(checkpoint, sequence);

    let arkTx = built.arkTx;
    for (const key of [prepared.buyer, prepared.seller]) {
        arkTx = await key.sign(arkTx, [0]);
    }
    const submitted = built.checkpoints.map((checkpoint) => base64.encode(checkpoint.toPSBT()));
    const response = await prepared.ark.submitTx(base64.encode(arkTx.toPSBT()), submitted);
    assertSubmittedArkTxid(response, arkTx, "submitTx");
    const matched = matchServerCheckpoints(
        response.signedCheckpointTxs,
        built.checkpoints,
        "submitTx",
    );
    const finalCheckpoints: string[] = [];
    for (const { server } of matched) {
        setSequence(server, sequence);
        let signed = server;
        for (const key of [prepared.buyer, prepared.seller]) {
            signed = await key.sign(signed, [0]);
        }
        finalCheckpoints.push(base64.encode(signed.toPSBT()));
    }
    await prepared.ark.finalizeTx(response.arkTxid, finalCheckpoints);
    return response.arkTxid;
}

function setSequence(tx: Transaction, sequence: number): void {
    tx.updateInput(0, { sequence });
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
    return true;
}

export function shortHex(bytes: Uint8Array): string {
    const encoded = hex.encode(bytes);
    return `${encoded.slice(0, 8)}…${encoded.slice(-8)}`;
}

export type { PayOutput };
