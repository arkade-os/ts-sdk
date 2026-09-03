/**
 * The arkade corridor: an Arkade address, checked against this operator.
 *
 * The check core omits is the one that matters here. `isValidArkAddress` — and
 * so `arkTarget`, which is built on it — proves bech32m and a 65-byte payload
 * and nothing about *whose* server key is embedded, so a well-formed address
 * belonging to another operator classifies as ours. Core already ships the
 * check, rotation-aware: {@link assertRecipientArkadeAddress} compares the hrp and
 * runs `classifyAgainstSignerSet`, refusing an unknown signer and a past-cutoff
 * one distinctly. It is promoted to core's root export rather than hand-rolled
 * as a `serverPubKey ===` comparison, which would reject valid addresses
 * mid-rotation.
 *
 * It throws rather than returning, so the module catches and maps its message
 * into the `refused` arm — which is what makes the difference between *not
 * mine* and *mine, and wrong* legible one layer up.
 */
import { ArkAddress, arkTarget, assertRecipientArkadeAddress } from "@arkade-os/sdk";
import type { CorridorDrive, CorridorFactory, CorridorModule } from "./contract";
import type { ArkadeCorridorDeps } from "./deps";

/**
 * Nothing, and each absence is a decision.
 *
 * `arkade -> arkade` is an offer covenant: no VHTLC lockup, no `refundLocktime`,
 * no manager action, and its watcher is `watchOfferSwaps`, which reads the
 * wallet's OWN contract events and drops everything that is not an offer — a
 * different seam from the two an RFQ drive pass reads, and no corridor's to
 * declare. On every corridor route the arkade leg's lockup IS the route's
 * lockup, declared once by the counter-corridor's entry, so declaring it again
 * here would be the same fact written twice with nothing keeping the two in
 * step.
 */
const ARKADE_DRIVE: CorridorDrive = {};

const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

export const arkadeCorridor: CorridorFactory<ArkadeCorridorDeps> = Object.assign(
    (deps: ArkadeCorridorDeps): CorridorModule<ArkadeCorridorDeps> => ({
        corridor: "arkade",
        deps,
        drive: ARKADE_DRIVE,
        matches(raw: string) {
            const target = arkTarget(raw);
            if (target === undefined) return undefined;
            try {
                // `arkTarget` already decoded this to classify it, so the
                // decode cannot fail here — but `matches` must not throw, and
                // the second decode is what hands the signer key over.
                const address = ArkAddress.decode(target);
                assertRecipientArkadeAddress(target, address, {
                    hrp: deps.network.hrp,
                    signerSet: deps.signerSet,
                });
            } catch (error) {
                return { refused: messageOf(error) };
            }
            return { claimed: { kind: "address", address: target } };
        },
    }),
    { target: arkTarget },
);
