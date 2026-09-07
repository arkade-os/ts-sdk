/**
 * What a corridor is given, what a caller may replace, and where "overridden to
 * nothing" is refused.
 *
 * §6's rules stand as written; what is added here is a shape, because
 * `chain?: ChainSource` cannot tell "absent, use the default" from "disabled,
 * deliberately". Almost every override field is `T | null`: `undefined` takes
 * the default, `null` is the refusal, and {@link resolveCorridorDeps} throws
 * {@link MissingCorridorDep} naming the dep. It cannot reuse the facade's
 * `need()` guard, which tests `value === undefined` and passes a deliberate
 * `null` straight through. The one exception is documented where it lives:
 * the onchain claim fee-rate, whose "disabled" is a working manual mode
 * rather than a missing dep.
 *
 * Resolution runs when a route first touches a corridor and never at
 * construction — a missing dep for a corridor nobody uses is not an error, which
 * is `MissingCorridorDep`'s own boundary note and what §6 means by "at quote
 * time". The registry beside this file is what memoizes that.
 *
 * Four keys, not three: §6 gives lightning two overridable deps and the
 * covclaimd deployment key is the second. The operator seam and the co-signer
 * key are deliberately NOT among them — an override there is a trust anchor §6
 * never granted — so the co-signer arrives on {@link CorridorBase} instead, the
 * way the facade already threads it.
 */
import {
    ESPLORA_URL,
    defaultEmulatorPubkey,
    getNetwork,
    resolveEmulatorPubkey,
    signerSetFromInfo,
    type ArkadeInfo,
    type IWallet,
    type Network,
    type NetworkName,
    type SignerSet,
} from "@arkade-os/sdk";
import type { ChainSource } from "../../onchainHtlc";
import { L1_NETWORKS, ONCHAIN_CLAIM_VSIZE } from "../../onchainHtlc";
import type { RfqSwapManagerCallbacks } from "../../swapManager";
import { l1NetworkFromArk, type InvoiceFacts } from "../../rfq";
import type { SwapOperator } from "../../refund";
import type { AssetSwapRepository } from "../../repository";
import type { Corridor } from "../corridor";
import { MissingCorridorDep, OperatorUnreachable } from "../errors";
import type { Pubkey } from "../primitives";
import { decodeBolt11 } from "./bolt11";
import { esploraChainSource } from "./chainSource";

/**
 * The facts every module reads and no caller replaces.
 *
 * Both wallet and operator seam, and the split is what each is for: the wallet
 * answers *who and where* — it is the only thing that can make the live,
 * fail-closed info read, since `SwapOperator.getInfo()` takes no options — and
 * the operator seam answers *submit and finalize*. Collapsing either into the
 * other would delete a seam the unit tests already double.
 */
export interface CorridorBase {
    readonly wallet: IWallet;
    readonly operator: SwapOperator;
    /** The network the live operator info named. */
    readonly networkName: NetworkName;
    /** Address parameters for {@link networkName}. */
    readonly network: Network;
    /** The operator's signer set, for the rotation-aware recipient check. */
    readonly signerSet: SignerSet;
    /**
     * Covenant co-signer override, 33-byte compressed hex.
     *
     * A dep of the arkade module and not a `CorridorOverrides` key, by the same
     * rule that keeps the operator seam out of them. Required on `testnet` and
     * `signet`, which `EMULATOR_PUBKEYS` does not pin.
     */
    readonly emulatorPubkey?: string;
    /** For hosts without a global `fetch`, and for tests. */
    readonly fetchImpl?: typeof fetch;
    /**
     * The client's storage, if it was given one.
     *
     * Here rather than only in the override matrix so the two seams cannot be
     * two different objects: a client that takes a repository and an arkade
     * override that names one would otherwise write records to one and read the
     * markets cache from the other. The override still wins where it is set,
     * and a deliberate `null` there still refuses.
     */
    readonly repository?: AssetSwapRepository;
}

/**
 * §6's override matrix, with each field widened to admit the refusal.
 *
 * An override replaces a dependency inside an implemented corridor. It never
 * enables a route, never selects a solver or transport, and never alters
 * settlement behaviour — and each one is a named trust anchor: the chain source
 * is whose L1 view evidence is reconciled against, the decoder is who validates
 * an invoice before display, the covclaimd key is who may open the sealed claim
 * packet, the repository is where persist-first lands.
 */
export interface CorridorOverrides {
    arkade?: {
        /** Where persist-first lands. Defaults to the client's own
         * `repository`, so the two seams are one object; `null` refuses. */
        repository?: AssetSwapRepository | null;
    };
    lightning?: {
        /** Default: the package's own {@link decodeBolt11}. */
        decode?: ((bolt11: string) => InvoiceFacts) | null;
        /** Default: an internal ephemeral self-claim seal, which is what
         * `undefined` here means — a deployment key is optional config. */
        covclaimd?: { pubkey: Pubkey } | null;
    };
    onchain?: {
        /** Default: `ESPLORA_URL[network]`. The override is the URL, not a
         * `ChainSource`: there is no wallet-held provider to substitute. */
        chain?: { esploraUrl: string } | null;
        /**
         * How the trader's L1 claim is built and broadcast. Default: see
         * {@link OnchainCorridorDeps.claim} — synthesized from
         * {@link claimFeeRateSatVb} when one is resolvable, so an explicit
         * `null` here preserves manual mode.
         */
        claim?: OnchainClaim | null;
        /**
         * Sat/vB the trader's L1 claim will be built at — and, on the quote
         * path, the rate the take leg is grossed up by so the recipient nets
         * the requested amount after the claim's fee. Default:
         * {@link ONCHAIN_CLAIM_FEE_RATE_SATVB}, per network. Environment-
         * sensitive (mempool congestion moves it) and so overridable.
         *
         * `null` here is NOT the refusal the other override fields carry: it
         * is "no default claim", and manual mode is a meaningful state for
         * this dep rather than a broken one — the corridor still quotes
         * (forwarding the take leg verbatim) and still drives the lockup,
         * and the L1 claim is the caller's to make by hand.
         */
        claimFeeRateSatVb?: number | null;
        /**
         * The vsize the claim is priced at for the recipient-exact gross-up,
         * when a caller knows better than the constant. Default:
         * {@link ONCHAIN_CLAIM_VSIZE}; `null` is "no override given", like
         * `undefined` — the estimate is the constant either way. The claim
         * build itself measures its own transaction and never reads this.
         */
        claimVsize?: number | null;
    };
}

/**
 * Build and broadcast the L1 claim of an `arkade -> onchain` fill.
 *
 * The manager's own callback type, so a caller wires `claimOnchainFill` to it
 * without a second shape to translate through.
 */
export type OnchainClaim = RfqSwapManagerCallbacks["claimOnchain"];

/**
 * The per-network default for the trader's L1 claim fee rate, sat/vB.
 *
 * One number for every network, and deliberately the RELAY FLOOR rather than a
 * market estimate: the rate both builds the claim and prices the
 * recipient-exact gross-up, so a value invented to look precise would be a lie
 * in two places at once — and an over-quoted test-network rate would short the
 * recipient. 1 sat/vB is what every esplora deployment here will relay and,
 * in practice on the test networks, what confirms in the next block. On
 * mainnet it is a floor a routing UI should override UPWARD in congestion —
 * the claim has a consensus deadline (`htlc.refundLocktime`), and a claim that
 * confirms slowly is a claim that can miss it, so a caller with fee-rate
 * information should spend it here.
 *
 * `Partial` on purpose: a network absent from this table means "no default",
 * and the corridor resolves to manual mode there rather than to a number
 * nobody justified. Every network the vocabulary knows is named; the Partial
 * is for the ones it learns later.
 */
export const ONCHAIN_CLAIM_FEE_RATE_SATVB: Partial<Record<NetworkName, number>> = {
    bitcoin: 1,
    testnet: 1,
    signet: 1,
    mutinynet: 1,
    regtest: 1,
};

/** The arkade corridor's deps. Only the repository is overridable. */
export interface ArkadeCorridorDeps {
    readonly wallet: IWallet;
    readonly operator: SwapOperator;
    readonly networkName: NetworkName;
    readonly network: Network;
    readonly signerSet: SignerSet;
    /**
     * The pinned per-network co-signer, or the caller's override.
     *
     * Resolved from the network NAME the wallet reports, never from a key the
     * operator reports about itself — `defaultEmulatorPubkey` refuses that
     * self-report by name, because the value ends up in a covenant leaf that
     * decides who can move the funds.
     */
    readonly emulatorPubkey: string;
    readonly repository: AssetSwapRepository | undefined;
}

/** The lightning corridor's deps. */
export interface LightningCorridorDeps {
    readonly networkName: NetworkName;
    readonly decode: (bolt11: string) => InvoiceFacts;
    /** `undefined` is the default seal — an internal ephemeral self-claim key —
     * and not a missing dep. */
    readonly covclaimd: { pubkey: Pubkey } | undefined;
}

/** The onchain corridor's deps. */
export interface OnchainCorridorDeps {
    readonly networkName: NetworkName;
    readonly chain: ChainSource;
    /**
     * How the trader's L1 claim is built and broadcast, when a caller supplies
     * one.
     *
     * The caller's callback, verbatim — never a synthesized one. The wallet-
     * backed DEFAULT claim is built one layer out, in the drive, which is the
     * seam that has the record store and the wallet in hand; what it needs
     * from here is {@link claimFeeRateSatVb}, and its absence — an override
     * `null` on it, or a network with no entry in
     * {@link ONCHAIN_CLAIM_FEE_RATE_SATVB} — is exactly what keeps manual
     * mode on. Without any claim the drive reports an `arkade -> onchain`
     * swap's L1 half blocked, with the reason naming the missing callback
     * rather than a counterparty who has done nothing wrong; the Arkade
     * lockup keeps being driven and refunded either way.
     *
     * A dep of the onchain corridor rather than a `SwapClientConfig` field,
     * because that is what it is: a route that never touches this corridor
     * never resolves it, and a deliberate `null` refuses at the same boundary
     * as the chain source.
     */
    readonly claim?: OnchainClaim;
    /**
     * The fee rate the onchain arm's two fee-paid places share, sat/vB.
     *
     * Feeds BOTH halves of the recipient-exact deal, and they must stay on one
     * number: the quote path grosses the take leg UP by the claim this rate
     * prices (`claimFeeSats`), and the default claim build prices the actual
     * claim with it. Quoting against one number and building against another
     * is how the recipient ends up short anyway.
     *
     * Resolved from the network's floor in {@link ONCHAIN_CLAIM_FEE_RATE_SATVB}
     * with the override winning; `undefined` when the network has no entry —
     * which is what keeps a deliberate "no default claim" (the override
     * `null`) and an unknown network on the same honest answer, rather than on
     * an invented rate.
     */
    readonly claimFeeRateSatVb?: number;
    /**
     * The vsize the gross-up prices the claim at; the claim build measures its
     * own transaction and never reads this. Default {@link ONCHAIN_CLAIM_VSIZE}.
     */
    readonly claimVsize?: number;
}

/** Which corridor gets which dep record. */
export interface CorridorDepsByCorridor {
    arkade: ArkadeCorridorDeps;
    lightning: LightningCorridorDeps;
    onchain: OnchainCorridorDeps;
}

/** Any corridor's deps. */
export type CorridorDeps = CorridorDepsByCorridor[Corridor];

/**
 * The `T | null` rule, in one place: `null` is the refusal, `undefined` is
 * "take the default" and is handed back for the caller to default.
 *
 * A caller saying "not this one" should fail loudly at the corridor rather than
 * quietly at the first thing that needed the dep, and it is the only shape that
 * can say so — `chain?: ChainSource` cannot tell absence from refusal.
 */
const refusedIfNull = <T>(
    value: T | null | undefined,
    corridor: Corridor,
    dep: string,
): T | undefined => {
    if (value === null) throw new MissingCorridorDep(corridor, dep);
    return value;
};

/**
 * The co-signer key for `base`'s network.
 *
 * A malformed override is core's refusal and stays one — it would otherwise be
 * passed into a covenant leaf and surface as an unspendable contract long after
 * the fact. An *absent* key on an unpinned network is this corridor's, though:
 * `EMULATOR_PUBKEYS` pins `bitcoin`, `mutinynet` and `regtest` only, so on
 * `testnet` and `signet` — both of which the v2 id vocabulary admits — the
 * override is required, and its absence is a missing dep rather than a bare
 * `Error` escaping the module.
 */
const emulatorPubkeyFor = (base: CorridorBase): string => {
    if (base.emulatorPubkey !== undefined) {
        return resolveEmulatorPubkey(base.network, base.emulatorPubkey);
    }
    try {
        return defaultEmulatorPubkey(base.network);
    } catch {
        throw new MissingCorridorDep(
            "arkade",
            `covenant co-signer key (none is pinned for ${base.networkName}; ` +
                "pass emulatorPubkey)",
        );
    }
};

/**
 * A corridor's deps, with `undefined` taking the default and `null` refused.
 *
 * Per corridor, and never for all three at once: resolving a corridor a route
 * does not touch is what would turn a deliberate `null` on an unused corridor
 * into an error.
 */
export function resolveCorridorDeps<C extends Corridor>(
    corridor: C,
    overrides: CorridorOverrides | undefined,
    base: CorridorBase,
): CorridorDepsByCorridor[C];
export function resolveCorridorDeps(
    corridor: Corridor,
    overrides: CorridorOverrides | undefined,
    base: CorridorBase,
): CorridorDeps {
    switch (corridor) {
        case "arkade": {
            // The accept path owns the default now, and it is the client's own
            // repository — so the override and `SwapClientConfig.repository`
            // resolve to one object rather than two. Still `undefined` when
            // neither is set: the arkade module is a leg of every route, so
            // demanding one here would mean a client with no storage could not
            // `quote()`, and quoting persists nothing. `accept()` is what
            // refuses, with this same `MissingCorridorDep`.
            const repository =
                refusedIfNull(overrides?.arkade?.repository, "arkade", "repository") ??
                base.repository;
            return {
                wallet: base.wallet,
                operator: base.operator,
                networkName: base.networkName,
                network: base.network,
                signerSet: base.signerSet,
                emulatorPubkey: emulatorPubkeyFor(base),
                repository,
            };
        }
        case "lightning": {
            return {
                networkName: base.networkName,
                decode:
                    refusedIfNull(overrides?.lightning?.decode, "lightning", "bolt11 decoder") ??
                    decodeBolt11,
                covclaimd: refusedIfNull(
                    overrides?.lightning?.covclaimd,
                    "lightning",
                    "covclaimd deployment key",
                ),
            };
        }
        case "onchain": {
            const chain = refusedIfNull(overrides?.onchain?.chain, "onchain", "chain source");
            const claim = refusedIfNull(overrides?.onchain?.claim, "onchain", "L1 claim callback");
            // The fee policy fields break the module's usual `null` rule ON
            // PURPOSE, because "no default claim" is a working state, not a
            // disabled dep: `null` spends nothing, it merely opts out of the
            // floor table, and quoting verbatim plus a caller-handled claim is
            // exactly what a host who prices its own fees asks for. See the
            // override's own doc comment for the contract. Said with `===`
            // rather than `??`, since `null` must NOT fall through to the
            // table that a mere `undefined` falls through to.
            const feeRateOverride = overrides?.onchain?.claimFeeRateSatVb;
            const claimFeeRateSatVb =
                feeRateOverride === null
                    ? undefined
                    : (feeRateOverride ?? ONCHAIN_CLAIM_FEE_RATE_SATVB[base.networkName]);
            const claimVsize =
                overrides?.onchain?.claimVsize === null
                    ? ONCHAIN_CLAIM_VSIZE
                    : (overrides?.onchain?.claimVsize ?? ONCHAIN_CLAIM_VSIZE);
            return {
                networkName: base.networkName,
                chain: esploraChainSource({
                    esploraUrl: chain?.esploraUrl ?? ESPLORA_URL[base.networkName],
                    network: L1_NETWORKS[l1NetworkFromArk(base.networkName)],
                    fetchImpl: base.fetchImpl,
                }),
                ...(claim === undefined ? {} : { claim }),
                // Absent-on-an-unknown-network and explicitly-off read the
                // same: no default claim path, manual mode.
                ...(claimFeeRateSatVb === undefined ? {} : { claimFeeRateSatVb }),
                claimVsize,
            };
        }
    }
}

/**
 * The operator info read, wrapped so every way it can fail arrives as one
 * typed error.
 *
 * The whole read is wrapped rather than a matched subset of its failures:
 * `requireLive` re-throws the provider's raw error unwrapped, which is a
 * `FetchError`, a `ProviderUnavailableError`, an `ArkError`, a bare `Error` or a
 * `TimeoutError` depending on how the read failed — and across a service-worker
 * boundary it is a fresh `Error` whose only branchable identity is `cause.name`.
 * A `catch` on a matched set would let exactly those through untyped.
 *
 * `requireLive` is the caller's, and the two callers want opposite things.
 * Every covenant derivation reads live (§6), because a snapshot binds a covenant
 * to a signer key the operator may no longer co-sign for. A destination *parse*
 * does not derive anything, and the client's `resolve()` promises to answer
 * without new disclosure and offline — so it takes the wallet's own fallback
 * read, which is live when the operator is reachable and the persisted snapshot
 * when it is not.
 */
export const liveArkadeInfo = async (
    wallet: IWallet,
    opts: { requireLive?: boolean } = {},
): Promise<ArkadeInfo> => {
    const requireLive = opts.requireLive ?? true;
    try {
        return await wallet.getArkadeInfo({ requireLive });
    } catch (cause) {
        throw new OperatorUnreachable(
            `the Arkade server info could not be read${requireLive ? " live" : ""}: ${
                cause instanceof Error ? cause.message : String(cause)
            }`,
            { cause },
        );
    }
};

/**
 * The one operator read, made once for all three corridors.
 *
 * The network narrowing after it is core's own fail-closed one and stays that
 * way: an operator that answers with a network name this SDK does not know is
 * not unreachable, and resolving it to mainnet parameters is the failure mode
 * `getNetwork` exists to prevent.
 */
export const resolveCorridorBase = async (input: {
    wallet: IWallet;
    operator: SwapOperator;
    emulatorPubkey?: string;
    fetchImpl?: typeof fetch;
    /** The client's storage, threaded so the arkade dep can default to it. */
    repository?: AssetSwapRepository;
    /** Defaults to `true` — see {@link liveArkadeInfo}. */
    requireLive?: boolean;
}): Promise<CorridorBase> => {
    const info = await liveArkadeInfo(input.wallet, { requireLive: input.requireLive });
    const networkName = info.network as NetworkName;
    return {
        wallet: input.wallet,
        operator: input.operator,
        networkName,
        network: getNetwork(networkName),
        signerSet: signerSetFromInfo(info),
        emulatorPubkey: input.emulatorPubkey,
        fetchImpl: input.fetchImpl,
        repository: input.repository,
    };
};
