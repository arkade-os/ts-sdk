import { beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { base64, hex } from "@scure/base";
import {
    ArkAddress,
    EsploraProvider,
    Extension,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestArkProvider,
    RestEmulatorProvider,
    RestIndexerProvider,
    SingleKey,
    Transaction,
    Wallet,
    asset,
    tapScriptSigEntries,
    toXOnly,
    type ExtendedVirtualCoin,
} from "@arkade-os/sdk";
import {
    buildOfferFillPlan,
    providerCosignerKey,
    createOffer,
    decodeOffer,
    prepareJointSubmission,
    signJointGraphForOwner,
    submitJointFill,
    type FillFunding,
} from "../../src";

const live = (name: string): string => {
    const value = process.env[name];
    if (process.env.TAXI_FILL_LIVE !== "1" || !value) {
        throw new Error(
            `${name} is required: run with TAXI_FILL_LIVE=1 plus the regtest endpoints`,
        );
    }
    return value;
};

const ARK_URL = process.env.TAXI_FILL_LIVE_ARK_URL ?? "";
const EMULATOR_URL = process.env.TAXI_FILL_LIVE_EMULATOR_URL ?? "";
const ESPLORA_URL = process.env.TAXI_FILL_LIVE_ESPLORA_URL ?? "";
const ARKD_CONTAINER = process.env.TAXI_FILL_LIVE_ARKD_CONTAINER ?? "";

const WANT_UNITS = 1_000n;
const FARE_UNITS = 100n;
const ISSUE_UNITS = 10_000n;
const DEPOSIT_SATS = 5_000;
// Funds each wallet. Only the faucet reads this; the fill economics use
// DEPOSIT_SATS and the unit constants above. CI reached issuance with 100_000
// spendable and still reported insufficient funds, so fund well clear of it.
const FAUCET_SATS = 1_000_000;

const execCommand = (command: string): string => {
    const result = execSync(command, { encoding: "utf8" })
        .replace(/\r/g, "")
        .split("\n")
        .filter((line) => !line.includes("WARN"))
        .join("\n")
        .trim();
    if (result.startsWith("error:")) throw new Error(result);
    return result;
};

// Funding drives real settlement rounds, and a round that loses a participant
// fails the whole batch. Retry those, loudly: a silent retry would hide a
// deterministic failure, and the printed cause is how CI tells us which it was.
const settle = (command: string, label: string): string => {
    for (let attempt = 1; ; attempt++) {
        try {
            return execCommand(command);
        } catch (error) {
            const cause = error instanceof Error ? error.message : String(error);
            if (attempt === 3) throw new Error(`${label} failed after ${attempt}: ${cause}`);
            console.log(`live fill ${label} attempt ${attempt} failed, retrying: ${cause}`);
        }
    }
};

const waitFor = async (
    fn: () => Promise<boolean>,
    { timeout = 120_000, interval = 1000 } = {},
): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error("timeout in waitFor");
};

const makeWallet = (identity: SingleKey) =>
    Wallet.create({
        identity,
        arkServerUrl: ARK_URL,
        onchainProvider: new EsploraProvider(ESPLORA_URL, {
            forcePolling: true,
            pollingInterval: 2000,
        }),
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
        settlementConfig: false,
    });

const faucet = async (wallet: Wallet): Promise<void> => {
    const arkdExec = `docker exec -t ${ARKD_CONTAINER}`;
    // Mint more than we send, as the sibling swap e2e does: three wallets are
    // funded in sequence from one CLI wallet, and minting exactly the send
    // amount leaves nothing behind to cover the next round.
    const note = execCommand(`${arkdExec} arkd note --amount ${FAUCET_SATS * 2}`);
    settle(`${arkdExec} ark redeem-notes -n ${note} --password secret`, "redeem-notes");
    const address = await wallet.getAddress();
    settle(
        `${arkdExec} ark send --to ${address} --amount ${FAUCET_SATS} --password secret`,
        "send",
    );
    // Wait for SPENDABLE funds, not merely a visible vtxo: the test mints an
    // asset immediately after funding, and an unsettled coin shows up in
    // getVtxos long before it can be spent.
    await waitFor(async () => {
        const coins = await wallet.getSpendableVtxos();
        return coins.reduce((sum, c) => sum + c.value, 0) >= FAUCET_SATS;
    });
    // Report what actually landed. Three guesses at this failure have been
    // wrong; the next CI run should say what the wallet holds rather than
    // leave it to be inferred from "Insufficient funds".
    const funded = await wallet.getSpendableVtxos();
    console.log(
        `live fill funded ${await wallet.getAddress()}: ${funded.length} coins, ` +
            `${funded.reduce((s, c) => s + c.value, 0)} sats spendable`,
    );
};

const toFunding = (coin: ExtendedVirtualCoin): FillFunding => ({
    txid: coin.txid,
    vout: coin.vout,
    value: coin.value,
    tapLeafScript: coin.forfeitTapLeafScript,
    tapTree: coin.tapTree,
    ...(coin.assets !== undefined
        ? {
              assets: coin.assets.map((a) => ({
                  assetId: a.assetId,
                  amount: a.amount,
              })),
          }
        : {}),
});

const satsOf = async (wallet: Wallet): Promise<number> => {
    const balance = await wallet.getBalance();
    return balance.settled + balance.preconfirmed;
};

const assetUnitsOf = async (wallet: Wallet, assetId: string): Promise<bigint> => {
    const vtxos = await wallet.getVtxos();
    return vtxos
        .flatMap((v) => v.assets ?? [])
        .reduce((sum, a) => sum + (a.assetId === assetId ? a.amount : 0n), 0n);
};

describe("two-owner fill against the regtest stack", () => {
    let maker: Wallet;
    let solver: Wallet;
    let taxi: Wallet;
    let makerKey: SingleKey;
    let solverKey: SingleKey;
    let taxiKey: SingleKey;

    beforeAll(async () => {
        live("TAXI_FILL_LIVE_ARK_URL");
        live("TAXI_FILL_LIVE_EMULATOR_URL");
        live("TAXI_FILL_LIVE_ESPLORA_URL");
        live("TAXI_FILL_LIVE_ARKD_CONTAINER");
        solverKey = SingleKey.fromRandomBytes();
        taxiKey = SingleKey.fromRandomBytes();
        makerKey = SingleKey.fromRandomBytes();
        maker = await makeWallet(makerKey);
        solver = await makeWallet(solverKey);
        taxi = await makeWallet(taxiKey);
        // Serial, not Promise.all: each faucet redeems a note, and concurrent
        // redemptions land in one settlement round that then fails with
        // "missing forfeit transactions".
        for (const wallet of [maker, solver, taxi]) await faucet(wallet);
    }, 300_000);

    it("fills an asset want with solver and taxi signatures", async () => {
        const minted = await solver.assetManager.issue({
            amount: ISSUE_UNITS,
            metadata: { decimals: 0, name: "Taxi Fill", ticker: "TFILL" },
        });
        const wantAsset = asset.AssetId.fromString(minted.assetId);
        await waitFor(async () => {
            const coins = await solver.getSpendableVtxos();
            return coins.some((c) =>
                (c.assets ?? []).some(
                    (a) =>
                        a.assetId === wantAsset.toString() &&
                        BigInt(a.amount) >= WANT_UNITS + FARE_UNITS,
                ),
            );
        });

        const offer = await createOffer(maker, ARK_URL, {
            wantAmount: WANT_UNITS,
            wantAsset,
        });
        const fundingTxid = await maker.send({
            address: offer.address,
            amount: DEPOSIT_SATS,
            extensions: [offer.extension],
        });
        const indexer = new RestIndexerProvider(ARK_URL);
        const script = hex.encode(offer.swapPkScript);
        await waitFor(async () => {
            const { vtxos } = await indexer.getVtxos({ scripts: [script] });
            return vtxos.some((v) => v.txid === fundingTxid);
        });

        const solverCoins = await solver.getSpendableVtxos();
        const solverFund = solverCoins.filter((c) =>
            (c.assets ?? []).some((a) => a.assetId === wantAsset.toString()),
        );
        expect(solverFund.length).toBeGreaterThan(0);
        const taxiCoins = await taxi.getSpendableVtxos();
        expect(taxiCoins.length).toBeGreaterThan(0);
        const taxiScript = ArkAddress.decode(await taxi.getAddress()).pkScript;
        const solverScript = ArkAddress.decode(await solver.getAddress()).pkScript;

        const expected = await buildOfferFillPlan(solver, ARK_URL, offer.offerHex, {
            fund: solverFund.map(toFunding),
            payoutScript: solverScript,
            swapAddress: offer.address,
            sponsor: {
                fund: [toFunding(taxiCoins[0])],
                netContributionSats: BigInt(500),
                fare: {
                    assetId: wantAsset.toString(),
                    amount: FARE_UNITS,
                    script: taxiScript,
                    sats: 330,
                },
                changeScript: taxiScript,
            },
        });

        const afterSolver = await signJointGraphForOwner({
            expected,
            owner: "solver",
            bindings: solverFund.map((_, k) => ({
                inputIndex: 1 + k,
                identity: solverKey,
            })),
        });
        const taxiStart = 1 + solverFund.length;
        const complete = await signJointGraphForOwner({
            expected,
            partial: afterSolver,
            owner: "sponsor",
            bindings: [{ inputIndex: taxiStart, identity: taxiKey }],
        });

        const solverSatsBefore = await satsOf(solver);
        const solverAssetBefore = await assetUnitsOf(solver, wantAsset.toString());
        const settled = Transaction.fromPSBT(base64.decode(expected.arkTx));
        const solverPayoutSats = Array.from({ length: settled.outputsLength }, (_, i) =>
            settled.getOutput(i),
        ).find((o) => o.script && hex.encode(o.script) === hex.encode(solverScript))!.amount!;
        const solverInputSats = solverFund.reduce((sum, c) => sum + BigInt(c.value), 0n);
        const solverDelta = solverPayoutSats - solverInputSats;

        const prepared = prepareJointSubmission({
            expected,
            partial: complete,
            ownerKeys: {
                solver: [hex.encode(await solverKey.xOnlyPublicKey())],
                sponsor: [hex.encode(await taxiKey.xOnlyPublicKey())],
            },
        });
        const arkInfo = await new RestArkProvider(ARK_URL).getInfo();
        const pins = {
            emulatorXOnly: hex.encode(decodeOffer(hex.decode(offer.offerHex)).emulatorPubkey),
            serverXOnly: arkInfo.signerPubkey,
        };
        const { txid, signedArkTx } = await submitJointFill({
            expected,
            prepared,
            provider: new RestEmulatorProvider(EMULATOR_URL),
            pins,
            ownerKeys: {
                solver: [hex.encode(await solverKey.xOnlyPublicKey())],
                sponsor: [hex.encode(await taxiKey.xOnlyPublicKey())],
            },
        });
        expect(txid).toBe(prepared.txid);

        const submitted = Transaction.fromPSBT(base64.decode(prepared.arkTx));
        expect(Extension.fromTx(submitted).getAssetPacket()).toBeDefined();

        const norm = (keyHex: string) => hex.encode(toXOnly(hex.decode(keyHex), "pin"));
        const tweaked = providerCosignerKey({
            expected,
            emulatorXOnly: pins.emulatorXOnly,
        });
        const covenantEntries = tapScriptSigEntries(
            Transaction.fromPSBT(base64.decode(signedArkTx)),
            0,
        );
        const observed = covenantEntries.map((e) =>
            e.pubKeyHex === tweaked
                ? "emulator-covenant"
                : e.pubKeyHex === norm(pins.serverXOnly)
                  ? "server"
                  : `UNPINNED:${e.pubKeyHex}`,
        );
        console.log(`live fill covenant input 0 co-signed by: ${observed.join(",")}`);
        expect(observed.length).toBeGreaterThan(0);
        expect(observed.every((o) => o === "emulator-covenant" || o === "server")).toBe(true);

        await waitFor(async () => {
            const units = await assetUnitsOf(maker, wantAsset.toString());
            return units >= WANT_UNITS;
        });
        await waitFor(async () => {
            const units = await assetUnitsOf(taxi, wantAsset.toString());
            return units >= FARE_UNITS;
        });
        await waitFor(async () => {
            const units = await assetUnitsOf(solver, wantAsset.toString());
            return units === solverAssetBefore - WANT_UNITS - FARE_UNITS;
        });
        await waitFor(async () => {
            const delta = (await satsOf(solver)) - solverSatsBefore;
            return delta === Number(solverDelta);
        });
    }, 300_000);
});
