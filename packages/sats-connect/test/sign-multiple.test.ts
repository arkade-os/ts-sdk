import { beforeEach, describe, expect, it, vi } from "vitest";

// signMultipleTransactions is imported at module scope by SatsConnectIdentity,
// so it must be mocked before the module is loaded. The per-instance
// `satsConnectRequest` is a constructor parameter and is injected directly.
const signMultipleTransactions = vi.fn();

vi.mock("sats-connect", () => ({
    signMultipleTransactions: (...args: unknown[]) => signMultipleTransactions(...args),
    AddressPurpose: { Ordinals: "ordinals", Payment: "payment" },
    BitcoinNetworkType: { Mainnet: "Mainnet", Testnet: "Testnet", Signet: "Signet" },
}));

const { SatsConnectIdentity } = await import("../src/identity/SatsConnectIdentity");

// 33-byte compressed key: 0x02 followed by 32 bytes.
const PUBKEY = new Uint8Array([0x02, ...new Array(32).fill(0x01)]);

/** A satsConnectRequest that always reports a live connection. */
const connectedRequest = vi.fn(async () => ({ status: "success", result: { addresses: [] } }));

function makeIdentity() {
    return new SatsConnectIdentity(PUBKEY, "bc1qexampleaddress", connectedRequest as never);
}

/** Minimal stand-in for an SDK Transaction: only what signMultiple touches. */
function fakeTx() {
    return {
        toPSBT: () => new Uint8Array([1, 2, 3]),
        inputsLength: 1,
    } as never;
}

/** Drive the sats-connect callback API with a canned wallet response. */
function walletReturns(response: unknown) {
    signMultipleTransactions.mockImplementation((opts: { onFinish: (r: unknown) => void }) => {
        opts.onFinish(response);
    });
}

describe("SatsConnectIdentity.signMultiple response validation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        connectedRequest.mockResolvedValue({ status: "success", result: { addresses: [] } });
    });

    it("rejects a short response instead of crashing on undefined", async () => {
        // Two requests, one PSBT back — the misbehaving-wallet case.
        walletReturns([{ psbtBase64: "AQID" }]);

        await expect(
            makeIdentity().signMultiple([{ tx: fakeTx() }, { tx: fakeTx() }] as never),
        ).rejects.toThrow(/returned 1 signed PSBT\(s\) for 2 request\(s\)/);
    });

    it("names the index when an entry carries no PSBT", async () => {
        walletReturns([{ psbtBase64: "AQID" }, {}]);

        await expect(
            makeIdentity().signMultiple([{ tx: fakeTx() }, { tx: fakeTx() }] as never),
        ).rejects.toThrow(/no signed PSBT at index 1/);
    });

    it("rejects a non-array response", async () => {
        walletReturns({ psbtBase64: "AQID" });

        await expect(makeIdentity().signMultiple([{ tx: fakeTx() }] as never)).rejects.toThrow(
            /a non-array signed PSBT/,
        );
    });
});
