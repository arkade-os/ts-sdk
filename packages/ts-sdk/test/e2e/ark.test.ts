import { expect, describe, it, beforeEach } from "vitest";
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
    RestArkProvider,
    ArkError,
    ArkAddress,
    buildOffchainTx,
    CSVMultisigTapscript,
    VtxoScript,
    Wallet,
    EsploraProvider,
    InMemoryWalletRepository,
    InMemoryContractRepository,
    ArkCash,
    RestDelegateProvider,
} from "../../src";
import {
    arkdExec,
    beforeEachFaucet,
    clearFees,
    createTestArkWallet,
    createTestArkWalletWithDelegate,
    createTestIdentity,
    createTestOnchainWallet,
    execCommand,
    faucetOffchain,
    faucetOnchain,
    mineBlocks,
    setFees,
    waitFor,
} from "./utils";
import { hex, base64 } from "@scure/base";

describe("Common", () => {
    beforeEach(beforeEachFaucet, 20000);

    for (const { name, factory } of [
        { name: "Wallet", factory: createTestArkWallet },
        // { name: "With Delegate", factory: createTestArkWalletWithDelegate },
        // { name: "With Mnemonic", factory: createTestArkWalletWithMnemonic },
    ]) {
        describe(name, () => {
            it("should settle a boarding UTXO", { timeout: 60000 }, async () => {
                const alice = await factory();

                const boardingAddress = await alice.wallet.getBoardingAddress();

                // faucet
                execCommand(`node regtest/regtest.mjs faucet ${boardingAddress} 0.001 --confirm`);

                await waitFor(async () => (await alice.wallet.getBoardingUtxos()).length > 0);

                const { fees } = await alice.wallet.arkProvider.getInfo();

                const settleTxid = await new Ramps(alice.wallet).onboard(fees);
                expect(settleTxid).toBeDefined();
            });

            it("should settle a VTXO", { timeout: 60000 }, async () => {
                // Create fresh wallet instance for this test
                const alice = await factory();
                const aliceOffchainAddress = await alice.wallet.getAddress();
                expect(aliceOffchainAddress).toBeDefined();

                const fundAmount = 1000;
                execCommand(
                    `${arkdExec} ark send --to ${aliceOffchainAddress} --amount ${fundAmount} --password secret`,
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

            it("should settle 2 clients in the same batch", { timeout: 60000 }, async () => {
                const alice = await factory();
                const bob = await factory();

                const aliceOffchainAddress = await alice.wallet.getAddress();
                expect(aliceOffchainAddress).toBeDefined();

                const bobOffchainAddress = await bob.wallet.getAddress();
                expect(bobOffchainAddress).toBeDefined();

                const fundAmount = 1000;
                execCommand(
                    `${arkdExec} ark send --to ${aliceOffchainAddress} --amount ${fundAmount} --password secret`,
                );
                execCommand(
                    `${arkdExec} ark send --to ${bobOffchainAddress} --amount ${fundAmount} --password secret`,
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
            });

            it(
                "should perform a complete offchain roundtrip payment",
                { timeout: 60000 },
                async () => {
                    // Create fresh wallet instances for this test
                    const alice = await factory();
                    const bob = await factory();

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
                    execCommand(
                        `${arkdExec} ark send --to ${aliceOffchainAddress} --amount ${fundAmount} --password secret`,
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
                    await alice.wallet.send({
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
                },
            );

            it("should return transaction history", { timeout: 60000 }, async () => {
                const alice = await factory();
                const bob = await factory();

                // Get addresses
                const aliceOffchainAddress = await alice.wallet.getAddress();
                const bobOffchainAddress = await bob.wallet.getAddress();
                expect(aliceOffchainAddress).toBeDefined();
                expect(bobOffchainAddress).toBeDefined();

                // Alice onboarding
                const boardingAmount = 10000;
                const boardingAddress = await alice.wallet.getBoardingAddress();
                execCommand(
                    `node regtest/regtest.mjs faucet ${boardingAddress} ${boardingAmount * 0.00000001} --confirm`,
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
                execCommand("node regtest/regtest.mjs mine 1");
                await new Promise((resolve) => setTimeout(resolve, 5000));

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
                const sendTxid = await alice.wallet.send({
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

                // Wait for the transaction to be processed
                execCommand("node regtest/regtest.mjs mine 1");
                await new Promise((resolve) => setTimeout(resolve, 5000));

                // Verify Bob's history
                const bobHistoryAfterSettling = await bob.wallet.getTransactionHistory();
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

                // Wait for the transaction to be processed
                execCommand("node regtest/regtest.mjs mine 1");
                await new Promise((resolve) => setTimeout(resolve, 5000));

                // Check bob's history
                const bobHistoryAfterExit = await bob.wallet.getTransactionHistory();
                expect(bobHistoryAfterExit).toBeDefined();
                expect(bobHistoryAfterExit.length).toBe(2);
                const [bobsExitTx] = bobHistoryAfterExit;
                expect(bobsExitTx.type).toBe(TxType.TxSent);
                expect(bobsExitTx.amount).toBe(amount);

                // Check alice's history
                const aliceHistoryAfterExit = await alice.wallet.getTransactionHistory();
                expect(aliceHistoryAfterExit).toBeDefined();
                expect(aliceHistoryAfterExit.length).toBe(3);
                const [alicesExitTx] = aliceHistoryAfterExit;
                expect(alicesExitTx.type).toBe(TxType.TxReceived);
                expect(alicesExitTx.amount).toBe(amount);
            });

            it("should redeem a note", { timeout: 60000 }, async () => {
                // Create fresh wallet instance for this test
                const alice = await factory();
                const aliceOffchainAddress = await alice.wallet.getAddress();
                expect(aliceOffchainAddress).toBeDefined();

                const fundAmount = 1000;

                const arknote = execCommand(`${arkdExec} arkd note --amount ${fundAmount}`);

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

                await new Promise((resolve) => setTimeout(resolve, 5000));

                const virtualCoins = await alice.wallet.getVtxos();
                expect(virtualCoins).toHaveLength(1);
                expect(virtualCoins[0].value).toBe(fundAmount);
            });

            it("should unroll", { timeout: 60000 }, async () => {
                const alice = await factory();

                const boardingAddress = await alice.wallet.getBoardingAddress();
                const offchainAddress = await alice.wallet.getAddress();

                // faucet
                execCommand(`node regtest/regtest.mjs faucet ${boardingAddress} 0.0001 --confirm`);

                // wait until indexer reflects the faucet instead of sleeping.
                await waitFor(async () => {
                    const b = await alice.wallet.getBoardingUtxos();
                    return b.length > 0;
                });

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

                execCommand(`node regtest/regtest.mjs mine 1`);

                // wait until indexer reflects the new block instead of sleeping.
                await waitFor(async () => {
                    const v = await alice.wallet.getVtxos();
                    return v.length > 0;
                });

                const virtualCoins = await alice.wallet.getVtxos();
                expect(virtualCoins).toHaveLength(1);
                const vtxo = virtualCoins[0];
                expect(vtxo.txid).toBeDefined();

                const onchainAlice = await OnchainWallet.create(alice.identity, "regtest");

                execCommand(
                    `node regtest/regtest.mjs faucet ${onchainAlice.address} 0.001 --confirm`,
                );

                await new Promise((resolve) => setTimeout(resolve, 5000));

                const session = await Unroll.Session.create(
                    { txid: vtxo.txid, vout: vtxo.vout },
                    onchainAlice,
                    onchainAlice.provider,
                    new RestIndexerProvider("http://localhost:7070"),
                );

                for await (const done of session) {
                    switch (done.type) {
                        case Unroll.StepType.WAIT:
                        case Unroll.StepType.UNROLL:
                            execCommand(`node regtest/regtest.mjs mine 1`);
                            break;
                    }
                }

                const virtualCoinsAfterExit = await alice.wallet.getVtxos({
                    withUnrolled: true,
                });
                expect(virtualCoinsAfterExit).toHaveLength(1);
                expect(virtualCoinsAfterExit[0].isUnrolled).toBe(true);
            });

            it(
                "should reject complete-unroll before unilateral exit delay matures",
                { timeout: 120000 },
                async () => {
                    const alice = await factory();

                    const boardingAddress = await alice.wallet.getBoardingAddress();
                    const offchainAddress = await alice.wallet.getAddress();

                    execCommand(
                        `node regtest/regtest.mjs faucet ${boardingAddress} 0.0001 --confirm`,
                    );

                    await waitFor(async () => {
                        const b = await alice.wallet.getBoardingUtxos();
                        return b.length > 0;
                    });

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

                    execCommand(`node regtest/regtest.mjs mine 1`);

                    await waitFor(async () => {
                        const v = await alice.wallet.getVtxos();
                        return v.length > 0;
                    });

                    const virtualCoins = await alice.wallet.getVtxos();
                    expect(virtualCoins).toHaveLength(1);
                    const vtxo = virtualCoins[0];
                    expect(vtxo.txid).toBeDefined();

                    const onchainAlice = await OnchainWallet.create(alice.identity, "regtest");

                    execCommand(
                        `node regtest/regtest.mjs faucet ${onchainAlice.address} 0.001 --confirm`,
                    );
                    await waitFor(async () => {
                        const b = await onchainAlice.getBalance();
                        return b > 0;
                    });

                    const session = await Unroll.Session.create(
                        { txid: vtxo.txid, vout: vtxo.vout },
                        onchainAlice,
                        onchainAlice.provider,
                        new RestIndexerProvider("http://localhost:7070"),
                    );

                    for await (const done of session) {
                        switch (done.type) {
                            case Unroll.StepType.WAIT:
                            case Unroll.StepType.UNROLL:
                                execCommand(`node regtest/regtest.mjs mine 1`);
                                break;
                        }
                    }

                    const virtualCoinsAfterExit = await alice.wallet.getVtxos({
                        withUnrolled: true,
                    });
                    expect(virtualCoinsAfterExit).toHaveLength(1);
                    const unrolled = virtualCoinsAfterExit[0];
                    expect(unrolled.isUnrolled).toBe(true);

                    const exits = VtxoScript.decode(unrolled.tapTree).exitPaths();
                    expect(exits.length).toBeGreaterThan(0);

                    const txStatus = await alice.wallet.onchainProvider.getTxStatus(unrolled.txid);
                    expect(txStatus.confirmed).toBe(true);

                    // Keep this aligned with availableExitPath() selection logic,
                    // which currently returns the first mature exit path.
                    const exitTimelock = exits[0].params.timelock;
                    const chainTip = await alice.wallet.onchainProvider.getChainTip();
                    if (exitTimelock.type === "blocks") {
                        const requiredHeight = txStatus.blockHeight + Number(exitTimelock.value);
                        expect(chainTip.height).toBeLessThan(requiredHeight);
                    } else {
                        const requiredTime = txStatus.blockTime + Number(exitTimelock.value);
                        expect(chainTip.time).toBeLessThan(requiredTime);
                    }

                    await expect(
                        Unroll.completeUnroll(alice.wallet, [unrolled.txid], onchainAlice.address),
                    ).rejects.toThrow(/no available exit path found/i);
                },
            );

            it(
                "should complete unroll after unilateral exit delay",
                { timeout: 120000 },
                async () => {
                    const alice = await factory();

                    const boardingAddress = await alice.wallet.getBoardingAddress();
                    const offchainAddress = await alice.wallet.getAddress();

                    execCommand(
                        `node regtest/regtest.mjs faucet ${boardingAddress} 0.0001 --confirm`,
                    );

                    await waitFor(async () => {
                        const b = await alice.wallet.getBoardingUtxos();
                        return b.length > 0;
                    });

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

                    execCommand(`node regtest/regtest.mjs mine 1`);

                    await waitFor(async () => {
                        const v = await alice.wallet.getVtxos();
                        return v.length > 0;
                    });

                    const virtualCoins = await alice.wallet.getVtxos();
                    expect(virtualCoins).toHaveLength(1);
                    const vtxo = virtualCoins[0];
                    expect(vtxo.txid).toBeDefined();

                    const onchainAlice = await OnchainWallet.create(alice.identity, "regtest");

                    execCommand(
                        `node regtest/regtest.mjs faucet ${onchainAlice.address} 0.001 --confirm`,
                    );
                    await waitFor(async () => {
                        const b = await onchainAlice.getBalance();
                        return b > 0;
                    });

                    const session = await Unroll.Session.create(
                        { txid: vtxo.txid, vout: vtxo.vout },
                        onchainAlice,
                        onchainAlice.provider,
                        new RestIndexerProvider("http://localhost:7070"),
                    );

                    for await (const done of session) {
                        switch (done.type) {
                            case Unroll.StepType.WAIT:
                            case Unroll.StepType.UNROLL:
                                execCommand(`node regtest/regtest.mjs mine 1`);
                                break;
                        }
                    }

                    const virtualCoinsAfterExit = await alice.wallet.getVtxos({
                        withUnrolled: true,
                    });
                    expect(virtualCoinsAfterExit).toHaveLength(1);
                    const unrolled = virtualCoinsAfterExit[0];
                    expect(unrolled.isUnrolled).toBe(true);

                    const exits = VtxoScript.decode(unrolled.tapTree).exitPaths();
                    expect(exits.length).toBeGreaterThan(0);

                    const txStatus = await alice.wallet.onchainProvider.getTxStatus(unrolled.txid);
                    expect(txStatus.confirmed).toBe(true);

                    // Keep this aligned with availableExitPath() selection logic,
                    // which currently returns the first mature exit path.
                    const exitTimelock = exits[0].params.timelock;
                    if (exitTimelock.type === "blocks") {
                        const chainTip = await alice.wallet.onchainProvider.getChainTip();
                        const requiredHeight = txStatus.blockHeight + Number(exitTimelock.value);
                        const remainingBlocks = Math.max(0, requiredHeight - chainTip.height);
                        if (remainingBlocks > 0) {
                            execCommand(`node regtest/regtest.mjs mine ${remainingBlocks}`);
                            // Wait for the onchain provider to observe the new
                            // tip; freshly mined blocks are not always visible
                            // to esplora the instant `regtest.mjs mine` returns.
                            await waitFor(async () => {
                                const tip = await alice.wallet.onchainProvider.getChainTip();
                                return tip.height >= requiredHeight;
                            });
                        }
                    } else {
                        const requiredTime = txStatus.blockTime + Number(exitTimelock.value);
                        const initialTip = await alice.wallet.onchainProvider.getChainTip();
                        let blocksMined = 0;
                        for (let i = 0; i < 300; i += 1) {
                            const chainTip = await alice.wallet.onchainProvider.getChainTip();
                            if (chainTip.time >= requiredTime) {
                                break;
                            }
                            execCommand(`node regtest/regtest.mjs mine 1`);
                            blocksMined += 1;
                        }
                        const finalTip = await alice.wallet.onchainProvider.getChainTip();
                        expect(finalTip.time).toBeGreaterThanOrEqual(requiredTime);
                        if (initialTip.time < requiredTime) {
                            expect(blocksMined).toBeGreaterThan(0);
                        }
                    }

                    const beforeBalance = await onchainAlice.getBalance();
                    const completeTxid = await Unroll.completeUnroll(
                        alice.wallet,
                        [unrolled.txid],
                        onchainAlice.address,
                    );
                    expect(completeTxid).toBeDefined();

                    execCommand(`node regtest/regtest.mjs mine 1`);

                    await waitFor(async () => {
                        const status = await alice.wallet.onchainProvider.getTxStatus(completeTxid);
                        return status.confirmed;
                    });

                    await waitFor(async () => {
                        const afterBalance = await onchainAlice.getBalance();
                        return afterBalance > beforeBalance;
                    });
                },
            );

            it("should exit collaboratively", { timeout: 60000 }, async () => {
                const alice = await factory();
                const onchainAlice = await createTestOnchainWallet();
                const aliceOffchainAddress = await alice.wallet.getAddress();

                // faucet offchain address
                const fundAmount = 10_000;
                execCommand(
                    `${arkdExec} ark send --to ${aliceOffchainAddress} --amount ${fundAmount} --password secret`,
                );

                await new Promise((resolve) => setTimeout(resolve, 1000));

                const feeInfo = await alice.wallet.arkProvider.getInfo();

                const exitTxid = await new Ramps(alice.wallet).offboard(
                    onchainAlice.wallet.address,
                    feeInfo.fees,
                );

                expect(exitTxid).toBeDefined();
            });

            it("should settle a recoverable VTXO", { timeout: 60000 }, async () => {
                const alice = await factory();
                const aliceOffchainAddress = await alice.wallet.getAddress();
                const boardingAddress = await alice.wallet.getBoardingAddress();
                expect(aliceOffchainAddress).toBeDefined();

                // faucet
                execCommand(`node regtest/regtest.mjs faucet ${boardingAddress} 0.001 --confirm`);

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
                execCommand(`node regtest/regtest.mjs mine 25`);

                // wait until indexer reflects the swept instead of sleeping.
                await waitFor(async () => {
                    const v = await alice.wallet.getVtxos({
                        withRecoverable: true,
                    });
                    return v.some((c) => c.txid === vtxo.txid && c.virtualStatus.state === "swept");
                });

                // get vtxos including the recoverable ones
                const vtxosAfterSweep = await alice.wallet.getVtxos({
                    withRecoverable: true,
                });

                // assert
                expect(vtxosAfterSweep).toHaveLength(1);
                const vtxoAfterSweep = vtxosAfterSweep[0];
                expect(vtxoAfterSweep.txid).toBe(vtxo.txid);
                expect(vtxoAfterSweep.virtualStatus.state).toBe("swept");
                expect(vtxoAfterSweep.spentBy).toBe("");

                const settleTxid = await alice.wallet.settle({
                    inputs: [vtxoAfterSweep],
                    outputs: [
                        {
                            address: aliceOffchainAddress!,
                            amount: BigInt(100_000),
                        },
                    ],
                });

                expect(settleTxid).toBeDefined();
            });

            it("should be notified of offchain incoming funds", { timeout: 10000 }, async () => {
                const alice = await factory();
                const aliceAddress = await alice.wallet.getAddress();
                expect(aliceAddress).toBeDefined();

                let notified = false;
                const fundAmount = 10000;

                // set up the notification
                alice.wallet.notifyIncomingFunds((notification) => {
                    const now = new Date();
                    expect(notification.type).toBe("vtxo");
                    let newVtxos: VirtualCoin[] = [];
                    if (notification.type === "vtxo") {
                        newVtxos = notification.newVtxos;
                    }
                    expect(newVtxos).toHaveLength(1);
                    expect(newVtxos[0].spentBy).toBeFalsy();
                    expect(newVtxos[0].value).toBe(fundAmount);
                    expect(newVtxos[0].virtualStatus.state).toBe("preconfirmed");
                    const age = now.getTime() - newVtxos[0].createdAt.getTime();
                    expect(age).toBeLessThanOrEqual(4000);
                    notified = true;
                });

                // wait for the notification to be set up
                await new Promise((resolve) => setTimeout(resolve, 1000));

                // fund the offchain address using faucet
                faucetOffchain(aliceAddress!, fundAmount);

                // wait for the transaction to be processed
                await new Promise((resolve) => setTimeout(resolve, 6000));
                expect(notified).toBeTruthy();
            });

            it("should be notified of onchain incoming funds", { timeout: 60000 }, async () => {
                const alice = await factory();
                const aliceBoardingAddress = await alice.wallet.getBoardingAddress();
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
            });

            it("should wait for offchain incoming funds", { timeout: 6000 }, async () => {
                const alice = await factory();
                const aliceAddress = await alice.wallet.getAddress();
                expect(aliceAddress).toBeDefined();

                const now = new Date();
                const fundAmount = 10000;

                // faucet in a few moments
                setTimeout(() => faucetOffchain(aliceAddress!, fundAmount), 1000);

                // wait for coins to arrive
                const notification = await waitForIncomingFunds(alice.wallet);
                let newVtxos: VirtualCoin[] = [];
                if (notification.type === "vtxo") {
                    newVtxos = notification.newVtxos;
                }

                // assert
                expect(newVtxos).toHaveLength(1);
                expect(newVtxos[0].spentBy).toBeFalsy();
                expect(newVtxos[0].value).toBe(fundAmount);
                expect(newVtxos[0].virtualStatus.state).toBe("preconfirmed");
                const age = now.getTime() - newVtxos[0].createdAt.getTime();
                expect(age).toBeLessThanOrEqual(4000);
            });

            it("should wait for onchain incoming funds", { timeout: 60000 }, async () => {
                const alice = await factory();
                const aliceBoardingAddress = await alice.wallet.getBoardingAddress();
                expect(aliceBoardingAddress).toBeDefined();

                const now = new Date();
                const fundAmount = 10000;

                // faucet in a few moments
                setTimeout(() => faucetOnchain(aliceBoardingAddress!, fundAmount), 1000);

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
            });

            it("should send subdust amount", { timeout: 60000 }, async () => {
                const alice = await factory();
                const bob = await factory();

                const aliceOffchainAddress = await alice.wallet.getAddress();
                const bobOffchainAddress = await bob.wallet.getAddress();

                const fundAmount = 10_000;
                execCommand(
                    `${arkdExec} ark send --to ${aliceOffchainAddress} --amount ${fundAmount} --password secret`,
                );

                await new Promise((resolve) => setTimeout(resolve, 1000));

                // alice should send offchain tx with subdust output
                await alice.wallet.send({
                    address: bobOffchainAddress!,
                    amount: 1,
                });

                await new Promise((resolve) => setTimeout(resolve, 1000));

                // bob should have 1 sat in offchain balance
                const bobBalance = await bob.wallet.getBalance();
                expect(bobBalance.total).toBe(1);

                // bob shouldn't be able to send offchain tx with subdust output
                await expect(
                    bob.wallet.send({
                        address: bobOffchainAddress!,
                        amount: 1,
                    }),
                ).rejects.toThrow("Insufficient funds");

                // bob shouldn't be able to settle cause the total amount is less than the dust amount
                await expect(bob.wallet.settle()).rejects.toThrow();

                await alice.wallet.send({
                    address: bobOffchainAddress!,
                    amount: fundAmount - 1,
                });

                await new Promise((resolve) => setTimeout(resolve, 1000));

                // now bob should be able to settle
                await bob.wallet.settle();
            });

            it("should parse ark errors", { timeout: 60000 }, async () => {
                const provider = new RestArkProvider("http://localhost:7070");
                try {
                    await provider.submitTx("invalid", ["invalid"]);
                } catch (error: any) {
                    expect(error).toBeDefined();
                    expect(error).toBeInstanceOf(ArkError);
                    expect(error.message).toContain("INVALID_ARK_PSBT (1)");
                    expect(error.code).toBe(1);
                    expect(error.name).toBe("INVALID_ARK_PSBT");
                    expect(error.metadata).toStrictEqual({ tx: "invalid" });
                }
            });

            it("should register and delete intents", { timeout: 60000 }, async () => {
                const provider = new RestArkProvider("http://localhost:7070");

                // Create fresh wallet instances for this test
                const alice = await factory();
                const bob = await factory();
                expect(alice).toBeDefined();
                expect(bob).toBeDefined();

                // Get addresses
                const bobPubkey = await bob.identity.xOnlyPublicKey();
                const aliceAddress = await alice.wallet.getAddress();
                const bobAddress = await bob.wallet.getAddress();
                expect(aliceAddress).toBeDefined();
                expect(bobAddress).toBeDefined();
                expect(bobPubkey).toBeDefined();

                const fundAmount = 10000;
                execCommand(
                    `${arkdExec} ark send --to ${aliceAddress} --amount ${fundAmount} --password secret`,
                );
                await new Promise((resolve) => setTimeout(resolve, 1000));

                // Check virtual coins after funding
                const virtualCoins = await alice.wallet.getVtxos();
                expect(virtualCoins).toHaveLength(1);
                const vtxo = virtualCoins[0];
                expect(vtxo.txid).toBeDefined();

                const cosignerPubkeys = [hex.encode(bobPubkey)];
                const onchainOutputsIndexes: number[] = [];
                const outputs = [
                    {
                        script: ArkAddress.decode(bobAddress).pkScript,
                        amount: BigInt(5000),
                    },
                ];

                const intent = await alice.wallet.makeRegisterIntentSignature(
                    virtualCoins,
                    outputs,
                    onchainOutputsIndexes,
                    cosignerPubkeys,
                );

                const deleteIntent = await alice.wallet.makeDeleteIntentSignature(virtualCoins);

                // register intent
                const registerResponse = await provider.registerIntent(intent);
                expect(registerResponse).toBeDefined();

                // should fail to register the same intent again
                try {
                    await provider.registerIntent(intent);
                } catch (error: any) {
                    expect(error).toBeDefined();
                    expect(error).toBeInstanceOf(ArkError);
                    expect(error.message).toContain("INTERNAL_ERROR (0)");
                    expect(error.message).toContain("already registered by another intent");
                    expect(error.code).toBe(0);
                    expect(error.name).toBe("INTERNAL_ERROR");
                }

                // delete intent
                await provider.deleteIntent(deleteIntent);
            });

            it("should finalize pending transactions", { timeout: 60000 }, async () => {
                const alice = await factory();
                const aliceOffchainAddress = await alice.wallet.getAddress();
                expect(aliceOffchainAddress).toBeDefined();

                const fundAmount = 21000; // 0.00021 BTC
                faucetOffchain(aliceOffchainAddress!, fundAmount);
                await new Promise((resolve) => setTimeout(resolve, 1000));

                const vtxos = await alice.wallet.getVtxos();
                expect(vtxos.length).toBeGreaterThan(0);
                const vtxo = vtxos[0];

                // should be empty initially
                const { finalized, pending } = await alice.wallet.finalizePendingTxs();
                expect(finalized).toHaveLength(0);
                expect(pending).toHaveLength(0);

                const arkProvider = new RestArkProvider("http://localhost:7070");
                const serverInfo = await arkProvider.getInfo();
                const checkpointTapscript = CSVMultisigTapscript.decode(
                    hex.decode(serverInfo.checkpointTapscript),
                );

                // build an offchain transaction manually
                const { arkTx, checkpoints } = buildOffchainTx(
                    [
                        {
                            ...vtxo,
                            tapLeafScript: vtxo.forfeitTapLeafScript,
                        },
                    ],
                    [
                        {
                            script: alice.wallet.offchainTapscript.pkScript,
                            amount: BigInt(fundAmount),
                        },
                    ],
                    checkpointTapscript,
                );

                const signedArkTx = await alice.identity.sign(arkTx);

                // submit the transaction (but don't finalize it yet - this creates a pending tx)
                const { arkTxid } = await arkProvider.submitTx(
                    base64.encode(signedArkTx.toPSBT()),
                    checkpoints.map((c) => base64.encode(c.toPSBT())),
                );
                expect(arkTxid).toBeDefined();

                await new Promise((resolve) => setTimeout(resolve, 1000));

                let incomingFunds: VirtualCoin[] = [];
                let incomingErr: Error | null = null;
                const incomingFundsPromise = (async () => {
                    try {
                        const result = await waitForIncomingFunds(alice.wallet);
                        if (result.type === "vtxo") {
                            incomingFunds = result.newVtxos;
                        }
                    } catch (err) {
                        incomingErr = err as Error;
                    }
                })();

                // Set the pending tx flag (normally set by buildAndSubmitOffchainTx)
                // so finalizePendingTxs doesn't early-exit.
                await alice.wallet.walletRepository.saveWalletState({
                    settings: { hasPendingTx: true },
                });

                const res = await alice.wallet.finalizePendingTxs();
                expect(res.finalized).toHaveLength(1);
                expect(res.finalized[0]).toBe(arkTxid);
                expect(res.pending).toHaveLength(1);
                expect(res.pending[0]).toBe(arkTxid);

                await incomingFundsPromise;

                expect(incomingErr).toBeNull();
                expect(incomingFunds).toHaveLength(1);
                expect(incomingFunds[0].txid).toBe(arkTxid);
            });

            it("Ramps should handle fees", { timeout: 60000 }, async () => {
                const alice = await factory();

                const boardingAddress = await alice.wallet.getBoardingAddress();

                // faucet 100_000 sats
                execCommand(`node regtest/regtest.mjs faucet ${boardingAddress} 0.001 --confirm`);

                await waitFor(async () => (await alice.wallet.getBoardingUtxos()).length > 0);

                try {
                    setFees({ onchainInput: "1000.0" });

                    const { fees } = await alice.wallet.arkProvider.getInfo();

                    expect(fees.intentFee.onchainInput).toBe("1000.0");

                    const settleTxid = await new Ramps(alice.wallet).onboard(fees);
                    expect(settleTxid).toBeDefined();

                    const vtxos = await alice.wallet.getVtxos();
                    expect(vtxos).toHaveLength(1);
                    const vtxo = vtxos[0];
                    expect(vtxo.value).toBe(100000 - 1000);
                } finally {
                    clearFees();
                }
            });
        });
    }
});

describe("Delegate", () => {
    beforeEach(beforeEachFaucet, 20000);

    it("should delegate renewal of vtxos", { timeout: 60000 }, async () => {
        const alice = await createTestArkWalletWithDelegate();
        const boardingAddress = await alice.wallet.getBoardingAddress();
        execCommand(`node regtest/regtest.mjs faucet ${boardingAddress} 0.001 --confirm`);
        await new Promise((resolve) => setTimeout(resolve, 5000));

        await alice.wallet.settle();

        let vtxos = await alice.wallet.getVtxos();
        expect(vtxos).toHaveLength(1);
        const vtxoBeforeDelegate = vtxos[0];
        expect(vtxoBeforeDelegate.txid).toBeDefined();

        const delegateManager = await alice.wallet.getDelegateManager();
        await delegateManager?.delegate(
            [vtxoBeforeDelegate],
            await alice.wallet.getAddress(),
            new Date(Date.now() + 1000),
        );

        // wait for the delegate to be completed
        await new Promise((resolve) => setTimeout(resolve, 20_000));

        vtxos = await alice.wallet.getVtxos();
        expect(vtxos).toHaveLength(1);

        const vtxoAfterDelegate = vtxos[0];
        expect(vtxoAfterDelegate.txid).not.toBe(vtxoBeforeDelegate.txid);
        expect(vtxoAfterDelegate.value).toBe(vtxoBeforeDelegate.value);
    });
});

describe("Delegate Lifecycle", () => {
    beforeEach(beforeEachFaucet, 20000);

    it(
        "should track and spend VTXOs across delegate add/remove ",
        { timeout: 120000 },
        async () => {
            const walletRepository = new InMemoryWalletRepository();
            const contractRepository = new InMemoryContractRepository();
            const identity = createTestIdentity();

            const onchainProvider = new EsploraProvider("http://localhost:3000/api", {
                forcePolling: true,
                pollingInterval: 2000,
            });

            // Phase 1 — No delegate
            const wallet1 = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider,
                storage: { walletRepository, contractRepository },
                settlementConfig: false,
            });

            const addressA = await wallet1.getAddress();
            await wallet1.getContractManager();

            faucetOffchain(addressA, 10_000);
            await waitFor(async () => (await wallet1.getVtxos()).length > 0);

            const balance1 = await wallet1.getBalance();
            expect(balance1.total).toBeGreaterThanOrEqual(10_000);

            // Phase 2 — Add delegate
            const wallet2 = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider,
                storage: { walletRepository, contractRepository },
                delegateProvider: new RestDelegateProvider("http://localhost:7012"),
                settlementConfig: false,
            });

            const addressB = await wallet2.getAddress();
            expect(addressB).not.toBe(addressA);

            const manager2 = await wallet2.getContractManager();

            // Both contracts should be registered (default from phase 1 + delegate)
            const contracts2 = await manager2.getContracts({
                type: ["default", "delegate"],
            });
            expect(contracts2).toHaveLength(2);

            faucetOffchain(addressB, 10_000);
            await waitFor(async () => (await wallet2.getVtxos()).length >= 2);

            // VTXOs from both addresses should be visible
            const vtxos2 = await wallet2.getVtxos();
            expect(vtxos2.length).toBeGreaterThanOrEqual(2);

            // Create a bob wallet to receive funds
            const bob = await createTestArkWallet();
            const bobAddress = await bob.wallet.getAddress();

            // Capture delegate VTXOs before sending
            const contractsBefore = await manager2.getContractsWithVtxos({
                type: ["delegate"],
            });
            expect(contractsBefore).toHaveLength(1);
            const delegateVtxosBefore = contractsBefore[0].vtxos;
            expect(delegateVtxosBefore.length).toBeGreaterThan(0);

            // Sum all individual VTXO values to find the max single VTXO
            const allVtxos2 = await wallet2.getVtxos();
            const maxSingleVtxo = Math.max(...allVtxos2.map((v) => v.value));

            // Send more than any single VTXO so both pools must be consumed
            const sendAmount = maxSingleVtxo + 1_000;
            const txid2 = await wallet2.send({
                address: bobAddress,
                amount: sendAmount,
            });
            expect(txid2).toBeDefined();

            // Verify delegate VTXOs were spent
            const contractsAfter = await manager2.getContractsWithVtxos({
                type: ["delegate"],
            });
            const delegateVtxosAfter = contractsAfter[0].vtxos.filter((v) => !v.isSpent);
            const spentDelegateOutpoints = delegateVtxosBefore.filter(
                (before) =>
                    !delegateVtxosAfter.some(
                        (after) => after.txid === before.txid && after.vout === before.vout,
                    ),
            );
            expect(spentDelegateOutpoints.length).toBeGreaterThan(0);

            // Phase 3 — Remove delegate
            const wallet3 = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider,
                storage: { walletRepository, contractRepository },
                settlementConfig: false,
            });

            const manager3 = await wallet3.getContractManager();

            // Both contracts still persisted
            const contracts3 = await manager3.getContracts();
            expect(contracts3.length).toBeGreaterThanOrEqual(2);

            faucetOffchain(addressA, 10_000);
            faucetOffchain(addressB, 10_000);
            await waitFor(async () => (await wallet3.getVtxos()).length >= 2);

            const vtxos3 = await wallet3.getVtxos();
            expect(vtxos3.length).toBeGreaterThanOrEqual(2);

            // Capture delegate VTXOs before spending (forfeit path)
            const contracts3Before = await manager3.getContractsWithVtxos({
                type: ["delegate"],
            });
            expect(contracts3Before).toHaveLength(1);
            const delegateVtxos3Before = contracts3Before[0].vtxos;
            expect(delegateVtxos3Before.length).toBeGreaterThan(0);

            // Send more than any single VTXO so delegate pool must be consumed
            const allVtxos3 = await wallet3.getVtxos();
            const maxSingleVtxo3 = Math.max(...allVtxos3.map((v) => v.value));
            const sendAmount3 = maxSingleVtxo3 + 1_000;

            // Spending still works — delegate VTXOs use forfeit path (Alice + Server)
            const txid3 = await wallet3.send({
                address: bobAddress,
                amount: sendAmount3,
            });
            expect(txid3).toBeDefined();

            // Verify delegate VTXOs were consumed via forfeit path
            const contracts3After = await manager3.getContractsWithVtxos({
                type: ["delegate"],
            });
            const delegateVtxos3After = contracts3After[0].vtxos.filter((v) => !v.isSpent);
            const spentDelegate3 = delegateVtxos3Before.filter(
                (before) =>
                    !delegateVtxos3After.some(
                        (after) => after.txid === before.txid && after.vout === before.vout,
                    ),
            );
            expect(spentDelegate3.length).toBeGreaterThan(0);
        },
    );
});

describe("Cross-contract spending", () => {
    beforeEach(beforeEachFaucet, 20000);

    it(
        "should spend VTXOs from both default and delegate contracts in a single send",
        { timeout: 120000 },
        async () => {
            const walletRepository = new InMemoryWalletRepository();
            const contractRepository = new InMemoryContractRepository();
            const identity = createTestIdentity();

            const onchainProvider = new EsploraProvider("http://localhost:3000/api", {
                forcePolling: true,
                pollingInterval: 2000,
            });

            // Step 1 — No delegate: receive 1000 to default address
            const wallet1 = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider,
                storage: { walletRepository, contractRepository },
                settlementConfig: false,
            });

            const defaultAddress = await wallet1.getAddress();
            await wallet1.getContractManager();

            faucetOffchain(defaultAddress, 1_000);
            await waitFor(async () => (await wallet1.getVtxos()).length > 0);

            const balance1 = await wallet1.getBalance();
            expect(balance1.total).toBeGreaterThanOrEqual(1_000);

            // Step 2 — Enable delegate: receive 1000 to delegate address
            const wallet2 = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider,
                storage: { walletRepository, contractRepository },
                delegateProvider: new RestDelegateProvider("http://localhost:7012"),
                settlementConfig: false,
            });

            const delegateAddress = await wallet2.getAddress();
            expect(delegateAddress).not.toBe(defaultAddress);

            const manager = await wallet2.getContractManager();

            // Both contracts registered (default from step 1 + delegate)
            const contracts = await manager.getContracts({
                type: ["default", "delegate"],
            });
            expect(contracts).toHaveLength(2);

            faucetOffchain(delegateAddress, 1_000);
            await waitFor(async () => (await wallet2.getVtxos()).length >= 2);

            // Wallet should see VTXOs from both contracts
            const allVtxos = await wallet2.getVtxos();
            expect(allVtxos).toHaveLength(2);
            const totalBalance = allVtxos.reduce((sum, v) => sum + v.value, 0);
            // Each VTXO ≈ 1000 (delegate VTXO may be slightly less due to fee)
            expect(totalBalance).toBeGreaterThanOrEqual(1_500);

            // Snapshot delegate VTXOs before sending
            const contractsBefore = await manager.getContractsWithVtxos({
                type: ["delegate"],
            });
            const delegateVtxosBefore = contractsBefore[0].vtxos;
            expect(delegateVtxosBefore.length).toBeGreaterThan(0);

            // Step 3 — Spend 1500: exceeds any single VTXO, forces both pools
            const bob = await createTestArkWallet();
            const bobAddress = await bob.wallet.getAddress();

            const maxSingleVtxo = Math.max(...allVtxos.map((v) => v.value));
            // Send more than any single VTXO can cover
            const sendAmount = maxSingleVtxo + 100;

            const txid = await wallet2.send({
                address: bobAddress,
                amount: sendAmount,
            });
            expect(txid).toBeDefined();

            // Verify delegate VTXOs were consumed
            const contractsAfter = await manager.getContractsWithVtxos({
                type: ["delegate"],
            });
            const delegateVtxosAfterUnspent = contractsAfter[0].vtxos.filter((v) => !v.isSpent);
            const spentDelegateVtxos = delegateVtxosBefore.filter(
                (before) =>
                    !delegateVtxosAfterUnspent.some(
                        (after) => after.txid === before.txid && after.vout === before.vout,
                    ),
            );
            expect(spentDelegateVtxos.length).toBeGreaterThan(0);

            // Step 4 — Verify change landed on the delegate address
            await waitFor(async () => {
                const vtxos = await wallet2.getVtxos();
                return vtxos.some((v) => !v.isSpent);
            });

            const vtxosAfter = await wallet2.getVtxos();
            const changeVtxos = vtxosAfter.filter((v) => !v.isSpent);
            // Change should exist (totalBalance - sendAmount > 0)
            expect(changeVtxos.length).toBeGreaterThan(0);

            // The change VTXO should be on the delegate contract
            // (the current address since delegate is active)
            const delegateContractAfter = await manager.getContractsWithVtxos({
                type: ["delegate"],
            });
            const delegateUnspentAfter = delegateContractAfter[0].vtxos.filter((v) => !v.isSpent);
            // At least one unspent VTXO on delegate = the change output
            expect(delegateUnspentAfter.length).toBeGreaterThan(0);
        },
    );

    it(
        "should spend VTXOs from both default and delegate contracts in a single send, funded after delegation",
        { timeout: 120000 },
        async () => {
            const walletRepository = new InMemoryWalletRepository();
            const contractRepository = new InMemoryContractRepository();
            const identity = createTestIdentity();

            const onchainProvider = new EsploraProvider("http://localhost:3000/api", {
                forcePolling: true,
                pollingInterval: 2000,
            });

            // Step 1 — No delegate: receive 1000 to default address
            const wallet1 = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider,
                storage: { walletRepository, contractRepository },
                settlementConfig: false,
            });

            const defaultAddress = await wallet1.getAddress();
            await wallet1.getContractManager();

            // Step 2 — Enable delegate: receive 1000 to delegate address
            const wallet2 = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider,
                storage: { walletRepository, contractRepository },
                delegateProvider: new RestDelegateProvider("http://localhost:7012"),
                settlementConfig: false,
            });

            faucetOffchain(defaultAddress, 1_000);
            await waitFor(async () => (await wallet1.getVtxos()).length > 0);

            const balance1 = await wallet1.getBalance();
            expect(balance1.total).toBeGreaterThanOrEqual(1_000);

            const delegateAddress = await wallet2.getAddress();
            expect(delegateAddress).not.toBe(defaultAddress);

            const manager = await wallet2.getContractManager();

            // Both contracts registered (default from step 1 + delegate)
            const contracts = await manager.getContracts({
                type: ["default", "delegate"],
            });
            expect(contracts).toHaveLength(2);

            faucetOffchain(delegateAddress, 1_000);
            await waitFor(async () => (await wallet2.getVtxos()).length >= 2);

            // Wallet should see VTXOs from both contracts
            const allVtxos = await wallet2.getVtxos();
            expect(allVtxos).toHaveLength(2);
            const totalBalance = allVtxos.reduce((sum, v) => sum + v.value, 0);
            // Each VTXO ≈ 1000 (delegate VTXO may be slightly less due to fee)
            expect(totalBalance).toBeGreaterThanOrEqual(1_500);

            // Snapshot delegate VTXOs before sending
            const contractsBefore = await manager.getContractsWithVtxos({
                type: ["delegate"],
            });
            const delegateVtxosBefore = contractsBefore[0].vtxos;
            expect(delegateVtxosBefore.length).toBeGreaterThan(0);

            // Step 3 — Spend 1500: exceeds any single VTXO, forces both pools
            const bob = await createTestArkWallet();
            const bobAddress = await bob.wallet.getAddress();

            const maxSingleVtxo = Math.max(...allVtxos.map((v) => v.value));
            // Send more than any single VTXO can cover
            const sendAmount = maxSingleVtxo + 100;

            const txid = await wallet2.send({
                address: bobAddress,
                amount: sendAmount,
            });
            expect(txid).toBeDefined();

            // Verify delegate VTXOs were consumed
            const contractsAfter = await manager.getContractsWithVtxos({
                type: ["delegate"],
            });
            const delegateVtxosAfterUnspent = contractsAfter[0].vtxos.filter((v) => !v.isSpent);
            const spentDelegateVtxos = delegateVtxosBefore.filter(
                (before) =>
                    !delegateVtxosAfterUnspent.some(
                        (after) => after.txid === before.txid && after.vout === before.vout,
                    ),
            );
            expect(spentDelegateVtxos.length).toBeGreaterThan(0);

            // Step 4 — Verify change landed on the delegate address
            await waitFor(async () => {
                const vtxos = await wallet2.getVtxos();
                return vtxos.some((v) => !v.isSpent);
            });

            const vtxosAfter = await wallet2.getVtxos();
            const changeVtxos = vtxosAfter.filter((v) => !v.isSpent);
            // Change should exist (totalBalance - sendAmount > 0)
            expect(changeVtxos.length).toBeGreaterThan(0);

            // The change VTXO should be on the delegate contract
            // (the current address since delegate is active)
            const delegateContractAfter = await manager.getContractsWithVtxos({
                type: ["delegate"],
            });
            const delegateUnspentAfter = delegateContractAfter[0].vtxos.filter((v) => !v.isSpent);
            // At least one unspent VTXO on delegate = the change output
            expect(delegateUnspentAfter.length).toBeGreaterThan(0);
        },
    );
});

describe("Asset integration tests", () => {
    beforeEach(beforeEachFaucet, 20000);

    it("collaborative exit", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const aliceAddress = await alice.wallet.getAddress();

        const fundAmount = 20_000;
        faucetOffchain(aliceAddress!, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // alice issues an asset
        const issueAmount = 500n;
        const issueResult = await alice.wallet.assetManager.issue({
            amount: issueAmount,
        });

        await new Promise((resolve) => setTimeout(resolve, 1000));

        const vtxosBefore = await alice.wallet.getVtxos();
        expect(vtxosBefore.length).toBeGreaterThan(0);
        const assetVtxo = vtxosBefore.find((v) =>
            v.assets?.some((a) => a.assetId === issueResult.assetId),
        );
        expect(assetVtxo).toBeDefined();

        const exitAmount = 5000;
        // settle with explicit inputs/outputs (includes asset packet)
        const totalValue = vtxosBefore.reduce((sum, v) => sum + v.value, 0);

        const settleTxid = await alice.wallet.settle({
            inputs: vtxosBefore,
            outputs: [
                {
                    address: aliceAddress!,
                    amount: BigInt(totalValue - exitAmount),
                },
                {
                    address: "bcrt1q7dn55unudcpmu3hg05rj9u2cn4m0r2yr0de3f6",
                    amount: BigInt(exitAmount),
                },
            ],
        });

        expect(settleTxid).toBeDefined();

        execCommand("node regtest/regtest.mjs mine 1");
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // verify the asset is still present on the settled vtxos
        const vtxosAfter = await alice.wallet.getVtxos();
        expect(vtxosAfter.length).toBeGreaterThan(0);

        const allAssets = vtxosAfter.flatMap((v) => v.assets ?? []);
        const assetTotal = allAssets
            .filter((a) => a.assetId === issueResult.assetId)
            .reduce((s, a) => s + a.amount, 0n);
        expect(assetTotal).toBe(issueAmount);
    });

    it("should issue an asset without control asset", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const aliceAddress = await alice.wallet.getAddress();

        // fund alice offchain
        const fundAmount = 10_000;
        faucetOffchain(aliceAddress!, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // issue an asset
        const amount = 1000n;
        const result = await alice.wallet.assetManager.issue({ amount });

        expect(result.arkTxId).toBeDefined();
        expect(result.assetId).toBeDefined();

        await new Promise((resolve) => setTimeout(resolve, 3000));

        // verify the asset appears on a vtxo
        const vtxos = await alice.wallet.getVtxos();
        expect(vtxos.length).toBeGreaterThan(0);

        const assetVtxo = vtxos.find((v) => v.assets?.some((a) => a.assetId === result.assetId));
        expect(assetVtxo).toBeDefined();

        const asset = assetVtxo!.assets!.find((a) => a.assetId === result.assetId);
        expect(asset!.amount).toBe(amount);
    });

    it("should issue an asset with existing control asset", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const aliceAddress = await alice.wallet.getAddress();

        const fundAmount = 10_000;
        faucetOffchain(aliceAddress!, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // first issuance to create a control asset
        const firstIssueResult = await alice.wallet.assetManager.issue({
            amount: 1n,
        });

        // Wait for round completion so change VTXO is indexed
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // second issuance to create a new asset using the control asset
        const secondIssueResult = await alice.wallet.assetManager.issue({
            amount: 500n,
            controlAssetId: firstIssueResult.assetId,
        });

        expect(secondIssueResult.arkTxId).toBeDefined();
        expect(secondIssueResult.assetId).toBeDefined();

        await new Promise((resolve) => setTimeout(resolve, 1000));

        // verify both the issued asset and control asset appear
        const vtxos = await alice.wallet.getVtxos();
        expect(vtxos.length).toBeGreaterThan(0);

        const allAssets = vtxos.flatMap((v) => v.assets ?? []);
        const issuedAsset = allAssets.find((a) => a.assetId === secondIssueResult.assetId);
        expect(issuedAsset).toBeDefined();
        expect(issuedAsset!.amount).toBe(500n);

        const controlAsset = allAssets.find((a) => a.assetId === firstIssueResult.assetId);
        expect(controlAsset).toBeDefined();
        expect(controlAsset!.amount).toBe(1n);
    });

    it("should issue an asset with metadata", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const aliceAddress = await alice.wallet.getAddress();

        const fundAmount = 10_000;
        faucetOffchain(aliceAddress!, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        const metadata = {
            decimals: 2,
            name: "Test Asset",
            ticker: "TA",
            icon: "https://example.com/icon.png",
        };

        const issueResult = await alice.wallet.assetManager.issue({
            amount: 1000n,
            metadata,
        });

        expect(issueResult.arkTxId).toBeDefined();
        expect(issueResult.assetId).toBeDefined();

        await new Promise((resolve) => setTimeout(resolve, 1000));

        const assetDetails = await alice.wallet.assetManager.getAssetDetails(issueResult.assetId);
        expect(assetDetails.metadata).toBeDefined();
        expect(assetDetails.metadata).toEqual(metadata);
    });

    it("should reissue an asset", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const aliceAddress = await alice.wallet.getAddress();

        const fundAmount = 20_000;
        faucetOffchain(aliceAddress!, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // first issuance to create a control asset
        const firstIssueResult = await alice.wallet.assetManager.issue({
            amount: 1n,
        });

        // Wait for round completion so change VTXO is indexed
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // second issuance to create a new asset using the control asset
        const secondIssueResult = await alice.wallet.assetManager.issue({
            amount: 500n,
            controlAssetId: firstIssueResult.assetId,
        });

        // Wait for round completion before reissue
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // reissue more units
        const reissueAmount = 300n;
        const reissueTxid = await alice.wallet.assetManager.reissue({
            assetId: secondIssueResult.assetId,
            amount: reissueAmount,
        });

        expect(reissueTxid).toBeDefined();
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // verify total asset amount is issueAmount + reissueAmount
        const vtxos = await alice.wallet.getVtxos();
        const allAssets = vtxos.flatMap((v) => v.assets ?? []);

        const totalAssetAmount = allAssets
            .filter((a) => a.assetId === secondIssueResult.assetId)
            .reduce((s, a) => s + a.amount, 0n);
        expect(totalAssetAmount).toBe(500n + reissueAmount);

        // control asset should still exist
        const controlAsset = allAssets.find((a) => a.assetId === firstIssueResult.assetId);
        expect(controlAsset).toBeDefined();
    });

    it("should burn an asset partially", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const aliceAddress = await alice.wallet.getAddress();

        const fundAmount = 20_000;
        faucetOffchain(aliceAddress!, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // issue an asset
        const issueAmount = 1000n;
        const issueResult = await alice.wallet.assetManager.issue({
            amount: issueAmount,
        });

        await new Promise((resolve) => setTimeout(resolve, 1000));

        // burn half
        const burnAmount = 400n;
        const burnTxid = await alice.wallet.assetManager.burn({
            assetId: issueResult.assetId,
            amount: burnAmount,
        });

        expect(burnTxid).toBeDefined();
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // verify remaining amount
        const vtxos = await alice.wallet.getVtxos();
        const allAssets = vtxos.flatMap((v) => v.assets ?? []);
        const remaining = allAssets
            .filter((a) => a.assetId === issueResult.assetId)
            .reduce((s, a) => s + a.amount, 0n);
        expect(remaining).toBe(issueAmount - burnAmount);
    });

    it("should burn an asset completely", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const aliceAddress = await alice.wallet.getAddress();

        const fundAmount = 20_000;
        faucetOffchain(aliceAddress!, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // issue an asset
        const issueAmount = 500n;
        const issueResult = await alice.wallet.assetManager.issue({
            amount: issueAmount,
        });

        await new Promise((resolve) => setTimeout(resolve, 1000));

        // burn all
        const burnTxid = await alice.wallet.assetManager.burn({
            assetId: issueResult.assetId,
            amount: issueAmount,
        });

        expect(burnTxid).toBeDefined();
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // verify asset is gone
        const vtxos = await alice.wallet.getVtxos();
        const allAssets = vtxos.flatMap((v) => v.assets ?? []);
        const remaining = allAssets.filter((a) => a.assetId === issueResult.assetId);
        expect(remaining).toHaveLength(0);
    });

    it("should send an asset to another wallet", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const bob = await createTestArkWallet();

        const aliceAddress = await alice.wallet.getAddress();
        const bobAddress = await bob.wallet.getAddress();

        const fundAmount = 20_000;
        faucetOffchain(aliceAddress!, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // alice issues an asset
        const issueAmount = 1000n;
        const issueResult = await alice.wallet.assetManager.issue({
            amount: issueAmount,
        });

        await new Promise((resolve) => setTimeout(resolve, 1000));

        // alice sends some asset to bob
        const sendAmount = 400n;
        const sendTxid = await alice.wallet.send({
            address: bobAddress!,
            amount: 0,
            assets: [{ assetId: issueResult.assetId, amount: sendAmount }],
        });

        expect(sendTxid).toBeDefined();
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // verify bob received the asset
        const bobVtxos = await bob.wallet.getVtxos();
        const bobAssets = bobVtxos.flatMap((v) => v.assets ?? []);
        const bobAsset = bobAssets.find((a) => a.assetId === issueResult.assetId);
        expect(bobAsset).toBeDefined();
        expect(bobAsset!.amount).toBe(sendAmount);

        // verify alice has the remaining asset as change
        const aliceVtxos = await alice.wallet.getVtxos();
        const aliceAssets = aliceVtxos.flatMap((v) => v.assets ?? []);
        const aliceRemaining = aliceAssets
            .filter((a) => a.assetId === issueResult.assetId)
            .reduce((s, a) => s + a.amount, 0n);
        expect(aliceRemaining).toBe(issueAmount - sendAmount);
    });

    it("should send all units of an asset", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const bob = await createTestArkWallet();

        const aliceAddress = await alice.wallet.getAddress();
        const bobAddress = await bob.wallet.getAddress();

        const fundAmount = 20_000;
        faucetOffchain(aliceAddress!, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // alice issues an asset
        const issueAmount = 500n;
        const issueResult = await alice.wallet.assetManager.issue({
            amount: issueAmount,
        });

        await new Promise((resolve) => setTimeout(resolve, 1000));

        // alice sends all units to bob
        const sendTxid = await alice.wallet.send({
            address: bobAddress!,
            amount: 0,
            assets: [{ assetId: issueResult.assetId, amount: issueAmount }],
        });

        expect(sendTxid).toBeDefined();
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // verify bob has all the asset
        const bobVtxos = await bob.wallet.getVtxos();
        const bobAssets = bobVtxos.flatMap((v) => v.assets ?? []);
        const bobTotal = bobAssets
            .filter((a) => a.assetId === issueResult.assetId)
            .reduce((s, a) => s + a.amount, 0n);
        expect(bobTotal).toBe(issueAmount);

        // verify alice has no more of this asset
        const aliceVtxos = await alice.wallet.getVtxos();
        const aliceAssets = aliceVtxos.flatMap((v) => v.assets ?? []);
        const aliceTotal = aliceAssets
            .filter((a) => a.assetId === issueResult.assetId)
            .reduce((s, a) => s + a.amount, 0n);
        expect(aliceTotal).toBe(0n);
    });

    it("should settle VTXOs with assets", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const aliceAddress = await alice.wallet.getAddress();

        const fundAmount = 20_000;
        faucetOffchain(aliceAddress!, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // alice issues an asset
        const issueAmount = 500n;
        const issueResult = await alice.wallet.assetManager.issue({
            amount: issueAmount,
        });

        await new Promise((resolve) => setTimeout(resolve, 1000));

        const vtxosBefore = await alice.wallet.getVtxos();
        expect(vtxosBefore.length).toBeGreaterThan(0);
        const assetVtxo = vtxosBefore.find((v) =>
            v.assets?.some((a) => a.assetId === issueResult.assetId),
        );
        expect(assetVtxo).toBeDefined();

        // settle with explicit inputs/outputs (includes asset packet)
        const totalValue = vtxosBefore.reduce((sum, v) => sum + v.value, 0);
        const settleTxid = await alice.wallet.settle({
            inputs: vtxosBefore,
            outputs: [
                {
                    address: aliceAddress!,
                    amount: BigInt(totalValue),
                },
            ],
        });

        expect(settleTxid).toBeDefined();

        execCommand("node regtest/regtest.mjs mine 1");
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // verify the asset is still present on the settled vtxos
        const vtxosAfter = await alice.wallet.getVtxos();
        expect(vtxosAfter.length).toBeGreaterThan(0);

        const allAssets = vtxosAfter.flatMap((v) => v.assets ?? []);
        const assetTotal = allAssets
            .filter((a) => a.assetId === issueResult.assetId)
            .reduce((s, a) => s + a.amount, 0n);
        expect(assetTotal).toBe(issueAmount);
    });

    it(
        "should track and spend VTXOs with assets across delegate add/remove",
        { timeout: 120000 },
        async () => {
            const walletRepository = new InMemoryWalletRepository();
            const contractRepository = new InMemoryContractRepository();
            const identity = createTestIdentity();

            const onchainProvider = new EsploraProvider("http://localhost:3000/api", {
                forcePolling: true,
                pollingInterval: 2000,
            });

            // Phase 1 — No delegate: fund and issue asset on default address
            const wallet1 = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider,
                storage: { walletRepository, contractRepository },
                settlementConfig: false,
            });

            const addressA = await wallet1.getAddress();
            await wallet1.getContractManager();

            faucetOffchain(addressA, 10_000);
            await waitFor(async () => (await wallet1.getVtxos()).length > 0);

            const issueResult1 = await wallet1.assetManager.issue({
                amount: 100n,
            });
            expect(issueResult1.assetId).toBeDefined();
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Phase 2 — Add delegate: fund and issue asset on delegate address
            const wallet2 = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider,
                storage: { walletRepository, contractRepository },
                delegateProvider: new RestDelegateProvider("http://localhost:7012"),
                settlementConfig: false,
            });

            const addressB = await wallet2.getAddress();
            expect(addressB).not.toBe(addressA);

            const manager2 = await wallet2.getContractManager();

            const contracts2 = await manager2.getContracts({
                type: ["default", "delegate"],
            });
            expect(contracts2).toHaveLength(2);

            faucetOffchain(addressB, 10_000);
            await waitFor(async () => (await wallet2.getVtxos()).length >= 2);

            const issueResult2 = await wallet2.assetManager.issue({
                amount: 200n,
            });
            expect(issueResult2.assetId).toBeDefined();
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Send assets to bob, forcing both VTXO pools to be consumed
            const bob = await createTestArkWallet();
            const bobAddress = await bob.wallet.getAddress();

            const allVtxos2 = await wallet2.getVtxos();
            const maxSingleVtxo = Math.max(...allVtxos2.map((v) => v.value));
            const sendAmount = maxSingleVtxo + 1_000;

            const txid2 = await wallet2.send({
                address: bobAddress,
                amount: sendAmount,
                assets: [
                    { assetId: issueResult1.assetId, amount: 50n },
                    { assetId: issueResult2.assetId, amount: 100n },
                ],
            });
            expect(txid2).toBeDefined();
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Verify bob received the assets
            const bobVtxos = await bob.wallet.getVtxos();
            const bobAssets = bobVtxos.flatMap((v) => v.assets ?? []);
            const bobAsset1 = bobAssets.find((a) => a.assetId === issueResult1.assetId);
            expect(bobAsset1).toBeDefined();
            expect(bobAsset1!.amount).toBe(50n);
            const bobAsset2 = bobAssets.find((a) => a.assetId === issueResult2.assetId);
            expect(bobAsset2).toBeDefined();
            expect(bobAsset2!.amount).toBe(100n);

            // Verify alice has remaining assets as change
            const aliceVtxos2 = await wallet2.getVtxos();
            const aliceAssets2 = aliceVtxos2.flatMap((v) => v.assets ?? []);
            const aliceRemaining1 = aliceAssets2
                .filter((a) => a.assetId === issueResult1.assetId)
                .reduce((s, a) => s + a.amount, 0n);
            expect(aliceRemaining1).toBe(50n);
            const aliceRemaining2 = aliceAssets2
                .filter((a) => a.assetId === issueResult2.assetId)
                .reduce((s, a) => s + a.amount, 0n);
            expect(aliceRemaining2).toBe(100n);

            // Phase 3 — Remove delegate: spend via forfeit path with assets
            const wallet3 = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider,
                storage: { walletRepository, contractRepository },
                settlementConfig: false,
            });

            const manager3 = await wallet3.getContractManager();

            const contracts3 = await manager3.getContracts();
            expect(contracts3.length).toBeGreaterThanOrEqual(2);

            faucetOffchain(addressA, 10_000);
            faucetOffchain(addressB, 10_000);
            await waitFor(async () => (await wallet3.getVtxos()).length >= 2);

            const issueResult3 = await wallet3.assetManager.issue({
                amount: 300n,
            });
            expect(issueResult3.assetId).toBeDefined();
            await new Promise((resolve) => setTimeout(resolve, 1000));

            const allVtxos3 = await wallet3.getVtxos();
            const maxSingleVtxo3 = Math.max(...allVtxos3.map((v) => v.value));
            const sendAmount3 = maxSingleVtxo3 + 1_000;

            // Spending works via forfeit path — assets should be preserved
            const txid3 = await wallet3.send({
                address: bobAddress,
                amount: sendAmount3,
                assets: [{ assetId: issueResult3.assetId, amount: 150n }],
            });
            expect(txid3).toBeDefined();
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Verify bob received the asset from phase 3
            const bobVtxos3 = await bob.wallet.getVtxos();
            const bobAssets3 = bobVtxos3.flatMap((v) => v.assets ?? []);
            const bobAsset3 = bobAssets3.find((a) => a.assetId === issueResult3.assetId);
            expect(bobAsset3).toBeDefined();
            expect(bobAsset3!.amount).toBe(150n);
        },
    );

    it(
        "should spend VTXOs with assets from both default and delegate contracts in a single send",
        { timeout: 120000 },
        async () => {
            const walletRepository = new InMemoryWalletRepository();
            const contractRepository = new InMemoryContractRepository();
            const identity = createTestIdentity();

            const onchainProvider = new EsploraProvider("http://localhost:3000/api", {
                forcePolling: true,
                pollingInterval: 2000,
            });

            // Step 1 — No delegate: fund default address and issue asset
            const wallet1 = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider,
                storage: { walletRepository, contractRepository },
                settlementConfig: false,
            });

            const defaultAddress = await wallet1.getAddress();
            await wallet1.getContractManager();

            faucetOffchain(defaultAddress, 1_000);
            await waitFor(async () => (await wallet1.getVtxos()).length > 0);

            const issueResult = await wallet1.assetManager.issue({
                amount: 500n,
            });
            expect(issueResult.assetId).toBeDefined();
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Step 2 — Enable delegate: fund delegate address
            const wallet2 = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider,
                storage: { walletRepository, contractRepository },
                delegateProvider: new RestDelegateProvider("http://localhost:7012"),
                settlementConfig: false,
            });

            const delegateAddress = await wallet2.getAddress();
            expect(delegateAddress).not.toBe(defaultAddress);

            const manager = await wallet2.getContractManager();

            const contracts = await manager.getContracts({
                type: ["default", "delegate"],
            });
            expect(contracts).toHaveLength(2);

            faucetOffchain(delegateAddress, 1_000);
            await waitFor(async () => (await wallet2.getVtxos()).length >= 2);

            // Step 3 — Send requiring both pools, including the asset
            const bob = await createTestArkWallet();
            const bobAddress = await bob.wallet.getAddress();

            const allVtxos = await wallet2.getVtxos();
            const maxSingleVtxo = Math.max(...allVtxos.map((v) => v.value));
            const sendAmount = maxSingleVtxo + 100;

            const txid = await wallet2.send({
                address: bobAddress,
                amount: sendAmount,
                assets: [{ assetId: issueResult.assetId, amount: 200n }],
            });
            expect(txid).toBeDefined();
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Verify bob received the asset
            const bobVtxos = await bob.wallet.getVtxos();
            const bobAssets = bobVtxos.flatMap((v) => v.assets ?? []);
            const bobAsset = bobAssets.find((a) => a.assetId === issueResult.assetId);
            expect(bobAsset).toBeDefined();
            expect(bobAsset!.amount).toBe(200n);

            // Verify change has remaining asset on delegate contract
            await waitFor(async () => {
                const vtxos = await wallet2.getVtxos();
                return vtxos.some((v) => !v.isSpent);
            });

            const vtxosAfter = await wallet2.getVtxos();
            const aliceAssets = vtxosAfter.flatMap((v) => v.assets ?? []);
            const aliceRemaining = aliceAssets
                .filter((a) => a.assetId === issueResult.assetId)
                .reduce((s, a) => s + a.amount, 0n);
            expect(aliceRemaining).toBe(300n);

            // Change should land on delegate contract
            const delegateContractAfter = await manager.getContractsWithVtxos({
                type: ["delegate"],
            });
            const delegateUnspent = delegateContractAfter[0].vtxos.filter((v) => !v.isSpent);
            expect(delegateUnspent.length).toBeGreaterThan(0);
        },
    );

    it(
        "should spend VTXOs with assets from both default and delegate contracts, funded after delegation",
        { timeout: 120000 },
        async () => {
            const walletRepository = new InMemoryWalletRepository();
            const contractRepository = new InMemoryContractRepository();
            const identity = createTestIdentity();

            const onchainProvider = new EsploraProvider("http://localhost:3000/api", {
                forcePolling: true,
                pollingInterval: 2000,
            });

            // Step 1 — Create wallet without delegate
            const wallet1 = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider,
                storage: { walletRepository, contractRepository },
                settlementConfig: false,
            });

            const defaultAddress = await wallet1.getAddress();
            await wallet1.getContractManager();

            // Step 2 — Enable delegate before funding
            const wallet2 = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider,
                storage: { walletRepository, contractRepository },
                delegateProvider: new RestDelegateProvider("http://localhost:7012"),
                settlementConfig: false,
            });

            const delegateAddress = await wallet2.getAddress();
            expect(delegateAddress).not.toBe(defaultAddress);

            const manager = await wallet2.getContractManager();

            const contracts = await manager.getContracts({
                type: ["default", "delegate"],
            });
            expect(contracts).toHaveLength(2);

            // Fund default address and issue asset after delegation is set up
            faucetOffchain(defaultAddress, 1_000);
            await waitFor(async () => (await wallet2.getVtxos()).length > 0);

            const issueResult = await wallet2.assetManager.issue({
                amount: 500n,
            });
            expect(issueResult.assetId).toBeDefined();
            await new Promise((resolve) => setTimeout(resolve, 1000));

            faucetOffchain(delegateAddress, 1_000);
            await waitFor(async () => (await wallet2.getVtxos()).length >= 2);

            // Step 3 — Send requiring both pools, including the asset
            const bob = await createTestArkWallet();
            const bobAddress = await bob.wallet.getAddress();

            const allVtxos = await wallet2.getVtxos();
            const maxSingleVtxo = Math.max(...allVtxos.map((v) => v.value));
            const sendAmount = maxSingleVtxo + 100;

            const txid = await wallet2.send({
                address: bobAddress,
                amount: sendAmount,
                assets: [{ assetId: issueResult.assetId, amount: 200n }],
            });
            expect(txid).toBeDefined();
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Verify bob received the asset
            const bobVtxos = await bob.wallet.getVtxos();
            const bobAssets = bobVtxos.flatMap((v) => v.assets ?? []);
            const bobAsset = bobAssets.find((a) => a.assetId === issueResult.assetId);
            expect(bobAsset).toBeDefined();
            expect(bobAsset!.amount).toBe(200n);

            // Verify change has remaining asset on delegate contract
            await waitFor(async () => {
                const vtxos = await wallet2.getVtxos();
                return vtxos.some((v) => !v.isSpent);
            });

            const vtxosAfter = await wallet2.getVtxos();
            const aliceAssets = vtxosAfter.flatMap((v) => v.assets ?? []);
            const aliceRemaining = aliceAssets
                .filter((a) => a.assetId === issueResult.assetId)
                .reduce((s, a) => s + a.amount, 0n);
            expect(aliceRemaining).toBe(300n);

            // Change should land on delegate contract
            const delegateContractAfter = await manager.getContractsWithVtxos({
                type: ["delegate"],
            });
            const delegateUnspent = delegateContractAfter[0].vtxos.filter((v) => !v.isSpent);
            expect(delegateUnspent.length).toBeGreaterThan(0);
        },
    );
});

describe("ArkCash", () => {
    beforeEach(beforeEachFaucet, 20000);

    const fundedWallet = async (amount: number) => {
        const w = await createTestArkWallet();
        faucetOffchain(await w.wallet.getAddress(), amount);
        await waitFor(async () => (await w.wallet.getVtxos()).length > 0);
        return w;
    };

    /** pkScript (hex) an arkcash string's VTXOs live at. */
    const cashScriptOf = (cashStr: string): string =>
        hex.encode(ArkCash.fromString(cashStr).vtxoScript.pkScript);

    /**
     * Wait for a just-created arkcash's VTXO to be indexed before claiming it.
     * `createCash` returns once the send is submitted, so a claim fired straight
     * after can race the indexer and see zero VTXOs.
     */
    const waitForCashVtxo = async (
        observer: Awaited<ReturnType<typeof createTestArkWallet>>,
        cashStr: string,
    ): Promise<void> => {
        const cashScript = cashScriptOf(cashStr);
        await waitFor(async () => {
            const { vtxos } = await observer.wallet.indexerProvider.getVtxos({
                scripts: [cashScript],
            });
            return vtxos.length > 0;
        });
    };

    it("should send and claim arkcash (happy path)", async () => {
        const alice = await fundedWallet(10000);
        const bob = await createTestArkWallet();

        // Alice creates cash — Bob never shares an address
        const cashStr = await alice.wallet.createCash(5000);
        expect(cashStr).toMatch(/cash1/);
        await waitForCashVtxo(bob, cashStr);

        const result = await bob.wallet.claimCash(cashStr);
        expect(result.swept).toBe(5000);
        expect(result.unclaimed.amount).toBe(0);
        expect(result.unclaimed.vtxos).toEqual([]);

        await waitFor(async () => (await bob.wallet.getBalance()).total >= 5000);

        // Sweep-or-report persists nothing: no arkcash contract may reach Bob's
        // repository, or his own renewal/recovery would settle an input he
        // cannot sign and reject the whole batch.
        const manager = await bob.wallet.getContractManager();
        const contracts = await manager.getContracts();
        const cashScript = hex.encode(ArkCash.fromString(cashStr).vtxoScript.pkScript);
        expect(contracts.some((c) => c.script === cashScript)).toBe(false);
    }, 60_000);

    it("should report an already-claimed arkcash instead of sweeping it", async () => {
        const alice = await fundedWallet(10000);
        const bob = await createTestArkWallet();
        const charlie = await createTestArkWallet();

        const cashStr = await alice.wallet.createCash(5000);
        await waitForCashVtxo(bob, cashStr);

        await bob.wallet.claimCash(cashStr);
        await waitFor(async () => (await bob.wallet.getBalance()).total >= 5000);

        // The VTXO still exists, it is just spent — Charlie is told it was
        // already claimed rather than that the arkcash is unknown.
        const result = await charlie.wallet.claimCash(cashStr);
        expect(result.swept).toBe(0);
        expect(result.unclaimed.amount).toBe(5000);
        expect(result.unclaimed.vtxos).toHaveLength(1);
        expect(result.unclaimed.vtxos[0].reason).toBe("already-spent");
    }, 90_000);

    it("should throw when the arkcash was never funded", async () => {
        const alice = await fundedWallet(10000);
        const info = await alice.wallet.arkProvider.getInfo();
        const cash = ArkCash.generate(
            hex.decode(info.signerPubkey).slice(1),
            { type: "blocks", value: 144n },
            "tarkcash",
        );

        await expect(alice.wallet.claimCash(cash.toString())).rejects.toThrow("No VTXOs found");
    }, 30_000);

    it("should reject invalid createCash amounts", async () => {
        const alice = await fundedWallet(10000);

        // Subdust (e.g. 1) is now allowed — only non-positive/non-integer
        // amounts are rejected.
        for (const amount of [0, -1, 0.5, NaN, Infinity]) {
            await expect(alice.wallet.createCash(amount)).rejects.toThrow("Invalid ArkCash amount");
        }
    }, 30_000);

    it("should claim each arkcash independently", async () => {
        const alice = await fundedWallet(30000);
        const bob = await createTestArkWallet();

        const cash1 = await alice.wallet.createCash(5000);
        await waitFor(async () => (await alice.wallet.getVtxos()).length > 0);
        const cash2 = await alice.wallet.createCash(3000);

        await waitForCashVtxo(bob, cash1);
        await waitForCashVtxo(bob, cash2);
        expect((await bob.wallet.claimCash(cash1)).swept).toBe(5000);
        expect((await bob.wallet.claimCash(cash2)).swept).toBe(3000);

        await waitFor(async () => (await bob.wallet.getBalance()).total >= 8000);
    }, 120_000);

    // ── server-swept recovery (hybrid L3 — see plans/pr-337-new-plan.md) ──

    /**
     * Create an arkcash from `alice` and force the server to sweep its VTXO at
     * batch expiry (expiry = 20 blocks), so `claimCash` must take the
     * import-for-recovery branch instead of the thin sweep. Returns the string
     * and its script.
     */
    const sweptCash = async (
        alice: Awaited<ReturnType<typeof fundedWallet>>,
        observer: Awaited<ReturnType<typeof createTestArkWallet>>,
        amount: number,
    ): Promise<{ cashStr: string; cashScript: string }> => {
        const cashStr = await alice.wallet.createCash(amount);
        const cashScript = cashScriptOf(cashStr);

        // Wait for the arkcash VTXO to land before mining it into expiry.
        await waitForCashVtxo(observer, cashStr);

        // Push past the batch expiry so the server sweeps the VTXO. 30 > 20
        // blocks covers any offset between the funding batch and the tip.
        mineBlocks(30);
        await waitFor(
            async () => {
                const { vtxos } = await observer.wallet.indexerProvider.getVtxos({
                    scripts: [cashScript],
                });
                return vtxos.some((v) => v.virtualStatus.state === "swept" && !v.isSpent);
            },
            { timeout: 60_000 },
        );

        return { cashStr, cashScript };
    };

    it("should recover a server-swept arkcash by importing it for recovery", async () => {
        const alice = await fundedWallet(10000);
        const bob = await createTestArkWallet();

        const { cashStr, cashScript } = await sweptCash(alice, bob, 5000);

        // A swept VTXO cannot move through the thin sweep — claimCash imports
        // it as a signable recovery-only contract instead of reporting it.
        const result = await bob.wallet.claimCash(cashStr);
        expect(result.swept).toBe(0);
        expect(result.recovering.amount).toBe(5000);
        expect(result.recovering.vtxos).toHaveLength(1);
        expect(result.unclaimed.amount).toBe(0);
        // The old report-only behavior is gone: "swept" no longer surfaces.
        expect(result.unclaimed.vtxos.some((v) => v.reason === "swept")).toBe(false);

        // The import persisted exactly one recovery-only contract carrying a
        // signing descriptor for the arkcash key.
        const manager = await bob.wallet.getContractManager();
        const imported = await manager.getContracts({ script: cashScript });
        expect(imported).toHaveLength(1);
        expect(imported[0].metadata?.recoveryOnly).toBe(true);
        expect(typeof imported[0].metadata?.signingDescriptor).toBe("string");

        // Drive the isolated recovery pass until the funds settle back to Bob.
        // The pass is idempotent and self-serialized, so calling it each poll
        // is safe whether or not the claimCash kick is still in flight.
        const vtxoManager = await bob.wallet.getVtxoManager();
        await waitFor(
            async () => {
                await vtxoManager.recoverImportedContracts();
                return (await bob.wallet.getBalance()).total >= 5000;
            },
            { timeout: 120_000, interval: 3000 },
        );

        // Exactly the swept value arrived — no double-spend, no double-count.
        expect((await bob.wallet.getBalance()).total).toBe(5000);

        // Recovery over: the contract is removed and its keyring key purged.
        await waitFor(
            async () => {
                await vtxoManager.recoverImportedContracts();
                return (await manager.getContracts({ script: cashScript })).length === 0;
            },
            { timeout: 30_000, interval: 2000 },
        );
    }, 240_000);

    it("should be idempotent when claimCash is re-run before recovery settles", async () => {
        const alice = await fundedWallet(10000);
        const bob = await createTestArkWallet();

        const { cashStr, cashScript } = await sweptCash(alice, bob, 5000);

        // Re-running the claim before recovery completes must not import a
        // second contract or a second key, nor recover the funds twice.
        const r1 = await bob.wallet.claimCash(cashStr);
        expect(r1.recovering.amount).toBe(5000);
        const r2 = await bob.wallet.claimCash(cashStr);
        // The second run either re-imports idempotently (still recovering) or
        // — if the kicked recovery already spent the VTXO — reports it spent;
        // either way it neither throws nor double-counts.
        expect(r2.recovering.amount + r2.swept).toBeLessThanOrEqual(5000);

        const manager = await bob.wallet.getContractManager();
        const imported = await manager.getContracts({ script: cashScript });
        expect(imported.length).toBeLessThanOrEqual(1);

        const vtxoManager = await bob.wallet.getVtxoManager();
        await waitFor(
            async () => {
                await vtxoManager.recoverImportedContracts();
                return (await bob.wallet.getBalance()).total >= 5000;
            },
            { timeout: 120_000, interval: 3000 },
        );

        // The double claim recovered the single VTXO exactly once.
        expect((await bob.wallet.getBalance()).total).toBe(5000);
    }, 240_000);

    // ── subdust full claim (Phase 5 — see plans/pr-337-new-plan.md) ──

    it("should recover a subdust arkcash via top-up aggregation", async () => {
        const alice = await fundedWallet(10000);
        // The claimer must hold spendable BTC: a subdust note cannot settle on
        // its own, so recovery aggregates a claimer top-up to clear dust.
        const bob = await fundedWallet(10000);

        // A below-dust mint is allowed now; it lands at the OP_RETURN script.
        const cashStr = await alice.wallet.createCash(1);
        const cashScript = cashScriptOf(cashStr);
        await waitForCashVtxo(bob, cashStr);

        const bobBefore = (await bob.wallet.getBalance()).total;

        // No spendable leaf → not swept away, imported for recovery as subdust.
        const result = await bob.wallet.claimCash(cashStr);
        expect(result.swept).toBe(0);
        expect(result.recovering.amount).toBe(1);
        expect(result.recovering.vtxos).toEqual([
            expect.objectContaining({ value: 1, kind: "subdust" }),
        ]);
        expect(result.unclaimed.amount).toBe(0);

        const manager = await bob.wallet.getContractManager();
        expect(await manager.getContracts({ script: cashScript })).toHaveLength(1);

        // Drive the isolated recovery: it settles the 1-sat note aggregated with
        // a claimer top-up in a single mixed-key intent (the one new
        // server-facing combination Phase 5 introduces).
        const vtxoManager = await bob.wallet.getVtxoManager();
        await waitFor(
            async () => {
                await vtxoManager.recoverImportedContracts();
                return (await bob.wallet.getBalance()).total >= bobBefore + 1;
            },
            { timeout: 120_000, interval: 3000 },
        );

        // Net +1: the top-up is a self-transfer, only the note's value is new.
        expect((await bob.wallet.getBalance()).total).toBe(bobBefore + 1);

        // Recovery over: contract removed, key purged.
        await waitFor(
            async () => {
                await vtxoManager.recoverImportedContracts();
                return (await manager.getContracts({ script: cashScript })).length === 0;
            },
            { timeout: 30_000, interval: 2000 },
        );
    }, 240_000);

    it("defers subdust recovery until the claimer wallet has funds", async () => {
        const alice = await fundedWallet(10000);
        // Unfunded claimer: no BTC to top up with, so recovery cannot proceed.
        const bob = await createTestArkWallet();

        const cashStr = await alice.wallet.createCash(1);
        const cashScript = cashScriptOf(cashStr);
        await waitForCashVtxo(bob, cashStr);

        const result = await bob.wallet.claimCash(cashStr);
        expect(result.recovering.amount).toBe(1);

        const manager = await bob.wallet.getContractManager();
        const vtxoManager = await bob.wallet.getVtxoManager();

        // With no claimer funds the top-up selector finds nothing, so the pass
        // defers this contract — it stays imported, the funds stay recoverable,
        // and nothing is settled or purged.
        await vtxoManager.recoverImportedContracts();
        expect(await manager.getContracts({ script: cashScript })).toHaveLength(1);
        expect((await bob.wallet.getBalance()).total).toBe(0);

        // Fund the claimer → the next cycle aggregates a top-up and settles.
        faucetOffchain(await bob.wallet.getAddress(), 10000);
        await waitFor(async () => (await bob.wallet.getVtxos()).length > 0);

        await waitFor(
            async () => {
                await vtxoManager.recoverImportedContracts();
                return (await bob.wallet.getBalance()).total >= 10001;
            },
            { timeout: 120_000, interval: 3000 },
        );
        expect((await bob.wallet.getBalance()).total).toBe(10001);
    }, 240_000);
});
