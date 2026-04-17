import { expect, describe, it, beforeEach, vi } from "vitest";
import { SingleKey } from "../../src";
import {
    arkdExec,
    beforeEachFaucet,
    createSharedRepos,
    createTestArkWalletWithDelegateAndOverride,
    execCommand,
    waitFor,
} from "./utils";

describe("Contract params change", () => {
    beforeEach(beforeEachFaucet, 20000);

    it(
        "registers new default + delegate contracts after server exit delay change and keeps receiving on old and new addresses",
        { timeout: 120000 },
        async () => {
            const errorSpy = vi
                .spyOn(console, "error")
                .mockImplementation(() => {});

            try {
                const repos = createSharedRepos();
                const identity = SingleKey.fromRandomBytes();

                // Multiples of 512 — arkd rounds non-multiples, so keep these
                // clean to make script/address comparisons stable.
                const oldExitDelay = 605184n;
                const newExitDelay = 86528n;

                // ── First load ───────────────────────────────────────────────
                const first = await createTestArkWalletWithDelegateAndOverride({
                    identity,
                    repos,
                    unilateralExitDelay: oldExitDelay,
                });

                const firstManager = await first.wallet.getContractManager();
                const contractsAfterFirst = await firstManager.getContracts();
                expect(contractsAfterFirst).toHaveLength(2);

                const oldDelegate = contractsAfterFirst.find(
                    (c) => c.type === "delegate"
                );
                const oldDefault = contractsAfterFirst.find(
                    (c) => c.type === "default"
                );
                expect(oldDelegate).toBeDefined();
                expect(oldDefault).toBeDefined();
                expect(oldDelegate!.state).toBe("active");
                expect(oldDefault!.state).toBe("active");

                const oldDelegateAddress = await first.wallet.getAddress();
                expect(oldDelegateAddress).toBe(oldDelegate!.address);

                const oldDelegateCsv = oldDelegate!.params.csvTimelock;
                const oldDefaultCsv = oldDefault!.params.csvTimelock;
                expect(oldDelegateCsv).toBe(oldDefaultCsv);

                // Fund the old delegate address and wait for VTXO to land.
                const fundAmountOld = 3000;
                execCommand(
                    `${arkdExec} ark send --to ${oldDelegateAddress} --amount ${fundAmountOld} --password secret`
                );
                await waitFor(async () => {
                    const vtxos = await first.wallet.getVtxos();
                    return vtxos.some((v) => v.value === fundAmountOld);
                });

                const vtxosAfterFirstFund = await first.wallet.getVtxos();
                expect(
                    vtxosAfterFirstFund.some((v) => v.value === fundAmountOld)
                ).toBe(true);

                await first.wallet.dispose();

                // ── Second load ──────────────────────────────────────────────
                const second = await createTestArkWalletWithDelegateAndOverride(
                    {
                        identity,
                        repos,
                        unilateralExitDelay: newExitDelay,
                    }
                );

                const secondManager = await second.wallet.getContractManager();
                const contractsAfterSecond = await secondManager.getContracts();
                expect(contractsAfterSecond).toHaveLength(4);

                const delegateContracts = contractsAfterSecond.filter(
                    (c) => c.type === "delegate"
                );
                const defaultContracts = contractsAfterSecond.filter(
                    (c) => c.type === "default"
                );
                expect(delegateContracts).toHaveLength(2);
                expect(defaultContracts).toHaveLength(2);

                const newDelegate = delegateContracts.find(
                    (c) => c.script !== oldDelegate!.script
                );
                const newDefault = defaultContracts.find(
                    (c) => c.script !== oldDefault!.script
                );
                expect(newDelegate).toBeDefined();
                expect(newDefault).toBeDefined();
                expect(newDelegate!.state).toBe("active");
                expect(newDefault!.state).toBe("active");

                // CSV timelocks on the new contracts must differ from the old ones.
                expect(newDelegate!.params.csvTimelock).not.toBe(
                    oldDelegateCsv
                );
                expect(newDefault!.params.csvTimelock).not.toBe(oldDefaultCsv);
                expect(newDelegate!.params.csvTimelock).toBe(
                    newDefault!.params.csvTimelock
                );

                // Addresses on the new contracts must differ from the old ones.
                expect(newDelegate!.address).not.toBe(oldDelegate!.address);
                expect(newDefault!.address).not.toBe(oldDefault!.address);

                // The wallet's current address must match the new delegate contract.
                const newDelegateAddress = await second.wallet.getAddress();
                expect(newDelegateAddress).toBe(newDelegate!.address);
                expect(newDelegateAddress).not.toBe(oldDelegateAddress);

                // The old contracts must still be in the repository, untouched.
                const persistedOldDelegate = contractsAfterSecond.find(
                    (c) => c.script === oldDelegate!.script
                );
                const persistedOldDefault = contractsAfterSecond.find(
                    (c) => c.script === oldDefault!.script
                );
                expect(persistedOldDelegate).toBeDefined();
                expect(persistedOldDefault).toBeDefined();
                expect(persistedOldDelegate!.params.csvTimelock).toBe(
                    oldDelegateCsv
                );
                expect(persistedOldDefault!.params.csvTimelock).toBe(
                    oldDefaultCsv
                );

                // Old VTXO must still be visible after reload (the repository kept it).
                const vtxosAfterReload = await second.wallet.getVtxos();
                expect(
                    vtxosAfterReload.some((v) => v.value === fundAmountOld)
                ).toBe(true);

                // Fund the new delegate address and verify the new VTXO lands.
                const fundAmountNew = 4000;
                execCommand(
                    `${arkdExec} ark send --to ${newDelegateAddress} --amount ${fundAmountNew} --password secret`
                );
                await waitFor(async () => {
                    const vtxos = await second.wallet.getVtxos();
                    return vtxos.some((v) => v.value === fundAmountNew);
                });

                const finalVtxos = await second.wallet.getVtxos();
                // Both the old-address and new-address VTXOs are visible in the
                // reloaded wallet thanks to watcher + shared repository.
                expect(finalVtxos.some((v) => v.value === fundAmountOld)).toBe(
                    true
                );
                expect(finalVtxos.some((v) => v.value === fundAmountNew)).toBe(
                    true
                );

                await second.wallet.dispose();

                // Nothing in the flow should have logged an error.
                expect(errorSpy).not.toHaveBeenCalled();
            } finally {
                errorSpy.mockRestore();
            }
        }
    );
});
