import { TransactionOutput } from "@scure/btc-signer/psbt";
import {
    ArkAddress,
    ArkProvider,
    decodeTapscript,
    Estimator,
    ExtendedCoin,
    ExtendedVirtualCoin,
    Identity,
    Intent,
    isRecoverable,
    MultisigTapscript,
    Outpoint,
    SignedIntent,
    Transaction,
    VtxoScript,
} from "..";
import { DelegatorProvider } from "../providers/delegator";
import { base64, hex } from "@scure/base";
import { scriptFromTapLeafScript } from "../script/base";
import { buildForfeitTxWithOutput } from "../forfeit";
import { Address, OutScript, SigHash } from "@scure/btc-signer";
import { Bytes } from "@scure/btc-signer/utils";
import { getNetwork, NetworkName } from "../networks";

export interface DelegatorManager {
    delegate(
        vtxos: ExtendedVirtualCoin[],
        destination: string,
        delegateAt?: Date
    ): Promise<{
        delegated: Outpoint[];
        failed: { outpoints: Outpoint[]; error: unknown }[];
    }>;
}

export class DelegatorManagerImpl implements DelegatorManager {
    constructor(
        readonly delegatorProvider: DelegatorProvider,
        readonly arkInfoProvider: Pick<ArkProvider, "getInfo">,
        readonly identity: Identity
    ) {}

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

        // if explicit delegateAt is provided, delegate all vtxos at once without sorting
        if (delegateAt) {
            try {
                await delegate(
                    this.identity,
                    this.delegatorProvider,
                    this.arkInfoProvider,
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
                    this.arkInfoProvider,
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
                    this.arkInfoProvider,
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
    arkInfoProvider: Pick<ArkProvider, "getInfo">,
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
        const expireAt = vtxos
            .filter(
                (coin) => !isRecoverable(coin) && coin.virtualStatus.batchExpiry
            )
            .reduce(
                (min, coin) => Math.min(min, coin.virtualStatus.batchExpiry!),
                Number.MAX_SAFE_INTEGER
            );
        if (!expireAt || expireAt === Number.MAX_SAFE_INTEGER) {
            // if no expiry (recoverable vtxos), delegate 1 minute from now
            delegateAt = new Date(Date.now() + 1 * 60 * 1000);
        } else {
            // delegate 10% before the expiry
            const remainingTime = expireAt - Date.now();
            if (remainingTime <= 0) {
                delegateAt = new Date(Date.now() + 1 * 60 * 1000);
            } else {
                delegateAt = new Date(expireAt - remainingTime * 0.1);
            }
        }
    }
    const { fees, dust, forfeitAddress, network } =
        await arkInfoProvider.getInfo();

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
    const { delegatorAddress, pubkey, fee } =
        await delegatorProvider.getDelegateInfo();

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
        delegateAtSeconds
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
    validAt: number
): Promise<SignedIntent<Intent.RegisterMessage>> {
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

function getDayTimestamp(timestamp: number): number {
    const date = new Date(timestamp);
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime();
}
