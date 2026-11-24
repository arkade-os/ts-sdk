import { vi } from "vitest";

/** User key `11…11`. With MAINNET_INFO it derives MAINNET_ADDRESS: an SDK `Wallet` built from the
 * same key and info reported that address (operator info read from arkade.computer, 2026-11-24). */
export const ENTROPY = `0x${"11".repeat(32)}`;
export const MAINNET_INFO = {
    network: "bitcoin",
    signerPubkey: "038202bebddeb1f7442803897a85eaf3ce9254d07df0172fc3725ab5f0d097779c",
    unilateralExitDelay: "605184",
    checkpointTapscript:
        "039e0440b27520b43a8363118c084a04d4f6a50ebfa58e81957f8cceceb2aee0ab64c9fd2d9977ac",
};
export const MAINNET_ADDRESS =
    "ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjameehwpteq6u430ehtk9pz3vpd8j4vee8m2sxdvc83ss87xye4cf43k0pwhj6";

type Params = { operation?: string; newState?: Record<string, unknown> } & Record<string, unknown>;

/** A `snap` global whose dialogs answer with `dialog` and whose state lives in memory. */
export function installSnap(dialog: (params: unknown) => unknown = () => true) {
    let state: Record<string, unknown> | null = null;
    const dialogs: unknown[] = [];
    const methods: string[] = [];
    const request = vi.fn(async ({ method, params }: { method: string; params?: Params }) => {
        methods.push(method);
        if (method === "snap_getEntropy") return ENTROPY;
        if (method === "snap_dialog") {
            dialogs.push(params);
            return dialog(params);
        }
        if (method === "snap_manageState" && params?.operation === "get") return state;
        if (method === "snap_manageState" && params?.operation === "update") {
            state = params.newState ?? null;
            return null;
        }
        throw new Error(`unexpected method ${method}`);
    });
    (globalThis as Record<string, unknown>).snap = { request };
    return { dialogs, methods };
}

/** `fetch` answering `<url>/v1/info` for each operator URL given; anything else fails. */
export function stubOperators(byUrl: Record<string, object>) {
    const fetchMock = vi.fn(async (input: unknown) => {
        const url = String(input);
        const operator = Object.keys(byUrl).find((base) => url === `${base}/v1/info`);
        if (!operator) throw new TypeError(`fetch failed: ${url}`);
        return new Response(JSON.stringify(byUrl[operator]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}
