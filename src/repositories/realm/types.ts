/**
 * Minimal interface for the subset of the Realm API used by the
 * Ark repositories.  Consumers pass their real Realm instance and
 * the compiler validates it satisfies this shape.
 */

/** Result set returned by `realm.objects()`. */
export interface RealmResults<T = Record<string, unknown>> extends Iterable<T> {
    filtered(query: string, ...args: unknown[]): RealmResults<T>;
}

/** The Realm API surface used by Ark repositories. */
export interface RealmLike {
    write(callback: () => void): void;
    objects<T = Record<string, unknown>>(schemaName: string): RealmResults<T>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create(
        schemaName: string,
        values: Record<string, any>,
        mode?: string
    ): void;
    delete(objects: unknown): void;
}
