import { describe, expect, it } from "vitest";
import { jsonResponse, textResponse } from "./helpers/response";

describe("the fetch-mock response helpers", () => {
    it("hand back a real Response, not a duck type", async () => {
        const res = jsonResponse({ vtxos: [] });

        expect(res).toBeInstanceOf(Response);
        expect(res.ok).toBe(true);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("application/json");
        expect(await res.clone().text()).toBe('{"vtxos":[]}');
        expect(await res.arrayBuffer()).toBeInstanceOf(ArrayBuffer);
    });

    it("serialize bigint the way grpc-gateway puts int64 on the wire", async () => {
        const res = jsonResponse({ batchExpiry: 144n });

        expect(await res.json()).toEqual({ batchExpiry: "144" });
    });

    it("reject a second body read, exactly as a fetched Response does", async () => {
        const res = textResponse("0200000001ab");

        expect(await res.text()).toBe("0200000001ab");
        await expect(res.text()).rejects.toThrow();
    });

    it("let init override the defaults", () => {
        const res = jsonResponse({}, { status: 404, statusText: "Not Found" });

        expect(res.ok).toBe(false);
        expect(res.status).toBe(404);
        expect(res.statusText).toBe("Not Found");
    });
});
