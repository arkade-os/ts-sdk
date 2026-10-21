import { hex } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { RestArkProvider, toXOnlySignerHex, type Coin } from "../src";
import { BoardingContractHandler } from "../src/contracts/handlers/boarding";
import { collectUtxos } from "../src/repositories/walletRepository";
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
    expect(await collectUtxos(walletRepository, deprecatedAddress)).toHaveLength(1);
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
                const { walletRepository, currentAddresses, deprecatedAddress, coinsByAddress } =
                    fixture;
                const deprecatedBefore = await collectUtxos(walletRepository, deprecatedAddress);
                coinsByAddress.set(currentAddresses[0], [coin("33")]);
                // An empty fetch must also clear stale coins at older HD addresses.
                if (hd) coinsByAddress.set(currentAddresses[1], []);

                await fixture.refresh(path);

                expect(
                    (await collectUtxos(walletRepository, currentAddresses[0])).map((c) => c.txid),
                ).toEqual([coin("33").txid]);
                if (hd) {
                    expect(await collectUtxos(walletRepository, currentAddresses[1])).toEqual([]);
                    expect(
                        (await collectUtxos(walletRepository, currentAddresses[2])).map(
                            (c) => c.txid,
                        ),
                    ).toEqual([coin("44").txid]);
                }
                expect(await collectUtxos(walletRepository, deprecatedAddress)).toEqual(
                    deprecatedBefore,
                );
                expect(fixture.getCoins.mock.calls.map(([address]) => address).sort()).toEqual(
                    [...currentAddresses].sort(),
                );
            },
        );

        it.each(workerPaths)(
            "%s preserves deprecated rows when every fetched address is empty",
            async (path) => {
                const fixture = await setup(hd);
                const deprecatedBefore = await collectUtxos(
                    fixture.walletRepository,
                    fixture.deprecatedAddress,
                );
                for (const address of fixture.currentAddresses)
                    fixture.coinsByAddress.set(address, []);

                await fixture.refresh(path);

                for (const address of fixture.currentAddresses) {
                    expect(await collectUtxos(fixture.walletRepository, address)).toEqual([]);
                }
                expect(
                    await collectUtxos(fixture.walletRepository, fixture.deprecatedAddress),
                ).toEqual(deprecatedBefore);
            },
        );
    });

    it.each(refreshPaths)(
        "%s preserves every cached row if one address fetch fails",
        async (path) => {
            const fixture = await setup(true);
            const addresses = [...fixture.currentAddresses, fixture.deprecatedAddress];
            const before = await Promise.all(
                addresses.map((a) => collectUtxos(fixture.walletRepository, a)),
            );
            fixture.getCoins.mockImplementation(async (address) => {
                if (address === fixture.currentAddresses[1])
                    throw new Error("explorer unavailable");
                return [];
            });

            await expect(fixture.refresh(path)).rejects.toThrow("explorer unavailable");

            expect(
                await Promise.all(addresses.map((a) => collectUtxos(fixture.walletRepository, a))),
            ).toEqual(before);
        },
    );

    it.each(refreshPaths)(
        "%s preserves the previous cache if saving the fetched coins fails",
        async (path) => {
            const fixture = await setup(true);
            const addresses = [...fixture.currentAddresses, fixture.deprecatedAddress];
            const before = await Promise.all(
                addresses.map((address) => collectUtxos(fixture.walletRepository, address)),
            );
            fixture.coinsByAddress.set(fixture.currentAddresses[0], [coin("33")]);
            vi.spyOn(fixture.walletRepository, "saveUtxos").mockRejectedValue(
                new DOMException("Storage transaction aborted", "AbortError"),
            );

            await expect(fixture.refresh(path)).rejects.toThrow("Storage transaction aborted");

            expect(
                await Promise.all(
                    addresses.map((address) => collectUtxos(fixture.walletRepository, address)),
                ),
            ).toEqual(before);
        },
    );
});
