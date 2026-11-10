import { contractHandlers } from "./handlers";
import type { Contract, ContractScope } from "./types";

export function scopeOf(contract: Pick<Contract, "type" | "scope">): ContractScope {
    return contract.scope ?? contractHandlers.get(contract.type)?.defaultScope ?? "offchain";
}

export function isOnchainScoped(contract: Pick<Contract, "type" | "scope">): boolean {
    return scopeOf(contract) !== "offchain";
}
