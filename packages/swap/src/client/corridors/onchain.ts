/**
 * The onchain corridor: a Bitcoin L1 address, on this wallet's network.
 *
 * Core's `isBtcAddress` classifies bech32 and base58 for "any network", by its
 * own doc comment, so the network match is this module's. It is made by
 * decoding against the wallet's parameters rather than by comparing prefixes:
 * a prefix table would have to restate what `L1_NETWORKS` already holds, and a
 * base58 address carries its network in a version byte and not in a prefix
 * anyone can read off the front.
 *
 * The mapping is promoted rather than re-authored — `l1NetworkFromArk` and
 * `L1_NETWORKS` were module-private, and the alternative was writing them a
 * third time. Their shape is also why no caller can claim a signet-versus-
 * testnet rejection: `OnchainNetwork` has three members and signet, mutinynet
 * and testnet all fold into `testnet`.
 */
import { btcTarget } from "@arkade-os/sdk";
import * as btc from "@scure/btc-signer";
import { L1_NETWORKS } from "../../onchainHtlc";
import { l1NetworkFromArk } from "../../rfq";
import type { CorridorDrive, CorridorFactory, CorridorModule } from "./contract";
import type { OnchainCorridorDeps } from "./deps";

/**
 * One direction only, and the absence is the decision.
 *
 * `onchain -> arkade` gets no entry because it is outside the `Route` union:
 * its Arkade half is the same solver-funded lockup a lightning receive has, but
 * it adds an L1 half the trader funds and must take back itself — a second
 * deadline, a second observation seam AND a second action callback. Declaring
 * the lockup half alone is what would produce a manager that silently lets the
 * trader's L1 refund window pass.
 *
 * On `arkade -> onchain` the pass reads two covenants and they have different
 * owners. The Arkade lockup is the trader's, and `refundLocktime` is the moment
 * the money comes back. The L1 HTLC is the solver's on its refund leaf — the
 * trader holds only the claim key — so reaching `htlc.refundLocktime` does not
 * mean "refund the HTLC", it means the claim was missed.
 */
const ONCHAIN_DRIVE: CorridorDrive = {
    take: {
        lockups: [
            { covenant: "arkade_lockup", owner: "trader", deadline: "refund_locktime" },
            { covenant: "onchain_htlc", owner: "solver", deadline: "htlc_refund_locktime" },
        ],
        actions: ["claimOnchain", "refundArkade"],
        seams: ["indexer", "chain"],
    },
};

export const onchainCorridor: CorridorFactory<OnchainCorridorDeps> = Object.assign(
    (deps: OnchainCorridorDeps): CorridorModule<OnchainCorridorDeps> => {
        const l1 = l1NetworkFromArk(deps.networkName);
        return {
            corridor: "onchain",
            deps,
            drive: ONCHAIN_DRIVE,
            matches(raw: string) {
                const target = btcTarget(raw);
                if (target === undefined) return undefined;
                try {
                    btc.Address(L1_NETWORKS[l1]).decode(target);
                } catch {
                    return { refused: `this is not a ${l1} address` };
                }
                return { claimed: { kind: "address", address: target } };
            },
        };
    },
    { target: btcTarget },
);
