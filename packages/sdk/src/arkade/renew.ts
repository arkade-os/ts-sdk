import { base64, hex } from "@scure/base";
import { RawWitness } from "@scure/btc-signer";
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
import { Intent } from "../intent";
import type { ArkProvider } from "../providers/ark";
import { TreeSignerSession, type SignerSession } from "../tree/signingSession";
import { withPrevTxs } from "../utils/prevoutTx";
import type { VirtualCoin } from "../wallet";
import { Batch } from "../wallet/batch";
import { createArkadeBatchHandler } from "./batch";
import type { Arkade, ArkadeContract } from "./contract";
import { witnessRefToBytes } from "./program";

const ABORTED = "renewArkadeVtxos: aborted before the batch completed";

/** A covenant VTXO and the function that renews it. */
export interface ArkadeRenewTarget {
    contract: ArkadeContract;
    coin: VirtualCoin;
    /**
     * Covenant function that lets proof input k+1 through to proof output k unchanged, e.g.
     * `require(tx.version == 2); require(this.tunnel(this.activeInputIndex - 1));`. Default `renew`.
     */
    fn?: string;
}

/**
 * Renews covenant VTXOs into a new batch without any owner key: the emulator signs the intent
 * proof after running each covenant and co-signs the forfeits, so a keeper can keep coins alive
 * while their owners are offline. Returns the commitment txid.
 */
export async function renewArkadeVtxos(
    client: Arkade,
    targets: ArkadeRenewTarget[],
    opts: { session?: SignerSession; signal?: AbortSignal } = {},
): Promise<{ commitmentTxid: string; intentId: string }> {
    const { emulator, indexer, network } = client;
    const arkProvider = client.arkProvider as ArkProvider;
    if (!emulator || !indexer || typeof arkProvider.registerIntent !== "function") {
        throw new Error(
            "renewArkadeVtxos: the Arkade client needs an emulator, an indexer and a full ArkProvider",
        );
    }
    if (targets.length === 0) throw new Error("renewArkadeVtxos: nothing to renew");
    // Before registering: an intent nobody joins would hold these coins until arkd drops it.
    if (opts.signal?.aborted) throw new Error(ABORTED);

    const legs = targets.map(({ contract, coin, fn = "renew" }) => {
        const compiled = contract.vtxoScript.functionByName(fn);
        if (!compiled?.arkadeScript) {
            throw new Error(`renewArkadeVtxos: ${fn} is not a covenant function`);
        }
        const stack = (compiled.def.arkadeScript?.witness ?? []).map((ref) =>
            witnessRefToBytes(ref, {}, contract.args),
        );
        return { contract, coin, compiled, witness: RawWitness.encode(stack) };
    });

    const coins = await withPrevTxs(
        legs.map(({ contract, coin, compiled }) => ({
            ...coin,
            tapTree: contract.tapTree,
            forfeitTapLeafScript: compiled.tapLeafScript,
            intentTapLeafScript: compiled.tapLeafScript,
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
    const message: Intent.RegisterMessage = {
        type: "register",
        onchain_output_indexes: [],
        valid_at: 0,
        expire_at: 0,
        cosigners_public_keys: [sessionKey],
    };
    const proof = Intent.create(message, coins, [
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
    const intentId = await arkProvider.registerIntent({ proof: signedProof, message });

    const handler = createArkadeBatchHandler(
        intentId,
        coins.map((coin, k) => ({ ...coin, arkadeScriptBytes: legs[k].compiled.arkadeScript! })),
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
    const abort = new AbortController();
    let onAbort = () => {};
    // Batch.join sees the abort only on its next event; a batch that never starts would hang.
    const aborted = new Promise<never>((_, reject) => {
        onAbort = () => {
            abort.abort();
            reject(new Error(ABORTED));
        };
    });
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
        const stream = arkProvider.getEventStream(abort.signal, [
            sessionKey,
            ...coins.map((c) => `${c.txid}:${c.vout}`),
        ]);
        const commitmentTxid = await Promise.race([
            Batch.join(stream, handler, { abortController: abort }),
            aborted,
        ]);
        return { commitmentTxid, intentId };
    } finally {
        opts.signal?.removeEventListener("abort", onAbort);
        abort.abort();
    }
}
