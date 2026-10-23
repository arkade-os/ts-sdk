import { describe, expect, it, beforeEach } from "vitest";
import {
    Wallet,
    EsploraProvider,
    RestArkProvider,
    SingleKey,
    InMemoryWalletRepository,
    InMemoryContractRepository,
    Estimator,
    ArkError,
} from "../../src";
import { arkdExec, beforeEachFaucet, clearFees, execCommand, setFees, waitFor } from "./utils";

// Early-renewal premium: charge joining a batch early in its expiry instead
// of blocking it with SettlementMinExpiryGap. Renewal inside the last `gapS`
// seconds pays nothing; earlier renewal pays a linear premium reaching 0.5% of
// amount at `fullLifeS` of remaining life, with a 200-sat minimum whenever a
// fee applies. Swept inputs (recovery) and notes stay free.
//
// Supported by official source: IntentOffchainInputEnv exposes
// amount/expiry/birth/inputType/now(), and the wallet prices swept inputs as
// "recoverable" (toOffchainInputFeeParams in src/wallet/vtxo.ts).
function premiumProgram(gapS: number, fullLifeS: number): string {
    const premium = `(expiry - now() - ${gapS}.0) / ${fullLifeS - gapS}.0 * amount * 0.005`;
    return (
        `inputType == 'recoverable' ? 0.0 : (inputType == 'note' ? 0.0 : ` +
        `(expiry - now() < ${gapS}.0 ? 0.0 : (${premium} < 200.0 ? 200.0 : ${premium})))`
    );
}

// Operator numbers: 30-day batch expiry with a 24h gap.
const GAP_PREMIUM_FEE = premiumProgram(86400, 30 * 86400);

// Regtest VTXOs live ~2h, always inside the 24h gap, so the live test drops
// the gap: any fresh VTXO then owes exactly the 200-sat floor.
const LIVE_PREMIUM_FEE = premiumProgram(0, 30 * 86400);

const arkdUrl = "http://localhost:7070";
const esploraUrl = "http://localhost:3000/api";

function testWallet(): Promise<Wallet> {
    return Wallet.create({
        identity: SingleKey.fromRandomBytes(),
        arkProvider: new RestArkProvider(arkdUrl),
        onchainProvider: new EsploraProvider(esploraUrl, {
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

describe("Settlement fee premium curve", () => {
    it("prices the 24h-gap/30d-expiry curve", () => {
        const estimator = new Estimator({ offchainInput: GAP_PREMIUM_FEE });
        const nowMs = Date.now();
        const at = (offsetS: number): Date => new Date(nowMs + offsetS * 1000);
        const feeOf = (
            expiry: Date | undefined,
            type: "vtxo" | "recoverable" | "note" = "vtxo",
            amount = 100_000n,
        ): number =>
            estimator.evalOffchainInput({
                amount,
                type,
                weight: 0,
                birth: new Date(nowMs - 600_000),
                ...(expiry ? { expiry } : {}),
            }).satoshis;

        // 30 days of remaining life -> full 0.5% premium.
        expect(feeOf(at(30 * 86400))).toBe(500);
        // Mid-life scales linearly: 15 days left -> ~0.241%.
        expect(feeOf(at(15 * 86400))).toBe(242);
        // Small amounts hit the 200-sat minimum whenever a fee applies.
        expect(feeOf(at(30 * 86400), "vtxo", 10_000n)).toBe(200);
        expect(feeOf(at(15 * 86400), "vtxo", 10_000n)).toBe(200);
        // Inside the 24h gap window -> no premium.
        expect(feeOf(at(12 * 3600))).toBe(0);
        expect(feeOf(at(86300))).toBe(0);
        expect(feeOf(at(87000))).toBe(200);
        // Recovery and notes stay free at any expiry.
        expect(feeOf(at(30 * 86400), "recoverable")).toBe(0);
        expect(feeOf(at(30 * 86400), "note")).toBe(0);
    });
});

describe("Settlement fee premium", () => {
    beforeEach(beforeEachFaucet, 20000);

    it("charges the premium on a fresh VTXO", { timeout: 120000 }, async () => {
        const fundAmount = 10_000;
        let wallet: Wallet | undefined;
        try {
            setFees({ offchainInput: LIVE_PREMIUM_FEE });

            wallet = await testWallet();
            const { fees } = await wallet.arkProvider.getInfo();
            expect(fees.intentFee.offchainInput).toBe(LIVE_PREMIUM_FEE);

            const address = await wallet.getAddress();
            execCommand(
                `${arkdExec} ark send --to ${address} --amount ${fundAmount} --password secret`,
            );

            await waitFor(async () => (await wallet!.getVtxos()).length > 0);
            const vtxos = await wallet.getVtxos();
            expect(vtxos).toHaveLength(1);
            const [vtxo] = vtxos;
            expect(vtxo.isSwept).toBe(false);
            expect(vtxo.expiresAt!.getTime()).toBeGreaterThan(Date.now());

            // Predict with the same field mapping the wallet itself uses.
            const predicted = new Estimator({ offchainInput: LIVE_PREMIUM_FEE }).evalOffchainInput({
                amount: BigInt(vtxo.value),
                type: "vtxo",
                weight: 0,
                birth: vtxo.createdAt,
                expiry: vtxo.expiresAt,
            }).satoshis;
            expect(predicted).toBe(200);

            const underpaid = await wallet
                .settle({
                    inputs: [vtxo],
                    outputs: [{ address, amount: BigInt(vtxo.value) }],
                })
                .then(
                    () => undefined,
                    (e: unknown) => e,
                );
            expect(underpaid).toBeInstanceOf(ArkError);
            expect((underpaid as ArkError).name).toBe("INTENT_INSUFFICIENT_FEE");

            // The server prices later, so its premium is <= the prediction.
            const netAmount = vtxo.value - predicted;
            const txid = await wallet.settle({
                inputs: [vtxo],
                outputs: [{ address, amount: BigInt(netAmount) }],
            });
            expect(txid).toBeDefined();

            await waitFor(async () => (await wallet!.getVtxos()).some((c) => c.txid !== vtxo.txid));
            const renewed = (await wallet.getVtxos()).find((c) => c.txid !== vtxo.txid);
            expect(renewed).toBeDefined();
            expect(renewed!.value).toBe(netAmount);
        } finally {
            clearFees();
            await wallet?.dispose();
        }
    });
});
