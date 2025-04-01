import { ExtendedVirtualCoin } from "../../../..";

export interface VtxoRepository {
    addOrUpdate(vtxos: ExtendedVirtualCoin[]): Promise<void>;
    deleteAll(): Promise<void>;
    getSpendableVtxos(): Promise<ExtendedVirtualCoin[]>;
    getAllVtxos(): Promise<{
        spendable: ExtendedVirtualCoin[];
        spent: ExtendedVirtualCoin[];
    }>;
}
