import { hex } from "@scure/base";
import {
    DefaultVtxo,
    ExecutorContractHandler,
    SingleKey,
    type InMemoryWalletRepository,
} from "../../src";
import { saveVtxosForContract } from "../../src/contracts/vtxoOwnership";
import { DELEGATION_STATUS_KEY } from "../../src/wallet/executor";
import { createMockExtendedVtxo } from "../contracts/helpers";
import vectors from "../fixtures/executor/vectors.json";

export const OPERATOR_PUBKEY_HEX = vectors.operatorPubkey;
export const DUST = 1000;
export const MAX_FEE = 100;
export const ARK_TXID = "ee".repeat(32);
export const HOUR = 3_600_000;
export const arkInfo = {
    signerPubkey: OPERATOR_PUBKEY_HEX,
    forfeitPubkey: OPERATOR_PUBKEY_HEX,
    batchExpiry: BigInt(144),
    unilateralExitDelay: BigInt(144),
    boardingExitDelay: BigInt(144),
    roundInterval: BigInt(144),
    network: "mutinynet",
    dust: BigInt(DUST),
    forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    checkpointTapscript:
        "039d0440b2752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac",
};
export const identity = SingleKey.fromHex(
    "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2",
);
export const operatorXOnly = hex.decode(OPERATOR_PUBKEY_HEX).subarray(1);
export const bob = new DefaultVtxo.Script({
    pubKey: await SingleKey.fromHex("11".repeat(32)).xOnlyPublicKey(),
    serverPubKey: operatorXOnly,
    csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
})
    .address("tark", operatorXOnly)
    .encode();

export interface RowOptions {
    maxFee?: number;
    operatorPubkey?: string;
    metadata?: Record<string, unknown>;
    /** Compressed; the identity's by default. */
    owner?: Uint8Array;
}

/** The identity's live renewal watch; `maxFee` tells two watches apart. */
export async function renewalRow({
    maxFee = MAX_FEE,
    operatorPubkey = OPERATOR_PUBKEY_HEX,
    metadata = { [DELEGATION_STATUS_KEY]: "active" },
    owner,
}: RowOptions = {}) {
    const params = ExecutorContractHandler.serializeParams({
        template: "renewal",
        owner: owner ?? (await identity.compressedPublicKey()),
        exitDelay: 144,
        renewalWindow: 1000,
        maxFee,
        batchCosignerPubKey: hex.decode(vectors.batchCosignerPubkey),
        operatorPubKey: hex.decode(operatorPubkey),
        emulatorPubKey: hex.decode(vectors.emulatorPubkey),
    });
    const script = ExecutorContractHandler.createScript(params);
    return {
        script,
        contract: {
            type: "executor",
            params,
            script: hex.encode(script.pkScript),
            address: script.address("tark", operatorXOnly).encode(),
            state: "active" as const,
            createdAt: Date.now(),
            metadata,
        },
    };
}
export type Row = Awaited<ReturnType<typeof renewalRow>>;

/** A spendable coin at `script`, kept in `address`'s bucket. */
export async function seed(
    walletRepository: InMemoryWalletRepository,
    bucket: { script: string; address: string },
    byte: string,
    value = 10_000,
) {
    const coin = createMockExtendedVtxo({
        script: bucket.script,
        txid: byte.repeat(32),
        value,
        isPreconfirmed: true,
        commitmentTxIds: ["cc".repeat(32)],
        expiresAt: new Date(Date.now() + 100 * HOUR),
    });
    await saveVtxosForContract(walletRepository, bucket, [coin]);
    return coin;
}
