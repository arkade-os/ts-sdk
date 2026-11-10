import { base64, hex } from "@scure/base";
import { RawWitness } from "@scure/btc-signer";
import { equalBytes } from "@scure/btc-signer/utils.js";
import { Estimator } from "../arkfee";
import { Extension } from "../extension";
import { EmulatorPacket } from "../extension/emulator";
import {
    Packet as AssetPacket,
    AssetGroup,
    AssetInput,
    AssetOutput,
    AssetId,
} from "../extension/asset";
import type { ExtensionPacket } from "../extension/packet";
import { Proof } from "../proof";
import type { OperatorProvider } from "../providers/ark";
import { TreeSignerSession, type SignerSession } from "../tree/signingSession";
import { withPrevTxs } from "../utils/prevoutTx";
import type { VirtualCoin } from "../wallet";
import { normalizeVtxo, toOffchainInputFeeParams } from "../wallet/vtxo";
import { Batch } from "../wallet/batch";
import { createArkadeBatchHandler } from "./batch";
import type { Arkade, ArkadeContract } from "./contract";
import { staticWitness } from "./program";

const ABORTED = "renewProgramContractOutputs: aborted before the batch completed";

/** A covenant VTXO and the function that renews it. */
export interface ProgramContractRenewTarget {
    // `<any>`, as in ArkadeTransactionBuilder: a contract of a literal program is not assignable
    // to ArkadeContract<Program>, and renewal reads nothing program-specific.
    contract: ArkadeContract<any>;
    coin: VirtualCoin;
    /**
     * Covenant function that lets proof input k+1 through to proof output k unchanged (the
     * emulator enforces it), e.g.
     * `require(tx.version == 2); require(this.tunnel(this.activeInputIndex - 1));`. Default `renew`.
     */
    fn?: string;
}

/**
 * Renews covenant VTXOs into a new batch without any owner key: the emulator signs the intent
 * proof after running each covenant and co-signs the forfeits, so a keeper can keep coins alive
 * while their owners are offline. Returns the commitment txid.
 */
export async function renewProgramContractOutputs(
    client: Arkade,
    targets: ProgramContractRenewTarget[],
    opts: { session?: SignerSession; signal?: AbortSignal } = {},
): Promise<{ commitmentTxid: string; intentId: string }> {
    const { emulator, indexer, network } = client;
    const arkProvider = client.arkProvider as OperatorProvider;
    if (!emulator || !indexer || typeof arkProvider.registerIntent !== "function") {
        throw new Error(
            "renewProgramContractOutputs: the Arkade client needs an emulator, an indexer and a full OperatorProvider",
        );
    }
    if (targets.length === 0) throw new Error("renewProgramContractOutputs: nothing to renew");
    const outpoints = targets.map(({ coin }) => `${coin.txid}:${coin.vout}`);
    const twice = outpoints.find((o, i) => outpoints.indexOf(o) !== i);
    if (twice) throw new Error(`renewProgramContractOutputs: coin ${twice} listed twice`);

    const legs = targets.map(({ contract, coin, fn = "renew" }) => {
        const compiled = contract.vtxoScript.functionByName(fn);
        if (!compiled?.arkadeScript) {
            throw new Error(`renewProgramContractOutputs: ${fn} is not a covenant function`);
        }
        // No owner signs a renewal: a leaf naming any key but the server's could never complete.
        if (compiled.signerKeys.some((key) => !equalBytes(key, contract.keys.serverKey))) {
            throw new Error(
                `renewProgramContractOutputs: ${fn} needs a signature besides the server's`,
            );
        }
        // arkd accepts no CSV leaf as a forfeit path.
        if (compiled.def.tapscript.csv) {
            throw new Error(`renewProgramContractOutputs: ${fn} has a CSV timelock`);
        }
        // A renewal has no call arguments, so neither stack may name a function input.
        const condition = staticWitness(compiled.def.tapscript.witness, contract.args);
        const stack = staticWitness(compiled.def.arkadeScript?.witness, contract.args);
        if (!condition || !stack) {
            throw new Error(
                `renewProgramContractOutputs: ${fn} needs call arguments, which a renewal cannot supply`,
            );
        }
        return { contract, coin, compiled, condition, witness: RawWitness.encode(stack) };
    });

    // Outputs must equal inputs for the covenant to pass, so a renewal cannot pay a fee. Evaluated
    // per coin: the server's programs can charge nothing for some amounts or expiries.
    const { fees } = await arkProvider.getInfo();
    const fee = new Estimator(fees?.intentFee ?? {}).evaluate(
        legs.map(({ coin }) => toOffchainInputFeeParams(normalizeVtxo(coin))),
        [],
        legs.map(({ contract, coin }) => ({
            amount: BigInt(coin.value),
            script: hex.encode(contract.pkScript),
        })),
        [],
    );
    if (fee.satoshis > 0) {
        throw new Error(
            `renewProgramContractOutputs: the server charges ${fee.satoshis} sats, which a covenant renewal cannot pay`,
        );
    }

    const coins = await withPrevTxs(
        legs.map(({ contract, coin, compiled, condition }) => ({
            ...coin,
            tapTree: contract.tapTree,
            forfeitTapLeafScript: compiled.tapLeafScript,
            proofTapLeafScript: compiled.tapLeafScript,
            // Written as ConditionWitness on the proof and the forfeits, where arkd evaluates it.
            ...(condition.length > 0 ? { extraWitness: condition } : {}),
        })),
        indexer,
    );

    // Proof input 0 is the message; target k is input k+1 and keeps its assets at output k.
    const groups = new Map<string, { ins: AssetInput[]; outs: AssetOutput[] }>();
    legs.forEach(({ coin }, k) => {
        for (const a of coin.assets ?? []) {
            const g = groups.get(a.assetId) ?? { ins: [], outs: [] };
            g.ins.push(AssetInput.create(k + 1, a.amount));
            g.outs.push(AssetOutput.create(k, a.amount));
            groups.set(a.assetId, g);
        }
    });
    const packets: ExtensionPacket[] = [];
    if (groups.size > 0) {
        packets.push(
            AssetPacket.create(
                [...groups].map(([id, g]) =>
                    AssetGroup.create(AssetId.fromString(id), null, g.ins, g.outs, []),
                ),
            ),
        );
    }
    packets.push(
        EmulatorPacket.create(
            legs.map(({ compiled, witness }, k) => ({
                vin: k + 1,
                script: compiled.arkadeScript!,
                witness,
            })),
        ) as ExtensionPacket,
    );

    const session = opts.session ?? TreeSignerSession.random();
    const sessionKey = hex.encode(await session.getPublicKey());
    const message: Proof.RegisterMessage = {
        type: "register",
        onchain_output_indexes: [],
        valid_at: 0,
        expire_at: 0,
        cosigners_public_keys: [sessionKey],
    };
    const proof = Proof.create(message, coins, [
        ...legs.map(({ contract, coin }) => ({
            script: contract.pkScript,
            amount: BigInt(coin.value),
        })),
        Extension.create(packets).txOut(),
    ]);
    const signedProof = await emulator.submitIntent({
        proof: base64.encode(proof.toPSBT()),
        message,
    });
    // Checked last thing before registering: an intent nobody joins holds the coins until arkd
    // drops it, and from here an abort can only leave it there.
    if (opts.signal?.aborted) throw new Error(ABORTED);
    const abort = new AbortController();
    let onAbort = () => {};
    try {
        // Subscribed before registering: a batch started meanwhile would otherwise go unseen.
        const events = Batch.prime(
            arkProvider.getEventStream(abort.signal, [sessionKey, ...outpoints]),
        );
        const intentId = await arkProvider.registerIntent({ proof: signedProof, message });

        const handler = createArkadeBatchHandler(
            intentId,
            coins.map((coin, k) => ({
                ...coin,
                arkadeScriptBytes: legs[k].compiled.arkadeScript!,
            })),
            undefined,
            signedProof,
            message,
            session,
            arkProvider,
            emulator,
            network,
            legs.map(({ contract, coin }) => ({
                address: contract.address,
                amount: coin.value,
                ...(coin.assets?.length ? { assets: coin.assets } : {}),
            })),
        );
        // Batch.join sees the abort only on its next event; a batch that never starts would hang.
        const aborted = new Promise<never>((_, reject) => {
            onAbort = () => {
                abort.abort();
                reject(new Error(ABORTED));
            };
        });
        if (opts.signal?.aborted) onAbort();
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        const commitmentTxid = await Promise.race([
            Batch.join(events, handler, { abortController: abort }),
            aborted,
        ]);
        return { commitmentTxid, intentId };
    } finally {
        opts.signal?.removeEventListener("abort", onAbort);
        abort.abort();
    }
}
