/**
 * The onchain-receive corridor's L1 half against the real stack. The trader
 * funds L1 and the solver funds the Arkade lockup, so the branch that matters
 * is `refundable`: refunding the L1 output after the Arkade side settled takes
 * BOTH sides of the trade. A unit test reaches it by handing in a phase; only
 * chain state proves the phase is the one the corridor will see. Solver stubbed
 * as in `rfqRegister.test.ts`.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { execSync } from "child_process";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    ArkAddress,
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    REGTEST_EMULATOR_PUBKEY,
    RestArkProvider,
    SingleKey,
    Wallet,
} from "@arkade-os/sdk";
import {
    ONCHAIN_RECEIVE_PAIR,
    chainSourceFrom,
    classifyOnchainHtlc,
    nextOnchainReceiveAction,
    onchainHtlcScript,
    receiveVtxoScript,
    requestOnchainReceive,
    unilateralClaimDelay,
    type RfqQuote,
    type RfqTransport,
} from "../../src";

const ARK_URL = "http://localhost:7070";
const ESPLORA_API_URL = "http://localhost:3000/api";
const arkdExec = "docker exec -t arkd";
const bccli = "docker exec -t bitcoin bitcoin-cli -regtest -rpcuser=admin1 -rpcpassword=123";

const FAUCET_SATS = 30_000;
const SWAP_SATS = 20_000;
const MIN_CONFIRMATIONS = 1;
/** Comfortably inside the fundable window `assertFundable` enforces. */
const HTLC_LOCKTIME_OFFSET = 6 * 3600;

const xOnly = (key: Uint8Array): Uint8Array => {
    if (key.length === 32) return key;
    if (key.length !== 33 || (key[0] !== 0x02 && key[0] !== 0x03)) {
        throw new Error("not a compressed or x-only public key");
    }
    return key.slice(1);
};

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

const mine = (blocks: number) => execCommand(`node regtest/regtest.mjs mine ${blocks}`);

const chainInfo = (): { blocks: number; mediantime: number } =>
    JSON.parse(execCommand("node regtest/regtest.mjs rpc getblockchaininfo"));

const waitFor = async (
    fn: () => Promise<boolean>,
    { timeout = 60_000, interval = 1000 } = {},
): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error("timeout in waitFor");
};

const SOLVER = schnorr.getPublicKey(new Uint8Array(32).fill(7));
const SOLVER_L1_CLAIM = schnorr.getPublicKey(new Uint8Array(32).fill(9));
const NOW = () => Math.floor(Date.now() / 1000);

let wallet: Wallet;
let traderRefundKey: Uint8Array;
let solverRefundPkScript: Uint8Array;
let htlcLocktime: number;
let operatorPubkey: Uint8Array;
let emulatorPubkey: Uint8Array;
let claimDelay: number;
let hrp: string;

/**
 * Built from the same inputs the trader will use, so the address comparison in
 * `deriveOnchainReceive` runs for real and cannot fail for solver reasons.
 */
const stubTransport = (): RfqTransport => ({
    async requestQuote(payload) {
        const profile = (payload as { profile: Record<string, unknown> }).profile;
        htlcLocktime = NOW() + HTLC_LOCKTIME_OFFSET;
        const refundLocktime = htlcLocktime + 3600;
        const paymentHash = profile.payment_hash as string;
        const htlc = onchainHtlcScript(
            {
                paymentHash,
                claimKey: SOLVER_L1_CLAIM,
                refundKey: hex.decode(profile.refund_pubkey as string),
                refundLocktime: htlcLocktime,
            },
            "regtest",
        );
        const lockup = receiveVtxoScript({
            solverPubkey: SOLVER,
            refundLocktime,
            serverPubkey: operatorPubkey,
            paymentHash,
            claimDelay,
            emulatorPubkey,
            solverRefundPkScript,
            payoutPubkey: hex.decode(profile.payout_pubkey as string),
            payoutPkScript: ArkAddress.decode(profile.payout_address as string).pkScript,
        });
        return {
            v: 1,
            type: "rfq_quote",
            rfq_id: payload.rfq_id as string,
            pair: ONCHAIN_RECEIVE_PAIR,
            from_amount: SWAP_SATS,
            to_amount: SWAP_SATS,
            solver_pubkey: hex.encode(SOLVER),
            valid_until: NOW() + 3600,
            refund_locktime: refundLocktime,
            profile: {
                claim_pubkey: hex.encode(SOLVER_L1_CLAIM),
                htlc_locktime: htlcLocktime,
                htlc_address: htlc.address,
                min_confirmations: MIN_CONFIRMATIONS,
                solver_refund_pk_script: hex.encode(solverRefundPkScript),
                lockup_address: lockup.address(hrp, operatorPubkey).encode(),
            },
        } as unknown as RfqQuote;
    },
    async status() {
        return null;
    },
    async close() {},
});

beforeAll(async () => {
    wallet = await Wallet.create({
        identity: SingleKey.fromRandomBytes(),
        arkServerUrl: ARK_URL,
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

    const note = execCommand(`${arkdExec} arkd note --amount 200000`);
    execCommand(`${arkdExec} ark redeem-notes -n ${note} --password secret`);
    const address = await wallet.getAddress();
    execCommand(`${arkdExec} ark send --to ${address} --amount ${FAUCET_SATS} --password secret`);
    await waitFor(async () => (await wallet.getVtxos()).length > 0);

    traderRefundKey = schnorr.getPublicKey(new Uint8Array(32).fill(11));
    solverRefundPkScript = ArkAddress.decode(address).pkScript;

    const info = await new RestArkProvider(ARK_URL).getInfo();
    operatorPubkey = xOnly(hex.decode(info.signerPubkey));
    claimDelay = unilateralClaimDelay(Number(info.unilateralExitDelay));
    hrp = ArkAddress.decode(address).hrp;
    emulatorPubkey = xOnly(hex.decode(REGTEST_EMULATOR_PUBKEY));
}, 180_000);

const chainSource = () =>
    chainSourceFrom(
        new EsploraProvider(ESPLORA_API_URL, { forcePolling: true, pollingInterval: 2000 }),
        "regtest",
    );

const classifier = (htlc: Parameters<typeof classifyOnchainHtlc>[1]["htlc"]) => {
    const chain = chainSource();
    return () => classifyOnchainHtlc(chain, { htlc, minConfirmations: MIN_CONFIRMATIONS });
};

describe("onchain-receive corridor L1 half (regtest)", () => {
    it("walks the corridor's OWN htlc from unfunded to claimable on real chain state", async () => {
        const received = await requestOnchainReceive(wallet, ARK_URL, stubTransport(), {
            amount: SWAP_SATS,
            amountSide: "from",
            refundPubkey: traderRefundKey,
        });
        const classify = classifier(received.htlc);

        expect((await classify()).phase).toBe("unfunded");
        expect(nextOnchainReceiveAction({ phase: await classify(), settled: false })).toBe("wait");

        execCommand(`${bccli} sendtoaddress ${received.htlc.address} ${SWAP_SATS / 1e8}`);
        await waitFor(async () => (await classify()).phase !== "unfunded");
        expect((await classify()).phase).toBe("awaiting_confirmations");
        expect(nextOnchainReceiveAction({ phase: await classify(), settled: false })).toBe("wait");

        mine(MIN_CONFIRMATIONS);
        await waitFor(async () => (await classify()).phase === "claimable");
        // still `wait`: the solver has until the locktime to fund the lockup
        expect(nextOnchainReceiveAction({ phase: await classify(), settled: false })).toBe("wait");
    }, 300_000);

    /**
     * Built directly, and that is forced: `assertFundable` refuses a locktime
     * under `minConfirmations * 600 + 5400` away — 100 minutes at one
     * confirmation — so no quote reaching `refundable` can exist inside a test.
     * Same derivation; only the funding gate is skipped.
     */
    it("refuses to refund a settled swap once the htlc is refundable", async () => {
        const matured = Math.min(chainInfo().mediantime, Math.floor(Date.now() / 1000)) - 3600;
        const htlc = onchainHtlcScript(
            {
                paymentHash: "cd".repeat(32),
                claimKey: SOLVER_L1_CLAIM,
                refundKey: traderRefundKey,
                refundLocktime: matured,
            },
            "regtest",
        );
        const classify = classifier(htlc);

        execCommand(`${bccli} sendtoaddress ${htlc.address} ${SWAP_SATS / 1e8}`);
        mine(MIN_CONFIRMATIONS);
        await waitFor(async () => (await classify()).phase === "refundable");

        const refundable = await classify();
        expect(refundable.phase).toBe("refundable");
        // the money branch, off chain state: refunding a settled swap takes the
        // lockup AND the L1 output the solver paid for it
        expect(nextOnchainReceiveAction({ phase: refundable, settled: false })).toBe("refund");
        expect(nextOnchainReceiveAction({ phase: refundable, settled: true })).toBe("taken");
    }, 300_000);
});
