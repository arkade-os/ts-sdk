/**
 * What M8 did to the root export, proved at the type level.
 *
 * `test/exports.test.ts` diffs names; this pins the two things a name diff
 * cannot see — which DECLARATION a name resolves to, and that a deleted type is
 * actually unreachable rather than merely absent from a barrel someone might
 * re-add. Checked by `tsconfig.test.json`, which `typecheck` runs, so every
 * `@ts-expect-error` below is an assertion CI enforces and one that stops
 * erroring fails the build.
 */
import { createSwapClient, exchange, pay, receive } from "../../src";
import type {
    ExchangeOptions,
    PayOptions,
    PayResult,
    ReceiveOptions,
    ReceiveRequest,
    Swap,
    SwapClient,
    SwapClientConfig,
    VerbDeps,
} from "../../src";

/**
 * R — the root `createSwapClient` is the v2 declaration, not #793's facade.
 *
 * The facade's took a `SwapClientDeps` and returned a client with
 * `quote(market, input)` and a `readonly manager: RfqSwapManager`; this one
 * takes a `SwapClientConfig`. Both are structural, so the assignment is the
 * proof: nothing about the old shape satisfies the new one.
 */
export const factory: (config: SwapClientConfig) => SwapClient = createSwapClient;

/** The verbs are on the root too — M7 shipped them behind a subpath. */
export const verbs: {
    pay: (deps: VerbDeps, destination: string, options?: PayOptions) => Promise<PayResult>;
    receive: (deps: VerbDeps, options: ReceiveOptions) => Promise<ReceiveRequest>;
    exchange: (deps: VerbDeps, options: ExchangeOptions) => Promise<Swap>;
} = { pay, receive, exchange };

/**
 * D — the facade's vocabulary is gone from the root with no `/protocol` floor.
 *
 * `SwapQuoteInput`'s `give: "base" | "quote"` and `UnifiedSwap.family` are the
 * two the spec disposes of by name: re-exporting either would keep the misroute
 * class the closed `Route` union exists to end both typed and constructible.
 * The rest of the facade goes with them, because half-deprecating it leaves
 * `SwapClientDeps` describing a client that no longer exists.
 */
// @ts-expect-error — D: use `QuoteInput` and the closed `Route` union.
export type { SwapQuoteInput } from "../../src";
// @ts-expect-error — D: use `Swap`; `family` does not exist in v2.
export type { UnifiedSwap } from "../../src";
// @ts-expect-error — D: use `SwapClientConfig`.
export type { SwapClientDeps } from "../../src";
// @ts-expect-error — D: use `Quote`.
export type { SwapQuote } from "../../src";

/**
 * …and neither does `/protocol` carry them. This is the assertion that makes
 * `D` mean something different from `P`: a floor exists for the 200 names M8
 * deprecated, and deliberately not for these.
 */
// @ts-expect-error — D has no floor, by design.
export type { SwapQuoteInput as ProtocolSwapQuoteInput } from "../../src/protocol";
// @ts-expect-error — D has no floor, by design.
export type { UnifiedSwap as ProtocolUnifiedSwap } from "../../src/protocol";

/**
 * I — internalized, and the same rule applies: no floor. `assertFundable` was
 * the archetype, a caller obligation the client turned into an invariant.
 */
// @ts-expect-error — I: `accept()` checks fundability itself.
export { assertFundable } from "../../src";
// @ts-expect-error — I: `accept()` checks fundability itself.
export { assertFundable as protocolAssertFundable } from "../../src/protocol";

/**
 * P — the floor is real, and it is the only spelling.
 *
 * There is no window in which a deprecated name answers to both, and that is
 * the decision this pair states: `0.1.0` breaks against `0.1.0-rc.1` whatever
 * the barrel does, so root re-exports would have split one migration into two
 * while leaving 200 v1 names on the v2 surface.
 */
export { requestLightningSend } from "../../src/protocol";
// @ts-expect-error — P lives on `/protocol` and nowhere else.
export { requestLightningSend as rootRequestLightningSend } from "../../src";

/**
 * The curated boundary, at the type level.
 *
 * `test/exports.test.ts` diffs the root's names against the curated list; this
 * is the compile-time half for the two directions a name diff states in the
 * abstract — the orchestration internals are NOT importable from the root, and
 * they ARE importable from `@arkade-os/swap/advanced`. The names are the ones
 * the curation review called out, so a regression names its victim.
 */
// @ts-expect-error — the drive is manual-driving orchestration: `./advanced`.
export { createSwapDrive } from "../../src";
// @ts-expect-error — custom quote flows import from `./advanced`.
export { acceptQuote } from "../../src";
// @ts-expect-error — destination claiming is `./advanced`, per V2_API.md.
export { corridorSet } from "../../src";
// @ts-expect-error — the RFQ quote path is `./advanced`.
export { quoteViaRfq } from "../../src";
// @ts-expect-error — the drive's record store is `./advanced`.
export { walletLockupIndexer } from "../../src";
// @ts-expect-error — the verbs' ceiling is their own plumbing: `./advanced`.
export { enforceFeeCeiling } from "../../src";
// @ts-expect-error — preparation is `./advanced`; `client.preparationOf()` answers it.
export type { QuotePreparation } from "../../src";

export {
    acceptQuote as advancedAcceptQuote,
    corridorSet as advancedCorridorSet,
    createSwapDrive as advancedCreateSwapDrive,
    quoteViaRfq as advancedQuoteViaRfq,
    walletLockupIndexer as advancedWalletLockupIndexer,
    type QuotePreparation as AdvancedQuotePreparation,
} from "../../src/advanced";

/**
 * S — v1-declared names the v2 surface references, reachable from the root.
 *
 * If a root-exported declaration names a type, a consumer has to be able to
 * name it too: `CorridorOverrides` authors `InvoiceFacts` and `ChainSource`,
 * `SwapDriveConfig` authors `LockupSpendIndexer` and `SwapContractRegistry`,
 * `AssetSwapRepository` is implemented over `AssetSwap`,
 * `CorridorSwapRecord.state` reads `RfqSwapState`, and `client.accept()`
 * throws `LockupRegistrationFailed`. Each import below fails the build if its
 * name leaves the root again.
 */
import type {
    AssetSwap,
    ChainSource,
    CorridorSwapRecord,
    InvoiceFacts,
    LockupSpendIndexer,
    RfqSwapState,
    SwapContractRegistry,
} from "../../src";
import { isRfqSwapTerminal, LockupRegistrationFailed } from "../../src";

export const rootReferencedNames: {
    decode: (bolt11: string) => InvoiceFacts;
    chain: ChainSource;
    row: AssetSwap;
    indexer: LockupSpendIndexer;
    contracts: SwapContractRegistry;
    state: RfqSwapState;
    terminal: (state: RfqSwapState) => boolean;
    failure: typeof LockupRegistrationFailed;
    record: CorridorSwapRecord;
} = {
    decode: () => {
        throw new Error("type-level only");
    },
    chain: undefined as never,
    row: undefined as never,
    indexer: undefined as never,
    contracts: undefined as never,
    state: "pending",
    terminal: isRfqSwapTerminal,
    failure: LockupRegistrationFailed,
    record: undefined as never,
};
