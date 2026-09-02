/**
 * Arkade Intents — an atomic-swap covenant on Arkade.
 *
 * The user funds this contract; a solver fills it through `fulfill`. The
 * `maker*` fields below (`makerWP`, `makerPkScript`, `makerPublicKey`) name
 * the funding side's position in the script, not a product role — see the
 * README's Roles section.
 *
 * The contracts are the two JSON files, one per WANT side:
 *   swap-want-asset.program.json  the fill must deliver an asset
 *   swap-want-btc.program.json    the fill must deliver sats
 *
 * Coins locked by a contract can only be spent by a transaction that delivers
 * `$wantAmount` (of `$wantAssetTxid`, or of BTC) to `$makerWP` — the `fulfill`
 * covenant, co-signed by the Arkade signer only after executing that script —
 * or returned to the user by `cancel`, this route's refund path. The two
 * outcomes are the same pair every Arkade Intents corridor offers after
 * funding: a fill, or the money back. The deposit side is whatever the
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
    arkade,
    asset,
    getNetwork,
    resolveEmulatorPubkey,
    toXOnlySignerHex,
    type IWallet,
    type NetworkName,
    type RelativeTimelock,
} from "@arkade-os/sdk";

import wantAssetProgram from "./swap-want-asset.program.json";
import wantBtcProgram from "./swap-want-btc.program.json";
import { promoteOfferContract, retireOfferContract } from "./coverage";
import type { AssetSwapRepository } from "./repository";
import { getAssetSwapsOrThrow, updateAssetSwap, updateAssetSwapBestEffort } from "./store";

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
 * identified by the funding vtxo itself); `offerAsset` set = the user
 * deposits that asset and wants sats. */
export interface Offer {
    /** The scriptPubKey of the swap contract. */
    swapPkScript: Uint8Array;
    /** Amount the user wants (asset units, or sats when wanting BTC). */
    wantAmount: bigint;
    /** The asset the user wants. Omitted when wanting BTC. */
    wantAsset?: asset.AssetId;
    /** The asset the user deposits. Omitted when depositing BTC. */
    offerAsset?: asset.AssetId;
    /** Maker's taproot scriptPubKey (34 bytes) — where the fill must pay. */
    makerPkScript: Uint8Array;
    /** Maker's x-only key (32 bytes) — the cancel path's `user` signer. */
    makerPublicKey: Uint8Array;
    /** Covenant co-signer (emulator) x-only key (32 bytes). */
    emulatorPubkey: Uint8Array;
    /** Partial-fill numerator. Reserved wire space in V1: carried through the
     * codec so an offer that sets it decodes, never interpreted here. */
    ratioNum?: bigint;
    /** Partial-fill denominator. Set with {@link Offer.ratioNum} or not at all. */
    ratioDen?: bigint;
    /** The maker's unilateral exit path. Present adds a third closure to the
     * taproot tree, so it changes `swapPkScript` — see {@link offerVtxoScript}. */
    exitDelay?: RelativeTimelock;
}

/** The program + argument/key binding of an offer's contract. Single source for
 * both address derivation and cancel, so the two can never drift apart (any
 * change here changes the derived swap addresses — see the golden test). */
/** Named through the public `arkade` namespace rather than left inferred: the
 * inferred shape reaches into the SDK's bundled chunk, which tsc refuses to
 * emit a portable declaration for once this function is exported. */
type SwapProgramBinding = {
    program: ConstructorParameters<typeof arkade.ArkadeProgramScript>[0];
    args: ConstructorParameters<typeof arkade.ArkadeProgramScript>[1];
    keys: ConstructorParameters<typeof arkade.ArkadeProgramScript>[2];
};

/**
 * Append the maker's unilateral exit closure to a program.
 *
 * A CSV closure of the maker alone: the signer key is deliberately absent, so
 * once the VTXO is unrolled onchain and the delay elapses the maker spends it
 * without anyone's cooperation. `cancel` stays the cooperative route.
 *
 * Order is load-bearing. The tree is assembled from the leaf list by btcd's
 * algorithm, so `exit` must remain the third path, after `fulfill` and
 * `cancel` — moving it changes the swap address.
 */
function withExitClosure(
    program: ReturnType<typeof arkade.parseArtifact>,
    exit: RelativeTimelock | undefined,
): ReturnType<typeof arkade.parseArtifact> {
    if (!exit) return program;
    return {
        ...program,
        // typed params are authoritative: an undeclared `$exitDelay` fails
        // validateProgram instead of compiling against an unbound value
        params: [...(program.params ?? []), { name: "exitDelay", type: "int" }],
        functions: {
            ...program.functions,
            exit: {
                tapscript: { signers: ["$user"], csv: { type: exit.type, value: "$exitDelay" } },
            },
        },
    };
}

/** Exported for the asset-id vector tests: the covenant is committed behind an
 * emulator-derived key, so the pushed asset bytes never appear in a leaf script
 * and the args are the only place the two forms are visible side by side.
 * Deliberately absent from the package index -- not public API. */
export function swapProgramBinding(
    offer: Omit<Offer, "swapPkScript">,
    serverPubkey: Uint8Array,
): SwapProgramBinding {
    // a wrong-width script would bind a truncated makerWP into the covenant and
    // only surface as an unspendable address once the user funds it
    if (offer.makerPkScript.length !== FIELDS.makerPkScript.width) {
        throw new Error("makerPkScript is not a 34-byte taproot scriptPubKey");
    }
    return {
        program: withExitClosure(
            offer.wantAsset ? swapPrograms.wantAsset : swapPrograms.wantBtc,
            offer.exitDelay,
        ),
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
            ...(offer.exitDelay && { exitDelay: offer.exitDelay.value }),
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
// so a solver can discover it from the txid alone.
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
    ratioNum: { tag: 0x09, width: 8 },
    ratioDen: { tag: 0x0a, width: 8 },
    offerAsset: { tag: 0x0b, width: undefined },
    exitTimelock: { tag: 0x0c, width: 9 },
} as const;

/** The `ExitTimelock` locktime types, indexed by their wire byte. */
const EXIT_TYPES = ["blocks", "seconds"] as const;

type FieldName = keyof typeof FIELDS;

const NAMES = Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [f.tag, k])) as Record<
    number,
    FieldName
>;

/** A u64 BE wire field. Rejects an out-of-range value rather than letting
 * setBigUint64 wrap it silently — reachable at ~18.45 tokens of an 18-decimal
 * asset — while the covenant binds the full amount. */
function u64(name: string, value: bigint): Uint8Array {
    if (value < BigInt(0) || value >> BigInt(64) > BigInt(0)) {
        throw new Error(`${name} does not fit the offer wire format (u64)`);
    }
    const out = new Uint8Array(FIELDS.wantAmount.width);
    new DataView(out.buffer).setBigUint64(0, value, false);
    return out;
}

/** Read a u64 BE wire field. The width was checked when the record was parsed. */
const readU64 = (value: Uint8Array): bigint =>
    new DataView(value.buffer, value.byteOffset).getBigUint64(0, false);

/** `0` is how the reference spells an unset ratio — it emits the record only
 * above zero — so a zero is omitted rather than written as a record no reader
 * honours. A negative is not "unset" but a value the u64 field cannot carry,
 * and normalizing it away here would slip it past {@link u64} and publish an
 * offer without the ratio the caller asked for. */
const setRatio = (name: string, value: bigint | undefined): bigint | undefined => {
    if (value === undefined || value === BigInt(0)) return undefined;
    if (value < BigInt(0)) throw new Error(`${name} does not fit the offer wire format (u64)`);
    return value;
};

function tlv(type: number, value: Uint8Array): Uint8Array {
    // the length prefix is u16 — reject rather than emit a truncated length
    // that would parse as a different record stream
    if (value.length > 0xffff) throw new Error("TLV value exceeds the u16 length field");
    return concatBytes(Uint8Array.of(type, (value.length >> 8) & 0xff, value.length & 0xff), value);
}

/** Serialize an offer to TLV bytes (the packet payload). */
export function encodeOffer(offer: Offer): Uint8Array {
    // decodeOffer rejects all of these on the way in; reject them on the way
    // out too, so a malformed offer fails at its source instead of at every
    // consumer that later reads the payload back
    if (Boolean(offer.wantAsset) === Boolean(offer.offerAsset)) {
        throw new Error("offer must carry exactly one of wantAsset or offerAsset");
    }
    for (const name of [
        "swapPkScript",
        "makerPkScript",
        "makerPublicKey",
        "emulatorPubkey",
    ] as const) {
        if (offer[name].length !== FIELDS[name].width) {
            throw new Error(`${name} must be ${FIELDS[name].width} bytes`);
        }
    }
    const ratioNum = setRatio("ratioNum", offer.ratioNum);
    const ratioDen = setRatio("ratioDen", offer.ratioDen);
    // a numerator without its denominator prices nothing
    if ((ratioNum === undefined) !== (ratioDen === undefined)) {
        throw new Error("offer must carry both ratioNum and ratioDen, or neither");
    }
    // the records are emitted in the order § 2.1 of the swap protocol requires;
    // parsers key off the type, but a canonical order keeps offer hashes stable
    const recs = [
        tlv(FIELDS.swapPkScript.tag, offer.swapPkScript),
        tlv(FIELDS.wantAmount.tag, u64("wantAmount", offer.wantAmount)),
    ];
    if (offer.wantAsset) recs.push(tlv(FIELDS.wantAsset.tag, offer.wantAsset.serialize()));
    if (ratioNum !== undefined) recs.push(tlv(FIELDS.ratioNum.tag, u64("ratioNum", ratioNum)));
    if (ratioDen !== undefined) recs.push(tlv(FIELDS.ratioDen.tag, u64("ratioDen", ratioDen)));
    if (offer.offerAsset) recs.push(tlv(FIELDS.offerAsset.tag, offer.offerAsset.serialize()));
    recs.push(
        tlv(FIELDS.makerPkScript.tag, offer.makerPkScript),
        tlv(FIELDS.makerPublicKey.tag, offer.makerPublicKey),
        tlv(FIELDS.emulatorPubkey.tag, offer.emulatorPubkey),
    );
    if (offer.exitDelay) recs.push(tlv(FIELDS.exitTimelock.tag, encodeExitDelay(offer.exitDelay)));
    return concatBytes(...recs);
}

/** `[type: 1B][value: u64 BE]`, per § 2.2. */
function encodeExitDelay(exit: RelativeTimelock): Uint8Array {
    const kind = EXIT_TYPES.indexOf(exit.type);
    if (kind < 0) throw new Error(`unknown exitDelay locktime type: ${exit.type}`);
    // the reference narrows the wire u64 to a uint32 locktime, so a wider value
    // derives one swap address here and another there — refuse to emit it
    if (exit.value >> BigInt(32) > BigInt(0)) {
        throw new Error("exitDelay does not fit the locktime field (u32)");
    }
    return concatBytes(Uint8Array.of(kind), u64("exitDelay", exit.value));
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
    // a zero-length asset record is malformed on its own terms; AssetId.fromBytes
    // below would reject it too, but with its internal wording — name the field
    for (const name of ["wantAsset", "offerAsset"] as const) {
        if (fields[name]?.length === 0) throw new Error(`missing/invalid ${name}`);
    }
    // width is checked wherever a fixed-width record appears, not only where
    // `need` reads it back: the optional ones have no other gate
    for (const [name, value] of Object.entries(fields) as [FieldName, Uint8Array][]) {
        const width: number | undefined = FIELDS[name].width;
        if (width !== undefined && value.length !== width) {
            throw new Error(`missing/invalid ${name}`);
        }
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
    // a present record valued `0` contradicts itself: that is the reference's
    // own spelling of "unset", and it emits the record only above zero
    const readRatio = (name: "ratioNum" | "ratioDen"): bigint | undefined => {
        const raw = fields[name];
        if (!raw) return undefined;
        const value = readU64(raw);
        if (value === BigInt(0)) throw new Error(`missing/invalid ${name}`);
        return value;
    };
    const ratioNum = readRatio("ratioNum");
    const ratioDen = readRatio("ratioDen");
    // enforced on the way in as well as out: another implementation may emit
    // half a ratio, and half a ratio prices nothing
    if ((ratioNum === undefined) !== (ratioDen === undefined)) {
        throw new Error("offer must carry both ratioNum and ratioDen, or neither");
    }
    return {
        swapPkScript: need("swapPkScript"),
        wantAmount: readU64(amount),
        ...(fields.wantAsset && { wantAsset: asset.AssetId.fromBytes(fields.wantAsset) }),
        ...(fields.offerAsset && { offerAsset: asset.AssetId.fromBytes(fields.offerAsset) }),
        makerPkScript: need("makerPkScript"),
        makerPublicKey: need("makerPublicKey"),
        emulatorPubkey: need("emulatorPubkey"),
        ...(ratioNum !== undefined && { ratioNum }),
        ...(ratioDen !== undefined && { ratioDen }),
        ...(fields.exitTimelock && { exitDelay: decodeExitDelay(fields.exitTimelock) }),
    };
}

/** The inverse of {@link encodeExitDelay}; the 9-byte width is already checked. */
function decodeExitDelay(value: Uint8Array): RelativeTimelock {
    const type = EXIT_TYPES[value[0]];
    // an unassigned locktime type is a record we cannot interpret, and reading
    // it as blocks would derive a swap address its emitter never meant
    if (!type) throw new Error(`unknown exitDelay locktime type: 0x${value[0].toString(16)}`);
    return { type, value: readU64(value.subarray(1)) };
}

// ── Contract registration ────────────────────────────────────────────────────

/** Label for a registered offer covenant. A script-level string, deliberately
 * not the swap id: identical offers share one address and `createContract` is
 * first-writer-wins, so the second deposit would inherit the first's label. */
export const OFFER_CONTRACT_LABEL = "Arkade swap offer";

/** `metadata.kind` for a registered offer covenant — what this script *is*,
 * which is the only kind of fact a shared script row can carry truthfully.
 * Per-offer identity (swap id, `offerHex`, `fundingTxid`) stays in `AssetSwap`. */
export const OFFER_CONTRACT_KIND = "asset-swap-offer";

/**
 * Register an offer's covenant as an `"arkade"` contract, so the deposit is
 * watched, survives restarts and re-derives offline — and, critically, so the
 * wallet knows the funds are escrowed.
 *
 * `metadata.genericallySpendable: false` is what keeps the deposit out of
 * generic coin selection. The covenant's `cancel` leaf is an untimelocked
 * 2-of-2 of user and server, so an offer VTXO is *always* cryptographically
 * spendable by the user's own wallet; nothing in the program artifact says
 * "escrow". Without the marker, `send`, `settle` or — with no user action at
 * all — background renewal would forfeit a live offer into an ordinary payment
 * and silently destroy it. The SDK's gate defaults closed, so the value is
 * redundant; it is written anyway because this is the one site that knows why.
 *
 * **The watch state is set unconditionally, not only on a fresh row.** Identical
 * offers share one script, and `createContract` is first-writer-wins, so
 * re-offering a script that a settlement retired would leave the row `retained`
 * — funded, but out of the subscription, the poll and every sync. The invariant
 * this states is the one the corridor needs: an offer address handed to a user
 * is a watched address, and {@link promoteOfferContract} is what keeps a
 * settlement racing this call from taking it back.
 */
async function registerOfferContract(
    wallet: IWallet,
    arkServerUrl: string,
    network: NetworkName,
    binding: Omit<Offer, "swapPkScript">,
    serverPubkey: Uint8Array,
    expectedPkScript: Uint8Array,
): Promise<void> {
    const { program, args, keys } = swapProgramBinding(binding, serverPubkey);
    const contractManager = await wallet.getContractManager();
    const client = await arkade.Arkade.connect({
        arkade: new RestArkProvider(arkServerUrl),
        indexer: new RestIndexerProvider(arkServerUrl),
        identity: wallet.identity,
        // without this the row's `address` would be derived against the SDK's
        // default network while its script is right — a row that disagrees with
        // the address the user is about to fund
        network: getNetwork(network),
        contractManager,
    });
    const contract = new arkade.ArkadeContract(client, program, args, keys);
    // the row is keyed by script: registering anything but the script being
    // funded would leave the real deposit unwatched and unmarked, which is the
    // failure this whole registration exists to prevent
    if (hex.encode(contract.pkScript) !== hex.encode(expectedPkScript)) {
        throw new Error("derived covenant does not match the offer's swapPkScript");
    }
    await contract.register({
        label: OFFER_CONTRACT_LABEL,
        metadata: { genericallySpendable: false, kind: OFFER_CONTRACT_KIND },
    });
    await promoteOfferContract(contractManager, hex.encode(expectedPkScript));
}

// ── User operations ─────────────────────────────────────────────────────────

/**
 * The exit closure's delay from the server's scalar `unilateralExitDelay`,
 * under the same threshold arkd's own closures use (`wallet.ts`, and solverd's
 * `fetchServerConfig`): below 512 the number is blocks, at or above it seconds.
 *
 * A missing value arrives here as `0` (`RestArkProvider` defaults it), which
 * would compile to a CSV of zero — an exit in name only. That is refused rather
 * than published, because an offer that says it has a unilateral exit and does
 * not is worse than one that never claimed it.
 */
function serverExitDelay(delay: bigint): RelativeTimelock {
    // `typeof` as well as the range: a provider predating the field returns an
    // info object without it, and comparing that to a bigint throws a TypeError
    // naming neither the field nor the way out
    if (typeof delay !== "bigint" || delay <= BigInt(0)) {
        throw new Error(
            "the server reports no usable unilateralExitDelay; pass `exitDelay` to set the offer's " +
                "exit closure explicitly, or `noExit: true` to publish without one",
        );
    }
    return { value: delay, type: delay < BigInt(512) ? "blocks" : "seconds" };
}

/**
 * Build a new offer for `wallet` (the user). Fund `address` with the side
 * you deposit, embedding the returned extension, and the solver does the rest:
 *
 *   // BTC -> asset
 *   const o = await createOffer(wallet, ARK, { wantAmount: 1000n, wantAsset })
 *   await wallet.send({ address: o.address, amount: 1000, extensions: [o.extension] })
 *
 *   // asset -> BTC (the sats are the VTXO carrier for the asset)
 *   const o = await createOffer(wallet, ARK, { wantAmount: 1000n, offerAsset })
 *   await wallet.send({ address: o.address, amount: 500,
 *                       assets: [{ assetId, amount: 1000n }],
 *                       extensions: [o.extension] })
 *
 * Broadcasts nothing, but does write locally: the covenant is registered with
 * the wallet's contract manager before the address is returned, so the deposit
 * is watched from the moment it lands and is marked as escrow (see
 * {@link registerOfferContract}). Registration deliberately happens *before*
 * funding rather than after: nothing is at stake yet, so a failure can throw
 * and be retried, where the same failure after `wallet.send` would leave a
 * funded deposit unwatched with no way to notice.
 *
 * **The maker's unilateral exit closure is built by default**, at the server's
 * own `unilateralExitDelay` — the same thing solverd does. Without it `cancel`
 * is the only way back out, and `cancel` needs the server's signature: a server
 * that will not co-sign leaves the deposit stuck at the swap address until the
 * VTXO expires and the operator sweeps it. An offer has no expiry of its own,
 * so that exposure has no end. `noExit` opts out for a caller who wants the
 * smaller tree and accepts the dependency.
 */
export async function createOffer(
    wallet: IWallet,
    arkServerUrl: string,
    params: {
        wantAmount: bigint;
        wantAsset?: asset.AssetId;
        offerAsset?: asset.AssetId;
        /** Co-signer key override (33-byte compressed hex); see
         * {@link resolveEmulatorPubkey}. */
        emulatorPubkey?: string;
        /** Override the exit closure's delay. Defaults to the server's own
         * `unilateralExitDelay`, which is the delay solverd uses too. */
        exitDelay?: RelativeTimelock;
        /** Publish without the exit closure, leaving `cancel` — which needs the
         * server — as the only way back out. See the note on this function. */
        noExit?: boolean;
    },
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
    const [info, makerAddress, makerPublicKey] = await Promise.all([
        new RestArkProvider(arkServerUrl).getInfo(),
        wallet.getAddress(),
        wallet.identity.xOnlyPublicKey(),
    ]);
    const serverPubKey = hex.decode(toXOnlySignerHex(info.signerPubkey));
    const network = getNetwork(info.network as NetworkName);
    const emuKey = hex.decode(
        toXOnlySignerHex(resolveEmulatorPubkey(network, params.emulatorPubkey)),
    );

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
        exitDelay: params.noExit
            ? undefined
            : (params.exitDelay ?? serverExitDelay(info.unilateralExitDelay)),
    };
    const script = offerVtxoScript(binding, serverPubKey);
    const offer: Offer = { ...binding, swapPkScript: script.pkScript };

    await registerOfferContract(
        wallet,
        arkServerUrl,
        info.network as NetworkName,
        binding,
        serverPubKey,
        script.pkScript,
    );

    const payload = encodeOffer(offer);
    return {
        offerHex: hex.encode(payload),
        extension: { type: OFFER_PACKET_TYPE, payload },
        // VtxoScript.address owns address construction; assembling an ArkAddress
        // from tweakedPublicKey here would silently miss any future step it gains
        address: script.address(network.hrp, serverPubKey).encode(),
        swapPkScript: script.pkScript,
    };
}

/**
 * Cancel an offer: spend the swap VTXO back to the user. Returns the ark txid.
 *
 * This is the cooperative refund path — how a user takes back a deposit no
 * solver filled. **No path here is on a deadline**, so an unfilled deposit
 * keeps its place at the swap address rather than expiring: nothing to miss and
 * no "expired" state to unwind, at the cost of the refund being something the
 * user asks for rather than something a clock delivers.
 *
 * The routes out of the covenant are deliberately asymmetric:
 *   - `fulfill` is signed by the **server alone**, but the covenant constrains
 *     it to pay output 0 to `makerWP` for at least `wantAmount` — a solver
 *     cannot take the deposit without delivering.
 *   - `cancel` is a **2-of-2 of the user and the server**, so cancelling is
 *     cooperative: the server co-signs. No solver signature is involved, so the
 *     refund never depends on the counterparty being reachable.
 *   - `exit` is the user **alone** after a relative timelock, present unless the
 *     offer was created with `noExit`. It is the route that survives a server
 *     that will not co-sign this one, and it is reached by unrolling the VTXO
 *     onchain rather than through this function.
 *
 * Cancel therefore races a fill rather than pre-empting it. An offer the solver
 * is filling in the same moment may be spent by `fulfill` first, in which case
 * this throws "no spendable VTXO at the swap address" — which means the swap
 * completed, not that anything failed. `restoreAssetSwaps` classifies the two
 * spends apart afterwards by the leaf each took (see `classifySpend`).
 *
 * Marking the deposit as escrow (see {@link registerOfferContract}) does not
 * close this path: the gate's subject is *implicit* coin selection, and cancel
 * names its input outpoint explicitly. The user keeps the only spend route
 * that was ever theirs to take.
 *
 * Identical offers derive the same address, so `fundingTxid` selects the exact
 * deposit; without it the address must hold exactly one spendable VTXO — with
 * several, cancel refuses to guess and throws.
 * `swapAddress` (the funded address) pins the server key the covenant was
 * built with, so cancel keeps working across a server signer rotation; without
 * it a rotated key is detected and reported rather than reading as a missing
 * VTXO.
 *
 * **When the matching swap record is present, this records its own outcome,
 * and that is what makes the live watcher cheap.** `cancel` is a 2-of-2 of
 * user and server, so a cancel can only be the user's own act: on a
 * successful submit this *is* the authoritative answer, and writing it here
 * means `watchOfferSwaps` has nothing left to decide for our own cancels — it
 * sees a terminal record and leaves it alone. The status moves to `cancelling`
 * first so a crash between submit and record leaves a marker rather than a
 * swap that still looks pending.
 *
 * Passing a repository that does not contain the swap record is allowed: the
 * cancel still submits and returns its txid, but no local status is written,
 * so the watcher or restore scan must classify the spend later.
 *
 * When a local record exists, the txid is only knowable after `send()`
 * returns, so a spend event that arrives in that window finds a `cancelling`
 * record and classifies the spend by its covenant leaf instead — the same
 * answer, one indexer read more.
 */
export async function cancelOffer(
    wallet: IWallet,
    arkServerUrl: string,
    offerHex: string,
    opts: {
        repository: AssetSwapRepository;
        fundingTxid?: string;
        swapAddress?: string;
    },
): Promise<string> {
    const { repository, fundingTxid, swapAddress } = opts;
    const offer = decodeOffer(hex.decode(offerHex));

    const contractManager = await wallet.getContractManager();
    const client = await arkade.Arkade.connect({
        arkade: new RestArkProvider(arkServerUrl),
        indexer: new RestIndexerProvider(arkServerUrl),
        identity: wallet.identity,
        // registered offers resolve their VTXOs from the contract repository
        // instead of a direct indexer query; the indexer above stays as the
        // fallback for offers created before registration existed
        contractManager,
        // no `network`, unlike registerOfferContract: the row lookup is by
        // script and the payout script comes from wallet.getAddress(), so the
        // client's network (which only shapes address derivation) is unused here
    });

    // Rebuild the contract with the offer's own keys (not the client's) so the
    // derived script matches the funded swap address exactly.
    const operatorPubkey = swapAddress
        ? ArkAddress.decode(swapAddress).serverPubKey
        : client.serverKey;
    const { program, args, keys } = swapProgramBinding(offer, operatorPubkey);
    // the offer's TLV pins the script the deposit was funded to; if the rebuild
    // disagrees, this server key is not the one the covenant was built with
    // (rotated since funding, or a wrong swapAddress) — getUtxos would just
    // return nothing, so fail with the diagnosis instead
    const rebuilt = new arkade.ArkadeProgramScript(program, args, keys);
    if (hex.encode(rebuilt.pkScript) !== hex.encode(offer.swapPkScript)) {
        throw new Error(
            "rebuilt covenant does not match the offer's swapPkScript — the server " +
                "signing key has likely rotated since funding; pass swapAddress (the " +
                "funded address) to pin the original key",
        );
    }
    const contract = new arkade.ArkadeContract(client, program, args, keys);

    const [vtxos, makerAddress] = await Promise.all([contract.getUtxos(), wallet.getAddress()]);
    if (!fundingTxid && vtxos.length > 1) {
        // identical offers share one address: guessing here would cancel an
        // arbitrary deposit while the caller believes it was a specific one
        throw new Error(
            "multiple spendable deposits at the swap address — pass fundingTxid to select one",
        );
    }
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
    const swapId = fundingTxid ?? vtxo.txid;
    // Strict read: a failed one must not read as "no local record here" and
    // send us past the marker into the broadcast.
    const hasLocalRecord = (await getAssetSwapsOrThrow(repository)).some((s) => s.id === swapId);
    // The in-flight marker is useful only when there is a local record to
    // update; a different or empty repository intentionally leaves the cancel
    // for event/restore classification. It gates the broadcast, so it throws:
    // the marker is what keeps a crash here from leaving a swap that still
    // looks pending.
    if (hasLocalRecord) await updateAssetSwap(repository, swapId, { status: "cancelling" });
    const { txid } = await cancel.send();
    if (hasLocalRecord) {
        // Past the point of no return: the cancel is broadcast, so a lost write
        // must not fail the caller. The watcher classifies by covenant leaf and
        // the restore scan re-derives the outcome.
        const { persisted, swaps } = await updateAssetSwapBestEffort(repository, swapId, {
            status: "cancelled",
            spentTxid: txid,
        });
        // Retiring belongs here for the same reason the status does: recording
        // its own outcome is what leaves the watcher nothing to do, and a
        // watcher that sees a terminal record returns before it would retire
        // (`spendUpdate`). Nothing else would ever drop this script.
        //
        // Only on a persisted write, as the watcher does: a record that still
        // reads `pending` to the next restore scan must stay watched.
        if (persisted) {
            await retireOfferContract(contractManager, swaps, hex.encode(offer.swapPkScript));
        }
    }
    return txid;
}
