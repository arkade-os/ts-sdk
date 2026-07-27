import { expect, describe, it, beforeEach } from "vitest";
import { hex } from "@scure/base";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
    DefaultVtxo,
    DelegateVtxo,
    EsploraProvider,
    HDDescriptorProvider,
    MnemonicIdentity,
    RestDelegateProvider,
    RestIndexerProvider,
    Wallet,
} from "../../src";
import type { HDCapableIdentity } from "../../src/identity";
import { deriveDescriptorLeafPubKey } from "../../src/identity/descriptor";
import {
    beforeEachFaucet,
    createSharedRepos,
    ESPLORA_API_URL,
    faucetOffchain,
    waitFor,
} from "./utils";

/**
 * The cross-variant band against a live operator: a delegate wallet credits an
 * externally issued `default` address at an in-band index, with no `restore()`.
 * Unit coverage of the band's composition is in `test/lookAhead.test.ts`.
 */
describe("HD look-ahead band", () => {
    beforeEach(beforeEachFaucet, 20000);

    it(
        "credits an externally issued default-variant address on a delegate wallet",
        { timeout: 120000 },
        async () => {
            const mnemonic = generateMnemonic(wordlist);
            const AMOUNT = 30_000; // small: two sends must fit the per-test faucet budget
            const ISSUED_INDEX = 3; // inside the default look-ahead window (20)

            const identity = MnemonicIdentity.fromMnemonic(mnemonic, { isMainnet: false });
            const repos = createSharedRepos();
            const wallet = await Wallet.create({
                identity,
                walletMode: "hd",
                arkServerUrl: "http://localhost:7070",
                onchainProvider: new EsploraProvider(ESPLORA_API_URL, {
                    forcePolling: true,
                    pollingInterval: 2000,
                }),
                storage: {
                    walletRepository: repos.walletRepository,
                    contractRepository: repos.contractRepository,
                },
                delegateProvider: new RestDelegateProvider("http://localhost:7012"),
                settlementConfig: false,
            });

            try {
                // Precondition: the issued address below is genuinely cross-variant.
                expect(wallet.offchainTapscript).toBeInstanceOf(DelegateVtxo.Script);

                // Fund the index-0 baseline so the test can assert a *delta*.
                const baseline = await wallet.getAddress();
                faucetOffchain(baseline!, AMOUNT);
                await waitFor(async () => (await wallet.getBalance()).total > 0, {
                    timeout: 60_000,
                    interval: 1_000,
                });
                const before = (await wallet.getBalance()).total;

                // The external issuer (NArk role): same seed, signer and exit
                // delay, but the plain `default` shape `ArkPaymentContract` emits.
                const provider = await HDDescriptorProvider.create(
                    identity as unknown as HDCapableIdentity,
                    createSharedRepos().walletRepository,
                );
                const issued = new DefaultVtxo.Script({
                    pubKey: deriveDescriptorLeafPubKey(
                        provider.materializeDescriptorAt(ISSUED_INDEX),
                    ),
                    serverPubKey: wallet.offchainTapscript.options.serverPubKey,
                    csvTimelock: wallet.offchainTapscript.options.csvTimelock,
                });
                faucetOffchain(
                    issued.address(wallet.network.hrp, wallet.arkServerPublicKey).encode(),
                    AMOUNT,
                );

                // Wait on the indexer so a failure below means the band missed
                // the script, not that the send was not indexed yet.
                const indexer = new RestIndexerProvider("http://localhost:7070");
                const issuedScript = hex.encode(issued.pkScript);
                await waitFor(
                    async () =>
                        (await indexer.getVtxos({ scripts: [issuedScript] })).vtxos.length > 0,
                    { timeout: 60_000, interval: 1_000 },
                );

                // No restore(): the live band alone must credit the payment.
                await waitFor(async () => (await wallet.getBalance()).total > before, {
                    timeout: 60_000,
                    interval: 2_000,
                });
                expect((await wallet.getBalance()).total).toBeGreaterThanOrEqual(2 * AMOUNT);
            } finally {
                await wallet.dispose();
            }
        },
    );
});
