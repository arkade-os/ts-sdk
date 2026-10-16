/**
 * Arkade Intents — an atomic-swap covenant on Arkade.
 *
 * The user funds the contract; a solver fills it through `fulfill`, or `cancel` refunds it. The
 * `maker*` fields name the funding side's position in the script, not a product role (see the
 * README's Roles section). One program per WANT side (`swap-want-asset` / `swap-want-btc`
 * `.program.json`). The covenant constrains only what `fulfill` pays `$makerWP` and never inspects
 * the deposit, which is what lets asset↔asset swaps ride the want-asset program.
 */
import { hex } from "@scure/base";
import { concatBytes } from "@scure/btc-signer/utils.js";
import {
    ASSET_CARRIER_SATS as SDK_ASSET_CARRIER_SATS,
    ArkAddress,
    RestArkProvider,
    RestEmulatorProvider,
    RestIndexerProvider,
    arkade,
    asset,
    networkFromArkadeInfo,
    resolveEmulatorPubkey,
    toXOnlySignerHex,
    type ArkTxInput,
    type ArkadeInfo,
    type EmulatorProvider,
    type IWallet,
    type Outpoint,
    type RelativeTimelock,
} from "@arkade-os/sdk";

import wantAssetProgram from "./swap-want-asset.program.json";
import wantBtcProgram from "./swap-want-btc.program.json";
import {
    promoteOfferContract,
    RETIRABLE,
    retireOfferContract,
    type CoverageRegistrationOptions,
} from "./coverage";
import { parseHex32 } from "./rfqProfileParts";
import type { AssetSwapRepository } from "./repository";
import {
    getAssetSwapsOrThrow,
    type AssetSwap,
    updateAssetSwap,
    updateAssetSwapBestEffort,
} from "./store";

// json imports widen "type": "pubkey" to string; parseArtifact validates at runtime
type Artifact = Parameters<typeof arkade.parseArtifact>[0];

/**
 * The contracts, one per WANT side — pure data, shared verbatim with any other implementation.
 *
 * An offer carrying an exit delay compiles a third closure that is in neither file (see
 * {@link withExitClosure}); the golden in `offer.test.ts` pins the artifact it produces.
 *
 * @deprecated Internal to `accept()`; no replacement. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export const swapPrograms: Record<
    "wantAsset" | "wantBtc",
    ReturnType<typeof arkade.parseArtifact>
> = {
    wantAsset: arkade.parseArtifact(wantAssetProgram as Artifact),
    wantBtc: arkade.parseArtifact(wantBtcProgram as Artifact),
};

// ── Offer ────────────────────────────────────────────────────────────────────

/** A full-fill offer. Exactly one field names an asset: `wantAsset` = the fill must deliver that
 * asset (the deposit is whatever the funding vtxo holds); `offerAsset` = the user deposits that
 * asset and wants sats.
 *
 * @deprecated Internal to `accept()`; no replacement. Moved off the package root to `@arkade-os/swap/protocol`.
 */
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

/** Program + args + keys of an offer's contract: the single source for address derivation and
 * cancel (any change here changes derived swap addresses — see the golden test). Spelled via the
 * public `arkade` namespace so tsc can emit a portable declaration. */
type SwapProgramBinding = {
    program: ConstructorParameters<typeof arkade.ArkadeProgramScript>[0];
    args: ConstructorParameters<typeof arkade.ArkadeProgramScript>[1];
    keys: ConstructorParameters<typeof arkade.ArkadeProgramScript>[2];
};

/**
 * Append the maker's unilateral exit closure: a CSV of the maker alone (no signer key), so once the
 * VTXO is unrolled and the delay elapses the maker spends without anyone's cooperation.
 *
 * Order is load-bearing: btcd's algorithm builds the tree from the leaf list, so `exit` must stay
 * third after `fulfill` and `cancel` or the swap address changes. Code rather than program JSON
 * because the closure is conditional and `csv.type` is a literal in the artifact format (only
 * `csv.value` resolves a `$param`); the declarative form would need six drift-prone files.
 */
function withExitClosure(
    program: ReturnType<typeof arkade.parseArtifact>,
    exit: RelativeTimelock | undefined,
): ReturnType<typeof arkade.parseArtifact> {
    if (!exit) return program;
    // Spread, never mutate: `swapPrograms` is shared module state, so appending in place would give
    // later exit-less offers a third leaf and an unbound `$exitDelay`.
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

/** Exported for the asset-id vector tests (the args are the only place both asset-id forms are
 * visible). Deliberately absent from the package index -- not public API. */
export function swapProgramBinding(
    offer: Omit<Offer, "swapPkScript">,
    operatorPubkey: Uint8Array,
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
            server: operatorPubkey,
            user: offer.makerPublicKey,
            // internal byte order
            ...(offer.wantAsset && {
                wantAssetTxid: offer.wantAsset.txid.slice().reverse(),
                wantAssetGroupIndex: offer.wantAsset.groupIndex,
            }),
            ...(offer.exitDelay && { exitDelay: offer.exitDelay.value }),
        },
        keys: {
            serverKey: operatorPubkey,
            userKey: offer.makerPublicKey,
            emulatorKey: offer.emulatorPubkey,
        },
    };
}

/** Compile the offer's contract: program + args -> taproot tree.
 *
 * @deprecated Internal to `accept()`; no replacement. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export function offerContract(
    offer: Omit<Offer, "swapPkScript">,
    operatorPubkey: Uint8Array,
): InstanceType<typeof arkade.ArkadeProgramScript> {
    const { program, args, keys } = swapProgramBinding(offer, operatorPubkey);
    return new arkade.ArkadeProgramScript(program, args, keys);
}

// ── Offer wire format ────────────────────────────────────────────────────────
// The offer travels inside the funding tx as an Extension packet (type 0x03)
// so a solver can discover it from the txid alone.
// Payload: `[type: 1B][length: 2B BE][value]` records.

/** Extension packet type tag for Arkade Intents offers.
 *
 * @deprecated Internal to `accept()`; no replacement. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export const OFFER_PACKET_TYPE = 0x03;

/** Wire fields: tag and, for fixed-width ones, exact byte length — one table so neither can drift.
 * Decode rejects any other length: a long u64 would be truncated to 8 bytes and price the offer at
 * an amount the covenant never bound. `width: undefined` = variable-length asset ids. */
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

/** A u64 BE wire field. Rejects out-of-range rather than letting setBigUint64 wrap silently —
 * reachable at ~18.45 tokens of an 18-decimal asset — while the covenant binds the full amount. */
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

/** `0` is the reference's spelling of an unset ratio (it emits the record only above zero), so it is
 * omitted. A negative is not "unset": normalizing it away would slip past {@link u64} and publish
 * the offer without the ratio the caller asked for. */
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

/** Serialize an offer to TLV bytes (the packet payload).
 *
 * @deprecated Internal to `accept()`; no replacement. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export function encodeOffer(offer: Offer): Uint8Array {
    // mirrors decodeOffer's checks so a malformed offer fails at its source, not at every reader
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
    return concatBytes(
        Uint8Array.of(EXIT_TYPES.indexOf(assertExitDelay(exit).type)),
        u64("exitDelay", exit.value),
    );
}

/**
 * The exit delay checks, returning the value for inline binding. Shared with {@link createOffer}
 * because it registers and promotes the covenant before encoding: a delay only the encoder refused
 * would leave a watched contract row that {@link retireOfferContract} will not take back.
 */
function assertExitDelay(exit: RelativeTimelock): RelativeTimelock {
    if (EXIT_TYPES.indexOf(exit.type) < 0) {
        throw new Error(`unknown exitDelay locktime type: ${exit.type}`);
    }
    // a zero delay is an exit in name only: the leaf exists, but the CSV imposes no wait
    if (exit.value <= BigInt(0)) {
        throw new Error("exitDelay must be a positive relative locktime");
    }
    // the reference narrows the wire u64 to a uint32 locktime, so a wider value
    // derives one swap address here and another there — refuse to emit it
    if (exit.value >> BigInt(32) > BigInt(0)) {
        throw new Error("exitDelay does not fit the locktime field (u32)");
    }
    return exit;
}

/** Parse TLV bytes into an offer. Throws on malformed or unknown records.
 *
 * @deprecated Internal to `accept()`; no replacement. Moved off the package root to `@arkade-os/swap/protocol`.
 */
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
        // strict by design: this payload binds a covenant, so an uninterpretable record must fail
        // loudly. Making unknown tags ignorable (e.g. an odd/even rule) is an offer-spec change.
        if (!name) throw new Error(`unknown TLV type: 0x${type.toString(16)}`);
        // last-wins would let the same bytes decode to different offers in
        // another implementation that takes the first record
        if (fields[name] !== undefined) throw new Error(`duplicate TLV record: ${name}`);
        fields[name] = data.slice(off, off + length);
        off += length;
    }
    // AssetId.fromBytes would reject these too, but without naming the field
    for (const name of ["wantAsset", "offerAsset"] as const) {
        if (fields[name]?.length === 0) throw new Error(`missing/invalid ${name}`);
    }
    for (const [name, value] of Object.entries(fields) as [FieldName, Uint8Array][]) {
        const width: number | undefined = FIELDS[name].width;
        if (width !== undefined && value.length !== width) {
            throw new Error(`missing/invalid ${name}`);
        }
    }
    const need = (name: FieldName) => {
        const v = fields[name];
        if (!v) throw new Error(`missing/invalid ${name}`);
        return v;
    };
    const amount = need("wantAmount");
    if (Boolean(fields.wantAsset) === Boolean(fields.offerAsset)) {
        throw new Error("offer must carry exactly one of wantAsset or offerAsset");
    }
    // a present record valued `0` contradicts itself: `0` is the reference's spelling of "unset"
    const readRatio = (name: "ratioNum" | "ratioDen"): bigint | undefined => {
        const raw = fields[name];
        if (!raw) return undefined;
        const value = readU64(raw);
        if (value === BigInt(0)) throw new Error(`missing/invalid ${name}`);
        return value;
    };
    const ratioNum = readRatio("ratioNum");
    const ratioDen = readRatio("ratioDen");
    // enforced on the way in too: another implementation may emit half a ratio
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
    // reading an unassigned type as blocks would derive a swap address its emitter never meant
    if (!type) throw new Error(`unknown exitDelay locktime type: 0x${value[0].toString(16)}`);
    return { type, value: readU64(value.subarray(1)) };
}

// ── Contract registration ────────────────────────────────────────────────────

/** Label for a registered offer covenant. Deliberately not the swap id: identical offers share one
 * address and `createContract` is first-writer-wins, so a second deposit would inherit the label. */
export const OFFER_CONTRACT_LABEL = "Arkade swap offer";

/** `metadata.kind` for a registered offer covenant — a script-level fact, the only kind a shared
 * script row can carry truthfully. Per-offer identity stays in `AssetSwap`. */
export const OFFER_CONTRACT_KIND = "asset-swap-offer";

/**
 * Register an offer's covenant as an `"arkade"` contract, so the deposit is watched, survives
 * restarts, and is known to be escrow. `genericallySpendable: false` keeps it out of coin selection:
 * the `cancel` leaf is an untimelocked user+server 2-of-2, so `send`, `settle` or background renewal
 * would otherwise forfeit a live offer (redundant with the SDK's closed default, written anyway).
 * Watch state is promoted unconditionally because `createContract` is first-writer-wins on a shared
 * script, so a re-offered retired script would otherwise stay unwatched.
 */
async function registerOfferContract(
    wallet: IWallet,
    info: ArkadeInfo,
    binding: Omit<Offer, "swapPkScript">,
    operatorPubkey: Uint8Array,
    expectedPkScript: Uint8Array,
    options: CoverageRegistrationOptions = {},
): Promise<void> {
    const contractManager = await wallet.getContractManager();
    const client = await derivingClient(wallet, info, contractManager);
    await contractManager.createContract(
        offerContractParams(client, binding, operatorPubkey, expectedPkScript),
    );
    await promoteOfferContract(contractManager, hex.encode(expectedPkScript), undefined, {
        ...options,
        scope: wallet,
    });
}

/** A derive-and-persist client over already-resolved info (no second `/v1/info`). `network` keeps a
 * row's `address` on the network its script was derived for. */
const derivingClient = (
    wallet: IWallet,
    info: ArkadeInfo,
    contractManager: Awaited<ReturnType<IWallet["getContractManager"]>>,
): Promise<arkade.Arkade> =>
    arkade.Arkade.connect({
        arkade: { getInfo: async () => info },
        identity: wallet.identity,
        network: networkFromArkadeInfo(info),
        contractManager,
    });

function offerContractParams(
    client: arkade.Arkade,
    binding: Omit<Offer, "swapPkScript">,
    operatorPubkey: Uint8Array,
    expectedPkScript: Uint8Array,
) {
    const { program, args, keys } = swapProgramBinding(binding, operatorPubkey);
    const contract = new arkade.ArkadeContract(client, program, args, keys);
    // the row is keyed by script: registering any other script would leave the real deposit
    // unwatched and unmarked
    if (hex.encode(contract.pkScript) !== hex.encode(expectedPkScript)) {
        throw new Error("derived covenant does not match the offer's swapPkScript");
    }
    return {
        ...contract.toContractParams(),
        label: OFFER_CONTRACT_LABEL,
        metadata: { genericallySpendable: false, kind: OFFER_CONTRACT_KIND },
    };
}

/** What coverage reads off a swap: an `AssetSwap` fits, and so does a drive record's facts. */
export type OfferCoverageSwap = Pick<
    AssetSwap,
    "status" | "swapPkScript" | "offerHex" | "createdAt"
> &
    CoverageRegistrationOptions;

export async function restoreOfferCoverage(
    wallet: IWallet,
    swaps: readonly OfferCoverageSwap[],
): Promise<void> {
    const live = swaps.filter((swap) => !RETIRABLE.includes(swap.status));
    if (live.length === 0) return;

    const [info, contractManager] = await Promise.all([
        wallet.getArkadeInfo({ requireLive: true }),
        wallet.getContractManager(),
    ]);
    const operatorPubkey = hex.decode(toXOnlySignerHex(info.signerPubkey));
    const client = await derivingClient(wallet, info, contractManager);
    const seen = new Set<string>();
    const covenants = [];
    for (const swap of live) {
        if (seen.has(swap.swapPkScript)) continue;
        seen.add(swap.swapPkScript);
        try {
            const { swapPkScript: _, ...binding } = decodeOffer(hex.decode(swap.offerHex));
            covenants.push({
                script: swap.swapPkScript,
                issued: swap.createdAt,
                coverageId: swap.coverageId,
                params: offerContractParams(
                    client,
                    binding,
                    operatorPubkey,
                    hex.decode(swap.swapPkScript),
                ),
            });
        } catch (error) {
            console.warn(`[swap] could not restore coverage for ${swap.swapPkScript}`, error);
        }
    }
    const params = covenants.map((covenant) => covenant.params);
    if (contractManager.createContracts) {
        await contractManager.createContracts(params);
    } else {
        for (const contract of params) await contractManager.createContract(contract);
    }
    for (const covenant of covenants) {
        await promoteOfferContract(contractManager, covenant.script, covenant.issued, {
            coverageId: covenant.coverageId,
            restore: true,
            scope: wallet,
        });
    }
}

// ── User operations ─────────────────────────────────────────────────────────

/**
 * The exit delay from the server's scalar `unilateralExitDelay`, with arkd's own threshold: below
 * 512 it is blocks, otherwise seconds. A missing value arrives as `0` (`RestArkProvider` defaults
 * it) and is refused: an offer claiming an exit it does not have is worse than one that never did.
 */
function serverExitDelay(delay: bigint): RelativeTimelock {
    // `typeof` too: a provider predating the field omits it, and comparing that to a bigint throws a
    // TypeError naming neither the field nor the way out
    if (typeof delay !== "bigint" || delay <= BigInt(0)) {
        throw new Error(
            "the server reports no usable unilateralExitDelay; pass `exitDelay` to set the offer's " +
                "exit closure explicitly, or `noExit: true` to publish without one",
        );
    }
    return assertExitDelay({ value: delay, type: delay < BigInt(512) ? "blocks" : "seconds" });
}

/**
 * Build a new offer for `wallet` (the user). Fund `address` with the side
 * you deposit, embedding the returned extension, and the solver does the rest:
 *
 *   // BTC -> asset
 *   const o = await createOffer(wallet, { wantAmount: 1000n, wantAsset })
 *   await wallet.send({ address: o.address, amount: 1000, extensions: [o.extension] })
 *
 *   // asset -> BTC (the sats are the VTXO carrier for the asset)
 *   const o = await createOffer(wallet, { wantAmount: 1000n, offerAsset })
 *   await wallet.send({ address: o.address, amount: 500,
 *                       assets: [{ assetId, amount: 1000n }],
 *                       extensions: [o.extension] })
 *
 * Broadcasts nothing, but registers the covenant before returning the address: a failure now is
 * retryable, whereas after `wallet.send` it would leave a funded deposit unwatched. The unilateral
 * exit closure is built by default (server's `unilateralExitDelay`, as solverd does); without it only
 * the server-co-signed `cancel` gets the deposit out, and an offer never expires.
 *
 * @deprecated Internal to `accept()`; no replacement. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export async function createOffer(
    wallet: IWallet,
    params: OfferParams,
    options: CoverageRegistrationOptions = {},
): Promise<{
    /** The encoded offer, hex. **Persist this** — it is the only input `cancelOffer` needs to
     * rebuild the covenant. */
    offerHex: string;
    /** Ready for `wallet.send`'s `extensions` — the caller never handles the packet type. */
    extension: { type: number; payload: Uint8Array };
    /** The swap address to fund. Identical offers derive an identical address, so the funding
     * txid — not the address — identifies one deposit. */
    address: string;
    /** The covenant's scriptPubKey: the key an indexer watches to spot the
     * deposit and its later spend (`AssetSwap.swapPkScript`). */
    swapPkScript: Uint8Array;
}> {
    const derived = await deriveOffer(wallet, params);
    await registerDerivedOffer(wallet, derived, options);
    return {
        offerHex: derived.offerHex,
        extension: derived.extension,
        address: derived.address,
        swapPkScript: derived.swapPkScript,
    };
}

export interface OfferParams {
    receiveAddress?: string;
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
     * server — as the only way back out. See the note on {@link createOffer}. */
    noExit?: boolean;
    /**
     * A live `getArkadeInfo` the caller already made.
     *
     * Passing it is what lets one live read bind both the derivation and the
     * registration that follows it; omitting it makes the read here. It must be
     * live for the reason {@link createOffer} reads live — the info's
     * `signerPubkey` ends up in a covenant leaf.
     */
    info?: ArkadeInfo;
    /**
     * The maker position, when the caller already read it.
     *
     * The RFQ path reads it BEFORE it sends the request — the profile commits
     * to this script and this key — so re-reading it here would let an address
     * rotation between the two reads derive a covenant the solver never quoted.
     */
    maker?: { pkScript: Uint8Array; publicKey: Uint8Array };
}

/**
 * Everything an offer commits to, derived and encoded, with nothing written.
 *
 * The split exists because `quote()` must derive the covenant it verifies the
 * solver's `offer_address` against while persisting and registering nothing,
 * and `accept()` must register **that** derivation rather than a second one
 * built from the same terms. So the tree's own parameters travel on this value:
 * two derivations that can disagree is the failure the hand-off deletes.
 */
export interface DerivedOffer {
    readonly offerHex: string;
    readonly extension: { readonly type: number; readonly payload: Uint8Array };
    readonly address: string;
    readonly swapPkScript: Uint8Array;
    /** The covenant's parameters — {@link registerDerivedOffer}'s only input. */
    readonly binding: Readonly<Omit<Offer, "swapPkScript">>;
    /** The live info this covenant is bound to. */
    readonly info: ArkadeInfo;
    readonly operatorPubkey: Uint8Array;
}

export function resolveReceivePkScript(
    receiveAddress: string | undefined,
    walletPkScript: Uint8Array,
    hrp: string,
    serverPubKey: Uint8Array,
): Uint8Array {
    if (receiveAddress === undefined) return walletPkScript;
    let address: ArkAddress;
    try {
        address = ArkAddress.decode(receiveAddress);
    } catch (cause) {
        throw new Error("receiveAddress is not a valid Arkade address", { cause });
    }
    if (address.hrp !== hrp) {
        throw new Error(
            `receiveAddress network ${address.hrp} does not match the server network ${hrp}`,
        );
    }
    if (address.encode() !== receiveAddress) {
        throw new Error("receiveAddress is not in canonical bech32m form");
    }
    if (hex.encode(address.serverPubKey) !== hex.encode(serverPubKey)) {
        throw new Error(
            "receiveAddress is bound to a different server public key than the connected server",
        );
    }
    return address.pkScript;
}

/** Derive and encode an offer. Writes nothing, locally or remotely. */
export async function deriveOffer(wallet: IWallet, params: OfferParams): Promise<DerivedOffer> {
    if (Boolean(params.wantAsset) === Boolean(params.offerAsset)) {
        throw new Error("set exactly one of wantAsset (BTC->asset) or offerAsset (asset->BTC)");
    }
    if (params.wantAmount < BigInt(1)) {
        throw new Error("wantAmount must be positive: a zero want lets anyone take the deposit");
    }
    const [info, maker] = await Promise.all([
        // requireLive: this binds signerPubkey into the covenant, and a snapshot could derive an
        // address the operator no longer co-signs for — fail closed instead
        params.info ?? wallet.getArkadeInfo({ requireLive: true }),
        params.maker ??
            (async () => {
                const [address, publicKey] = await Promise.all([
                    wallet.getAddress(),
                    wallet.identity.xOnlyPublicKey(),
                ]);
                return { pkScript: ArkAddress.decode(address).pkScript, publicKey };
            })(),
    ]);
    const operatorPubKey = hex.decode(toXOnlySignerHex(info.signerPubkey));
    const network = networkFromArkadeInfo(info);
    const emuKey = hex.decode(
        toXOnlySignerHex(resolveEmulatorPubkey(network, params.emulatorPubkey)),
    );

    // the script derives from every other field, so build the binding first — an Offer value never
    // exists with an empty swapPkScript
    const binding = Object.freeze({
        wantAmount: params.wantAmount,
        wantAsset: params.wantAsset,
        offerAsset: params.offerAsset,
        makerPkScript: resolveReceivePkScript(
            params.receiveAddress,
            maker.pkScript,
            network.hrp,
            operatorPubKey,
        ),
        makerPublicKey: maker.publicKey,
        emulatorPubkey: emuKey,
        // checked before registration below. @see assertExitDelay
        exitDelay: params.noExit
            ? undefined
            : params.exitDelay
              ? assertExitDelay(params.exitDelay)
              : serverExitDelay(info.unilateralExitDelay),
    });
    const script = offerContract(binding, operatorPubKey);
    const offer: Offer = { ...binding, swapPkScript: script.pkScript };
    const payload = encodeOffer(offer);
    // frozen because `SwapClient.preparationOf` hands this very value out, and `accept()` registers it
    return Object.freeze({
        offerHex: hex.encode(payload),
        extension: { type: OFFER_PACKET_TYPE, payload },
        // the contract's .address() builds the address; assembling an ArkAddress
        // from tweakedPublicKey here would silently miss any future step it gains
        address: script.address(network.hrp, operatorPubKey).encode(),
        swapPkScript: script.pkScript,
        binding,
        info,
        operatorPubkey: operatorPubKey,
    });
}

/**
 * Register a derived offer's covenant, so the deposit is watched and marked as
 * escrow before anything funds it. See {@link registerOfferContract}.
 */
export async function registerDerivedOffer(
    wallet: IWallet,
    derived: DerivedOffer,
    options: CoverageRegistrationOptions = {},
): Promise<void> {
    await registerOfferContract(
        wallet,
        derived.info,
        derived.binding,
        derived.operatorPubkey,
        derived.swapPkScript,
        options,
    );
}

/**
 * Cancel an offer: spend the swap VTXO back to the user. Returns the ark txid. No path is on a
 * deadline, so an unfilled deposit stays at the swap address until the user cancels.
 *
 * Routes out: `fulfill` (server alone, but constrained to pay `makerWP` at least `wantAmount`),
 * `cancel` (user+server 2-of-2, no solver involved), `exit` (user alone after a CSV unless `noExit`;
 * reached by unrolling onchain, not here).
 *
 * Cancel races a fill: if `fulfill` spent first this throws "no spendable VTXO at the swap address",
 * which means the swap completed (`classifySpend` tells the spends apart by leaf). The escrow marker
 * gates implicit coin selection only; cancel names its input explicitly.
 *
 * `fundingTxid` selects the deposit (identical offers share an address); without it the address must
 * hold exactly one. `swapAddress` pins the funding-time operator key across a signer rotation. When
 * `repository` holds the record, this writes `cancelling` (crash marker) then `cancelled`, so the
 * watcher has nothing to decide for our own cancels; otherwise the watcher/restore scan classifies.
 *
 * @deprecated Use `client.cancel()`. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export async function cancelOffer(
    wallet: IWallet,
    offerHex: string,
    opts: {
        repository: AssetSwapRepository;
        fundingTxid?: string;
        fundingOutpoint?: FillOutpoint;
        swapAddress?: string;
    },
): Promise<string> {
    const { repository, fundingTxid, fundingOutpoint, swapAddress } = opts;
    const prepared = await prepareOfferCancel(wallet, offerHex, {
        ...(fundingTxid === undefined ? {} : { fundingTxid }),
        ...(fundingOutpoint === undefined ? {} : { fundingOutpoint }),
        ...(swapAddress === undefined ? {} : { swapAddress }),
    });
    // v1 keys on the deposit; the v2 client keys on its quote id and runs the same ordering over its
    // own record (see `client/cancel.ts`)
    const swapId = fundingTxid ?? prepared.vtxo.txid;
    // strict read: a failure must not read as "no local record" and skip the marker
    const hasLocalRecord = (await getAssetSwapsOrThrow(repository)).some((s) => s.id === swapId);
    // the marker gates the broadcast, so it throws: it keeps a crash here from leaving a swap that
    // still looks pending
    if (hasLocalRecord) await updateAssetSwap(repository, swapId, { status: "cancelling" });
    const txid = await prepared.send();
    if (hasLocalRecord) {
        // Past the point of no return: a lost write must not fail the caller. The watcher classifies
        // by covenant leaf and the restore scan re-derives the outcome.
        const { persisted, swaps } = await updateAssetSwapBestEffort(repository, swapId, {
            status: "cancelled",
            spentTxid: txid,
        });
        // Retired here because the watcher returns on a terminal record before it would retire
        // (`spendUpdate`), so nothing else would drop this script. Only on a persisted write: a
        // record that still reads `pending` to the next restore scan must stay watched.
        if (persisted) {
            const contractManager = await wallet.getContractManager();
            await retireOfferContract(
                contractManager,
                swaps,
                hex.encode(prepared.offer.swapPkScript),
                { scope: wallet },
            );
        }
    }
    return txid;
}

/**
 * No deposit left to cancel at the swap address — almost always the fill winning the race. Typed so
 * the v2 client's `cancel()` reconciles by `instanceof` (see `client/cancel.ts`); message is v1's.
 *
 * @deprecated Internal to `accept()`; no replacement. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export class NoSpendableDepositError extends Error {
    override readonly name = "NoSpendableDepositError";
    constructor(options?: ErrorOptions) {
        super("no spendable VTXO at the swap address", options);
    }
}

/**
 * The rebuilt covenant disagrees with the offer's `swapPkScript`: the pinned operator key is not the
 * one the covenant was funded with (rotated signer, a wrong `swapAddress`, or a corrupt record).
 * Fires before any broadcast.
 *
 * @deprecated Internal to `accept()`; no replacement. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export class OfferCovenantMismatchError extends Error {
    override readonly name = "OfferCovenantMismatchError";
    constructor(
        readonly swapPkScript: string,
        options?: ErrorOptions,
    ) {
        super(
            "rebuilt covenant does not match the offer's swapPkScript — the operator signing key pinned by the " +
                "rebuild does not reproduce the funded covenant; the signing key has " +
                "likely rotated since funding (pass swapAddress, the funded address, to " +
                "pin the original key), or the record is corrupt",
            options,
        );
    }
}

/** A cancel ready to broadcast: the deposit it spends, and the send. */
export interface PreparedOfferCancel {
    /** The decoded offer — the covenant's script is the watcher's matching key. */
    readonly offer: Offer;
    /** The deposit selected for the cancel. */
    readonly vtxo: { txid: string; vout: number; value: number };
    /** Broadcast the cancel and return its txid. */
    send(): Promise<string>;
}

/**
 * Everything {@link cancelOffer} does before the broadcast — rebuild the covenant, pin the
 * funding-time operator key, select the deposit, build the `cancel` spend — so the caller owns the
 * record ordering that gates it. Touches no record.
 */
export async function prepareOfferCancel(
    wallet: IWallet,
    offerHex: string,
    opts: {
        fundingTxid?: string;
        fundingOutpoint?: FillOutpoint;
        /** The funded address — pins the operator key the covenant was built
         * with, so cancel keeps working across a signer rotation. */
        swapAddress?: string;
    },
): Promise<PreparedOfferCancel> {
    const { fundingTxid, fundingOutpoint, swapAddress } = opts;
    const offer = decodeOffer(hex.decode(offerHex));

    const [contractManager, info, reader, broadcaster] = await Promise.all([
        wallet.getContractManager(),
        wallet.getArkadeInfo({ requireLive: true }),
        wallet.getArkadeReader(),
        wallet.getArkadeBroadcaster(),
    ]);
    const client = await arkade.Arkade.connect({
        arkade: { getInfo: async () => info, ...broadcaster },
        indexer: reader,
        identity: wallet.identity,
        // registered offers resolve VTXOs from the contract repository; the indexer is the fallback
        // for offers created before registration existed
        contractManager,
        // no `network`: the row lookup is by script and the payout comes from wallet.getAddress()
        oneShotSubmit: wallet.oneShotSubmit,
    });

    // the offer's own keys, not the client's, so the script matches the funded address exactly
    const operatorPubkey = swapAddress
        ? ArkAddress.decode(swapAddress).serverPubKey
        : client.serverKey;
    const { program, args, keys } = swapProgramBinding(offer, operatorPubkey);
    // a mismatch means the wrong operator key; getUtxos would just return nothing, so fail with the
    // diagnosis instead
    let rebuilt: InstanceType<typeof arkade.ArkadeProgramScript>;
    try {
        rebuilt = new arkade.ArkadeProgramScript(program, args, keys);
    } catch (cause) {
        // a pinned key that is not a curve point throws in the taproot encoder — same diagnosis
        throw new OfferCovenantMismatchError(hex.encode(offer.swapPkScript), { cause });
    }
    if (hex.encode(rebuilt.pkScript) !== hex.encode(offer.swapPkScript)) {
        throw new OfferCovenantMismatchError(hex.encode(offer.swapPkScript));
    }
    const contract = new arkade.ArkadeContract(client, program, args, keys);

    const [vtxos, makerAddress] = await Promise.all([contract.getUtxos(), wallet.getAddress()]);
    const vtxo = resolveDeposit(vtxos, { fundingTxid, fundingOutpoint });

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
    return {
        offer,
        vtxo: { txid: vtxo.txid, vout: vtxo.vout, value: vtxo.value },
        send: async () => (await cancel.send()).txid,
    };
}

/** Sats carried by output 0 when the maker is paid in an ASSET: the covenant checks the asset, and
 * the output still needs its own carrier. Overridable per fill via `assetCarrierSats`.
 *
 * @deprecated Read it from `@arkade-os/sdk`, which owns the constant. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export const ASSET_CARRIER_SATS = BigInt(SDK_ASSET_CARRIER_SATS);

/**
 * A coin the taker supplies, plus the assets it carries. `ArkTxInput` is sats-only, and **arkd
 * refuses a spend whose asset packet omits an asset one of its inputs owns** (`ASSET_NOT_FOUND`), so
 * every asset on a funding coin must be declared. A wallet's own coins already carry this shape.
 */
export type FillFunding = ArkTxInput & {
    assets?: readonly { assetId: string; amount: bigint | number }[];
};

/** @deprecated Use `Outpoint` from `@arkade-os/sdk`. */
export type FillOutpoint = Outpoint;

export type FillInputOwner = "solver" | "sponsor";

export type FillOutputRole = "receiver" | "solver" | "sponsor-fare" | "sponsor-change";

export interface SponsorFillInput {
    fund: FillFunding[];

    netContributionSats: bigint | number;

    combineSatsFareWithChange?: boolean;

    fare?: {
        assetId?: string;
        amount?: bigint | number;
        script: Uint8Array;
        sats: bigint | number;
    };

    changeScript: Uint8Array;
}

/**
 * Fill an offer — the TAKER's side, and the counterpart to {@link createOffer}. Composes the
 * `fulfill` spend; it does not weaken or reinterpret the covenant.
 *
 * For an ASSET want the covenant reads output 0 through `OP_INSPECTOUTASSETLOOKUP` with
 * `lookup_index = 0`, so the wanted asset must be the FIRST group in the packet (groups keep insertion
 * order) and output 0 carries only a dust carrier ({@link ASSET_CARRIER_SATS}). Every other asset in
 * the spend goes to the taker's payout; see {@link FillFunding}.
 *
 * Writes NO local swap record: the maker learns the outcome from the chain (RFQ protocol § 7.2).
 * `fund` is explicit because only the caller knows which coins are reserved (e.g. a corridor's
 * float). Racing a cancel is NORMAL: "no spendable VTXO at the swap address" means the offer is gone.
 *
 * @deprecated The v2 client has no taker-side fill, so there is no replacement:
 * `accept()` funds a covenant of your own; it does not spend someone else's
 * offer through its `fulfill` leaf. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export async function fillOffer(
    wallet: IWallet,
    arkServerUrl: string,
    offerHex: string,
    opts: {
        fund: FillFunding[];

        payoutScript?: Uint8Array;

        fundingTxid?: string;

        fundingOutpoint?: FillOutpoint;

        swapAddress?: string;

        assetCarrierSats?: bigint;

        emulator: EmulatorProvider | string;

        emulatorPubkey?: string;
    },
): Promise<string> {
    const {
        fund,
        payoutScript,
        fundingTxid,
        fundingOutpoint,
        swapAddress,
        assetCarrierSats = ASSET_CARRIER_SATS,
        emulator,
        emulatorPubkey,
    } = opts;
    const offer = decodeOffer(hex.decode(offerHex));
    const contract = await connectFillContract(wallet, arkServerUrl, offer, {
        swapAddress,
        emulator,
        emulatorPubkey,
    });
    const [vtxos, takerAddress] = await Promise.all([contract.getUtxos(), wallet.getAddress()]);
    const vtxo = resolveDeposit(vtxos, { fundingTxid, fundingOutpoint });
    const fill = contract.functions.fulfill();
    assembleOfferFill(fill, {
        offer,
        vtxo,
        solverFund: fund,
        solverPayout: payoutScript ?? ArkAddress.decode(takerAddress).pkScript,
        assetCarrierSats,
    });
    const { txid } = await fill.send();
    return txid;
}

export async function connectFillContract(
    wallet: IWallet,
    arkServerUrl: string,
    offer: Offer,
    opts: {
        swapAddress?: string;
        emulator?: EmulatorProvider | string;
        emulatorPubkey?: string;
    } = {},
): Promise<arkade.ArkadeContract> {
    const { swapAddress, emulator, emulatorPubkey } = opts;
    const contractManager = await wallet.getContractManager();
    const client = await arkade.Arkade.connect({
        arkade: new RestArkProvider(arkServerUrl),
        indexer: new RestIndexerProvider(arkServerUrl),
        identity: wallet.identity,
        contractManager,
        ...(emulator !== undefined
            ? {
                  emulator:
                      typeof emulator === "string" ? new RestEmulatorProvider(emulator) : emulator,
              }
            : {}),
        ...(emulatorPubkey ? { emulatorPubkey } : {}),
    });

    const serverKey = swapAddress ? ArkAddress.decode(swapAddress).serverPubKey : client.serverKey;
    const { program, args, keys } = swapProgramBinding(offer, serverKey);
    const rebuilt = new arkade.ArkadeProgramScript(program, args, keys);
    if (hex.encode(rebuilt.pkScript) !== hex.encode(offer.swapPkScript)) {
        throw new Error(
            "rebuilt covenant does not match the offer's swapPkScript — the server " +
                "signing key has likely rotated since funding; pass swapAddress (the " +
                "funded address) to pin the original key",
        );
    }
    return new arkade.ArkadeContract(client, program, args, keys);
}

export function resolveDeposit<V extends { txid: string; vout: number }>(
    vtxos: readonly V[],
    sel: { fundingTxid?: string; fundingOutpoint?: FillOutpoint },
): V {
    const { fundingTxid, fundingOutpoint } = sel;
    if (fundingOutpoint !== undefined) {
        const txid = parseHex32(fundingOutpoint.txid, "fundingOutpoint.txid");
        const vout = assertVout(fundingOutpoint.vout, "fundingOutpoint.vout");
        if (fundingTxid !== undefined && fundingTxid.toLowerCase() !== txid) {
            throw new Error(
                `fundingTxid ${fundingTxid} does not match fundingOutpoint ${txid}:${vout} — pass one deposit reference`,
            );
        }
        const vtxo = vtxos.find((v) => v.txid.toLowerCase() === txid && v.vout === vout);
        if (!vtxo) throw new NoSpendableDepositError();
        return vtxo;
    }
    if (fundingTxid !== undefined) {
        const txid = parseHex32(fundingTxid, "fundingTxid");
        const matches = vtxos.filter((v) => v.txid.toLowerCase() === txid);
        if (matches.length > 1) {
            throw new Error(
                `multiple spendable deposits share fundingTxid ${txid} — pass fundingOutpoint to select one`,
            );
        }
        const [vtxo] = matches;
        if (!vtxo) throw new NoSpendableDepositError();
        return vtxo;
    }
    if (vtxos.length > 1) {
        throw new Error(
            "multiple spendable deposits at the swap address — pass fundingTxid to select one",
        );
    }
    const [vtxo] = vtxos;
    if (!vtxo) throw new NoSpendableDepositError();
    return vtxo;
}

export type FillCoin = {
    txid: string;
    vout: number;
    value: number;
    assets?: readonly { assetId: string; amount: bigint | number }[] | undefined;
};

export interface AssembledFillLayout {
    inputs: { owner: FillInputOwner | null; txid: string; vout: number }[];
    outputs: { role: FillOutputRole; script: Uint8Array; sats: bigint }[];
}

export function assembleOfferFill(
    fill: arkade.ArkadeTransactionBuilder,
    args: {
        offer: Offer;
        vtxo: FillCoin;
        solverFund: FillFunding[];
        solverPayout: Uint8Array;
        assetCarrierSats?: bigint;
        sponsor?: SponsorFillInput;
    },
): AssembledFillLayout {
    const {
        offer,
        vtxo,
        solverFund,
        solverPayout,
        assetCarrierSats = ASSET_CARRIER_SATS,
        sponsor,
    } = args;
    const wantedAssetId = offer.wantAsset?.toString();

    if (solverFund.length === 0) {
        throw new Error("fillOffer needs coins to pay wantAmount with — `fund` is empty");
    }
    solverFund.forEach((coin, i) => assertFillCoin(coin, `fund[${i}]`));
    assertScript(solverPayout, "payoutScript");
    toAmount(vtxo.value, "deposit.value", "sats", BigInt(1));
    assertAssetEntries(vtxo.assets, "deposit");
    const carrier = toAmount(assetCarrierSats, "assetCarrierSats", "sats", BigInt(1));

    let sponsorFund: FillFunding[] = [];
    let sponsorChange = BigInt(0);
    let fareAsset = "";
    let fareAmount = BigInt(0);
    let fareSats = BigInt(0);
    let combineSatsFareWithChange = false;
    if (sponsor !== undefined) {
        if (sponsor.fund.length === 0) {
            throw new Error("sponsor needs coins to contribute with — `sponsor.fund` is empty");
        }
        sponsor.fund.forEach((coin, i) => {
            assertFillCoin(coin, `sponsor.fund[${i}]`);
            if ((coin.assets?.length ?? 0) > 0) {
                throw new Error(`sponsor.fund[${i}] carries assets — sponsor funding is sats-only`);
            }
        });
        assertScript(sponsor.changeScript, "sponsor.changeScript");
        const contribution = toAmount(
            sponsor.netContributionSats,
            "sponsor.netContributionSats",
            "sats",
        );
        if (contribution <= BigInt(0)) {
            throw new Error("sponsor.netContributionSats must be a positive amount of sats");
        }
        if (
            sponsor.combineSatsFareWithChange !== undefined &&
            typeof sponsor.combineSatsFareWithChange !== "boolean"
        ) {
            throw new Error("sponsor.combineSatsFareWithChange must be a boolean");
        }
        combineSatsFareWithChange = sponsor.combineSatsFareWithChange === true;
        if (combineSatsFareWithChange && sponsor.fare === undefined) {
            throw new Error("sponsor.combineSatsFareWithChange requires a fare");
        }
        if (sponsor.fare !== undefined) {
            const { assetId, amount } = sponsor.fare;
            if ((assetId === undefined) !== (amount === undefined)) {
                throw new Error(
                    "sponsor.fare needs assetId and amount together, or neither for a sats fare",
                );
            }
            if (assetId !== undefined) {
                fareAsset = assertAssetId(assetId, "sponsor.fare.assetId");
                fareAmount = toAmount(amount, "sponsor.fare.amount", "asset units");
                if (fareAmount <= BigInt(0)) {
                    throw new Error("sponsor.fare.amount must be a positive amount of asset units");
                }
            }
            assertScript(sponsor.fare.script, "sponsor.fare.script");
            fareSats = toAmount(sponsor.fare.sats, "sponsor.fare.sats", "sats", BigInt(1));
            if (combineSatsFareWithChange) {
                if (assetId !== undefined) {
                    throw new Error("sponsor.combineSatsFareWithChange requires a sats-only fare");
                }
                if (hex.encode(sponsor.fare.script) !== hex.encode(sponsor.changeScript)) {
                    throw new Error(
                        "sponsor.combineSatsFareWithChange requires fare and change to use the same script",
                    );
                }
            }
        }
        const sponsorInputs = sponsor.fund.reduce((s, c) => s + BigInt(c.value), BigInt(0));
        if (contribution > sponsorInputs) {
            throw new Error(
                `sponsor.netContributionSats ${contribution} exceeds the sponsor inputs ${sponsorInputs}`,
            );
        }
        sponsorFund = sponsor.fund;
        const baseSponsorChange = sponsorInputs - contribution;
        sponsorChange = combineSatsFareWithChange
            ? toAmount(baseSponsorChange + fareSats, "combined sponsor change", "sats", BigInt(1))
            : baseSponsorChange;
    }
    if (wantedAssetId !== undefined) {
        const required =
            offer.wantAmount +
            (sponsor?.fare !== undefined && fareAsset === wantedAssetId ? fareAmount : BigInt(0));
        const supplied = solverFund.reduce(
            (sum, coin) => sum + amountOfAsset(coin.assets, wantedAssetId),
            BigInt(0),
        );
        if (supplied < required) {
            throw new Error(
                `fillOffer needs ${required} of ${wantedAssetId} to pay the maker, but ` +
                    `\`fund\` declares ${supplied} — pass coins carrying it, and declare their assets`,
            );
        }
    }
    if (offer.offerAsset) {
        const offered = offer.offerAsset.toString();
        const deposited = amountOfAsset(vtxo.assets, offered);
        if (deposited <= BigInt(0)) {
            throw new Error(
                `the deposit at the swap address carries no ${offered}, which this offer sells — ` +
                    "filling it would pay wantAmount for nothing. The indexer may be behind, or " +
                    "the offer may not be backed by what it advertises",
            );
        }
    }
    const seen = new Set<string>();
    const claim = (txid: string, vout: number, what: string) => {
        const key = `${txid.toLowerCase()}:${vout}`;
        if (seen.has(key)) throw new Error(`duplicate fill input ${key} (${what})`);
        seen.add(key);
    };
    claim(parseHex32(vtxo.txid, "deposit.txid"), assertVout(vtxo.vout, "deposit.vout"), "deposit");
    solverFund.forEach((coin, i) => claim(coin.txid, coin.vout, `fund[${i}]`));
    sponsorFund.forEach((coin, i) => claim(coin.txid, coin.vout, `sponsor.fund[${i}]`));
    const makerSats =
        wantedAssetId === undefined
            ? toAmount(offer.wantAmount, "offer.wantAmount", "sats")
            : carrier;
    const outputs: AssembledFillLayout["outputs"] = [
        { role: "receiver", script: offer.makerPkScript, sats: makerSats },
    ];
    const fareVout = outputs.length;
    if (sponsor?.fare !== undefined && !combineSatsFareWithChange) {
        outputs.push({ role: "sponsor-fare", script: sponsor.fare.script, sats: fareSats });
    }
    if (sponsor !== undefined && sponsorChange > BigInt(0)) {
        outputs.push({ role: "sponsor-change", script: sponsor.changeScript, sats: sponsorChange });
    }
    const solverVout = outputs.length;

    fill.from({ txid: vtxo.txid, vout: vtxo.vout, value: vtxo.value })
        .fund(sponsorFund.length > 0 ? [...solverFund, ...sponsorFund] : solverFund)
        .to(offer.makerPkScript, makerSats);
    if (sponsor?.fare !== undefined && !combineSatsFareWithChange)
        fill.to(sponsor.fare.script, fareSats);
    if (sponsor !== undefined && sponsorChange > BigInt(0))
        fill.to(sponsor.changeScript, sponsorChange);
    fill.change(solverPayout);
    const held = new Map<string, { vin: number; amount: bigint }[]>();
    const hold = (vin: number, assets: FillFunding["assets"]) => {
        for (const a of assets ?? []) {
            const amount = BigInt(a.amount);
            if (amount <= BigInt(0)) continue;
            held.set(a.assetId, [...(held.get(a.assetId) ?? []), { vin, amount }]);
        }
    };
    hold(0, vtxo.assets);
    solverFund.forEach((coin, i) => hold(i + 1, coin.assets));
    sponsorFund.forEach((coin, i) => hold(1 + solverFund.length + i, coin.assets));

    const explicitSats = outputs.reduce((s, o) => s + o.sats, BigInt(0));
    const inputsSum =
        BigInt(vtxo.value) +
        solverFund.reduce((s, c) => s + BigInt(c.value), BigInt(0)) +
        sponsorFund.reduce((s, c) => s + BigInt(c.value), BigInt(0));
    if (inputsSum > MAX_SAFE_SATS) {
        throw new Error(`fill inputs total ${inputsSum} sats exceeds the safe integer domain`);
    }
    if (explicitSats > MAX_SAFE_SATS) {
        throw new Error(`fill outputs total ${explicitSats} sats exceeds the safe integer domain`);
    }
    if (explicitSats > inputsSum) {
        throw new Error(
            `fill outputs total ${explicitSats} sats but the inputs carry ${inputsSum} — ` +
                "increase solver or sponsor funding",
        );
    }
    const hasPayoutOutput = inputsSum > explicitSats;

    if (sponsor?.fare !== undefined && fareAsset !== "") {
        const carried = (held.get(fareAsset) ?? []).reduce((s, i) => s + i.amount, BigInt(0));
        if (carried < fareAmount) {
            throw new Error(
                `sponsor fare needs ${fareAmount} of ${fareAsset} but the inputs carry ${carried}`,
            );
        }
    }

    const stranded = (assetId: string, amount: bigint): Error =>
        new Error(
            `fillOffer has ${amount} of ${assetId} to return but no payout output — ` +
                "fund with more sats than the maker's output takes",
        );
    if (wantedAssetId !== undefined) {
        const supplying = held.get(wantedAssetId) ?? [];
        const supplied = supplying.reduce((s, i) => s + i.amount, BigInt(0));
        const group = [{ vout: 0, amount: offer.wantAmount }];
        const farePart =
            sponsor?.fare !== undefined && fareAsset === wantedAssetId ? fareAmount : BigInt(0);
        if (farePart > BigInt(0)) group.push({ vout: fareVout, amount: farePart });
        const surplus = supplied - offer.wantAmount - farePart;
        if (surplus > BigInt(0)) {
            if (!hasPayoutOutput) throw stranded(wantedAssetId, surplus);
            group.push({ vout: solverVout, amount: surplus });
        }
        fill.withAsset({ assetId: wantedAssetId, inputs: supplying, outputs: group });
        held.delete(wantedAssetId);
    }
    if (sponsor?.fare !== undefined && fareAsset !== "" && fareAsset !== wantedAssetId) {
        const supplying = held.get(fareAsset) ?? [];
        const carried = supplying.reduce((s, i) => s + i.amount, BigInt(0));
        const group = [{ vout: fareVout, amount: fareAmount }];
        const remainder = carried - fareAmount;
        if (remainder > BigInt(0)) {
            if (!hasPayoutOutput) throw stranded(fareAsset, remainder);
            group.push({ vout: solverVout, amount: remainder });
        }
        fill.withAsset({ assetId: fareAsset, inputs: supplying, outputs: group });
        held.delete(fareAsset);
    }
    for (const [assetId, inputs] of held) {
        const amount = inputs.reduce((s, i) => s + i.amount, BigInt(0));
        if (!hasPayoutOutput) throw stranded(assetId, amount);
        fill.withAsset({ assetId, inputs, outputs: [{ vout: solverVout, amount }] });
    }

    if (hasPayoutOutput) {
        outputs.push({ role: "solver", script: solverPayout, sats: inputsSum - explicitSats });
    }
    return {
        inputs: [
            { owner: null, txid: vtxo.txid.toLowerCase(), vout: vtxo.vout },
            ...solverFund.map((coin) => ({
                owner: "solver" as const,
                txid: coin.txid.toLowerCase(),
                vout: coin.vout,
            })),
            ...sponsorFund.map((coin) => ({
                owner: "sponsor" as const,
                txid: coin.txid.toLowerCase(),
                vout: coin.vout,
            })),
        ],
        outputs,
    };
}

const amountOfAsset = (assets: FillFunding["assets"], assetId: string): bigint => {
    let total = BigInt(0);
    for (const a of assets ?? []) {
        if (a.assetId === assetId) total += BigInt(a.amount);
    }
    return total;
};

const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);

const MAX_SAFE_SATS = BigInt(Number.MAX_SAFE_INTEGER);

function assertVout(vout: unknown, what: string): number {
    if (typeof vout !== "number" || !Number.isSafeInteger(vout) || vout < 0 || vout > 0xffffffff) {
        throw new Error(`${what} must be a non-negative output index`);
    }
    return vout;
}

function toAmount(
    value: unknown,
    what: string,
    unit: "sats" | "asset units",
    min = BigInt(0),
): bigint {
    const max = unit === "sats" ? MAX_SAFE_SATS : U64_MAX;
    let amount: bigint | undefined;
    if (typeof value === "bigint") {
        if (value >= BigInt(0) && value <= max) amount = value;
    } else if (typeof value === "number") {
        if (Number.isSafeInteger(value) && value >= 0) amount = BigInt(value);
    }
    if (amount === undefined) {
        throw new Error(`${what} must be a safe integer amount of ${unit} (0 to ${max})`);
    }
    if (amount < min) {
        throw new Error(`${what} must be a positive amount of ${unit}`);
    }
    return amount;
}

function assertScript(script: unknown, what: string): asserts script is Uint8Array {
    if (!(script instanceof Uint8Array) || script.length === 0) {
        throw new Error(`${what} must be a non-empty output script`);
    }
}

function assertAssetId(assetId: unknown, what: string): string {
    if (typeof assetId !== "string") throw new Error(`${what} must be an asset id string`);
    try {
        return asset.AssetId.fromString(assetId).toString();
    } catch {
        throw new Error(`${what} is not a valid asset id`);
    }
}

function assertAssetEntries(assets: FillFunding["assets"], what: string): void {
    const seen = new Set<string>();
    for (const [i, a] of (assets ?? []).entries()) {
        const id = assertAssetId(a.assetId, `${what}.assets[${i}].assetId`);
        if (seen.has(id)) {
            throw new Error(`${what} declares ${id} twice — merge the entries instead`);
        }
        seen.add(id);
        toAmount(a.amount, `${what}.assets[${i}].amount`, "asset units");
    }
}

function assertFillCoin(coin: FillFunding, what: string): void {
    parseHex32(coin.txid, `${what}.txid`);
    assertVout(coin.vout, `${what}.vout`);
    toAmount(coin.value, `${what}.value`, "sats", BigInt(1));
    assertAssetEntries(coin.assets, what);
}

/** @deprecated Use `offerContract` from `@arkade-os/swap/protocol`. */
export const offerVtxoScript = offerContract;
