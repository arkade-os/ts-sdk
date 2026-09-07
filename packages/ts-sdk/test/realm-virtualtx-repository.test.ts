import { virtualTxRepositoryConformance } from "./conformance/virtualTxRepository.conformance";
import { RealmVirtualTxRepository } from "../src/repositories/realm/virtualTxRepository";
import { createMockRealm } from "../../../config/test-helpers/mockRealm";

virtualTxRepositoryConformance(
    "realm",
    async () =>
        new RealmVirtualTxRepository(
            createMockRealm({ ArkVirtualTx: "txid", ArkVtxoBranch: "pk" }),
        ),
);
