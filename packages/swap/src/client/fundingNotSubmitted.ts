import { ArkAddress, type IWallet } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { retireOfferContract, type OfferContractRetirer } from "../coverage";
import { collectRfqSwaps, collectSwapRecords, type AssetSwapRepository } from "../repository";
import { fundingWasNotSubmitted, type SwapRecord } from "./record";

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
