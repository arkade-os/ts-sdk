/**
 * Names from before the rename to Arkade. Each one points at its replacement, so
 * existing code keeps working. They go away in the release after 0.6.0.
 *
 * shortcut: a const plus a type keeps `@deprecated` in the bundled types, but
 * `ArkPsbtFieldKey.Member` no longer works as a type. Use `ArkadePsbtFieldKey` there.
 */
import { ArkadeNote } from "./arkadeNote";
import {
    contractFromArkadeContract,
    contractFromArkadeContractWithAddress,
    decodeArkadeContract,
    encodeArkadeContract,
    isArkadeContract,
    type ParsedArkadeContract,
} from "./contracts/arkadeContract";
import { CachingArkadeProvider } from "./providers/cachingArkade";
import { RestArkadeProvider, type ArkadeProvider } from "./providers/arkade";
import { ArkadeError, ArkadeErrorName, isArkadeError, maybeArkadeError } from "./providers/errors";
import type { BatchRegistration, BatchRegistrationState } from "./repositories/intentRepository";
import { ArkadeAddress } from "./script/address";
import type { ArkadeTapscript, TapscriptType } from "./script/tapscript";
import {
    assertSubmittedArkadeTxid,
    isValidArkadeAddress,
    type ArkadeTxInput,
} from "./utils/arkadeTransaction";
import { attachPrevArkadeTxs } from "./utils/prevoutTx";
import {
    ArkadePsbtFieldKey,
    ArkadePsbtFieldKeyType,
    getArkadePsbtFields,
    PrevArkadeTxField,
    setArkadePsbtField,
    type ArkadePsbtFieldCoder,
} from "./utils/unknownFields";
import type { ArkadeTransaction } from "./wallet";

/** @deprecated Use {@link ArkadeAddress}. */
export const ArkAddress = ArkadeAddress;
/** @deprecated Use {@link ArkadeAddress}. */
export type ArkAddress = ArkadeAddress;
/** @deprecated Use {@link RestArkadeProvider}. */
export const RestArkProvider = RestArkadeProvider;
/** @deprecated Use {@link RestArkadeProvider}. */
export type RestArkProvider = RestArkadeProvider;
/** @deprecated Use {@link CachingArkadeProvider}. */
export const CachingArkProvider = CachingArkadeProvider;
/** @deprecated Use {@link CachingArkadeProvider}. */
export type CachingArkProvider = CachingArkadeProvider;
/** @deprecated Use {@link ArkadeError}. */
export const ArkError = ArkadeError;
/** @deprecated Use {@link ArkadeError}. */
export type ArkError = ArkadeError;
/** @deprecated Use {@link ArkadeErrorName}. */
export const ArkErrorName = ArkadeErrorName;
/** @deprecated Use {@link ArkadeErrorName}. */
export type ArkErrorName = ArkadeErrorName;
/** @deprecated Use {@link ArkadeNote}. */
export const ArkNote = ArkadeNote;
/** @deprecated Use {@link ArkadeNote}. */
export type ArkNote = ArkadeNote;
/** @deprecated Use {@link ArkadePsbtFieldKey}. */
export const ArkPsbtFieldKey = ArkadePsbtFieldKey;
/** @deprecated Use {@link ArkadePsbtFieldKey}. */
export type ArkPsbtFieldKey = ArkadePsbtFieldKey;
/** @deprecated Use {@link isArkadeError}. */
export const isArkError = isArkadeError;
/** @deprecated Use {@link maybeArkadeError}. */
export const maybeArkError = maybeArkadeError;
/** @deprecated Use {@link getArkadePsbtFields}. */
export const getArkPsbtFields = getArkadePsbtFields;
/** @deprecated Use {@link setArkadePsbtField}. */
export const setArkPsbtField = setArkadePsbtField;
/** @deprecated Use {@link PrevArkadeTxField}. */
export const PrevArkTxField = PrevArkadeTxField;
/** @deprecated Use {@link attachPrevArkadeTxs}. */
export const attachPrevArkTxs = attachPrevArkadeTxs;
/** @deprecated Use {@link isValidArkadeAddress}. */
export const isValidArkAddress = isValidArkadeAddress;
/** @deprecated Use {@link ArkadePsbtFieldKeyType}. */
export const ArkPsbtFieldKeyType = ArkadePsbtFieldKeyType;
/** @deprecated Use {@link decodeArkadeContract}. */
export const decodeArkContract = decodeArkadeContract;
/** @deprecated Use {@link encodeArkadeContract}. */
export const encodeArkContract = encodeArkadeContract;
/** @deprecated Use {@link isArkadeContract}. */
export const isArkContract = isArkadeContract;
/** @deprecated Use {@link contractFromArkadeContract}. */
export const contractFromArkContract = contractFromArkadeContract;
/** @deprecated Use {@link contractFromArkadeContractWithAddress}. */
export const contractFromArkContractWithAddress = contractFromArkadeContractWithAddress;
/** @deprecated Use {@link assertSubmittedArkadeTxid}. */
export const assertSubmittedArkTxid = assertSubmittedArkadeTxid;
/** @deprecated Use {@link ArkadeProvider}. */
export type ArkProvider = ArkadeProvider;
/** @deprecated Use {@link ArkadeTransaction}. */
export type ArkTransaction = ArkadeTransaction;
/** @deprecated Use {@link BatchRegistration}. */
export type ArkIntent = BatchRegistration;
/** @deprecated Use {@link BatchRegistrationState}. */
export type ArkIntentState = BatchRegistrationState;
/** @deprecated Use {@link ArkadeTxInput}. */
export type ArkTxInput = ArkadeTxInput;
/** @deprecated Use {@link ParsedArkadeContract}. */
export type ParsedArkContract = ParsedArkadeContract;
/** @deprecated Use {@link ArkadePsbtFieldCoder}. */
export type ArkPsbtFieldCoder<T> = ArkadePsbtFieldCoder<T>;
/** @deprecated Use {@link ArkadeTapscript}. */
export type ArkTapscript<T extends TapscriptType, Params> = ArkadeTapscript<T, Params>;
