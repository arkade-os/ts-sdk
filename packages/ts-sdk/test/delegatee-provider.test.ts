import { hex } from "@scure/base";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DelegateeNotFoundError, RestDelegateeProvider } from "../src/providers/delegatee";
import { buildDelegateeArkadeScript, buildDelegateeTapLeaf } from "../src/script/delegatee";
import { DelegateVtxo } from "../src/script/delegate";
import { DelegateeManagerImpl } from "../src/wallet/delegatee";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

vi.mock("../src/utils/fetch", () => ({
    fetch: mockFetch,
    baseFetch: mockFetch,
}));

const compressedKey = hex.decode(
    "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
);

function makeInfo(renewalWindow = 1024, maxFee = 0) {
    const arkadeScript = buildDelegateeArkadeScript({
        delegatePubKey: compressedKey,
        renewalWindow,
        maxFee,
    });
    const leaf = buildDelegateeTapLeaf(compressedKey, compressedKey, arkadeScript);
    return {
        version: "test",
        network: "regtest",
        delegatePubkey: hex.encode(compressedKey),
        serverPubkey: hex.encode(compressedKey),
        emulatorPubkey: hex.encode(compressedKey),
        emulatorTweakedPubkey: `02${hex.encode(leaf.emulatorTweakedPubKey)}`,
        arkadeScript: hex.encode(arkadeScript),
        delegateTapscript: hex.encode(leaf.script),
        renewalWindow,
        maxFee,
    };
}

const respond = (body: unknown, status = 200) =>
    mockFetch.mockResolvedValueOnce({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    });

describe("RestDelegateeProvider", () => {
    beforeEach(() => mockFetch.mockReset());

    it("validates the covenant response and requests the selected parameters", async () => {
        const info = makeInfo(3600, 25);
        respond(info);
        const provider = new RestDelegateeProvider("https://delegatee.test/");

        await expect(provider.getInfo({ renewalWindow: 3600, maxFee: 25 })).resolves.toEqual(info);
        expect(mockFetch).toHaveBeenCalledWith(
            "https://delegatee.test/v1/info?renewalWindow=3600&maxFee=25",
        );
    });

    it("accepts protobuf JSON with an omitted zero maxFee and string renewalWindow", async () => {
        const info = makeInfo();
        respond({ ...info, renewalWindow: String(info.renewalWindow), maxFee: undefined });

        await expect(
            new RestDelegateeProvider("https://delegatee.test").getInfo(),
        ).resolves.toEqual(info);
    });

    it("still rejects a fee-paying covenant when maxFee is omitted", async () => {
        respond({ ...makeInfo(1024, 25), maxFee: undefined });

        await expect(new RestDelegateeProvider("https://delegatee.test").getInfo()).rejects.toThrow(
            "covenant does not match",
        );
    });

    it("rejects info whose advertised covenant does not match its parameters", async () => {
        const info = makeInfo();
        respond({ ...info, arkadeScript: "00" });
        await expect(new RestDelegateeProvider("https://delegatee.test").getInfo()).rejects.toThrow(
            "covenant does not match",
        );
    });

    it("returns a typed not-found error for an unregistered address", async () => {
        respond("not found", 404);
        await expect(
            new RestDelegateeProvider("https://delegatee.test").getDelegation("tark1missing"),
        ).rejects.toBeInstanceOf(DelegateeNotFoundError);
    });
});

describe("DelegateeManagerImpl registration", () => {
    const script = new DelegateVtxo.Script({
        pubKey: compressedKey.slice(1),
        serverPubKey: compressedKey.slice(1),
        delegatePubKey: compressedKey,
        emulatorPubKey: compressedKey,
        renewalWindow: 1024,
        maxFee: 0,
        csvTimelock: { value: 144n, type: "blocks" },
    });

    it("reuses an already-registered address on wallet startup", async () => {
        const existing = { id: 1, address: "tark1existing", status: "active" };
        const provider = {
            getInfo: vi.fn().mockResolvedValue(makeInfo()),
            getDelegation: vi.fn().mockResolvedValue({ delegation: existing }),
            registerDelegation: vi.fn(),
            revokeDelegation: vi.fn(),
        };
        const manager = new DelegateeManagerImpl(provider, {} as any);

        await expect(manager.register(script)).resolves.toEqual(existing);
        expect(provider.getDelegation).toHaveBeenCalledWith(expect.stringMatching(/^tark1/));
        expect(provider.registerDelegation).not.toHaveBeenCalled();
    });

    it("registers the covenant leaves when the address is not known yet", async () => {
        const provider = {
            getInfo: vi.fn().mockResolvedValue(makeInfo()),
            getDelegation: vi.fn().mockRejectedValue(new DelegateeNotFoundError("tark1new")),
            registerDelegation: vi.fn().mockResolvedValue({
                id: 2,
                address: "tark1new",
                status: "active",
            }),
            revokeDelegation: vi.fn(),
        };
        const manager = new DelegateeManagerImpl(provider, {} as any);

        await manager.register(script);
        expect(provider.registerDelegation).toHaveBeenCalledWith(script.scripts.map(hex.encode), {
            renewalWindow: 1024,
            maxFee: 0,
        });
    });
});
