/**
 * `send({ selectedVtxos })` turned its named inputs away before any provider call: they cannot
 * fund the outputs, carry the asset change, or meet the expiry floor. A pure function of the
 * inputs and the operator's limits, so a caller can treat the spend as never attempted.
 * Match on `name` across the service-worker boundary.
 */
export class SendInputsRefusedError extends Error {
    readonly name = "SendInputsRefusedError";
}
