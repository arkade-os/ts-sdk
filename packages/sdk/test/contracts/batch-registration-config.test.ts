import { afterEach, describe, expect, it, vi } from "vitest";
import { ContractManager } from "../../src/contracts/contractManager";
import { reconcileIntents } from "../../src/wallet/intentReconciliation";

vi.mock("../../src/wallet/intentReconciliation", async (importOriginal) => ({
    ...(await importOriginal<object>()),
    reconcileIntents: vi.fn(),
}));

const repository = { name: "repository" };
const isOutpointInFlight = vi.fn();

const reconcile = (config: object) => {
    const manager = Object.create(ContractManager.prototype);
    manager.config = config;
    return manager.reconcileStaleIntents();
};

describe("ContractManager batch registration config", () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it("reads the new keys, and they win over the deprecated ones", async () => {
        const deleteBatchRegistration = vi.fn();
        await reconcile({
            batchRegistrationRepository: repository,
            intentRepository: { name: "old" },
            batchRegistrationReconciliation: { deleteBatchRegistration, isOutpointInFlight },
            intentReconciliation: { deleteIntent: vi.fn() },
        });
        expect(reconcileIntents).toHaveBeenCalledWith(
            expect.objectContaining({
                intentRepository: repository,
                deleteIntent: deleteBatchRegistration,
                isOutpointInFlight,
            }),
        );
    });

    it("keeps a deprecated callback that the new config leaves out", async () => {
        const deleteBatchRegistration = vi.fn();
        await reconcile({
            intentRepository: repository,
            batchRegistrationReconciliation: { deleteBatchRegistration },
            intentReconciliation: { isOutpointInFlight },
        });
        expect(reconcileIntents).toHaveBeenCalledWith(
            expect.objectContaining({
                deleteIntent: deleteBatchRegistration,
                isOutpointInFlight,
            }),
        );
    });

    it("keeps reading the deprecated keys", async () => {
        const deleteIntent = vi.fn();
        await reconcile({
            intentRepository: repository,
            intentReconciliation: { deleteIntent, isOutpointInFlight },
        });
        expect(reconcileIntents).toHaveBeenCalledWith(
            expect.objectContaining({
                intentRepository: repository,
                deleteIntent,
                isOutpointInFlight,
            }),
        );
    });

    it("skips reconciliation without a repository", async () => {
        await reconcile({ intentReconciliation: { deleteIntent: vi.fn() } });
        expect(reconcileIntents).not.toHaveBeenCalled();
    });
});
