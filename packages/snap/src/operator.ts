import { RestOperatorProvider, toXOnly, type NetworkName } from "@arkade-os/sdk";
import { type Json, ManageStateOperation, heading, panel, row, text } from "@metamask/snaps-sdk";
import { hex } from "@scure/base";

import { validateNetwork, validateOperatorUrl } from "./utils";

/** Trusted without a prompt: the SDK's mainnet default and the Arkade wallet's mutinynet server. */
const BUILT_IN: Partial<Record<NetworkName, string>> = {
    bitcoin: "https://arkade.computer",
    mutinynet: "https://mutinynet.arkade.sh",
};

export interface Operator {
    url: string;
    network: NetworkName;
    /** The signer key as the operator reports it, which the user sees and approves. */
    signerPubkey: string;
    /** x-only */
    signer: Uint8Array;
    exitDelay: bigint;
    checkpointTapscript: string;
}

interface CachedInfo {
    network: string;
    signerPubkey: string;
    unilateralExitDelay: string;
    checkpointTapscript: string;
}

interface SnapState {
    operators?: Record<string, CachedInfo>;
    /** origin -> operator URL -> the signer key the user approved */
    pins?: Record<string, Record<string, string>>;
    /** The snap's x-only key, hex, so a sign prompt can spot change without touching entropy. */
    pubkey?: string;
}

export async function readState(): Promise<SnapState> {
    const state = await snap.request({
        method: "snap_manageState",
        params: { operation: ManageStateOperation.GetState },
    });
    return (state ?? {}) as SnapState;
}

/** `snap_manageState` replaces the whole blob, so every write merges into what is stored. */
export async function updateState(change: (state: SnapState) => SnapState): Promise<void> {
    const newState = change(await readState()) as unknown as Record<string, Json>;
    await snap.request({
        method: "snap_manageState",
        params: { operation: ManageStateOperation.UpdateState, newState },
    });
}

/** Fresh info when the operator answers, else the last info it gave: a stale cache would keep
 * deriving addresses for a signer the operator has rotated away from. */
async function infoOf(url: string): Promise<CachedInfo> {
    try {
        const info = await new RestOperatorProvider(url).getInfo();
        const fresh: CachedInfo = {
            network: info.network,
            signerPubkey: info.signerPubkey,
            unilateralExitDelay: info.unilateralExitDelay.toString(),
            checkpointTapscript: info.checkpointTapscript,
        };
        await updateState((state) => ({
            ...state,
            operators: { ...state.operators, [url]: fresh },
        }));
        return fresh;
    } catch (error) {
        const cached = (await readState()).operators?.[url];
        if (!cached) throw error;
        return cached;
    }
}

async function approveOperator(origin: string, operator: Operator): Promise<void> {
    const key = operator.signerPubkey;
    const state = await readState();
    if (state.pins?.[origin]?.[operator.url] === key) return;

    const approved = await snap.request({
        method: "snap_dialog",
        params: {
            type: "confirmation",
            content: panel([
                heading("Use this Arkade operator?"),
                text(
                    `**${origin}** wants addresses and signatures on an operator the snap does not know.`,
                ),
                row("Operator", text(operator.url)),
                row("Network", text(operator.network)),
                row("Operator key", text(key)),
                row(
                    "Exit delay",
                    text(
                        `${operator.exitDelay} ${operator.exitDelay < 512n ? "blocks" : "seconds"}`,
                    ),
                ),
                text(
                    "Only approve an operator you trust: it cosigns every payment from these addresses.",
                ),
            ]),
        },
    });
    if (approved !== true) throw new Error("User rejected the operator");

    await updateState((current) => ({
        ...current,
        pins: { ...current.pins, [origin]: { ...current.pins?.[origin], [operator.url]: key } },
    }));
}

/**
 * The operator a request names: `network`, and `operatorUrl` where no operator is built in for it
 * (or to pick another one). Its info comes from the operator itself, never from the caller, and an
 * operator the snap does not know needs the user's approval for the requesting origin.
 */
export async function resolveOperator(params: unknown, origin: string): Promise<Operator> {
    if (!params || typeof params !== "object") {
        throw new Error("Invalid params: expected object");
    }
    const { network, operatorUrl } = params as { network: unknown; operatorUrl: unknown };
    const name = validateNetwork(network);
    const builtIn = BUILT_IN[name];
    const url = operatorUrl === undefined ? builtIn : validateOperatorUrl(operatorUrl);
    if (url === undefined) {
        throw new Error(`No built-in operator for ${name}: pass operatorUrl`);
    }

    const info = await infoOf(url);
    if (info.network !== name) {
        throw new Error(`Operator at ${url} reports network ${info.network}, expected ${name}`);
    }
    if (!info.signerPubkey) throw new Error(`Operator at ${url} reports no signer key`);
    const exitDelay = BigInt(info.unilateralExitDelay);
    if (exitDelay <= 0n) throw new Error(`Operator at ${url} reports no exit delay`);

    const operator: Operator = {
        url,
        network: name,
        signerPubkey: info.signerPubkey,
        signer: toXOnly(hex.decode(info.signerPubkey), "operator signer key"),
        exitDelay,
        checkpointTapscript: info.checkpointTapscript,
    };
    if (url !== builtIn) await approveOperator(origin, operator);
    return operator;
}
