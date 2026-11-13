import { describe, it, expect, beforeEach } from "vitest";
import { base64, hex } from "@scure/base";
import {
    arkade,
    ArkAddress,
    Batch,
    EsploraProvider,
    Proof,
    networks,
    RestEmulatorProvider,
    RestIndexerProvider,
    RestOperatorProvider,
    SingleKey,
    TreeSignerSession,
    EmulatorPacket,
    Extension,
    withPrevTxs,
    type Identity,
} from "../../src";
import {
    beforeEachFaucet,
    createTestArkWallet,
    faucetOnchain,
    waitFor,
    waitForUtxo,
} from "./utils";

/**
 * Non-interactive boarding: a client generates an onchain boarding address, goes offline, and a
 * server it does not trust with any key boards the coin into a batch on its behalf.
 *
 * CLIENT ONLY (holds the user key):
 *   - choose the receiver (its own Ark address) and build the boarding address from it.
 *     The receiver is baked into the covenant, so the client must derive the address itself:
 *     an address handed out by the server could pay anyone.
 *
 * SAFE ON THE SERVER (holds no user key, needs only public data: user pubkey + receiver):
 *   - rebuild the contract and check it matches the address the client funded,
 *   - build the intent, have the emulator run the covenant and sign it,
 *   - join the batch: tree signing with a throwaway session key, commitment co-signed by the
 *     emulator. The covenant forces output 0 to pay the receiver the full amount, so the worst a
 *     malicious server can do is not board the coin; the user keeps the CSV exit.
 */
const OPERATOR_URL = "http://localhost:7070";
const EMULATOR_URL = "http://localhost:7073";
const ESPLORA_URL = "http://localhost:3000/api";
const AMOUNT = 10_000;

// `board`: server key only (no user key), plus the covenant: output 0 pays `$receiver` the whole
// input value. `exit`: the user's unilateral way out if the server never boards the coin.
const boardingProgram = (exitDelay: bigint) =>
    ({
        version: 1,
        params: [
            { name: "server", type: "pubkey" },
            { name: "user", type: "pubkey" },
            { name: "receiver", type: "pubkey" },
        ],
        functions: {
            board: {
                tapscript: { signers: ["$server"] },
                arkadeScript: {
                    asm: [
                        0,
                        "INSPECTOUTPUTSCRIPTPUBKEY",
                        1,
                        "EQUALVERIFY",
                        "$receiver",
                        "EQUALVERIFY",
                        0,
                        "INSPECTOUTPUTVALUE",
                        "PUSHCURRENTINPUTINDEX",
                        "INSPECTINPUTVALUE",
                        "EQUAL",
                    ],
                },
            },
            exit: {
                tapscript: {
                    signers: ["$user"],
                    csv: { type: "blocks", value: exitDelay },
                },
            },
        },
    }) satisfies arkade.Program;

describe("arkade non-interactive boarding", () => {
    const arkProvider = new RestOperatorProvider(OPERATOR_URL);
    const indexer = new RestIndexerProvider(OPERATOR_URL);
    const emulator = new RestEmulatorProvider(EMULATOR_URL);
    const explorer = new EsploraProvider(ESPLORA_URL);

    beforeEach(beforeEachFaucet, 20000);

    it("server boards a client's covenant UTXO into a batch", { timeout: 180_000 }, async () => {
        const { boardingExitDelay } = await arkProvider.getInfo();
        const program = boardingProgram(BigInt(boardingExitDelay));

        // ===== CLIENT =====
        const receiverWallet = await createTestArkWallet();
        const receiverAddress = await receiverWallet.wallet.getAddress();
        const receiver = ArkAddress.decode(receiverAddress).pkScript.subarray(2);

        const userIdentity = SingleKey.fromRandomBytes();
        const client = await arkade.Arkade.connect({
            arkade: arkProvider,
            identity: userIdentity,
            emulator,
            network: networks.regtest,
        });
        const clientContract = client.contract(program, { receiver });
        const boardingAddress = clientContract.vtxoScript.onchainAddress(networks.regtest);
        // Public data the client hands to the server; nothing here can spend.
        const handoff = {
            boardingAddress,
            user: await userIdentity.xOnlyPublicKey(),
            receiver,
        };

        faucetOnchain(boardingAddress, AMOUNT);

        // ===== SERVER (no user key) =====
        const server = await arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            indexer,
            network: networks.regtest,
        });
        const contract = server.contract(program, {
            user: handoff.user,
            receiver: handoff.receiver,
        });
        expect(contract.vtxoScript.onchainAddress(networks.regtest)).toBe(handoff.boardingAddress);

        const utxo = await waitForUtxo(handoff.boardingAddress);
        const board = contract.vtxoScript.functionByName("board")!;
        const arkadeScriptBytes = board.arkadeScript!;

        const [coin] = await withPrevTxs(
            [
                {
                    ...utxo,
                    tapTree: contract.tapTree,
                    forfeitTapLeafScript: board.tapLeafScript,
                    proofTapLeafScript: board.tapLeafScript,
                    status: { confirmed: true },
                },
            ],
            indexer,
            explorer,
        );

        const session = TreeSignerSession.random();
        const sessionPubKey = hex.encode(await session.getPublicKey());
        const message: Proof.RegisterMessage = {
            type: "register",
            onchain_output_indexes: [],
            valid_at: 0,
            expire_at: 0,
            cosigners_public_keys: [sessionPubKey],
        };
        const receiverPkScript = ArkAddress.decode(receiverAddress).pkScript;
        const proof = Proof.create(
            message,
            [coin],
            [
                { script: receiverPkScript, amount: BigInt(AMOUNT) },
                Extension.create([
                    EmulatorPacket.create([
                        { vin: 1, script: arkadeScriptBytes, witness: new Uint8Array(0) },
                    ]),
                ]).txOut(),
            ],
        );

        // The emulator executes the covenant and signs the proof in place of the user.
        const signedProof = await emulator.submitIntent({
            proof: base64.encode(proof.toPSBT()),
            message,
        });
        const intentId = await arkProvider.registerIntent({ proof: signedProof, message });

        // `board` names no user key, so the handler has nothing to sign: the emulator co-signs the
        // commitment input. The handler still demands a signer for boarding inputs, hence a no-op.
        const noSigner = { sign: async (tx) => tx } as Identity;
        const handler = arkade.createArkadeBatchHandler(
            intentId,
            [{ ...coin, arkadeScriptBytes }],
            noSigner,
            signedProof,
            message,
            session,
            arkProvider,
            emulator,
            networks.regtest,
            [{ address: receiverAddress, amount: AMOUNT }],
        );

        const abortController = new AbortController();
        try {
            const stream = arkProvider.getEventStream(abortController.signal, [
                sessionPubKey,
                `${utxo.txid}:${utxo.vout}`,
            ]);
            const commitmentTxid = await Batch.join(stream, handler, { abortController });
            expect(commitmentTxid).toBeTruthy();
        } finally {
            abortController.abort();
        }

        // ===== CLIENT =====
        await waitFor(async () => {
            const { available } = await receiverWallet.wallet.getBalance();
            return available >= AMOUNT;
        });
    });
});
