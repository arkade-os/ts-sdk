import { ArkAddress, type IWallet } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { retireOfferContract, type OfferContractRetirer } from "../coverage";
import { collectRfqSwaps, collectSwapRecords, type AssetSwapRepository } from "../repository";
import { fundingWasNotSubmitted, type SwapRecord } from "./record";

/** Refusals the SDK's `send` throws while selecting coins, before any provider submission;
 * the service-worker client rewraps them as `Send failed: Error: …`. Matched exactly, since an
 * unknown error may follow a submission and must leave the swap pending. */
const SEND_REFUSAL =
    /^(?:Send failed: Error: )?(?:Insufficient funds|Insufficient asset balance: have \d+, need \d+|Cannot form minimum change amount of \d+ sats)$/;

export const refusedBeforeSubmission = (error: unknown): boolean =>
    error instanceof Error &&
    (error.name === "VtxoReservedError" || SEND_REFUSAL.test(error.message));

/** The script a record's deposit is funded to. */
export const fundingScriptOf = (record: SwapRecord): string =>
    record.family === "offer" ? record.swapPkScript : record.lockupPkScript;

export const retireUnsubmittedFunding = async (
    wallet: IWallet,
    repository: AssetSwapRepository,
    record: SwapRecord,
    contracts?: OfferContractRetirer,
): Promise<void> => {
    if (!fundingWasNotSubmitted(record)) return;
    const script = fundingScriptOf(record);
    try {
        await retireOfferContract(
            contracts ?? (await wallet.getContractManager()),
            async () => {
                const records = await collectSwapRecords(repository);
                const native = records.map((row) => ({
                    id: row.id,
                    swapPkScript: fundingScriptOf(row),
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
