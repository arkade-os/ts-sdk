/**
 * What a corridor is given, what a caller may replace, and where "overridden to nothing" is refused.
 *
 * Override fields are `T | null` so "absent, use the default" (`undefined`) differs from "disabled,
 * deliberately" (`null`, which {@link resolveCorridorDeps} refuses with {@link MissingCorridorDep}).
 * Exception: the onchain claim fee rate, whose `null` is manual mode. Resolution runs when a route
 * first touches a corridor, never at construction. The operator seam and co-signer key are trust
 * anchors and deliberately NOT overridable.
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
 * The facts every module reads and no caller replaces. The wallet answers *who and where* (only it
 * can make the live, fail-closed info read — `SwapOperator.getInfo()` takes no options); the
 * operator seam answers *submit and finalize*.
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
    /** Covenant co-signer override, 33-byte compressed hex. Required on `testnet` and `signet`, which
     * `EMULATOR_PUBKEYS` does not pin. */
    readonly emulatorPubkey?: string;
    /** For hosts without a global `fetch`, and for tests. */
    readonly fetchImpl?: typeof fetch;
    /** The client's storage, here so the arkade override defaults to the same object (records and
     * the markets cache in one store). The override still wins; its `null` still refuses. */
    readonly repository?: AssetSwapRepository;
}

/** The override matrix. An override replaces a dependency inside an implemented corridor; it never
 * enables a route, selects a solver or transport, or alters settlement. */
export interface CorridorOverrides {
    arkade?: {
        /** Where persist-first lands. Defaults to the client's own
         * `repository`, so the two seams are one object; `null` refuses. */
        repository?: AssetSwapRepository | null;
    };
    lightning?: {
        /** Default: the package's own {@link decodeBolt11}. */
        decode?: ((bolt11: string) => InvoiceFacts) | null;
        /** Default: none — nothing is sealed and no packet is sent, so the
         * trader must claim its own lockup before `refund_locktime`. */
        covclaimd?: { pubkey: Pubkey } | null;
    };
    onchain?: {
        /** Default: `ESPLORA_URL[network]`. The override is the URL, not a
         * `ChainSource`: there is no wallet-held provider to substitute. */
        chain?: { esploraUrl: string } | null;
        /** How the trader's L1 claim is built and broadcast. Default: synthesized from
         * {@link claimFeeRateSatVb} when resolvable (see {@link OnchainCorridorDeps.claim}). */
        claim?: OnchainClaim | null;
        /**
         * Sat/vB the trader's L1 claim is built at, and the rate the take leg is grossed up by so the
         * recipient nets the requested amount. Default: {@link ONCHAIN_CLAIM_FEE_RATE_SATVB}.
         *
         * `null` is NOT a refusal here: it is "no default claim" — manual mode. The corridor still
         * quotes (take leg verbatim) and drives the lockup; the L1 claim is the caller's to make.
         */
        claimFeeRateSatVb?: number | null;
        /** The vsize the recipient-exact gross-up prices the claim at. Default
         * {@link ONCHAIN_CLAIM_VSIZE}; `null` reads as `undefined`. The claim build measures its own. */
        claimVsize?: number | null;
    };
}

/** Build and broadcast the L1 claim of an `arkade -> onchain` fill (the manager's own type). */
export type OnchainClaim = RfqSwapManagerCallbacks["claimOnchain"];

/**
 * Per-network default L1 claim fee rate, sat/vB — deliberately the RELAY FLOOR, since it both builds
 * the claim and prices the gross-up. On mainnet override UPWARD in congestion: the claim has a
 * consensus deadline (`htlc.refundLocktime`). `Partial`: an absent network means manual mode.
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
    /** The pinned per-network co-signer, or the caller's override. Resolved from the network NAME,
     * never from the operator's self-report — the key lands in a covenant leaf deciding who moves
     * the funds. */
    readonly emulatorPubkey: string;
    readonly repository: AssetSwapRepository | undefined;
}

/** The lightning corridor's deps. */
export interface LightningCorridorDeps {
    readonly networkName: NetworkName;
    readonly decode: (bolt11: string) => InvoiceFacts;
    /** `undefined` means no covclaimd is deployed — nothing is sealed and no
     * packet is sent. Not a missing dep. */
    readonly covclaimd: { pubkey: Pubkey } | undefined;
}

/** The onchain corridor's deps. */
export interface OnchainCorridorDeps {
    readonly networkName: NetworkName;
    readonly chain: ChainSource;
    /** The caller's L1 claim callback, verbatim. The default claim is built in the drive from
     * {@link claimFeeRateSatVb}; with neither, the L1 half reports blocked while the Arkade lockup is
     * still driven and refunded. */
    readonly claim?: OnchainClaim;
    /**
     * The one fee rate both recipient-exact halves share: the quote's gross-up (`claimFeeSats`) and
     * the default claim build. Two numbers would short the recipient. `undefined` = manual mode.
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

/** The `T | null` rule in one place: `null` refuses loudly at the corridor, `undefined` is handed
 * back for the caller to default. */
const refusedIfNull = <T>(
    value: T | null | undefined,
    corridor: Corridor,
    dep: string,
): T | undefined => {
    if (value === null) throw new MissingCorridorDep(corridor, dep);
    return value;
};

/** An onchain fee-policy number, handed back: `null` and `undefined` pass, and
 * only a non-positive or non-finite value refuses. */
const refusedIfMalformed = (value: number | null | undefined, dep: string) => {
    if (value !== undefined && value !== null && !(Number.isFinite(value) && value > 0)) {
        throw new MissingCorridorDep("onchain", dep);
    }
    return value;
};

/**
 * The co-signer key for `base`'s network. A malformed override stays core's refusal (it would
 * otherwise surface as an unspendable contract). An absent key on an unpinned network (`testnet`,
 * `signet`) is a missing dep rather than a bare `Error`.
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
 * A corridor's deps, with `undefined` taking the default and `null` refused. Per corridor, never all
 * three at once: resolving an untouched corridor would turn its deliberate `null` into an error.
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
            // Still `undefined` when neither is set: arkade is a leg of every route, and quoting
            // persists nothing. `accept()` is what refuses, with this same `MissingCorridorDep`.
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
            // `null` is manual mode (see the override's doc), so `===` rather than `??`: it must not
            // fall through to the table. A non-positive/non-finite rate would misprice both fee-paid
            // halves (or NaN-poison them), so it refuses here at resolution.
            const feeRateOverride = refusedIfMalformed(
                overrides?.onchain?.claimFeeRateSatVb,
                "L1 claim fee rate",
            );
            const claimFeeRateSatVb =
                feeRateOverride === null
                    ? undefined
                    : (feeRateOverride ?? ONCHAIN_CLAIM_FEE_RATE_SATVB[base.networkName]);
            const claimVsize =
                refusedIfMalformed(overrides?.onchain?.claimVsize, "L1 claim vsize") ??
                ONCHAIN_CLAIM_VSIZE;
            return {
                networkName: base.networkName,
                chain: esploraChainSource({
                    esploraUrl: chain?.esploraUrl ?? ESPLORA_URL[base.networkName],
                    network: L1_NETWORKS[l1NetworkFromArk(base.networkName)],
                    fetchImpl: base.fetchImpl,
                }),
                ...(claim === undefined ? {} : { claim }),
                ...(claimFeeRateSatVb === undefined ? {} : { claimFeeRateSatVb }),
                claimVsize,
            };
        }
    }
}

/**
 * The operator info read, every failure as one typed {@link OperatorUnreachable}. The whole read is
 * wrapped because `requireLive` re-throws the provider's raw error, whose type varies (and across a
 * service-worker boundary is a bare `Error`). Covenant derivations read live, since a snapshot can
 * bind a signer key the operator no longer co-signs for; `resolve()` takes the offline fallback.
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
 * The one operator read, made once for all three corridors. `getNetwork` stays fail-closed: an
 * unknown network name is not "unreachable", and resolving it to mainnet params is what it prevents.
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
