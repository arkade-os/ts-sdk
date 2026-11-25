import { ArkAddress, type IWallet } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { retireOfferContract, type OfferContractRetirer } from "../coverage";
import { collectRfqSwaps, collectSwapRecords, type AssetSwapRepository } from "../repository";
import { fundingWasNotSubmitted, type SwapRecord, type SwapRecordCommon } from "./record";

/** Refusals the SDK's `send` throws while selecting coins, before any provider submission;
 * the service-worker client rewraps them as `Send failed: Error: …`. Matched exactly, since an
 * unknown error may follow a submission and must leave the swap pending. */
const SEND_REFUSAL =
    /^(?:Send failed: Error: )?(?:Insufficient funds|Insufficient asset balance: have \d+, need \d+|Cannot form minimum change amount of \d+ sats|Asset recipient amount \d+ is below dust \d+)$/;

export const refusedBeforeSubmission = (error: unknown): boolean =>
    error instanceof Error &&
    (error.name === "VtxoReservedError" || SEND_REFUSAL.test(error.message));

export const retireUnsubmittedFunding = async (
    wallet: IWallet,
    repository: AssetSwapRepository,
    record: SwapRecord,
    contracts?: OfferContractRetirer,
): Promise<void> => {
    if (!fundingWasNotSubmitted(record)) return;
    const script = record.family === "offer" ? record.swapPkScript : record.lockupPkScript;
    try {
        await retireOfferContract(
            contracts ?? (await wallet.getContractManager()),
            async () => {
                const records = await collectSwapRecords(repository);
                const native = records.map((row) => ({
                    id: row.id,
                    swapPkScript: row.family === "offer" ? row.swapPkScript : row.lockupPkScript,
                    createdAt: row.createdAt * 1000,
                    status:
                        row.family === "offer"
                            ? row.status
                            : fundingWasNotSubmitted(row)
                              ? ("cancelled" as const)
                              : row.state === "settled" || row.state === "refunded"
                                ? ("fulfilled" as const)
                                : ("pending" as const),
                }));
                const legacy = (await collectRfqSwaps(repository)).map((row) => ({
                    swapPkScript: hex.encode(ArkAddress.decode(row.lockupAddress).pkScript),
                    createdAt: row.createdAt * 1000,
                    status:
                        row.state === "settled" || row.state === "refunded"
                            ? ("fulfilled" as const)
                            : ("pending" as const),
                }));
                return [...native, ...legacy];
            },
            script,
            { scope: wallet },
        );
    } catch (error) {
        console.warn(`[swap] could not retire unsent funding for ${record.id}`, error);
    }
};

type Proof = NonNullable<SwapRecordCommon["fundingNotSubmitted"]>;
type StopInput = { wallet: IWallet; drive?: { ingest(record: SwapRecord): void } };

/** Record the swap as stopped with its proof, hand it to the drive and retire its contract. */
export const stopUnsentFunding = async (
    input: StopInput,
    repository: AssetSwapRepository,
    record: SwapRecord,
    proof: Proof,
): Promise<SwapRecord> => {
    const stopped = {
        ...record,
        ...(record.family === "offer"
            ? { status: "cancelled" as const }
            : { state: "failed" as const }),
        fundingNotSubmitted: proof,
        updatedAt: Math.floor(Date.now() / 1000),
    } as SwapRecord;
    try {
        await repository.saveSwapRecord(stopped);
        input.drive?.ingest(stopped);
        await retireUnsubmittedFunding(input.wallet, repository, stopped);
    } catch (cause) {
        console.warn(`[swap] could not finish unsent funding cleanup for ${record.id}`, cause);
    }
    return stopped;
};

/** Retire a record whose send never started; `undefined` if another runtime holds its claim. */
export const retireNeverSent = async (
    input: StopInput,
    repository: AssetSwapRepository,
    record: SwapRecord,
): Promise<SwapRecord | undefined> =>
    (await repository.claimSwapFunding(record.id))
        ? stopUnsentFunding(
              input,
              repository,
              { ...record, fundingSend: "claimed" },
              { reason: "send_not_started" },
          )
        : undefined;
