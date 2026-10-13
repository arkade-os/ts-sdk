/**
 * Real `Response`s for the fetch mocks. An object literal with `ok` and `json`
 * answers whichever two members its own call site reads, so production code can
 * never reach for a third — `clone()`, `arrayBuffer()`, `headers` — without
 * breaking every test at once.
 */

/** int64 crosses grpc-gateway as a decimal string, and JSON has no bigint. */
const wireSafe = (_key: string, value: unknown): unknown =>
    typeof value === "bigint" ? value.toString() : value;

export const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
    new Response(JSON.stringify(body, wireSafe), {
        status: 200,
        headers: { "content-type": "application/json" },
        ...init,
    });

export const textResponse = (body: string, init?: ResponseInit): Response =>
    new Response(body, { status: 200, ...init });
