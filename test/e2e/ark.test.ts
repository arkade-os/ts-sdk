import { expect, describe, it, beforeEach } from "vitest";
import { execSync } from "child_process";
import {
    TxType,
    RestIndexerProvider,
    ArkNote,
    waitForIncomingFunds,
    OnchainWallet,
    Unroll,
    Ramps,
    Coin,
    VirtualCoin,
} from "../../src";
import {
    arkdExec,
    createTestArkWallet,
    createTestOnchainWallet,
    faucetOffchain,
    faucetOnchain,
} from "./utils";

describe("Ark integration tests", () => {
    beforeEach(() => {
        // Check if there's enough offchain balance before proceeding
        const balanceOutput = execSync(`${arkdExec} ark balance`).toString();
        const balance = JSON.parse(balanceOutput);
        const offchainBalance = balance.offchain_balance.total;

        if (offchainBalance < 20_000) {
            for (let i = 0; i < 2; i++) {
                const note = execSync(`${arkdExec} arkd note --amount 30_000`);
                const noteStr = note.toString().trim();
                execSync(
                    `${arkdExec} ark redeem-notes -n ${noteStr} --password secret`
                );
            }
        }
    });

    it("should settle a boarding UTXO", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();

        const boardingAddress = await alice.wallet.getBoardingAddress();

        // faucet
        execSync(`nigiri faucet ${boardingAddress} 0.001`);

        await new Promise((resolve) => setTimeout(resolve, 5000));

        const settleTxid = await new Ramps(alice.wallet).onboard();
        expect(settleTxid).toBeDefined();
    });

    it("should settle a VTXO", { timeout: 60000 }, async () => {
        // Create fresh wallet instance for this test
        const alice = await createTestArkWallet();
        const aliceOffchainAddress = await alice.wallet.getAddress();
        expect(aliceOffchainAddress).toBeDefined();

        const fundAmount = 1000;
        execSync(
            `${arkdExec} ark send --to ${aliceOffchainAddress} --amount ${fundAmount} --password secret`
        );

        await new Promise((resolve) => setTimeout(resolve, 1000));

        const virtualCoins = await alice.wallet.getVtxos();
        expect(virtualCoins).toHaveLength(1);
        const vtxo = virtualCoins[0];
        expect(vtxo.txid).toBeDefined();

        const settleTxid = await alice.wallet.settle({
            inputs: [vtxo],
            outputs: [
                {
                    address: aliceOffchainAddress!,
                    amount: BigInt(fundAmount),
                },
            ],
        });

        expect(settleTxid).toBeDefined();
    });

    it(
        "should settle 2 clients in the same batch",
        { timeout: 60000 },
        async () => {
            const alice = await createTestArkWallet();
            const bob = await createTestArkWallet();

            const aliceOffchainAddress = await alice.wallet.getAddress();
            expect(aliceOffchainAddress).toBeDefined();

            const bobOffchainAddress = await bob.wallet.getAddress();
            expect(bobOffchainAddress).toBeDefined();

            const fundAmount = 1000;
            execSync(
                `${arkdExec} ark send --to ${aliceOffchainAddress} --amount ${fundAmount} --password secret`
            );
            execSync(
                `${arkdExec} ark send --to ${bobOffchainAddress} --amount ${fundAmount} --password secret`
            );

            await new Promise((resolve) => setTimeout(resolve, 1000));

            const virtualCoins = await alice.wallet.getVtxos();
            expect(virtualCoins).toHaveLength(1);
            const aliceVtxo = virtualCoins[0];
            expect(aliceVtxo.txid).toBeDefined();

            const bobVirtualCoins = await bob.wallet.getVtxos();
            expect(bobVirtualCoins).toHaveLength(1);
            const bobVtxo = bobVirtualCoins[0];
            expect(bobVtxo.txid).toBeDefined();

            const [aliceSettleTxid, bobSettleTxid] = await Promise.all([
                alice.wallet.settle({
                    inputs: [aliceVtxo],
                    outputs: [
                        {
                            address: aliceOffchainAddress!,
                            amount: BigInt(fundAmount),
                        },
                    ],
                }),
                bob.wallet.settle({
                    inputs: [bobVtxo],
                    outputs: [
                        {
                            address: bobOffchainAddress!,
                            amount: BigInt(fundAmount),
                        },
                    ],
                }),
            ]);

            expect(aliceSettleTxid).toBeDefined();
            expect(bobSettleTxid).toBeDefined();
            expect(aliceSettleTxid).toBe(bobSettleTxid);
        }
    );

    it(
        "should perform a complete offchain roundtrip payment",
        { timeout: 60000 },
        async () => {
            // Create fresh wallet instances for this test
            const alice = await createTestArkWallet();
            const bob = await createTestArkWallet();

            // Get addresses
            const aliceOffchainAddress = await alice.wallet.getAddress();
            const bobOffchainAddress = await bob.wallet.getAddress();
            expect(aliceOffchainAddress).toBeDefined();
            expect(bobOffchainAddress).toBeDefined();

            // Initial balance check
            const aliceInitialBalance = await alice.wallet.getBalance();
            const bobInitialBalance = await bob.wallet.getBalance();
            expect(aliceInitialBalance.total).toBe(0);
            expect(bobInitialBalance.total).toBe(0);

            // Initial virtual coins check
            expect((await alice.wallet.getVtxos()).length).toBe(0);
            expect((await bob.wallet.getVtxos()).length).toBe(0);

            // Use a smaller amount for testing
            const fundAmount = 10000;
            execSync(
                `${arkdExec} ark send --to ${aliceOffchainAddress} --amount ${fundAmount} --password secret`
            );

            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Check virtual coins after funding
            const virtualCoins = await alice.wallet.getVtxos();

            // Verify we have a preconfirmed virtual coin
            expect(virtualCoins).toHaveLength(1);
            const vtxo = virtualCoins[0];
            expect(vtxo.txid).toBeDefined();
            expect(vtxo.value).toBe(fundAmount);
            expect(vtxo.virtualStatus.state).toBe("preconfirmed");

            // Check Alice's balance after funding
            const aliceBalanceAfterFunding = await alice.wallet.getBalance();
            expect(aliceBalanceAfterFunding.total).toBe(fundAmount);

            // Send from Alice to Bob offchain
            const sendAmount = 5000; // 5k sats instead of 50k
            await alice.wallet.sendBitcoin({
                address: bobOffchainAddress!,
                amount: sendAmount,
            });

            // Wait for the transaction to be processed
            await new Promise((resolve) => setTimeout(resolve, 5000));

            // Final balance check
            const aliceFinalBalance = await alice.wallet.getBalance();
            const bobFinalBalance = await bob.wallet.getBalance();
            // Verify the transaction was successful
            expect(bobFinalBalance.total).toBe(sendAmount);
            expect(aliceFinalBalance.total).toBe(fundAmount - sendAmount);
        }
    );

    it("should return transaction history", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const bob = await createTestArkWallet();

        // Get addresses
        const aliceOffchainAddress = await alice.wallet.getAddress();
        const bobOffchainAddress = await bob.wallet.getAddress();
        expect(aliceOffchainAddress).toBeDefined();
        expect(bobOffchainAddress).toBeDefined();

        // Alice onboarding
        const boardingAmount = 10000;
        const boardingAddress = await alice.wallet.getBoardingAddress();
        execSync(
            `nigiri faucet ${boardingAddress} ${boardingAmount * 0.00000001}`
        );

        await new Promise((resolve) => setTimeout(resolve, 5000));

        // Get boarding utxos
        const boardingInputs = await alice.wallet.getBoardingUtxos();
        expect(boardingInputs.length).toBeGreaterThanOrEqual(1);

        await alice.wallet.settle({
            inputs: boardingInputs,
            outputs: [
                {
                    address: aliceOffchainAddress!,
                    amount: BigInt(boardingAmount),
                },
            ],
        });

        // Wait for the transaction to be processed
        execSync("nigiri rpc generatetoaddress 1 $(nigiri rpc getnewaddress)");
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Check history before sending to bob
        let aliceHistory = await alice.wallet.getTransactionHistory();
        expect(aliceHistory).toBeDefined();
        expect(aliceHistory.length).toBe(1); // should have boarding tx

        // Check boarding transaction
        expect(aliceHistory[0].type).toBe(TxType.TxReceived);
        expect(aliceHistory[0].amount).toBe(boardingAmount);
        expect(aliceHistory[0].settled).toBe(true);
        expect(aliceHistory[0].key.boardingTxid.length).toBeGreaterThan(0);

        // Send from Alice to Bob offchain
        const sendAmount = 5000;
        const sendTxid = await alice.wallet.sendBitcoin({
            address: bobOffchainAddress!,
            amount: sendAmount,
        });

        // Wait for the transaction to be processed
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // Check final balances
        const aliceFinalBalance = await alice.wallet.getBalance();
        const bobFinalBalance = await bob.wallet.getBalance();
        expect(bobFinalBalance.total).toBe(sendAmount);
        expect(aliceFinalBalance.total).toBe(boardingAmount - sendAmount);

        // Get transaction history for Alice
        aliceHistory = await alice.wallet.getTransactionHistory();
        expect(aliceHistory).toBeDefined();
        expect(aliceHistory.length).toBe(2); // Should have at least receive and send transactions

        const [sendTx, fundingTx] = aliceHistory;

        // Check funding transaction
        expect(fundingTx.type).toBe(TxType.TxReceived);
        expect(fundingTx.amount).toBe(boardingAmount);
        expect(fundingTx.settled).toBe(true);
        expect(fundingTx.key.boardingTxid.length).toBeGreaterThan(0);

        // Check send transaction
        expect(sendTx.type).toBe(TxType.TxSent);
        expect(sendTx.amount).toBe(sendAmount);
        expect(sendTx.key.arkTxid.length).toBeGreaterThan(0);
        expect(sendTx.key.arkTxid).toBe(sendTxid);

        // Get transaction history for Bob
        const bobHistory = await bob.wallet.getTransactionHistory();
        expect(bobHistory).toBeDefined();
        expect(bobHistory.length).toBe(1); // Should have at least the receive transaction

        // Verify Bob's receive transaction
        const [bobsReceiveTx] = bobHistory;
        expect(bobsReceiveTx.type).toBe(TxType.TxReceived);
        expect(bobsReceiveTx.amount).toBe(sendAmount);
        expect(bobsReceiveTx.settled).toBe(false);
        expect(bobsReceiveTx.key.arkTxid.length).toBeGreaterThan(0);

        // Bob settles the received VTXO
        let bobInputs = await bob.wallet.getVtxos();
        await bob.wallet.settle({
            inputs: bobInputs,
            outputs: [
                {
                    address: bobOffchainAddress!,
                    amount: BigInt(sendAmount),
                },
            ],
        });

        // Verify Bob's history
        const bobHistoryAfterSettling =
            await bob.wallet.getTransactionHistory();
        expect(bobHistoryAfterSettling).toBeDefined();
        expect(bobHistoryAfterSettling.length).toBe(1);
        const [bobsReceiveTxAfterSettling] = bobHistoryAfterSettling;
        expect(bobsReceiveTxAfterSettling.type).toBe(TxType.TxReceived);
        expect(bobsReceiveTxAfterSettling.amount).toBe(sendAmount);
        expect(bobsReceiveTxAfterSettling.settled).toBe(true);

        // Bob does a collaborative exit to alice's boarding address
        bobInputs = await bob.wallet.getVtxos();
        const amount = bobInputs.reduce((acc, input) => acc + input.value, 0);
        const bobExitTxid = await bob.wallet.settle({
            inputs: bobInputs,
            outputs: [
                {
                    address: boardingAddress!,
                    amount: BigInt(amount),
                },
            ],
        });

        expect(bobExitTxid).toBeDefined();

        // Check bob's history
        const bobHistoryAfterExit = await bob.wallet.getTransactionHistory();
        expect(bobHistoryAfterExit).toBeDefined();
        expect(bobHistoryAfterExit.length).toBe(2);
        const [bobsExitTx] = bobHistoryAfterExit;
        expect(bobsExitTx.type).toBe(TxType.TxSent);
        expect(bobsExitTx.amount).toBe(amount);

        // Check alice's history
        const aliceHistoryAfterExit =
            await alice.wallet.getTransactionHistory();
        expect(aliceHistoryAfterExit).toBeDefined();
        expect(aliceHistoryAfterExit.length).toBe(3);
        const [alicesExitTx] = aliceHistoryAfterExit;
        expect(alicesExitTx.type).toBe(TxType.TxReceived);
        expect(alicesExitTx.amount).toBe(amount);
    });

    it("should redeem a note", { timeout: 60000 }, async () => {
        // Create fresh wallet instance for this test
        const alice = await createTestArkWallet();
        const aliceOffchainAddress = await alice.wallet.getAddress();
        expect(aliceOffchainAddress).toBeDefined();

        const fundAmount = 1000;

        const arknote = execSync(`${arkdExec} arkd note --amount ${fundAmount}`)
            .toString()
            .replace(/\n/g, "");

        const settleTxid = await alice.wallet.settle({
            inputs: [ArkNote.fromString(arknote)],
            outputs: [
                {
                    address: aliceOffchainAddress!,
                    amount: BigInt(fundAmount),
                },
            ],
        });

        expect(settleTxid).toBeDefined();

        await new Promise((resolve) => setTimeout(resolve, 1000));

        const virtualCoins = await alice.wallet.getVtxos();
        expect(virtualCoins).toHaveLength(1);
        expect(virtualCoins[0].value).toBe(fundAmount);
    });

    it("should unroll", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();

        const boardingAddress = await alice.wallet.getBoardingAddress();
        const offchainAddress = await alice.wallet.getAddress();

        // faucet
        execSync(`nigiri faucet ${boardingAddress} 0.0001`);

        await new Promise((resolve) => setTimeout(resolve, 5000));

        const boardingInputs = await alice.wallet.getBoardingUtxos();
        expect(boardingInputs.length).toBeGreaterThanOrEqual(1);

        await alice.wallet.settle({
            inputs: boardingInputs,
            outputs: [
                {
                    address: offchainAddress!,
                    amount: BigInt(10000),
                },
            ],
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));

        execSync(`nigiri rpc generatetoaddress 1 $(nigiri rpc getnewaddress)`);

        await new Promise((resolve) => setTimeout(resolve, 1000));

        const virtualCoins = await alice.wallet.getVtxos();
        expect(virtualCoins).toHaveLength(1);
        const vtxo = virtualCoins[0];
        expect(vtxo.txid).toBeDefined();

        const onchainAlice = new OnchainWallet(alice.identity, "regtest");

        execSync(`nigiri faucet ${onchainAlice.address} 0.001`);

        await new Promise((resolve) => setTimeout(resolve, 5000));

        const session = await Unroll.Session.create(
            { txid: vtxo.txid, vout: vtxo.vout },
            onchainAlice,
            onchainAlice.provider,
            new RestIndexerProvider("http://localhost:7070")
        );

        for await (const done of session) {
            switch (done.type) {
                case Unroll.StepType.WAIT:
                case Unroll.StepType.UNROLL:
                    execSync(
                        `nigiri rpc generatetoaddress 1 $(nigiri rpc getnewaddress)`
                    );
                    break;
            }
        }

        const virtualCoinsAfterExit = await alice.wallet.getVtxos({
            withUnrolled: true,
        });
        expect(virtualCoinsAfterExit).toHaveLength(1);
        expect(virtualCoinsAfterExit[0].isUnrolled).toBe(true);
    });

    it("should exit collaboratively", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const onchainAlice = createTestOnchainWallet();
        const aliceOffchainAddress = await alice.wallet.getAddress();

        // faucet offchain address
        const fundAmount = 10_000;
        execSync(
            `${arkdExec} ark send --to ${aliceOffchainAddress} --amount ${fundAmount} --password secret`
        );

        await new Promise((resolve) => setTimeout(resolve, 2000));

        const exitTxid = await new Ramps(alice.wallet).offboard(
            onchainAlice.wallet.address
        );

        expect(exitTxid).toBeDefined();
    });

    it("should settle a recoverable VTXO", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const aliceOffchainAddress = await alice.wallet.getAddress();
        const boardingAddress = await alice.wallet.getBoardingAddress();
        expect(aliceOffchainAddress).toBeDefined();

        // faucet
        execSync(`nigiri faucet ${boardingAddress} 0.001`);

        await new Promise((resolve) => setTimeout(resolve, 5000));

        const boardingInputs = await alice.wallet.getBoardingUtxos();
        expect(boardingInputs.length).toBeGreaterThanOrEqual(1);

        await alice.wallet.settle({
            inputs: boardingInputs,
            outputs: [
                {
                    address: aliceOffchainAddress!,
                    amount: BigInt(100_000),
                },
            ],
        });

        // give some time for the server to be swept
        await new Promise((resolve) => setTimeout(resolve, 10000));

        const vtxos = await alice.wallet.getVtxos({
            withRecoverable: false,
        });
        expect(vtxos).toHaveLength(1);
        const vtxo = vtxos[0];
        expect(vtxo.txid).toBeDefined();
        expect(vtxo.virtualStatus.state).toBe("settled");

        // generate 25 blocks to make the vtxo swept (expiry set to 20 blocks)
        execSync(`nigiri rpc generatetoaddress 25 $(nigiri rpc getnewaddress)`);

        await new Promise((resolve) => setTimeout(resolve, 20_000));

        const vtxosAfterSweep = await alice.wallet.getVtxos({
            withRecoverable: true,
        });
        expect(vtxosAfterSweep).toHaveLength(1);
        const vtxoAfterSweep = vtxosAfterSweep[0];
        expect(vtxoAfterSweep.txid).toBe(vtxo.txid);
        expect(vtxoAfterSweep.virtualStatus.state).toBe("swept");
        expect(vtxoAfterSweep.spentBy).toBe("");

        const settleTxid = await alice.wallet.settle({
            inputs: [vtxo],
            outputs: [
                {
                    address: aliceOffchainAddress!,
                    amount: BigInt(100_000),
                },
            ],
        });

        expect(settleTxid).toBeDefined();
    });

    it(
        "should be notified of offchain incoming funds",
        { timeout: 6000 },
        async () => {
            const alice = await createTestArkWallet();
            const aliceAddress = await alice.wallet.getAddress();
            expect(aliceAddress).toBeDefined();

            let notified = false;
            const fundAmount = 10000;

            // set up the notification
            alice.wallet.notifyIncomingFunds((notification) => {
                const now = new Date();
                expect(notification.type).toBe("vtxo");
                let vtxos: VirtualCoin[] = [];
                if (notification.type === "vtxo") {
                    vtxos = notification.vtxos;
                }
                expect(vtxos).toHaveLength(1);
                expect(vtxos[0].spentBy).toBeFalsy();
                expect(vtxos[0].value).toBe(fundAmount);
                expect(vtxos[0].virtualStatus.state).toBe("preconfirmed");
                const age = now.getTime() - vtxos[0].createdAt.getTime();
                expect(age).toBeLessThanOrEqual(4000);
                notified = true;
            });

            // wait for the notification to be set up
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // fund the offchain address using faucet
            faucetOffchain(aliceAddress!, fundAmount);

            // wait for the transaction to be processed
            await new Promise((resolve) => setTimeout(resolve, 4000));
            expect(notified).toBeTruthy();
        }
    );

    it(
        "should be notified of onchain incoming funds",
        { timeout: 60000 },
        async () => {
            const alice = await createTestArkWallet();
            const aliceBoardingAddress =
                await alice.wallet.getBoardingAddress();
            expect(aliceBoardingAddress).toBeDefined();

            let notified = false;
            const fundAmount = 10000;

            // set up the notification
            alice.wallet.notifyIncomingFunds((notification) => {
                const now = new Date();
                expect(notification.type).toBe("utxo");
                let utxos: Coin[] = [];
                if (notification.type == "utxo") {
                    utxos = notification.coins;
                }
                expect(utxos).toHaveLength(1);
                expect(utxos[0].value).toBe(fundAmount);
                expect(utxos[0].status.confirmed).toBeTruthy();
                expect(utxos[0].status.block_time).toBeDefined();
                const age = now.getTime() - utxos[0].status.block_time! * 1000;
                expect(age).toBeLessThanOrEqual(10000);
                notified = true;
            });

            // wait for the notification to be set up
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // fund the onchain address using faucet
            faucetOnchain(aliceBoardingAddress!, fundAmount);

            // wait for the transaction to be processed
            await new Promise((resolve) => setTimeout(resolve, 10000));

            expect(notified).toBeTruthy();
        }
    );

    it(
        "should wait for offchain incoming funds",
        { timeout: 6000 },
        async () => {
            const alice = await createTestArkWallet();
            const aliceAddress = await alice.wallet.getAddress();
            expect(aliceAddress).toBeDefined();

            const now = new Date();
            const fundAmount = 10000;

            // faucet in a few moments
            setTimeout(() => faucetOffchain(aliceAddress!, fundAmount), 1000);

            // wait for coins to arrive
            const notification = await waitForIncomingFunds(alice.wallet);
            let vtxos: VirtualCoin[] = [];
            if (notification.type === "vtxo") {
                vtxos = notification.vtxos;
            }

            // assert
            expect(vtxos).toHaveLength(1);
            expect(vtxos[0].spentBy).toBeFalsy();
            expect(vtxos[0].value).toBe(fundAmount);
            expect(vtxos[0].virtualStatus.state).toBe("preconfirmed");
            const age = now.getTime() - vtxos[0].createdAt.getTime();
            expect(age).toBeLessThanOrEqual(4000);
        }
    );

    it(
        "should wait for onchain incoming funds",
        { timeout: 60000 },
        async () => {
            const alice = await createTestArkWallet();
            const aliceBoardingAddress =
                await alice.wallet.getBoardingAddress();
            expect(aliceBoardingAddress).toBeDefined();

            const now = new Date();
            const fundAmount = 10000;

            // faucet in a few moments
            setTimeout(
                () => faucetOnchain(aliceBoardingAddress!, fundAmount),
                1000
            );

            // wait for coins to arrive
            const notification = await waitForIncomingFunds(alice.wallet);
            let utxos: Coin[] = [];
            if (notification.type === "utxo") {
                utxos = notification.coins;
            }

            // assert
            expect(utxos).toHaveLength(1);
            expect(utxos[0].value).toBe(fundAmount);
            expect(utxos[0].status.block_time).toBeDefined();
            const age = now.getTime() - utxos[0].status.block_time! * 1000;
            expect(age).toBeLessThanOrEqual(10000);
        }
    );

    it("should send subdust amount", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const bob = await createTestArkWallet();

        const aliceOffchainAddress = await alice.wallet.getAddress();
        const bobOffchainAddress = await bob.wallet.getAddress();

        const fundAmount = 10_000;
        execSync(
            `${arkdExec} ark send --to ${aliceOffchainAddress} --amount ${fundAmount} --password secret`
        );

        await new Promise((resolve) => setTimeout(resolve, 1000));

        // alice should send offchain tx with subdust output
        await alice.wallet.sendBitcoin({
            address: bobOffchainAddress!,
            amount: 1,
        });

        await new Promise((resolve) => setTimeout(resolve, 3000));

        // bob should have 1 sat in offchain balance
        const bobBalance = await bob.wallet.getBalance();
        expect(bobBalance.total).toBe(1);

        // bob shouldn't be able to send offchain tx with subdust output
        await expect(
            bob.wallet.sendBitcoin({
                address: bobOffchainAddress!,
                amount: 1,
            })
        ).rejects.toThrow("Insufficient funds");

        // bob shouldn't be able to settle cause the total amount is less than the dust amount
        await expect(bob.wallet.settle()).rejects.toThrow();

        await alice.wallet.sendBitcoin({
            address: bobOffchainAddress!,
            amount: fundAmount - 1,
        });

        await new Promise((resolve) => setTimeout(resolve, 3000));

        // now bob should be able to settle
        await bob.wallet.settle();
    });
});
