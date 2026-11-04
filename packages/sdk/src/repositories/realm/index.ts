export { RealmWalletRepository } from "./walletRepository";
export { RealmContractRepository } from "./contractRepository";
export { RealmIntentRepository } from "./intentRepository";
export { RealmVirtualTxRepository } from "./virtualTxRepository";
export { ChainedTxType } from "../virtualTxRepository";
export type { VirtualTx, VirtualTxRepository, VtxoBranch } from "../virtualTxRepository";
export {
    ArkadeRealmSchemas,
    ArkadeExperimentalRealmSchemas,
    ARKADE_REALM_SCHEMA_VERSION,
    runArkadeRealmMigrations,
} from "./schemas";
export type { RealmLike, RealmResults } from "./types";

import {
    ARKADE_REALM_SCHEMA_VERSION,
    ArkadeExperimentalRealmSchemas,
    ArkadeRealmSchemas,
    runArkadeRealmMigrations,
} from "./schemas";

/** @deprecated Use {@link ArkadeRealmSchemas}. */
export const ArkRealmSchemas = ArkadeRealmSchemas;
/** @deprecated Use {@link ArkadeExperimentalRealmSchemas}. */
export const ArkExperimentalRealmSchemas = ArkadeExperimentalRealmSchemas;
/** @deprecated Use {@link ARKADE_REALM_SCHEMA_VERSION}. */
export const ARK_REALM_SCHEMA_VERSION = ARKADE_REALM_SCHEMA_VERSION;
/** @deprecated Use {@link runArkadeRealmMigrations}. */
export const runArkRealmMigrations = runArkadeRealmMigrations;
