import { expect, it, vi } from "vitest";
import { collectPages, iteratePages } from "../../src/repositories/page";

it("rejects a page that repeats the previous cursor", async () => {
    const read = vi.fn(async () => ({ items: [1], nextCursor: { key: "same" } }));
    await expect(collectPages(read)).rejects.toThrow("cursor did not advance");
    expect(read).toHaveBeenCalledTimes(2);

    read.mockClear();
    const iterator = iteratePages(read);
    await iterator.next();
    await expect(iterator.next()).rejects.toThrow("cursor did not advance");
    expect(read).toHaveBeenCalledTimes(2);
});
