import type { ArkadeCashRecord } from "./tracker";
import type { ArkadeCashStatusReport } from "./status";
import type { ArkadeCashClaimResult } from "../wallet/wallet";
import type { Activity } from "../wallet/activity";

export type ArkadeCashRequest =
    | { action: "get"; token: string }
    | { action: "create"; amount: number }
    | { action: "claim"; token: string }
    | { action: "reveal"; token: string }
    | { action: "activities"; records: ArkadeCashRecord[] };

export type ArkadeCashResponse =
    | ({ action: "get" } & ArkadeCashStatusReport & { cashId: string })
    | { action: "create"; token: string }
    | ({ action: "claim" } & ArkadeCashClaimResult)
    | { action: "reveal"; cashId: string }
    | { action: "activities"; activities: Activity[] };
