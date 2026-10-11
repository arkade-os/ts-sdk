/**
 * The arkade corridor: an Arkade address, checked against this operator.
 *
 * `isValidArkAddress` (and so `arkTarget`) proves bech32m and a 65-byte payload, not whose server
 * key is embedded, so another operator's address would classify as ours.
 * {@link assertRecipientArkadeAddress} checks hrp and signer set rotation-aware; a hand-rolled
 * `serverPubKey ===` would reject valid addresses mid-rotation. It throws, so `matches` maps the
 * message into `refused` (*mine, and wrong*) as distinct from `undefined` (*not mine*).
 */
import { ArkAddress, arkTarget, assertRecipientArkadeAddress } from "@arkade-os/sdk";
import type { CorridorDrive, CorridorFactory, CorridorModule } from "./contract";
import type { ArkadeCorridorDeps } from "./deps";

/**
 * Deliberately empty. `arkade -> arkade` is an offer covenant (no VHTLC lockup, no
 * `refundLocktime`, watched by `watchOfferSwaps`), and on corridor routes the arkade leg's lockup
 * is declared once by the counter-corridor's entry; declaring it here too would let the two drift.
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
                // Cannot fail after `arkTarget`; the re-decode is what yields the signer key.
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
