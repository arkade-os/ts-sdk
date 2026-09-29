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
