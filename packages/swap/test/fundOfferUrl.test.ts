import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import {
    asset,
    CSVMultisigTapscript,
    DefaultVtxo,
    Extension,
    SingleKey,
    Transaction,
    UnknownPacket,
    type IWallet,
    type NormalizedExtendedVirtualCoin,
} from "@arkade-os/sdk";
import { fundOffer, InMemoryAssetSwapRepository } from "../src";
import { encodeOffer, OFFER_PACKET_TYPE, offerVtxoScript, type Offer } from "../src/offer";

const SERVER_KEY = hex.decode("4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa");
const MAKER_KEY = hex.decode("3c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1");
const EMULATOR_KEY = hex.decode("466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27");
const ASSET_ID = `${"aa".repeat(32)}0000`;
const servers: Server[] = [];

const fixture = async (pathname: string, opaque: boolean) => {
    const identity = SingleKey.fromHex("33".repeat(32));
    const walletScript = new DefaultVtxo.Script({
        pubKey: MAKER_KEY,
        serverPubKey: SERVER_KEY,
        csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
    });
    const walletAddress = walletScript.address("tark", SERVER_KEY).encode();
    const binding: Omit<Offer, "swapPkScript"> = {
        wantAmount: 992n,
        wantAsset: asset.AssetId.fromString(ASSET_ID),
        makerPkScript: walletScript.pkScript,
        makerPublicKey: MAKER_KEY,
        emulatorPubkey: EMULATOR_KEY,
        exitDelay: { type: "seconds", value: 4096n },
    };
    const script = offerVtxoScript(binding, SERVER_KEY);
    const offerHex = hex.encode(encodeOffer({ ...binding, swapPkScript: script.pkScript }));
    const funding = new Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true });
    funding.addInput({ txid: hex.decode("11".repeat(32)), index: 0 });
    funding.addOutput({ script: script.pkScript, amount: 10_000n });
    funding.addOutput(
        Extension.create([new UnknownPacket(OFFER_PACKET_TYPE, hex.decode(offerHex))]).txOut(),
    );
    const info = {
        signerPubkey: `02${hex.encode(SERVER_KEY)}`,
        checkpointTapscript: hex.encode(
            CSVMultisigTapscript.encode({
                timelock: { type: "blocks", value: 10n },
                pubkeys: [SERVER_KEY],
            }).script,
        ),
        network: "regtest",
        unilateralExitDelay: "4096",
        dust: "330",
        vtxoMinAmount: "330",
    };
    const prefix = pathname.startsWith("/api") ? "/api" : "";
    const infoPath = `${prefix}/v1/info`;
    const indexerPath = `${prefix}/v1/indexer/virtualTx/${funding.id}`;
    const requests: string[] = [];
    const server = createServer((request, response) => {
        requests.push(request.url!);
        response.setHeader("content-type", "application/json");
        if (request.url === infoPath) response.end(JSON.stringify(info));
        else if (request.url === indexerPath)
            response.end(JSON.stringify({ txs: [base64.encode(funding.toPSBT())] }));
        else {
            response.statusCode = 404;
            response.end(JSON.stringify({ error: "unexpected path" }));
        }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}${pathname}`;
    const contractManager = {
        createContract: vi.fn(async (params: Record<string, unknown>) => ({
            ...params,
            state: "active",
            createdAt: 0,
        })),
        setContractWatchState: vi.fn(async () => {}),
    };
    const wallet = {
        identity,
        getAddress: vi.fn(async () => walletAddress),
        getContractManager: vi.fn(async () => contractManager),
        getSpendableVtxos: vi.fn(async () => [
            {
                txid: "11".repeat(32),
                vout: 0,
                value: 20_000,
                virtualStatus: { state: "settled" },
                isSpent: false,
                isSwept: false,
            } as NormalizedExtendedVirtualCoin,
        ]),
        ...(opaque ? {} : { dustAmount: 330n }),
        send: vi.fn(async () => funding.id),
    } as unknown as IWallet;
    return { wallet, contractManager, url, requests, infoPath, indexerPath, offerHex, funding };
};

afterEach(async () => {
    for (const server of servers.splice(0)) {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
        });
    }
});

describe("fundOffer REST URL boundaries", () => {
    it.each([
        ["", false],
        ["/", false],
        ["///", false],
        ["/api", false],
        ["/api/", false],
        ["/api///", true],
    ] as const)(
        "uses exact REST paths for %s (opaque=%s) and preserves retry identity",
        async (pathname, opaque) => {
            const current = await fixture(pathname, opaque);
            const repository = new InMemoryAssetSwapRepository();
            const params = {
                repository,
                offerHex: current.offerHex,
                deposit: { amount: 10_000n },
                id: "url-operation",
            };
            const funded = await fundOffer(current.wallet, current.url, params);

            expect(funded.fundingIntent?.arkServerUrl).toBe(new URL(current.url).toString());
            expect(funded.fundingIntent?.state).toBe("bound");
            expect(current.contractManager.createContract).toHaveBeenCalledOnce();
            expect(current.requests).toContain(current.infoPath);
            if (opaque) expect(current.requests).toContain(current.indexerPath);
            expect(
                current.requests.every(
                    (path) => path === current.infoPath || (opaque && path === current.indexerPath),
                ),
            ).toBe(true);
            const previousRequests = [...current.requests];
            await expect(
                fundOffer(current.wallet, new URL(current.url).toString(), params),
            ).resolves.toEqual(funded);
            expect(current.requests).toEqual(previousRequests);
            expect(current.wallet.send).toHaveBeenCalledOnce();
        },
    );

    it.each(["?token=example", "?"])(
        "rejects a query URL %s before providers or persistence",
        async (query) => {
            const current = await fixture("", false);
            const repository = new InMemoryAssetSwapRepository();
            await expect(
                fundOffer(current.wallet, `${current.url}${query}`, {
                    repository,
                    offerHex: current.offerHex,
                    deposit: { amount: 10_000n },
                }),
            ).rejects.toThrow(/query/i);

            expect(current.requests).toEqual([]);
            expect(current.wallet.getAddress).not.toHaveBeenCalled();
            expect(current.contractManager.createContract).not.toHaveBeenCalled();
            expect(current.wallet.send).not.toHaveBeenCalled();
            expect(await repository.getAllSwaps()).toEqual([]);
        },
    );

    it.each(["credentials", "fragment"])(
        "keeps rejecting %s before provider work",
        async (kind) => {
            const current = await fixture("", false);
            const repository = new InMemoryAssetSwapRepository();
            const url =
                kind === "credentials"
                    ? current.url.replace("http://", "http://example@")
                    : `${current.url}#fragment`;
            await expect(
                fundOffer(current.wallet, url, {
                    repository,
                    offerHex: current.offerHex,
                    deposit: { amount: 10_000n },
                }),
            ).rejects.toThrow(/credentials|fragment/i);

            expect(current.requests).toEqual([]);
            expect(current.wallet.send).not.toHaveBeenCalled();
            expect(await repository.getAllSwaps()).toEqual([]);
        },
    );
});
