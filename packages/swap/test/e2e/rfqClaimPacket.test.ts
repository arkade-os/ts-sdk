/**
 * The claim packet against a REAL solver and a REAL covclaimd — the only place
 * its bug could live. One wire format has three implementations (covclaimd's
 * Go, this package, the solver) and unit tests reach only the two in TypeScript.
 *
 * The property: the client goes offline after paying and never calls
 * `pushClaim`, yet the money arrives. Unstamped, the lockup sits until expiry.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { execSync, spawn } from "child_process";
import { base64, hex } from "@scure/base";
import {
    EsploraProvider,
    Extension,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestIndexerProvider,
    SingleKey,
    Transaction,
    Wallet,
} from "@arkade-os/sdk";
import {
    claimPacketShape,
    covclaimdClient,
    httpTransport,
    requestLightningReceive,
    type InvoiceFacts,
} from "../../src";

const ARK_URL = "http://localhost:7070";
const ESPLORA_API_URL = "http://localhost:3000/api";
const SOLVER_URL = "http://localhost:8787";
const COVCLAIMD_URL = "http://localhost:7271";

/** Interior to the solver's regtest corridor limits (1_000..1_000_000), and
 * inside what `lnd-peer` holds after pushing half its channel to `lnd`. */
const RECEIVE_SATS = 25_000;

/** covclaimd's Arkade extension packet type. */
const CLAIM_PACKET = 0x04;

const execCommand = (command: string): string =>
    execSync(command, { encoding: "utf8" })
        .replace(/\r/g, "")
        .split("\n")
        .filter((line) => !line.includes("WARN"))
        .join("\n")
        .trim();

const lncli = (node: string, args: string): string =>
    execCommand(`docker exec -t ${node} lncli --network=regtest ${args}`);

const waitFor = async (
    fn: () => Promise<boolean>,
    { timeout = 180_000, interval = 2_000, what = "condition" } = {},
): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`timeout waiting for ${what}`);
};

const decodeInvoice = (raw: string): InvoiceFacts => {
    const d = JSON.parse(lncli("lnd-peer", `decodepayreq ${raw}`));
    return {
        raw,
        paymentHash: String(d.payment_hash).toLowerCase(),
        amountSats: Number(d.num_satoshis),
        expiresAt: Number(d.timestamp) + Number(d.expiry),
    };
};

const indexer = new RestIndexerProvider(ARK_URL);
let wallet: Wallet;
let covclaimdPubkey: Uint8Array;

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

    ({ covclaimdPubkey } = await covclaimdClient(COVCLAIMD_URL).info());
    expect(covclaimdPubkey).toHaveLength(33);
}, 300_000);

describe("claim packet, end to end (regtest)", () => {
    it("lets covclaimd claim a lockup the client never touches", async () => {
        const before = (await wallet.getBalance()).total;

        const receive = await requestLightningReceive(wallet, ARK_URL, httpTransport(SOLVER_URL), {
            amount: RECEIVE_SATS,
            amountSide: "to",
            covclaimdPubkey,
            decodeInvoice,
        });
        expect(receive.expectedAmount).toBe(RECEIVE_SATS);

        // A HOLD invoice: it stays in flight until the solver learns P, which is
        // the last step of this test. Awaiting it here would deadlock.
        const payment = spawn(
            "docker",
            [
                "exec",
                "lnd-peer",
                "lncli",
                "--network=regtest",
                "payinvoice",
                "--force",
                receive.invoice,
            ],
            { stdio: "ignore" },
        );

        const lockupScript = hex.encode(receive.swapPkScript);
        await waitFor(
            async () => (await indexer.getVtxos({ scripts: [lockupScript] })).vtxos.length > 0,
            { what: "the solver to fund the lockup" },
        );

        const { vtxos } = await indexer.getVtxos({ scripts: [lockupScript] });
        const lockup = vtxos[0]!;
        const { txs } = await indexer.getVirtualTxs([lockup.txid]);
        const funding = Transaction.fromPSBT(base64.decode(txs[0]!));

        // Read back through this package's own codec, off the real chain.
        const packets = [];
        for (let i = 0; i < funding.outputsLength; i++) {
            const script = funding.getOutput(i)?.script;
            if (script && Extension.isExtension(script)) {
                packets.push(Extension.fromBytes(script).getPacketByType(CLAIM_PACKET));
            }
        }
        const stamped = packets.find((p) => p !== null && p !== undefined);
        expect(stamped).toBeDefined();

        const shape = claimPacketShape(base64.encode(stamped!.serialize()));
        expect(shape.kind).toBe("packet");
        if (shape.kind !== "packet") return;
        // `0x02` present is the solver's stamp; covclaimd rejects a body without
        // it. `0x03` is what tells covclaimd the packet is addressed to it.
        expect(shape.needsArkadeScript).toBe(false);
        expect(hex.encode(shape.covclaimdPubkey!)).toBe(hex.encode(covclaimdPubkey));

        // No pushClaim anywhere below: an arriving balance is covclaimd's doing.
        await waitFor(async () => (await wallet.getBalance()).total >= before + RECEIVE_SATS, {
            timeout: 300_000,
            what: "covclaimd to claim the lockup",
        });

        await waitFor(
            async () =>
                (await indexer.getVtxos({ scripts: [lockupScript] })).vtxos.every(
                    (v) => v.txid !== lockup.txid || v.isSpent === true,
                ),
            { what: "the lockup to read as spent" },
        );

        payment.kill();
    }, 900_000);
});
