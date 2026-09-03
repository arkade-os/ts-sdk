/**
 * What a corridor is given, what a caller may replace, and where "overridden to
 * nothing" is refused.
 *
 * §6's rules stand as written; what is added here is a shape, because
 * `chain?: ChainSource` cannot tell "absent, use the default" from "disabled,
 * deliberately". Every override field is `T | null`: `undefined` takes the
 * default, `null` is the refusal, and {@link resolveCorridorDeps} throws
 * {@link MissingCorridorDep} naming the dep. It cannot reuse the facade's
 * `need()` guard, which tests `value === undefined` and passes a deliberate
 * `null` straight through.
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
import { L1_NETWORKS } from "../../onchainHtlc";
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
        /** Where persist-first lands. No default until the accept path owns
         * one, so `undefined` leaves it absent rather than building one. */
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
    };
}

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
            // The one dep with no default to fall back to: the repository
            // default belongs to the milestone that owns persistence, so an
            // absent one stays absent and only a deliberate `null` is refused.
            const repository = refusedIfNull(overrides?.arkade?.repository, "arkade", "repository");
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
            return {
                networkName: base.networkName,
                chain: esploraChainSource({
                    esploraUrl: chain?.esploraUrl ?? ESPLORA_URL[base.networkName],
                    network: L1_NETWORKS[l1NetworkFromArk(base.networkName)],
                    fetchImpl: base.fetchImpl,
                }),
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
    };
};
