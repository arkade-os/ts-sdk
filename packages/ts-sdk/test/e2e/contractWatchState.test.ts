import { expect, describe, it, beforeEach } from "vitest";
import { hex } from "@scure/base";
import { DefaultContractHandler, SingleKey, networks } from "../../src";
import { beforeEachFaucet, createTestArkWallet, faucetOffchain, waitFor } from "./utils";

/**
 * `awaiting-funds` against a live operator: a one-shot destination is covered
 * by the background channels until it is paid, and demotes itself the moment
 * the payment lands.
 *
 * Unit coverage in `test/contracts/manager.test.ts` drives the same transition
 * through a mocked indexer. What only a real stack can show is that the
 * demotion fires off genuine indexer data — the VTXO is persisted first, so the
 * contract stops being watched only after it has stopped needing to be.
 */
describe("contract watch state", () => {
    beforeEach(beforeEachFaucet, 20000);

    it("demotes an awaiting-funds contract once its payment lands, keeping the vtxo", {
        timeout: 120000,
    }, async () => {
        const AMOUNT = 2000;
        const alice = await createTestArkWallet();
        const manager = await alice.wallet.getContractManager();

        // A second `default` script the wallet owns nothing else at:
        // the live row's serialized params verbatim, with a fresh key.
        // Reusing them keeps the server pubkey and CSV exactly what this
        // operator issues, so the address is payable by the faucet.
        const [own] = await manager.getContracts({ type: "default" });
        const other = SingleKey.fromRandomBytes();
        const params = { ...own.params, pubKey: hex.encode(await other.xOnlyPublicKey()) };
        const tapscript = DefaultContractHandler.createScript(params);
        const script = hex.encode(tapscript.pkScript);
        const address = tapscript
            .address(networks.regtest.hrp, hex.decode(params.serverPubKey))
            .encode();

        await manager.createContract({
            type: "default",
            params,
            script,
            address,
            watch: "awaiting-funds",
        });

        // Unfunded: watched, on every background channel.
        expect((await manager.getContracts({ script }))[0].watch).toBe("awaiting-funds");
        expect(
            (await manager.getContracts({ watch: "watched" })).map((c) => c.script),
        ).not.toContain(script);

        faucetOffchain(address, AMOUNT);

        // The subscription drives this on its own; the refresh is the
        // failsafe, so the assertion does not depend on SSE delivery.
        await waitFor(async () => {
            await manager.refreshVtxos();
            return (await manager.getContracts({ script }))[0]?.watch === "retained";
        });

        // Demoted only after the payment was persisted — coverage held
        // exactly as long as it was needed.
        const [withVtxos] = await manager.getContractsWithVtxos({ script });
        expect(withVtxos.vtxos.map((v) => v.value)).toContain(AMOUNT);

        // And the row is still there for history and restore.
        expect((await manager.getContracts({ script }))[0].address).toBe(address);

        await alice.wallet.dispose();
    });
});
