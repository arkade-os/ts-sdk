/**
 * `arkade -> onchain` against the REAL intent-solver: the v2 client funds the lockup and claims the
 * L1 HTLC itself. Every case pins the no-double-payment invariants: the solver funds the HTLC
 * once, the recipient is paid once, and the solver takes no more of the lockup than it quoted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "child_process";
import {
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestIndexerProvider,
    RestOperatorProvider,
    SingleKey,
    Wallet,
} from "@arkade-os/sdk";
import { indexMarketFromCard, type DiscoveredMarket } from "@arkade-os/solver-discovery";
import { httpTransport } from "../../src/protocol";
import {
    createSwapClient,
    InMemoryAssetSwapRepository,
    quoteIdOfSwapId,
    type CorridorSwapRecord,
    type Swap,
    type SwapClient,
} from "../../src";
import { attesting } from "../../src/client/transport";

const OPERATOR_URL = "http://localhost:7070";
const ESPLORA_API_URL = "http://localhost:3000/api";
const SOLVER_URL = "http://localhost:8787";
const SOLVER = "intent-solver";
const bccli = "docker exec bitcoin bitcoin-cli -regtest -rpcuser=admin1 -rpcpassword=123";
const lncli = "docker exec lnd lncli --network=regtest";

const PAYOUT_SATS = 20_000n;

const sh = (command: string): string =>
    execSync(command, { encoding: "utf8" })
        .replace(/\r/g, "")
        .split("\n")
        .filter((line) => !line.includes("WARN"))
        .join("\n")
        .trim();

const mine = (blocks = 1): void => {
    sh(`${bccli} generatetoaddress ${blocks} ${sh(`${bccli} getnewaddress`)}`);
};

const waitFor = async (
    what: string,
    fn: () => Promise<boolean>,
    { timeout = 300_000, interval = 2_000, mining = false } = {},
): Promise<void> => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await fn()) return;
        if (mining) mine();
        await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`timeout waiting for ${what}`);
};

/** Every output, confirmed or in the mempool, that ever paid `address`. */
const outputsPaying = async (address: string): Promise<number[]> => {
    const txs = (await (await fetch(`${ESPLORA_API_URL}/address/${address}/txs`)).json()) as {
        vout: { scriptpubkey_address?: string; value: number }[];
    }[];
    return txs.flatMap((tx) =>
        tx.vout.filter((o) => o.scriptpubkey_address === address).map((o) => o.value),
    );
};

const receivedBy = (address: string): bigint =>
    BigInt(Math.round(Number(sh(`${bccli} getreceivedbyaddress ${address} 1`)) * 1e8));

const solverHealthy = async (): Promise<boolean> => {
    try {
        return (await fetch(`${SOLVER_URL}/healthz`)).ok;
    } catch {
        return false;
    }
};

const restartSolver = async (): Promise<void> => {
    sh(`docker restart ${SOLVER}`);
    await waitFor("the solver to come back", solverHealthy, { timeout: 120_000 });
};

const indexer = new RestIndexerProvider(OPERATOR_URL);
const repository = new InMemoryAssetSwapRepository();
let wallet: Wallet;
let market: DiscoveredMarket;
let responder: string;
const seen = new Map<string, Swap>();
const clients: SwapClient[] = [];

const clientOn = (): SwapClient => {
    const client = createSwapClient({
        wallet,
        repository,
        discovery: { snapshot: [market] },
        corridors: { onchain: { chain: { esploraUrl: ESPLORA_API_URL } } },
        transportFor: () => attesting(httpTransport(SOLVER_URL), responder),
    });
    client.onUpdate((u) => seen.set(u.swap.id, u.swap));
    clients.push(client);
    return client;
};

const recordOf = async (swap: Swap) =>
    (await repository.getSwapRecord(quoteIdOfSwapId(swap.id))) as CorridorSwapRecord;

const lockupVtxos = async (record: CorridorSwapRecord) =>
    (await indexer.getVtxos({ scripts: [record.lockupPkScript] })).vtxos;

const htlcOutputs = async (record: CorridorSwapRecord) =>
    outputsPaying(record.profile.htlcAddress as string);

/** Quote and accept a payout to a fresh bitcoind address. */
const send = async (client: SwapClient) => {
    const destination = sh(`${bccli} getnewaddress "" bech32m`);
    let quote: Awaited<ReturnType<SwapClient["quote"]>> | undefined;
    await waitFor(
        "a quote",
        async () => {
            quote = await client
                .quote({ to: destination, amount: PAYOUT_SATS, amountOn: "take" })
                .catch((e: unknown) => {
                    if (String(e).includes("exposure_cap")) return undefined;
                    throw e;
                });
            return quote !== undefined;
        },
        { timeout: 120_000, mining: true },
    );
    if (!quote) throw new Error("unreachable");
    expect(quote.take.amount).toBe(PAYOUT_SATS);
    const balanceBefore = BigInt((await wallet.getBalance()).available);
    const swap = await client.accept(quote);
    return { quote, swap, destination, balanceBefore, record: await recordOf(swap) };
};

/** Drive to the end, then assert both legs moved exactly once and the client paid exactly `give`. */
const settles = async (s: Awaited<ReturnType<typeof send>>): Promise<void> => {
    await waitFor("the client's L1 claim", async () => seen.get(s.swap.id)?.outcome === "claimed", {
        mining: true,
    });
    await waitFor("the lockup to be emptied", async () =>
        (await lockupVtxos(s.record)).every((v) => v.isSpent),
    );

    await waitFor(
        "the L1 payout to confirm",
        async () => receivedBy(s.destination) >= PAYOUT_SATS,
        {
            mining: true,
        },
    );
    expect(await htlcOutputs(s.record)).toHaveLength(1);
    expect(await outputsPaying(s.destination)).toHaveLength(1);

    const paid = s.balanceBefore - s.quote.give.amount;
    await waitFor(
        "the client's balance to settle",
        async () => BigInt((await wallet.getBalance()).available) === paid,
    );
};

beforeAll(async () => {
    wallet = await Wallet.create({
        identity: SingleKey.fromRandomBytes(),
        arkProvider: new RestOperatorProvider(OPERATOR_URL),
        onchainProvider: new EsploraProvider(ESPLORA_API_URL, {
            forcePolling: true,
            pollingInterval: 2000,
        }),
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
        settlementConfig: false,
    });
    const note = sh("docker exec arkd arkd note --amount 300000");
    sh(`docker exec arkd ark redeem-notes -n ${note} --password secret`);
    sh(
        `docker exec arkd ark send --to ${await wallet.getAddress()} --amount 250000 --password secret`,
    );
    await waitFor("the faucet", async () => (await wallet.getBalance()).available >= 250_000);

    // The solver pays each HTLC from LND's confirmed onchain balance: one UTXO per swap.
    const lndConfirmed = () => Number(JSON.parse(sh(`${lncli} walletbalance`)).confirmed_balance);
    if (lndConfirmed() < 4_000_000) {
        const outputs = Object.fromEntries(
            Array.from({ length: 5 }, () => [
                JSON.parse(sh(`${lncli} newaddress p2tr`)).address,
                0.01,
            ]),
        );
        sh(`${bccli} sendmany "" '${JSON.stringify(outputs)}'`);
        await waitFor("LND to see its float confirmed", async () => lndConfirmed() >= 4_000_000, {
            mining: true,
        });
    }

    const out = sh(
        `docker exec ${SOLVER} node --enable-source-maps --experimental-eventsource packages/solver-app/dist/cli.js card e2e`,
    );
    const card = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    responder = card.discovery_pubkey;
    const onchain = card.markets.find((m: { quote_asset: { id: string } }) =>
        m.quote_asset.id.startsWith("bitcoin:"),
    );
    expect(onchain, `no onchain market on the solver's card: ${out}`).toBeDefined();
    const indexed = indexMarketFromCard(card, onchain);
    if (!indexed.ok) throw new Error(`onchain market excluded: ${indexed.excluded}`);
    market = { ...indexed.market, source: "local", sourceType: "local" };
}, 300_000);

afterAll(async () => {
    await Promise.all(clients.map((c) => c[Symbol.asyncDispose]()));
});

describe("arkade -> onchain against the real solver (regtest)", () => {
    it("pays once, and a second accept of the same quote funds nothing", async () => {
        const client = clientOn();
        const s = await send(client);
        expect(s.swap.fundingTxid).toEqual(expect.any(String));

        const again = await client.accept(s.quote);
        expect(again.id).toBe(s.swap.id);

        await settles(s);
    }, 600_000);

    it("returns a second funding of the lockup to the client at once", async () => {
        const s = await send(clientOn());
        await waitFor(
            "the solver's HTLC funding",
            async () => (await htlcOutputs(s.record)).length > 0,
        );

        await wallet.send({ address: s.record.lockupAddress, amount: Number(s.quote.give.amount) });

        await settles(s);
    }, 600_000);

    it("funds the HTLC once across solver restarts before and after funding", async () => {
        const s = await send(clientOn());
        await restartSolver();
        await waitFor(
            "the solver's HTLC funding",
            async () => (await htlcOutputs(s.record)).length > 0,
        );
        await restartSolver();

        await settles(s);
    }, 900_000);

    it("claims once from a second client restored after the first is disposed", async () => {
        const first = clientOn();
        const s = await send(first);
        await waitFor(
            "the solver's HTLC funding",
            async () => (await htlcOutputs(s.record)).length > 0,
        );
        await first[Symbol.asyncDispose]();

        const second = clientOn();
        await second.ready;
        await settles(s);
    }, 600_000);
});
