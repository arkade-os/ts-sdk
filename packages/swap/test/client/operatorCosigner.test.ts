import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { createSwapClient } from "../../src/client/client";
import { QuoteVerificationFailed } from "../../src/client/errors";
import type { QuoteInput } from "../../src/client/quote";
import {
    ARK_INFO,
    EMULATOR_PUBKEY,
    EMULATOR_PUBKEY_HEX,
    OPERATOR_PUBKEY,
    PAYMENT_HASH,
    assetCard,
    clockAt,
    feedServing,
    hdWallet,
    invoiceFor,
    lightningCard,
    onchainCard,
    solverFor,
    solverTransport,
    type SolverAnswer,
} from "./fixtures";

const NOW = 1_700_000_000;
const CLOCK = clockAt(NOW);
const BCRT1 = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
// Compressed, as arkd reports it: the request must still name the x-only key.
const INFO = { ...ARK_INFO, signerPubkey: `02${hex.encode(OPERATOR_PUBKEY)}` };

const ROUTES: [string, () => QuoteInput][] = [
    ["arkade -> lightning", () => ({ to: invoiceFor(PAYMENT_HASH, CLOCK) })],
    ["lightning -> arkade", () => ({ via: "lightning", amount: 5_000n, amountOn: "give" })],
    ["arkade -> onchain", () => ({ to: BCRT1, amount: 100_000n, amountOn: "give" })],
    ["onchain -> arkade", () => ({ via: "onchain", amount: 100_000n, amountOn: "give" })],
    ["arkade -> arkade", () => ({ give: "BTC", take: "USD", amount: 10_000n, amountOn: "give" })],
];

const clientOn = async (over: { override?: string; answer?: SolverAnswer } = {}) => {
    const transport = solverTransport(over.answer ?? solverFor(CLOCK));
    const client = createSwapClient({
        wallet: await hdWallet({ info: INFO }),
        discovery: { snapshot: [lightningCard, onchainCard, assetCard] },
        ...(over.override === undefined ? {} : { emulatorPubkey: over.override }),
        transportFor: () => transport,
        fetchImpl: feedServing().fetch,
    });
    return { client, sent: transport.sent };
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
    vi.useRealTimers();
});

describe("quote() names the covenant's co-signer key on every RFQ request", () => {
    it.each(ROUTES)("%s: arkd's x-only key, or the override", async (_route, input) => {
        const arkd = await clientOn();
        await arkd.client.quote(input());
        expect(arkd.sent[0].profile).toHaveProperty("emulator_pubkey", hex.encode(OPERATOR_PUBKEY));

        const own = await clientOn({ override: EMULATOR_PUBKEY_HEX });
        await own.client.quote(input());
        expect(own.sent[0].profile).toHaveProperty("emulator_pubkey", hex.encode(EMULATOR_PUBKEY));
    });

    it.each(ROUTES)("%s: refuses a solver that derives on another key", async (_route, input) => {
        const honest = solverFor(CLOCK);
        const answer: SolverAnswer = (payload) =>
            honest({
                ...payload,
                profile: {
                    ...(payload.profile as object),
                    emulator_pubkey: hex.encode(EMULATOR_PUBKEY),
                },
            });
        const { client } = await clientOn({ answer });
        await expect(client.quote(input())).rejects.toBeInstanceOf(QuoteVerificationFailed);
    });
});
