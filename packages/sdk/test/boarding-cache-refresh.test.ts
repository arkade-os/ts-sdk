import { hex } from "@scure/base";
import { Address, OutScript } from "@scure/btc-signer";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
    isVtxoSpent,
    RestArkProvider,
    toXOnlySignerHex,
    type Coin,
    type InMemoryWalletRepository,
} from "../src";
import { BoardingContractHandler } from "../src/contracts/handlers/boarding";
import { collectScriptVtxos } from "../src/repositories/walletRepository";
import {
    DEFAULT_MESSAGE_TAG,
    WalletMessageHandler,
} from "../src/wallet/serviceWorker/wallet-message-handler";
import {
    installRestoreHarness,
    makeHdWalletForTest,
    makeStaticWalletForTest,
    teardownRestoreHarness,
} from "./helpers/restoreWallet";

const DEPRECATED_SIGNER = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const coin = (byte: string): Coin => ({
    txid: byte.repeat(32),
    vout: 0,
    value: 10_000,
    status: { confirmed: false },
});
const workerPaths = ["INIT_WALLET", "RELOAD_WALLET"] as const;
const refreshPaths = ["direct", ...workerPaths] as const;
type RefreshPath = (typeof refreshPaths)[number];

/** Boarding coins stored for an address, as the contract manager keeps them. */
async function storedRows(repo: InMemoryWalletRepository, network: any, address: string) {
    const script = hex.encode(OutScript.encode(Address(network).decode(address)));
    return collectScriptVtxos(repo, script);
}

async function setup(hd: boolean) {
    const { wallet, walletRepository, contractRepository } = await (hd
        ? makeHdWalletForTest()
        : makeStaticWalletForTest());
    onTestFinished(() => wallet.dispose());
    const currentAddresses = [await wallet.getBoardingAddress()];
    if (hd) {
        currentAddresses.push(await wallet.getNewBoardingAddress());
        currentAddresses.push(await wallet.getNewBoardingAddress());
    }

    // Persist a boarding contract from before the server rotated its signer.
    const params = {
        pubKey: hex.encode(await wallet.identity.xOnlyPublicKey()),
        serverPubKey: DEPRECATED_SIGNER,
        csvTimelock: "144",
    };
    const script = BoardingContractHandler.createScript(params);
    const deprecatedAddress = script.onchainAddress(wallet.network);
    await contractRepository.saveContract({
        type: "boarding",
        params,
        script: hex.encode(script.pkScript),
        address: deprecatedAddress,
        state: "active",
        createdAt: 1,
    });
    wallet.refreshDeprecatedSigners({
        deprecatedSigners: [{ pubkey: DEPRECATED_SIGNER, cutoffDate: 0n }],
    });

    const coinsByAddress = new Map<string, Coin[]>([
        [currentAddresses[0], [coin("11")]],

        [deprecatedAddress, [coin("dd")]],
    ]);
    if (hd) {
        coinsByAddress.set(currentAddresses[1], [coin("22")]);
        coinsByAddress.set(currentAddresses[2], [coin("44")]);
    }
    const getCoins = vi
        .spyOn(wallet.onchainProvider, "getCoins")
        .mockImplementation(async (address) => {
            const coins = coinsByAddress.get(address);
            if (!coins) throw new Error(`Unexpected boarding address: ${address}`);
            return coins;
        });
    const signers = new Set([
        DEPRECATED_SIGNER,
        toXOnlySignerHex(hex.encode(wallet.arkServerPublicKey)),
    ]);
    // Populate through the same real fetch used by deprecated-signer migration.
    await wallet.getBoardingUtxosForSigners(signers);
    expect(await wallet.getBoardingAddresses()).toContain(deprecatedAddress);
    const stored = (address: string) => storedRows(walletRepository, wallet.network, address);
    /** Unspent stored txids, the coins a stored read reports. */
    const unspent = async (address: string) =>
        (await stored(address)).filter((v) => !isVtxoSpent(v)).map((v) => v.txid);
    expect(await unspent(deprecatedAddress)).toEqual([coin("dd").txid]);
    getCoins.mockClear();

    const handler = new WalletMessageHandler();
    await handler.start(
        { readonlyWallet: wallet, arkProvider: new RestArkProvider("http://localhost:7070") },
        { walletRepository },
    );
    onTestFinished(() => handler.stop());

    const refresh = async (path: RefreshPath) => {
        if (path === "direct") {
            const coins = await wallet.getBoardingUtxos();
            expect(coins.some((c) => c.txid === coin("dd").txid)).toBe(false);
            return;
        }
        const response = await handler.handleMessage({
            id: "boarding-refresh",
            tag: DEFAULT_MESSAGE_TAG,
            type: path,
            payload: { arkServerUrl: "http://localhost:7070" },
        });
        if (response.error) throw response.error;
    };
    return {
        wallet,
        walletRepository,
        currentAddresses,
        deprecatedAddress,
        coinsByAddress,
        getCoins,
        signers,
        refresh,
        stored,
        unspent,
    };
}

describe("boarding cache refresh", () => {
    beforeEach(installRestoreHarness);
    afterEach(teardownRestoreHarness);

    describe.each([false, true])("HD=%s", (hd) => {
        it.each(workerPaths)(
            "%s replaces fetched rows and preserves deprecated rows",
            async (path) => {
                const fixture = await setup(hd);
                const { currentAddresses, deprecatedAddress, coinsByAddress } = fixture;
                const deprecatedBefore = await fixture.stored(deprecatedAddress);
                coinsByAddress.set(currentAddresses[0], [coin("33")]);
                // An empty fetch must also clear stale coins at older HD addresses.
                if (hd) coinsByAddress.set(currentAddresses[1], []);

                await fixture.refresh(path);

                expect(await fixture.unspent(currentAddresses[0])).toEqual([coin("33").txid]);
                if (hd) {
                    expect(await fixture.unspent(currentAddresses[1])).toEqual([]);
                    expect(await fixture.unspent(currentAddresses[2])).toEqual([coin("44").txid]);
                }
                expect(await fixture.stored(deprecatedAddress)).toEqual(deprecatedBefore);
                const fetched = new Set(fixture.getCoins.mock.calls.map(([address]) => address));
                expect([...fetched].sort()).toEqual([...currentAddresses].sort());
            },
        );

        it.each(workerPaths)(
            "%s preserves deprecated rows when every fetched address is empty",
            async (path) => {
                const fixture = await setup(hd);
                const deprecatedBefore = await fixture.stored(fixture.deprecatedAddress);
                for (const address of fixture.currentAddresses)
                    fixture.coinsByAddress.set(address, []);

                await fixture.refresh(path);

                for (const address of fixture.currentAddresses) {
                    expect(await fixture.unspent(address)).toEqual([]);
                }
                expect(await fixture.stored(fixture.deprecatedAddress)).toEqual(deprecatedBefore);
            },
        );
    });

    it.each(refreshPaths)(
        "%s preserves every stored row if one address fetch fails",
        async (path) => {
            const fixture = await setup(true);
            const addresses = [...fixture.currentAddresses, fixture.deprecatedAddress];
            const before = await Promise.all(addresses.map((a) => fixture.stored(a)));
            fixture.getCoins.mockImplementation(async (address) => {
                if (address === fixture.currentAddresses[1])
                    throw new Error("explorer unavailable");
                return [];
            });

            await expect(fixture.refresh(path)).rejects.toThrow("explorer unavailable");

            expect(await Promise.all(addresses.map((a) => fixture.stored(a)))).toEqual(before);
        },
    );

    it.each(refreshPaths)(
        "%s keeps the stored rows of a contract whose write fails",
        async (path) => {
            const fixture = await setup(true);
            const addresses = [...fixture.currentAddresses, fixture.deprecatedAddress];
            const before = await Promise.all(addresses.map((a) => fixture.stored(a)));
            fixture.coinsByAddress.set(fixture.currentAddresses[0], [coin("33")]);
            vi.spyOn(fixture.walletRepository, "saveVtxosForScript").mockRejectedValue(
                new DOMException("Storage transaction aborted", "AbortError"),
            );
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

            // The sync logs a failed write per contract; the fetch itself succeeded.
            await fixture.refresh(path);

            expect(await Promise.all(addresses.map((a) => fixture.stored(a)))).toEqual(before);
            expect(warn).toHaveBeenCalled();
        },
    );
});
