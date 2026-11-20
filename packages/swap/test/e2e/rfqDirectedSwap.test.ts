/**
 * The directed asset swap (`asset-swap-v4`, R1–R7) against a real arkd and emulator. The client is
 * `SwapClient` opted in to v4 by policy; the solver quotes over a stub transport, derives the
 * covenant from its own operator read and identity, and fills with `fillOffer`. The `rfq` prefix
 * routes the file to the seconds-typed swap-rfq stack, which runs the emulator.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { base64, hex } from "@scure/base";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { planOffer, type DiscoveredMarket } from "@arkade-os/solver-discovery";
import {
    ArkAddress,
    ArkNote,
    EsploraProvider,
    Extension,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestIndexerProvider,
    RestOperatorProvider,
    SingleKey,
    Transaction,
    Wallet,
    arkade,
    asset,
    networkFromOperatorInfo,
    resolveEmulatorPubkey,
    toXOnlySignerHex,
} from "@arkade-os/sdk";
import {
    createSwapClient,
    InMemoryAssetSwapRepository,
    quoteIdOfSwapId,
    type OfferSwapRecord,
    type Swap,
    type SwapClient,
} from "../../src";
import {
    bindingProgram,
    fillOffer,
    OFFER_PACKET_TYPE,
    recordOfferBinding,
    type FillFunding,
    type OfferBinding,
} from "../../src/offer";
import { buildOfferFillPlan } from "../../src/offerFillPlan";
import { ASSET_SWAP_DERIVABLE_VERSIONS, ASSET_SWAP_V4 } from "../../src/program";
import { collectSwapRecords } from "../../src/repository";
import { spendTxidsOf } from "../../src/restore";
import type { AttestingRfqTransport } from "../../src/client/transport";
import type { RfqQuote } from "../../src/protocol";

// Defaults are CI's swap-rfq stack; the overrides let it run against a namespaced one.
const OPERATOR_URL = process.env.OPERATOR_URL ?? "http://localhost:7070";
const ESPLORA_API_URL = process.env.ESPLORA_URL ?? "http://localhost:3000/api";
const EMULATOR_URL = process.env.EMULATOR_URL ?? "http://localhost:7073";
const PREFIX = process.env.REGTEST_CONTAINER_PREFIX ?? "";
const TICKER = "DAS";
const PRICE = 100_000;

const indexer = new RestIndexerProvider(OPERATOR_URL);
const repository = new InMemoryAssetSwapRepository();
const clientKey = crypto.getRandomValues(new Uint8Array(32));
let client: Wallet;
let solver: Wallet;
let stranger: Wallet;
let swaps: SwapClient;
let card: DiscoveredMarket;
let assetId: string;
let takerHex: string;
/** The operator terms the solver read for itself. */
let terms: Pick<OfferBinding, "serverPublicKey" | "emulatorPublicKey" | "exitDelay"> & {
    hrp: string;
};
/** The covenant the solver derived for the latest quote. */
let lastQuoted: OfferBinding | undefined;

beforeAll(async () => {
    const operatorInfo = await (await fetch(`${OPERATOR_URL}/v1/info`)).json();
    const emulatorInfo = await (await fetch(`${EMULATOR_URL}/v1/info`)).json();
    const network = networkFromOperatorInfo(operatorInfo);
    // a refused emulator signature is a key mismatch until proven otherwise
    expect(emulatorInfo.signerPubkey).toBe(resolveEmulatorPubkey(network));
    const delay = BigInt(operatorInfo.unilateralExitDelay);
    terms = {
        serverPublicKey: hex.decode(toXOnlySignerHex(operatorInfo.signerPubkey)),
        emulatorPublicKey: hex.decode(toXOnlySignerHex(resolveEmulatorPubkey(network))),
        exitDelay: { type: delay < 512n ? "blocks" : "seconds", value: delay },
        hrp: network.hrp,
    };

    [client, solver, stranger] = await Promise.all([
        walletOf(clientKey),
        walletOf(crypto.getRandomValues(new Uint8Array(32))),
        walletOf(crypto.getRandomValues(new Uint8Array(32))),
    ]);
    await Promise.all([client, solver, stranger].map((wallet) => faucet(wallet)));
    ({ assetId } = await solver.assetManager.issue({ amount: 10_000n }));
    await waitFor(async () => (await unitsOf(solver)) === 10_000n);
    for (const holder of [client, stranger]) {
        await solver.send({
            address: await holder.getAddress(),
            assets: [{ assetId, amount: 3_000n }],
        });
        await waitFor(async () => (await unitsOf(holder)) === 3_000n);
    }
    takerHex = hex.encode(await solver.identity.xOnlyPublicKey());
    card = {
        pair: `BTC/${TICKER}`,
        base_asset: { id: "btc", name: "Bitcoin", ticker: "BTC", decimals: 8 },
        quote_asset: { id: assetId, name: "Directed", ticker: TICKER, decimals: 2 },
        price_feed: "https://feed.example/btc-das",
        price_feed_schema: { type: "json", price_path: "/price" },
        price_decimals: 6,
        fee_bps: 30,
        min_base_amount: "1000",
        max_base_amount: "5000000",
        min_quote_amount: "50",
        max_quote_amount: "500000",
        solver: "directed-stub",
        source: "https://registry.example/regtest.json",
        sourceType: "registry",
        discovery_pubkey: takerHex,
        transports: { nostr: { relays: ["wss://relay.invalid"] } },
    };
    swaps = clientOn(client, repository);
}, 600_000);

afterAll(async () => {
    await swaps?.[Symbol.asyncDispose]();
});

const directions = [
    { name: "asset-want", give: "BTC", take: TICKER, amount: 5_000n, step: 100n },
    { name: "sats-want", give: TICKER, take: "BTC", amount: 300n, step: 10n },
] as const;

describe.each(directions)("directed swap, $name", ({ give, take, amount, step }) => {
    let filled: Deposit;
    let refused: Deposit;

    it("R1: funds the covenant the client, the solver and the chain all derive", async () => {
        filled = await accept(give, take, amount);
        const script = hex.encode(scriptOf(filled.binding).pkScript);
        const funded = await fundingTx(filled.txid);
        expect(filled.record.swapPkScript).toBe(script);
        expect(hex.encode(funded.getOutput(filled.vout).script!)).toBe(script);
        expect(filled.record.binding).toEqual(recordOfferBinding(filled.binding));
        expect(filled.record.offerHex).toBeUndefined();
        expect(packetOf(funded)).toBeTruthy();
    }, 180_000);

    it("R2: takes the taker's fill through the fulfill leaf", async () => {
        const coins = await coinsOf(solver);
        const fillTxid = await fillOffer(solver, OPERATOR_URL, filled.binding, {
            fund: coins,
            emulator: EMULATOR_URL,
            fundingTxid: filled.txid,
        });
        const { checkpoint, ark } = await spendOf(filled);
        expect(ark.id).toBe(fillTxid);
        expect(leafOf(checkpoint)).toBe(leafHex(filled.binding, "fulfill"));
        expect(hex.encode(ark.getOutput(0).script!)).toBe(
            hex.encode(filled.binding.receiverPkScript),
        );
        const paid =
            filled.binding.wantAsset === undefined ? ark.getOutput(0).amount! : unitsAt(ark, 0);
        expect(paid).toBeGreaterThanOrEqual(filled.binding.amount);
        await waitFor(async () => (await outcomeOf(filled)) === "filled");
        await caughtUp(solver, coins, fillTxid);
    }, 240_000);

    it("R3a: refuses the stranger's fillOffer before anything is sent", async () => {
        refused = await accept(give, take, amount + step);
        await expect(
            fillOffer(stranger, OPERATOR_URL, refused.binding, {
                fund: await coinsOf(stranger),
                emulator: EMULATOR_URL,
                fundingTxid: refused.txid,
            }),
        ).rejects.toThrow("fulfill: external leaf signatures are required");
        expect(await isSpent(refused)).toBe(false);
    }, 180_000);

    it("R3b: refuses the stranger's fill around that guard, for the missing taker signature", async () => {
        const refusal = `checkpoint 0: missing signature for ${takerHex}`;
        const since = logClock();
        const before = occurrences(logsOf("emulator", since), refusal);
        const { graph, own } = await plan(stranger, refused);
        const response = await submit(
            await stranger.identity.sign(tx(graph.arkTx), own),
            await Promise.all(
                graph.checkpoints.map((c, i) =>
                    own.includes(i) ? stranger.identity.sign(tx(c), [0]) : tx(c),
                ),
            ),
        );
        expect(response.ok).toBe(false);
        expect(await isSpent(refused)).toBe(false);
        await waitFor(async () => occurrences(logsOf("emulator", since), refusal) > before, 20_000);
    }, 180_000);

    it("R3c: arkd refuses a bogus taker signature the emulator let through", async () => {
        // The taker's valid checkpoint signature is what passes the emulator, which verifies only
        // checkpoints: this exercises arkd's own gate, not a path a stranger has.
        const since = logClock();
        const { graph, own } = await plan(solver, refused);
        const signed = await solver.identity.sign(tx(graph.arkTx), own);
        const valid = (await solver.identity.sign(tx(graph.arkTx), [0])).getInput(0)
            .tapScriptSig![0][1];
        const bogus = valid.slice();
        bogus[63] ^= 1;
        const [, leaf] = signed.getInput(0).tapLeafScript![0];
        const leafHash = tapLeafHash(leaf.subarray(0, -1), leaf[leaf.length - 1]);
        signed.updateInput(0, {
            tapScriptSig: [[{ pubKey: hex.decode(takerHex), leafHash }, bogus]],
        });
        const response = await submit(
            signed,
            await Promise.all(graph.checkpoints.map((c) => solver.identity.sign(tx(c), [0]))),
        );
        expect(response.ok).toBe(false);
        expect(await isSpent(refused)).toBe(false);
        const refusal = `invalid signature for input 0, sig: ${hex.encode(bogus)}`;
        await waitFor(async () => logsOf("arkd", since).includes(refusal), 20_000);
    }, 180_000);

    it("R4: cancels the unfilled deposit with no solver involved", async () => {
        const deposit = (await vtxosAt(refused.record.swapPkScript)).find(
            (v) => v.txid === refused.txid,
        )!;
        await expect(swaps.cancel(refused.swapId)).resolves.toEqual({ outcome: "cancelled" });
        const { checkpoint, ark } = await spendOf(refused);
        expect(leafOf(checkpoint)).toBe(leafHex(refused.binding, "cancel"));
        expect(hex.encode(ark.getOutput(0).script!)).toBe(
            hex.encode(ArkAddress.decode(await client.getAddress()).pkScript),
        );
        expect(ark.getOutput(0).amount).toBe(BigInt(deposit.value));
        const units = deposit.assets?.find((a) => a.assetId === assetId)?.amount;
        if (refused.binding.offerAsset !== undefined) expect(units).toBeDefined();
        if (units !== undefined) expect(unitsAt(ark, 0)).toBe(BigInt(units));
    }, 180_000);

    it("R5: rebuilds a deposit from its packet on a wallet restored from the seed", async () => {
        const deposit = await accept(give, take, amount + 2n * step);
        const { restored, records } = await restoreFromSeed(deposit.txid);
        try {
            const record = records.find((r) => r.fundingTxid === deposit.txid);
            expect(record).toMatchObject({
                swapPkScript: deposit.record.swapPkScript,
                market: { kind: "restored" },
            });
            expect(record?.binding).toEqual(recordOfferBinding(deposit.binding));
            await expect(restored.cancel(`offer:${record!.id}`)).resolves.toEqual({
                outcome: "cancelled",
            });
            expect(leafOf((await spendOf(deposit)).checkpoint)).toBe(
                leafHex(deposit.binding, "cancel"),
            );
        } finally {
            await restored[Symbol.asyncDispose]();
        }
    }, 300_000);
});

describe("directed swap, once", () => {
    it("R6: tracks only the deposit when a direct send lands beside it", async () => {
        const deposit = await accept("BTC", TICKER, 5_300n);
        const script = deposit.record.swapPkScript;
        const direct = await stranger.send({ address: deposit.record.swapAddress, amount: 1_000 });
        await waitFor(async () => (await vtxosAt(script)).some((v) => v.txid === direct));
        expect((await vtxosAt(script)).map((v) => v.txid).sort()).toEqual(
            [deposit.txid, direct].sort(),
        );
        const { restored, records } = await restoreFromSeed(deposit.txid);
        await restored[Symbol.asyncDispose]();
        expect(records.filter((r) => r.swapPkScript === script).map((r) => r.fundingTxid)).toEqual([
            deposit.txid,
        ]);
        expect(await outcomeOf(deposit)).toBe("open");
        await expect(swaps.cancel(deposit.swapId)).resolves.toEqual({ outcome: "cancelled" });
        expect(leafOf((await spendOf(deposit)).checkpoint)).toBe(
            leafHex(deposit.binding, "cancel"),
        );
        expect((await vtxosAt(script)).find((v) => v.txid === direct)?.isSpent).toBeFalsy();
    }, 300_000);

    it("R7: funds with no packet, which the solver still fills and a seed restore cannot find", async () => {
        const deposit = await accept("BTC", TICKER, 5_400n, { attachOfferPacket: false });
        expect(deposit.record.attachOfferPacket).toBe(false);
        expect(packetOf(await fundingTx(deposit.txid))).toBeFalsy();
        const { restored, records } = await restoreFromSeed(deposit.txid);
        await restored[Symbol.asyncDispose]();
        expect(records.some((r) => r.fundingTxid === deposit.txid)).toBe(false);
        await fillOffer(solver, OPERATOR_URL, deposit.binding, {
            fund: await coinsOf(solver),
            emulator: EMULATOR_URL,
            fundingTxid: deposit.txid,
        });
        expect(leafOf((await spendOf(deposit)).checkpoint)).toBe(
            leafHex(deposit.binding, "fulfill"),
        );
        await waitFor(async () => (await outcomeOf(deposit)) === "filled");
    }, 300_000);
});

// ── helpers ──────────────────────────────────────────────────────────────────

interface Deposit {
    swapId: Swap["id"];
    record: OfferSwapRecord;
    /** The solver's derivation, which is what it fills from. */
    binding: OfferBinding;
    txid: string;
    vout: number;
}

function walletOf(privateKey: Uint8Array): Promise<Wallet> {
    return Wallet.create({
        identity: SingleKey.fromPrivateKey(privateKey),
        arkProvider: new RestOperatorProvider(OPERATOR_URL),
        indexerProvider: new RestIndexerProvider(OPERATOR_URL),
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
}

function clientOn(wallet: Wallet, store: InMemoryAssetSwapRepository): SwapClient {
    return createSwapClient({
        wallet,
        repository: store,
        discovery: { snapshot: [card] },
        fetchImpl: (async () =>
            new Response(JSON.stringify({ price: PRICE }))) as unknown as typeof fetch,
        policy: { assetSwapContractVersions: ASSET_SWAP_DERIVABLE_VERSIONS },
        transportFor: () => solverTransport(),
    });
}

function solverTransport(): AttestingRfqTransport {
    return {
        attestedResponder: takerHex,
        async requestQuote(payload) {
            if (!(payload.contract_versions as string[] | undefined)?.includes(ASSET_SWAP_V4)) {
                throw new Error("the client did not offer asset-swap-v4");
            }
            const profile = payload.profile as Record<string, string>;
            const buying = (payload.pair as string).startsWith("arkade:BTC->");
            const from = BigInt(payload.amount as string);
            const { receive } = planOffer({
                market: card,
                give: buying ? "base" : "quote",
                giveAmount: from,
                feedValue: PRICE,
                safetyBps: 0,
            });
            const id = asset.AssetId.fromString(assetId);
            const binding: OfferBinding = {
                version: ASSET_SWAP_V4,
                receiverPkScript: hex.decode(profile.maker_pk_script),
                amount: receive.atomic,
                ...(buying ? { wantAsset: id } : { offerAsset: id }),
                userPublicKey: hex.decode(profile.maker_public_key),
                serverPublicKey: terms.serverPublicKey,
                emulatorPublicKey: terms.emulatorPublicKey,
                exitDelay: terms.exitDelay,
                taker: hex.decode(takerHex),
            };
            const script = scriptOf(binding);
            lastQuoted = binding;
            return {
                v: 1,
                type: "rfq_quote",
                rfq_id: payload.rfq_id as string,
                pair: payload.pair as string,
                from_amount: from.toString(),
                to_amount: receive.atomic.toString(),
                solver_pubkey: takerHex,
                // past the drive's directed auto-cancel for as long as any step needs the deposit
                valid_until: Math.floor(Date.now() / 1000) + 3_600,
                contract_version: ASSET_SWAP_V4,
                profile: {
                    offer_address: script.address(terms.hrp, terms.serverPublicKey).encode(),
                    offer_pk_script: hex.encode(script.pkScript),
                },
            } as RfqQuote;
        },
        async status() {
            return null;
        },
        async close() {},
    };
}

async function accept(
    give: string,
    take: string,
    amount: bigint,
    options: { attachOfferPacket?: boolean } = {},
): Promise<Deposit> {
    const quote = await swaps.quote({ give, take, amount, amountOn: "give" });
    const binding = lastQuoted!;
    const swap = await swaps.accept(quote, options);
    const txid = swap.fundingTxid;
    if (txid === undefined) throw new Error(`accept funded nothing for ${swap.id}`);
    const record = (await repository.getSwapRecord(quoteIdOfSwapId(swap.id))) as OfferSwapRecord;
    let vout = -1;
    await waitFor(async () => {
        vout = (await vtxosAt(record.swapPkScript)).find((v) => v.txid === txid)?.vout ?? -1;
        return vout >= 0;
    });
    return { swapId: swap.id, record, binding, txid, vout };
}

/** A client on the client's key with nothing local: a new wallet and an empty store. */
async function restoreFromSeed(fundingTxid: string) {
    const wallet = await walletOf(clientKey);
    // the scan reads history, so a miss must not be history that had not caught up
    await waitFor(async () =>
        (await wallet.getTransactionHistory()).some((t) => t.key.arkTxid === fundingTxid),
    );
    const store = new InMemoryAssetSwapRepository();
    const restored = clientOn(wallet, store);
    await restored.ready;
    const records = (await collectSwapRecords(store)).filter(
        (r): r is OfferSwapRecord => r.family === "offer",
    );
    return { restored, records };
}

function scriptOf(binding: OfferBinding) {
    const { program, args, keys } = bindingProgram(binding);
    return new arkade.ArkadeProgramScript(program, args, keys);
}

function leafHex(binding: OfferBinding, name: "fulfill" | "cancel"): string {
    return hex.encode(scriptOf(binding).functionByName(name)!.tapLeafScript[1]);
}

function leafOf(checkpoint: Transaction): string {
    return hex.encode(checkpoint.getInput(0).tapLeafScript![0][1]);
}

const tx = (psbt: string): Transaction => Transaction.fromPSBT(base64.decode(psbt));

async function vtxosAt(script: string) {
    return (await indexer.getVtxos({ scripts: [script] })).vtxos;
}

async function isSpent(deposit: Deposit): Promise<boolean> {
    const vtxos = await vtxosAt(deposit.record.swapPkScript);
    return vtxos.find((v) => v.txid === deposit.txid)?.isSpent === true;
}

async function outcomeOf(deposit: Deposit) {
    return (await swaps.swaps()).find((s) => s.id === deposit.swapId)?.outcome;
}

async function fundingTx(txid: string): Promise<Transaction> {
    return tx((await indexer.getVirtualTxs([txid])).txs[0]);
}

function packetOf(funding: Transaction) {
    try {
        return Extension.fromTx(funding).getPacketByType(OFFER_PACKET_TYPE);
    } catch {
        return undefined;
    }
}

/** Both halves of the deposit's spend, once the indexer reports it. */
async function spendOf(deposit: Deposit) {
    await waitFor(() => isSpent(deposit));
    const vtxo = (await vtxosAt(deposit.record.swapPkScript)).find((v) => v.txid === deposit.txid)!;
    const txs = (await indexer.getVirtualTxs(spendTxidsOf(vtxo))).txs.map(tx);
    const checkpoint = txs.find((t) => hex.encode(t.getInput(0).txid!) === deposit.txid)!;
    const ark = txs.find((t) => hex.encode(t.getInput(0).txid!) === checkpoint.id)!;
    return { checkpoint, ark };
}

function unitsAt(ark: Transaction, vout: number): bigint {
    const group = Extension.fromTx(ark)
        .getAssetPacket()
        ?.groups.find((g) => g.assetId?.toString() === assetId);
    return (group?.outputs ?? [])
        .filter((o) => o.vout === vout)
        .reduce((sum, o) => sum + o.amount, 0n);
}

async function plan(wallet: Wallet, deposit: Deposit) {
    const graph = await buildOfferFillPlan(wallet, OPERATOR_URL, deposit.binding, {
        fund: await coinsOf(wallet),
        fundingTxid: deposit.txid,
    });
    return { graph, own: graph.inputOwners.flatMap((owner, i) => (owner === null ? [] : [i])) };
}

function submit(arkTx: Transaction, checkpoints: Transaction[]): Promise<Response> {
    return fetch(`${EMULATOR_URL}/v1/tx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            arkTx: base64.encode(arkTx.toPSBT()),
            checkpointTxs: checkpoints.map((c) => base64.encode(c.toPSBT())),
        }),
    });
}

/** Wide, so a container clock behind the host's still includes the line. */
const logClock = (): string => new Date(Date.now() - 60_000).toISOString();

function logsOf(container: "arkd" | "emulator", since: string): string {
    const name = `${PREFIX}${container}`;
    const read = spawnSync("docker", ["logs", "--since", since, name], { encoding: "utf8" });
    if (read.error !== undefined || read.status !== 0) {
        throw new Error(`cannot read ${name}'s log: ${read.error?.message ?? read.stderr}`);
    }
    return `${read.stdout}${read.stderr}`;
}

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

async function coinsOf(wallet: Wallet): Promise<FillFunding[]> {
    return (await wallet.getVtxos()).map((c) => ({
        txid: c.txid,
        vout: c.vout,
        value: c.value,
        tapLeafScript: c.forfeitTapLeafScript,
        tapTree: c.tapTree,
        assets: c.assets,
    }));
}

/** Until the fill's change is a coin and the coins it spent are gone, so the next plan funds. */
async function caughtUp(wallet: Wallet, spent: FillFunding[], fillTxid: string): Promise<void> {
    await waitFor(async () => {
        const coins = await wallet.getVtxos();
        return (
            coins.some((c) => c.txid === fillTxid) &&
            coins.every((c) => !spent.some((s) => s.txid === c.txid && s.vout === c.vout))
        );
    });
}

async function unitsOf(wallet: Wallet): Promise<bigint> {
    const held = (await wallet.getBalance()).availableAssets.find((a) => a.assetId === assetId);
    return held ? BigInt(held.amount) : 0n;
}

async function faucet(wallet: Wallet, sats = 100_000): Promise<void> {
    const note = execFileSync(
        "docker",
        ["exec", `${PREFIX}arkd`, "arkd", "note", "--amount", String(sats)],
        { encoding: "utf8" },
    )
        .replace(/\r/g, "")
        .split("\n")
        .filter((line) => line.trim() && !line.includes("WARN"))
        .join("\n")
        .trim();
    await wallet.settle({
        inputs: [ArkNote.fromString(note)],
        outputs: [{ address: await wallet.getAddress(), amount: BigInt(sats) }],
    });
    await waitFor(async () => (await wallet.getBalance()).available >= sats);
}

async function waitFor(fn: () => Promise<boolean>, timeout = 120_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (await fn()) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("timeout in waitFor");
}
