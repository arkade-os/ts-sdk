import { afterEach, describe, expect, it, vi } from "vitest";
import { RestDelegateProvider } from "../src/providers/delegate";

afterEach(() => vi.unstubAllGlobals());

// Regression: the delegate service runs on a different origin (e.g.
// delegate.arkade.money) whose CORS policy does not allow `X-Build-Version` in
// the preflight Access-Control-Allow-Headers. That header is arkd-specific, so
// the delegate provider must NOT send it — otherwise every delegate request
// fails the preflight.
describe("RestDelegateProvider request headers (CORS)", () => {
    it("does not send X-Build-Version to the delegate service", async () => {
        const seen: Headers[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (_url: string, init?: RequestInit) => {
                seen.push(new Headers(init?.headers));
                return {
                    ok: true,
                    text: async () => "",
                    json: async () => ({
                        pubkey: "02abc",
                        fee: "0",
                        delegatorAddress: "tark1validaddress",
                    }),
                };
            }),
        );

        await new RestDelegateProvider("https://delegate.test").getDelegateInfo();

        expect(seen).toHaveLength(1);
        expect(seen[0].has("X-Build-Version")).toBe(false);
    });
});
