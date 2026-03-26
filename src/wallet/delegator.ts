import { TransactionOutput } from "@scure/btc-signer/psbt";
import {
    ArkAddress,
    ArkInfo,
    ArkProvider,
    Asset,
    decodeTapscript,
    DelegateInfo,
    Estimator,
    ExtendedCoin,
    ExtendedVirtualCoin,
    Identity,
    Intent,
    isRecoverable,
    MultisigTapscript,
    Outpoint,
    Recipient,
    SignedIntent,
    Transaction,
    VirtualCoin,
    VtxoScript,
} from "..";
import { DelegatorProvider } from "../providers/delegator";
import { base64, hex } from "@scure/base";
import { scriptFromTapLeafScript } from "../script/base";
import { buildForfeitTxWithOutput } from "../forfeit";
import { Address, OutScript, SigHash } from "@scure/btc-signer";
import { Bytes } from "@scure/btc-signer/utils";
import { equalBytes } from "@scure/btc-signer/utils.js";
import { getNetwork, NetworkName } from "../networks";
import { createAssetPacket } from "./asset";
import { Extension } from "../extension";

export interface IDelegatorManager {
    delegate(
        vtxos: ExtendedVirtualCoin[],
        destination: string,
        delegateAt?: Date
    ): Promise<{
        delegated: Outpoint[];
        failed: { outpoints: Outpoint[]; error: unknown }[];
    }>;

    getDelegateInfo(): Promise<DelegateInfo>;
}

export class DelegatorManagerImpl implements IDelegatorManager {
    constructor(
        readonly delegatorProvider: DelegatorProvider,
        readonly arkInfoProvider: Pick<ArkProvider, "getInfo">,
        readonly identity: Identity
    ) {}

    async getDelegateInfo(): Promise<DelegateInfo> {
        return this.delegatorProvider.getDelegateInfo();
    }

    async delegate(
        vtxos: ExtendedVirtualCoin[],
        destination: string,
        delegateAt?: Date
    ): Promise<{
        delegated: Outpoint[];
        failed: { outpoints: Outpoint[]; error: unknown }[];
    }> {
        if (vtxos.length === 0) {
            return { delegated: [], failed: [] };
        }

        const destinationScript = ArkAddress.decode(destination).pkScript;

        // fetch server and delegator info once, shared across all groups
        const arkInfo = await this.arkInfoProvider.getInfo();
        const delegateInfo = await this.delegatorProvider.getDelegateInfo();

        // if explicit delegateAt is provided, delegate all vtxos at once without sorting
        if (delegateAt) {
            try {
                await delegate(
                    this.identity,
                    this.delegatorProvider,
                    arkInfo,
                    delegateInfo,
                    vtxos,
                    destinationScript,
                    delegateAt
                );
            } catch (error) {
                return { delegated: [], failed: [{ outpoints: vtxos, error }] };
            }
            return { delegated: vtxos, failed: [] };
        }

        // if no explicit delegateAt is provided, sort vtxos by expiry and delegate in groups of the same expiry day
        const groupByExpiry: Map<number, ExtendedVirtualCoin[]> = new Map();
        let recoverableVtxos: ExtendedVirtualCoin[] = [];

        for (const vtxo of vtxos) {
            if (isRecoverable(vtxo)) {
                recoverableVtxos.push(vtxo);
                continue;
            }

            const expiry = vtxo.virtualStatus.batchExpiry;
            if (!expiry) continue;

            const dayKey = getDayTimestamp(expiry);
            groupByExpiry.set(dayKey, [
                ...(groupByExpiry.get(dayKey) ?? []),
                vtxo,
            ]);
        }

        // if no groups, it means we only need to delegate the recoverable vtxos
        if (groupByExpiry.size === 0) {
            try {
                await delegate(
                    this.identity,
                    this.delegatorProvider,
                    arkInfo,
                    delegateInfo,
                    recoverableVtxos,
                    destinationScript,
                    delegateAt
                );
            } catch (error) {
                return {
                    delegated: [],
                    failed: [{ outpoints: recoverableVtxos, error }],
                };
            }
            return { delegated: recoverableVtxos, failed: [] };
        }

        // search for the earliest group, include recoverable vtxos into it
        const earliestGroup = Math.min(...groupByExpiry.keys());

        groupByExpiry.set(earliestGroup, [
            ...(groupByExpiry.get(earliestGroup) ?? []),
            ...recoverableVtxos,
        ]);

        const groupsList = Array.from(groupByExpiry.entries());

        const result = await Promise.allSettled(
            groupsList.map(async ([, vtxosGroup]) =>
                delegate(
                    this.identity,
                    this.delegatorProvider,
                    arkInfo,
                    delegateInfo,
                    vtxosGroup,
                    destinationScript
                )
            )
        );

        const delegated: Outpoint[] = [];
        const failed: { outpoints: Outpoint[]; error: unknown }[] = [];

        for (const [index, resultItem] of result.entries()) {
            const vtxos = groupsList[index][1];
            if (resultItem.status === "rejected") {
                failed.push({ outpoints: vtxos, error: resultItem.reason });
                continue;
            }

            delegated.push(...vtxos);
        }

        return { delegated, failed };
    }
}

/**
 * Delegates virtual coins to a delegator provider, allowing them to manage the coins renewal
 * on behalf of the wallet.
 * @param vtxos - Array of extended virtual coins to delegate. Must not be empty.
 * @param delegateAt - Optional Date specifying when the delegation
 *                     should occur. If not provided, defaults to 12 hours before the earliest
 *                     expiry time of the provided vtxos.
 */
async function delegate(
    identity: Identity,
    delegatorProvider: DelegatorProvider,
    arkInfo: ArkInfo,
    delegateInfo: DelegateInfo,
    vtxos: ExtendedVirtualCoin[],
    destinationScript: Bytes,
    delegateAt?: Date
): Promise<void> {
    if (vtxos.length === 0) {
        throw new Error("unable to delegate: no vtxos provided");
    }

    if (!delegatorProvider) {
        throw new Error(
            "unable to delegate: delegator provider not configured"
        );
    }

    if (!delegateAt) {
        const expiryTimestamp = vtxos
            .filter(
                (coin) => !isRecoverable(coin) && coin.virtualStatus.batchExpiry
            )
            .reduce(
                (min, coin) => Math.min(min, coin.virtualStatus.batchExpiry!),
                Number.MAX_SAFE_INTEGER
            );
        if (!expiryTimestamp || expiryTimestamp === Number.MAX_SAFE_INTEGER) {
            // if no expiry (recoverable vtxos), delegate 1 minute from now
            delegateAt = new Date(Date.now() + 1 * 60 * 1000);
        } else {
            const remainingTimeMs = expiryTimestamp - Date.now();
            if (remainingTimeMs <= 0) {
                delegateAt = new Date(Date.now() + 1 * 60 * 1000);
            } else {
                // delegate 10% before the expiry
                delegateAt = new Date(expiryTimestamp - remainingTimeMs * 0.1);
            }
        }
    }
    const { fees, dust, forfeitAddress, network } = arkInfo;

    const delegateAtSeconds = delegateAt.getTime() / 1000;
    const estimator = new Estimator({
        ...fees.intentFee,
        // replace now() function with the delegateAt timestamp
        offchainInput: fees.intentFee.offchainInput?.replace(
            "now()",
            `double(${delegateAtSeconds})`
        ),
        offchainOutput: fees.intentFee.offchainOutput?.replace(
            "now()",
            `double(${delegateAtSeconds})`
        ),
    });

    let amount = 0n;
    for (const coin of vtxos) {
        const inputFee = estimator.evalOffchainInput({
            amount: BigInt(coin.value),
            type: "vtxo",
            weight: 0,
            birth: coin.createdAt,
            expiry: coin.virtualStatus.batchExpiry
                ? new Date(coin.virtualStatus.batchExpiry)
                : undefined,
        });
        if (inputFee.value >= coin.value) {
            continue;
        }
        amount += BigInt(coin.value) - BigInt(inputFee.value);
    }
    const { delegatorAddress, pubkey, fee } = delegateInfo;

    const outputs = [];
    const delegatorFee = BigInt(Number(fee));

    if (delegatorFee > 0n) {
        outputs.push({
            script: ArkAddress.decode(delegatorAddress).pkScript,
            amount: delegatorFee,
        });
    }

    const outputFee = outputs.reduce((fee, output) => {
        if (!output.amount || !output.script) return fee;
        return (
            fee +
            estimator.evalOffchainOutput({
                amount: output.amount,
                script: hex.encode(output.script),
            }).satoshis
        );
    }, 0);

    if (amount - BigInt(outputFee) <= dust) {
        throw new Error("Amount is below dust limit, cannot delegate");
    }
    amount -= BigInt(outputFee);

    amount -= delegatorFee;
    if (amount <= dust) {
        throw new Error("Amount is below dust limit, cannot delegate");
    }

    outputs.push({
        script: destinationScript,
        amount: amount,
    });

    const registerIntent = await makeSignedDelegateIntent(
        identity,
        vtxos,
        outputs,
        [],
        [pubkey],
        delegateAtSeconds,
        destinationScript
    );

    const forfeitOutputScript = OutScript.encode(
        Address(getNetwork(network as NetworkName)).decode(forfeitAddress)
    );

    const forfeits = await Promise.all(
        vtxos
            .filter((v) => !isRecoverable(v))
            .map(async (coin) => {
                const forfeit = await makeDelegateForfeitTx(
                    coin,
                    dust,
                    pubkey,
                    forfeitOutputScript,
                    identity
                );
                return base64.encode(forfeit.toPSBT());
            })
    );

    await delegatorProvider.delegate(registerIntent, forfeits);
}

async function makeDelegateForfeitTx(
    input: ExtendedVirtualCoin,
    connectorAmount: bigint,
    delegatePubkey: string,
    forfeitOutputScript: Bytes,
    identity: Identity
): Promise<Transaction> {
    if (delegatePubkey.length === 66) {
        delegatePubkey = delegatePubkey.slice(2);
    }

    const vtxoScript = VtxoScript.decode(input.tapTree);
    const delegateTapLeaf = vtxoScript.leaves.find((tapLeaf) => {
        const arkTapscript = decodeTapscript(scriptFromTapLeafScript(tapLeaf));
        if (!MultisigTapscript.is(arkTapscript)) return false;
        if (
            !arkTapscript.params.pubkeys
                .map(hex.encode)
                .includes(delegatePubkey)
        )
            return false;
        return true;
    });

    if (!delegateTapLeaf) {
        throw new Error(
            `delegate tap leaf not found for input: ${input.txid}:${input.vout}`
        );
    }

    const tx = buildForfeitTxWithOutput(
        [
            {
                txid: input.txid,
                index: input.vout,
                witnessUtxo: {
                    amount: BigInt(input.value),
                    script: VtxoScript.decode(input.tapTree).pkScript,
                },
                sighashType: SigHash.ALL_ANYONECANPAY,
                tapLeafScript: [delegateTapLeaf],
            },
        ],
        {
            script: forfeitOutputScript,
            amount: BigInt(input.value) + connectorAmount,
        }
    );

    return identity.sign(tx);
}

async function makeSignedDelegateIntent(
    identity: Identity,
    coins: ExtendedCoin[],
    outputs: TransactionOutput[],
    onchainOutputsIndexes: number[],
    cosignerPubKeys: string[],
    validAt: number,
    destinationScript: Bytes
): Promise<SignedIntent<Intent.RegisterMessage>> {
    // if some of the inputs hold assets, build the asset packet and append as output
    // in the intent proof tx, there is a "fake" input at index 0
    // so the real coin indices are offset by +1
    const assetInputs = new Map<number, Asset[]>();
    for (let i = 0; i < coins.length; i++) {
        if ("assets" in coins[i]) {
            const assets = (coins[i] as unknown as VirtualCoin).assets;
            if (assets && assets.length > 0) {
                assetInputs.set(i + 1, assets);
            }
        }
    }

    let outputAssets: Asset[] | undefined;

    const assetOutputIndex = findDestinationOutputIndex(
        outputs,
        destinationScript
    );

    if (assetInputs.size > 0) {
        if (assetOutputIndex === -1) {
            throw new Error(
                "Cannot assign assets: no output matches the destination address"
            );
        }
        // collect all input assets and assign them to the first offchain output
        const allAssets = new Map<string, bigint>();
        for (const [, assets] of assetInputs) {
            for (const asset of assets) {
                const existing = allAssets.get(asset.assetId) ?? 0n;
                allAssets.set(asset.assetId, existing + BigInt(asset.amount));
            }
        }

        outputAssets = [];
        for (const [assetId, amount] of allAssets) {
            outputAssets.push({ assetId, amount: Number(amount) });
        }
    }

    const recipients: Recipient[] = outputs.map((output, i) => ({
        address: "", // not needed for asset packet creation
        amount: Number(output.amount),
        assets: i === assetOutputIndex ? outputAssets : undefined,
    }));

    if (outputAssets && outputAssets.length > 0) {
        const assetPacket = createAssetPacket(assetInputs, recipients);
        outputs.push(Extension.create([assetPacket]).txOut());
    }

    const message: Intent.RegisterMessage = {
        type: "register",
        onchain_output_indexes: onchainOutputsIndexes,
        valid_at: Math.floor(validAt),
        expire_at: 0,
        cosigners_public_keys: cosignerPubKeys,
    };

    const proof = Intent.create(message, coins, outputs);
    const signedProof = await identity.sign(proof);

    return {
        proof: base64.encode(signedProof.toPSBT()),
        message,
    };
}

/**
 * Finds the index of the output whose script matches the destination script.
 * Returns -1 if no match is found.
 */
export function findDestinationOutputIndex(
    outputs: TransactionOutput[],
    destinationScript: Bytes
): number {
    return outputs.findIndex(
        (o) => o.script && equalBytes(o.script, destinationScript)
    );
}

function getDayTimestamp(timestamp: number): number {
    const date = new Date(timestamp);
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime();
}
