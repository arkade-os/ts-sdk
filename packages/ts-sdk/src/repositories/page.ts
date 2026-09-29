export interface PageRequest<Cursor = string> {
    limit: number;
    after?: Cursor;
}

export interface PageResult<Item, Cursor = string> {
    items: Item[];
    nextCursor?: Cursor;
}

export const MAX_PAGE_SIZE = 500;

export function assertPageRequest(request: PageRequest<unknown>): void {
    if (
        !Number.isSafeInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > MAX_PAGE_SIZE
    ) {
        throw new RangeError(`page limit must be between 1 and ${MAX_PAGE_SIZE}`);
    }
}

export function pageResult<Item, Cursor>(
    rows: Item[],
    limit: number,
    cursorOf: (item: Item) => Cursor,
): PageResult<Item, Cursor> {
    const items = rows.slice(0, limit);
    return rows.length > limit
        ? { items, nextCursor: cursorOf(items[items.length - 1]) }
        : { items };
}

export async function* iteratePages<Item, Cursor>(
    read: (page: PageRequest<Cursor>) => Promise<PageResult<Item, Cursor>>,
): AsyncGenerator<Item> {
    let after: Cursor | undefined;
    do {
        const page = await read({ limit: MAX_PAGE_SIZE, after });
        for (const item of page.items) yield item;
        after = page.nextCursor;
    } while (after !== undefined);
}

export async function collectPages<Item, Cursor>(
    read: (page: PageRequest<Cursor>) => Promise<PageResult<Item, Cursor>>,
): Promise<Item[]> {
    const items: Item[] = [];
    let after: Cursor | undefined;
    do {
        const page = await read({ limit: MAX_PAGE_SIZE, after });
        items.push(...page.items);
        after = page.nextCursor;
    } while (after !== undefined);
    return items;
}
