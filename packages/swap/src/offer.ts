/**
 * Arkade Intents — an atomic-swap covenant on Arkade.
 *
 * The contracts are the two JSON files, one per WANT side:
 *   swap-want-asset.program.json  the fill must deliver an asset
 *   swap-want-btc.program.json    the fill must deliver sats
 *
 * Coins locked by a contract can only be spent by a transaction that delivers
 * `$wantAmount` (of `$wantAssetTxid`, or of BTC) to `$makerWP` — the `fulfill`
 * covenant, co-signed by the Arkade signer only after executing that script —
 * or cooperatively by the maker (`cancel`). The deposit side is whatever the
 * funding tx put in the offer vtxo (sats, or any asset riding a dust carrier)
 * — the covenant never inspects it, which is what lets asset↔asset swaps ride
 * the want-asset program. This file is just plumbing: bind an offer's values
 * to the program's `$param`s, and speak the solver's TLV offer-discovery
 * format.
 */
import { hex } from "@scure/base";
import { concatBytes } from "@scure/btc-signer/utils.js";
import {
    ArkAddress,
    RestArkProvider,
    RestIndexerProvider,
    RestEmulatorProvider,
    arkade,
    asset,
    getNetwork,
    type IWallet,
    type NetworkName,
} from "@arkade-os/sdk";

import wantAssetProgram from "./swap-want-asset.program.json";
import wantBtcProgram from "./swap-want-btc.program.json";

// json imports widen "type": "pubkey" to string; parseArtifact validates at runtime
type Artifact = Parameters<typeof arkade.parseArtifact>[0];

/** The contracts — pure data, shared verbatim with any other implementation. */
export const swapPrograms: Record<
    "wantAsset" | "wantBtc",
    ReturnType<typeof arkade.parseArtifact>
> = {
    wantAsset: arkade.parseArtifact(wantAssetProgram as Artifact),
    wantBtc: arkade.parseArtifact(wantBtcProgram as Artifact),
};

// ── Offer ────────────────────────────────────────────────────────────────────

/** A full-fill offer. Exactly one field names an asset: `wantAsset` set = the
 * fill must deliver that asset (the deposit may be BTC or another asset,
 * identified by the funding vtxo itself); `offerAsset` set = the maker
 * deposits that asset and wants sats. */
export interface Offer {
    /** The scriptPubKey of the swap contract. */
    swapPkScript: Uint8Array;
    /** Amount the maker wants (asset units, or sats when wanting BTC). */
    wantAmount: bigint;
    /** The asset the maker wants. Omitted when wanting BTC. */
    wantAsset?: asset.AssetId;
    /** The asset the maker deposits. Omitted when depositing BTC. */
    offerAsset?: asset.AssetId;
    /** Maker's taproot scriptPubKey (34 bytes) — where the fill must pay. */
    makerPkScript: Uint8Array;
    /** Maker's x-only key (32 bytes) — the cancel path's `user` signer. */
    makerPublicKey: Uint8Array;
    /** Covenant co-signer (emulator) x-only key (32 bytes). */
    emulatorPubkey: Uint8Array;
}

/** The program + argument/key binding of an offer's contract. Single source for
 * both address derivation and cancel, so the two can never drift apart (any
 * change here changes the derived swap addresses — see the golden test). */
function swapProgramBinding(offer: Omit<Offer, "swapPkScript">, serverPubkey: Uint8Array) {
    return {
        program: offer.wantAsset ? swapPrograms.wantAsset : swapPrograms.wantBtc,
        args: {
            makerWP: offer.makerPkScript.subarray(2),
            wantAmount: offer.wantAmount,
            server: serverPubkey,
            user: offer.makerPublicKey,
            // internal byte order
            ...(offer.wantAsset && {
                wantAssetTxid: offer.wantAsset.txid.slice().reverse(),
                wantAssetGroupIndex: offer.wantAsset.groupIndex,
            }),
        },
        keys: {
            serverKey: serverPubkey,
            userKey: offer.makerPublicKey,
            emulatorKey: offer.emulatorPubkey,
        },
    };
}

/** Compile the offer's contract: program + args -> taproot tree. */
export function offerVtxoScript(
    offer: Omit<Offer, "swapPkScript">,
    serverPubkey: Uint8Array,
): InstanceType<typeof arkade.ArkadeProgramScript> {
    const { program, args, keys } = swapProgramBinding(offer, serverPubkey);
    return new arkade.ArkadeProgramScript(program, args, keys);
}

// ── Offer wire format ────────────────────────────────────────────────────────
// The offer travels inside the funding tx as an Extension packet (type 0x03)
// so a taker (the arkade solver) can discover it from the txid alone.
// Payload: `[type: 1B][length: 2B BE][value]` records.

/** Extension packet type tag for Arkade Intents offers. */
export const OFFER_PACKET_TYPE = 0x03;

/** The wire fields: tag, and for the fixed-width ones the exact byte length.
 * One table so a tag can never drift from its width — a big-endian u64
 * amount, taproot scriptPubKeys, x-only keys. Decode rejects any other
 * length: a short value would make getBigUint64 throw a RangeError, a long
 * one would be silently truncated to its first 8 bytes and price the offer at
 * an amount the covenant never bound. `width: undefined` marks the
 * variable-length asset ids, which are validated by AssetId.fromBytes. */
const FIELDS = {
    swapPkScript: { tag: 0x01, width: 34 },
    wantAmount: { tag: 0x02, width: 8 },
    wantAsset: { tag: 0x03, width: undefined },
    makerPkScript: { tag: 0x05, width: 34 },
    makerPublicKey: { tag: 0x07, width: 32 },
    emulatorPubkey: { tag: 0x08, width: 32 },
    offerAsset: { tag: 0x0b, width: undefined },
} as const;

type FieldName = keyof typeof FIELDS;

const NAMES = Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [f.tag, k])) as Record<
    number,
    FieldName
>;

/** Drop the prefix of a 33-byte compressed key; pass an x-only key through.
 * A malformed key would otherwise bind silently into the covenant and only
 * surface as an unspendable address once the maker funds it. */
const xOnly = (key: Uint8Array, label: string): Uint8Array => {
    if (key.length === FIELDS.makerPublicKey.width) return key;
    if (key.length !== 33 || (key[0] !== 0x02 && key[0] !== 0x03)) {
        throw new Error(`${label} is not a compressed or x-only public key`);
    }
    return key.slice(1);
};

function tlv(type: number, value: Uint8Array): Uint8Array {
    return concatBytes(Uint8Array.of(type, (value.length >> 8) & 0xff, value.length & 0xff), value);
}

/** Serialize an offer to TLV bytes (the packet payload). */
export function encodeOffer(offer: Offer): Uint8Array {
    // the wire field is a fixed u64; setBigUint64 would wrap silently past 2^64
    // (reachable at ~18.45 tokens of an 18-decimal asset) while the covenant
    // binds the full amount — reject instead of advertising a wrapped amount
    if (offer.wantAmount < BigInt(0) || offer.wantAmount >> BigInt(64) > BigInt(0)) {
        throw new Error("wantAmount does not fit the offer wire format (u64)");
    }
    const amount = new Uint8Array(FIELDS.wantAmount.width);
    new DataView(amount.buffer).setBigUint64(0, offer.wantAmount, false);
    const recs = [
        tlv(FIELDS.swapPkScript.tag, offer.swapPkScript),
        tlv(FIELDS.wantAmount.tag, amount),
    ];
    if (offer.wantAsset) recs.push(tlv(FIELDS.wantAsset.tag, offer.wantAsset.serialize()));
    if (offer.offerAsset) recs.push(tlv(FIELDS.offerAsset.tag, offer.offerAsset.serialize()));
    recs.push(
        tlv(FIELDS.makerPkScript.tag, offer.makerPkScript),
        tlv(FIELDS.makerPublicKey.tag, offer.makerPublicKey),
        tlv(FIELDS.emulatorPubkey.tag, offer.emulatorPubkey),
    );
    return concatBytes(...recs);
}

/** Parse TLV bytes into an offer. Throws on malformed or unknown records. */
export function decodeOffer(data: Uint8Array): Offer {
    const fields: Partial<Record<FieldName, Uint8Array>> = {};
    let off = 0;
    while (off < data.length) {
        if (off + 3 > data.length) throw new Error("truncated TLV header");
        const type = data[off];
        const length = (data[off + 1] << 8) | data[off + 2];
        off += 3;
        if (off + length > data.length)
            throw new Error(`truncated TLV value for type 0x${type.toString(16)}`);
        const name = NAMES[type];
        // strict by design: this payload binds a covenant, so a record we
        // cannot interpret must not be silently dropped — an offer whose terms
        // are partly unintelligible should fail loudly, not display or cancel
        // as if understood. Making unassigned tags ignorable is a change to the
        // offer spec (e.g. adopting an odd/even "ok to be odd" rule), not a
        // decision for one client.
        if (!name) throw new Error(`unknown TLV type: 0x${type.toString(16)}`);
        // last-wins would let the same bytes decode to different offers in
        // another implementation that takes the first record
        if (fields[name] !== undefined) throw new Error(`duplicate TLV record: ${name}`);
        fields[name] = data.slice(off, off + length);
        off += length;
    }
    const need = (name: FieldName) => {
        const v = fields[name];
        const len: number | undefined = FIELDS[name].width;
        if (!v || (len !== undefined && v.length !== len))
            throw new Error(`missing/invalid ${name}`);
        return v;
    };
    const amount = need("wantAmount");
    if (Boolean(fields.wantAsset) === Boolean(fields.offerAsset)) {
        throw new Error("offer must carry exactly one of wantAsset or offerAsset");
    }
    return {
        swapPkScript: need("swapPkScript"),
        wantAmount: new DataView(amount.buffer, amount.byteOffset).getBigUint64(0, false),
        ...(fields.wantAsset && { wantAsset: asset.AssetId.fromBytes(fields.wantAsset) }),
        ...(fields.offerAsset && { offerAsset: asset.AssetId.fromBytes(fields.offerAsset) }),
        makerPkScript: need("makerPkScript"),
        makerPublicKey: need("makerPublicKey"),
        emulatorPubkey: need("emulatorPubkey"),
    };
}

// ── Maker operations ─────────────────────────────────────────────────────────

/**
 * Build a new offer for `wallet` (the maker). Fund `address` with the side
 * you deposit, embedding the returned extension, and the solver does the rest:
 *
 *   // BTC -> asset
 *   const o = await createOffer(wallet, ARK, EMU, { wantAmount: 1000n, wantAsset })
 *   await wallet.send({ address: o.address, amount: 1000, extensions: [o.extension] })
 *
 *   // asset -> BTC (the sats are the VTXO carrier for the asset)
 *   const o = await createOffer(wallet, ARK, EMU, { wantAmount: 1000n, offerAsset })
 *   await wallet.send({ address: o.address, amount: 500,
 *                       assets: [{ assetId, amount: 1000n }],
 *                       extensions: [o.extension] })
 */
export async function createOffer(
    wallet: IWallet,
    arkServerUrl: string,
    emulatorUrl: string,
    params: { wantAmount: bigint; wantAsset?: asset.AssetId; offerAsset?: asset.AssetId },
): Promise<{
    /** The encoded offer, hex. **Persist this** — it is the only input
     * `cancelOffer` needs to rebuild the covenant, and the restore scan reads
     * the same bytes back off the funding tx into `AssetSwap.offerHex`. */
    offerHex: string;
    /** Ready for `wallet.send`'s `extensions` — the caller never handles the packet type. */
    extension: { type: number; payload: Uint8Array };
    /** The swap address to fund. Nothing exists on chain until the deposit
     * lands here: `createOffer` is pure derivation and broadcasts nothing.
     * Identical offers derive an identical address, so the funding txid — not
     * the address — is what identifies one deposit. */
    address: string;
    /** The covenant's scriptPubKey: the key an indexer watches to spot the
     * deposit and its later spend (`AssetSwap.swapPkScript`). */
    swapPkScript: Uint8Array;
}> {
    if (Boolean(params.wantAsset) === Boolean(params.offerAsset)) {
        throw new Error("set exactly one of wantAsset (BTC->asset) or offerAsset (asset->BTC)");
    }
    const [info, emulatorInfo, makerAddress, makerPublicKey] = await Promise.all([
        new RestArkProvider(arkServerUrl).getInfo(),
        new RestEmulatorProvider(emulatorUrl).getInfo(),
        wallet.getAddress(),
        wallet.identity.xOnlyPublicKey(),
    ]);
    // both keys arrive compressed (33B) today; drop the prefix by length so an
    // already-x-only key is passed through rather than shortened to 31 bytes
    const serverPubKey = xOnly(hex.decode(info.signerPubkey), "ark signer key");
    const emuKey = xOnly(hex.decode(emulatorInfo.signerPubkey), "emulator signer key");

    // the script derives from every field but the script itself, so build the
    // binding first and complete the offer with it — an Offer value never
    // exists in a state that would encode to an empty swapPkScript
    const binding = {
        wantAmount: params.wantAmount,
        wantAsset: params.wantAsset,
        offerAsset: params.offerAsset,
        makerPkScript: ArkAddress.decode(makerAddress).pkScript,
        makerPublicKey,
        emulatorPubkey: emuKey,
    };
    const script = offerVtxoScript(binding, serverPubKey);
    const offer: Offer = { ...binding, swapPkScript: script.pkScript };

    const payload = encodeOffer(offer);
    return {
        offerHex: hex.encode(payload),
        extension: { type: OFFER_PACKET_TYPE, payload },
        // VtxoScript.address owns address construction; assembling an ArkAddress
        // from tweakedPublicKey here would silently miss any future step it gains
        address: script.address(getNetwork(info.network as NetworkName).hrp, serverPubKey).encode(),
        swapPkScript: script.pkScript,
    };
}

/**
 * Cancel an offer: spend the swap VTXO back to the maker. Returns the ark txid.
 *
 * This is how a maker exits an offer no taker filled. **Neither program carries
 * a timelock**, so an unfilled deposit does not expire and nothing reclaims it
 * on the maker's behalf — it sits at the swap address until cancelled. There is
 * no "expired" state to wait for; a maker who wants the deposit back must ask.
 *
 * Both paths out of the covenant are deliberately asymmetric:
 *   - `fulfill` is signed by the **server alone**, but the covenant constrains
 *     it to pay output 0 to `makerWP` for at least `wantAmount` — the taker
 *     cannot take the deposit without delivering.
 *   - `cancel` is a **2-of-2 of the maker and the server**, so cancelling is
 *     cooperative: the server co-signs. It is not a unilateral withdrawal.
 *
 * Cancel therefore races a fill rather than pre-empting it. An offer the solver
 * is filling in the same moment may be spent by `fulfill` first, in which case
 * this throws "no spendable VTXO at the swap address" — which means the swap
 * completed, not that anything failed. `restoreAssetSwaps` classifies the two
 * spends apart afterwards (see `isCancelSpend`).
 *
 * Identical offers derive the same address, so `fundingTxid` selects the exact
 * deposit; without it the first spendable VTXO at the address is cancelled.
 * `swapAddress` (the funded address) pins the server key the covenant was
 * built with, so cancel keeps working across a server signer rotation.
 */
export async function cancelOffer(
    wallet: IWallet,
    arkServerUrl: string,
    offerHex: string,
    fundingTxid?: string,
    swapAddress?: string,
): Promise<string> {
    const offer = decodeOffer(hex.decode(offerHex));

    const client = await arkade.Arkade.connect({
        arkade: new RestArkProvider(arkServerUrl),
        indexer: new RestIndexerProvider(arkServerUrl),
        identity: wallet.identity,
    });

    // Rebuild the contract with the offer's own keys (not the client's) so the
    // derived script matches the funded swap address exactly.
    const serverKey = swapAddress ? ArkAddress.decode(swapAddress).serverPubKey : client.serverKey;
    const { program, args, keys } = swapProgramBinding(offer, serverKey);
    const contract = new arkade.ArkadeContract(client, program, args, keys);

    const [vtxos, makerAddress] = await Promise.all([contract.getUtxos(), wallet.getAddress()]);
    const vtxo = fundingTxid ? vtxos.find((v) => v.txid === fundingTxid) : vtxos[0];
    if (!vtxo) throw new Error("no spendable VTXO at the swap address");

    const makerPkScript = ArkAddress.decode(makerAddress).pkScript;
    const cancel = contract.functions
        .cancel()
        .from({ txid: vtxo.txid, vout: vtxo.vout, value: vtxo.value })
        .to(makerPkScript, BigInt(vtxo.value));
    // An asset-deposit swap VTXO carries the asset; move it back too.
    for (const a of vtxo.assets ?? []) {
        cancel.withAsset({
            assetId: a.assetId,
            inputs: [{ vin: 0, amount: BigInt(a.amount) }],
            outputs: [{ vout: 0, amount: BigInt(a.amount) }],
        });
    }
    const { txid } = await cancel.send();
    return txid;
}
