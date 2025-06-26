import { ExtendedVirtualCoin } from "../../../..";

export interface VtxoRepository {
    addOrUpdate(vtxos: ExtendedVirtualCoin[]): Promise<void>;
    deleteAll(): Promise<void>;
    getSpendableVtxos(): Promise<ExtendedVirtualCoin[]>;
    getSweptVtxos(): Promise<ExtendedVirtualCoin[]>;
    getSpentVtxos(): Promise<ExtendedVirtualCoin[]>;
    getAllVtxos(): Promise<{
        spendable: ExtendedVirtualCoin[];
        spent: ExtendedVirtualCoin[];
    }>;
    close(): Promise<void>;
    open(): Promise<void>;
}
