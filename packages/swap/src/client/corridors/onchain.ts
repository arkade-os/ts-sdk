/**
 * The onchain corridor: a Bitcoin L1 address, on this wallet's network.
 *
 * Core's `isBtcAddress` accepts any network, so the network match is made here by
 * decoding against the wallet's parameters, not by prefix: a base58 address carries its
 * network in a version byte. Signet, mutinynet and testnet all fold into `testnet`, so
 * a signet-versus-testnet mismatch is not detectable.
 */
import { BIP21, btcTarget } from "@arkade-os/sdk";
import * as btc from "@scure/btc-signer";
import { L1_NETWORKS } from "../../onchainHtlc";
import { l1NetworkFromArk } from "../../rfq";
import type { CorridorDrive, CorridorFactory, CorridorModule } from "./contract";
import type { OnchainCorridorDeps } from "./deps";

/**
 * One direction only. `onchain -> arkade` is deliberately absent: it adds an L1 half the
 * trader funds and must refund itself, and declaring only the lockup half would yield a
 * manager that silently lets the trader's L1 refund window pass.
 *
 * On `arkade -> onchain` the two covenants have different owners: the Arkade lockup is
 * the trader's (`refundLocktime` = money comes back), but the L1 HTLC's refund leaf is
 * the solver's, so reaching `htlc.refundLocktime` means the claim was missed.
 */
export const ONCHAIN_DRIVE = {
    take: {
        lockups: [
            { covenant: "arkade_lockup", owner: "trader", deadline: "refund_locktime" },
            { covenant: "onchain_htlc", owner: "solver", deadline: "htlc_refund_locktime" },
        ],
        actions: ["claimOnchain", "refundArkade"],
        seams: ["indexer", "chain"],
    },
} as const satisfies CorridorDrive;

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
                // A BIP21 `amount=` pins the recipient's expected amount; a bare address pins none.
                const amount = BIP21.amountSats(raw);
                return {
                    claimed: {
                        kind: "address",
                        address: target,
                        ...(amount === undefined ? {} : { amount: BigInt(amount) }),
                    },
                };
            },
        };
    },
    { target: btcTarget },
);
