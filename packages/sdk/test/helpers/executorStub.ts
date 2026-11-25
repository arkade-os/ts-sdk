import { vi } from "vitest";
import { hex } from "@scure/base";
import { ScriptNum } from "@scure/btc-signer";
import {
    ExecutorContractHandler,
    ExecutorRequestError,
    networks,
    type ExecutorProvider,
} from "../../src";
import { DEFAULT_TEMPLATE_IDS } from "../../src/script/executor/executorTemplate";
import vectors from "../fixtures/executor/vectors.json";

/**
 * An Executor that registers whatever it is asked, answering with the addresses the wallet derives.
 * `state.refuse` makes every registration throw; `state.status` is what it says of a watch it is asked about, `missing` being a 404.
 */
export function executorStub() {
    const state = { refuse: false, status: "active" };
    const registerDelegation = vi.fn(
        async (templateId: string, variables: Record<string, string>) => {
            if (state.refuse) throw new Error("Executor unavailable");
            const template = templateId === DEFAULT_TEMPLATE_IDS.boarding ? "boarding" : "renewal";
            const num = (name: string) => Number(ScriptNum().decode(hex.decode(variables[name])));
            const script = ExecutorContractHandler.createScript(
                ExecutorContractHandler.serializeParams({
                    template,
                    owner: hex.decode(variables.owner),
                    exitDelay: num("exit_delay"),
                    renewalWindow: num("renewal_window"),
                    maxFee: num("max_fee"),
                    ...(template === "boarding"
                        ? { boardingExitDelay: num("boarding_exit_delay") }
                        : {}),
                    cosignerPubKey: hex.decode(vectors.cosignerPubkey),
                    serverPubKey: hex.decode(vectors.serverPubkey),
                    emulatorPubKey: hex.decode(vectors.emulatorPubkey),
                }),
            );
            return {
                id: 1,
                templateId,
                variables,
                status: "active",
                inputs: [
                    {
                        name: template,
                        onchain: template === "boarding",
                        script: hex.encode(script.pkScript),
                        address:
                            template === "boarding"
                                ? script.onchainAddress(networks.mutinynet)
                                : script
                                      .address("tark", hex.decode(vectors.serverPubkey).subarray(1))
                                      .encode(),
                    },
                ],
            };
        },
    );
    const getDelegation = vi.fn(async () => {
        if (state.status === "missing") throw new ExecutorRequestError("delegation not found", 404);
        return { delegation: { status: state.status }, coins: [] };
    });
    const getInfo = vi.fn(async () => ({
        version: "test",
        network: "mutinynet",
        cosignerPubkey: vectors.cosignerPubkey,
        serverPubkey: vectors.serverPubkey,
        emulatorPubkey: vectors.emulatorPubkey,
    }));
    return {
        state,
        registerDelegation,
        getDelegation,
        provider: { getInfo, registerDelegation, getDelegation } as unknown as ExecutorProvider,
    };
}
