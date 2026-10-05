import { describe, expect, it, vi } from "vitest";
import type { Identity } from "@arkade-os/sdk";
import type { CovenantTransfer } from "@arkade-taxi/client";
import { TaxiClaimQueue, type ClaimQueueOptions } from "../src/claimQueue";
import { offerKey, type ClaimClient, type VerifiedClaim } from "../src/claims";
import { BOB, bitcoinClaim, coins, satsFareClaim } from "./claimsFixtures";
import { KEYS, TAXI_URL } from "./contextFixtures";

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};
const offer = (id: string, client: ClaimClient, paid = false): VerifiedClaim => ({
    taxi: { network: "mutinynet", url: TAXI_URL, operatorKey: KEYS.operator },
    claim: { ...(paid ? satsFareClaim(7n) : bitcoinClaim(280n)), transferId: id },
    transfer: {} as CovenantTransfer,
    client,
});
const clientWith = (recycle: ClaimClient["recycle"]): ClaimClient => ({
    recycle,
    purchase: vi.fn(),
    info: vi.fn(),
    subscribeClaims: vi.fn(),
    verifyIncomingClaim: vi.fn(),
});
const options = (extra: Partial<ClaimQueueOptions> = {}): ClaimQueueOptions => ({
    identity: BOB,
    getCoins: async () => coins([1000n]),
    allowed: () => true,
    coordinate: async (run) => run(),
    reload: async () => {},
    recordClaim: () => {},
    ...extra,
});
const idle = async (queue: TaxiClaimQueue) => {
    await vi.waitFor(() => expect(queue.snapshot().busy).toBeUndefined());
};

describe("Taxi claim queue", () => {
    it("recycles three deliveries sequentially using only each reloaded replacement coin", async () => {
        let walletCoins = coins([1000n]);
        const inputs: string[] = [];
        const events: string[] = [];
        let active = 0;
        const client = clientWith(
            vi.fn(async (_transfer, funding) => {
                expect(++active).toBe(1);
                inputs.push(`${funding.input.txid}:${funding.input.vout}`);
                events.push("submit");
                active--;
                return String(inputs.length).repeat(64);
            }),
        );
        const queue = new TaxiClaimQueue(
            options({
                getCoins: async () => walletCoins,
                recordClaim: (_offer, _plan, txid) => {
                    events.push(`record:${txid[0]}`);
                },
                reload: async () => {
                    await Promise.resolve();
                    walletCoins = [
                        {
                            ...walletCoins[0],
                            txid: String(inputs.length).repeat(64),
                            value: walletCoins[0].value + 50,
                        },
                    ];
                    events.push("reload");
                },
            }),
        );
        for (const id of ["first", "second", "third"]) queue.offer(offer(id, client));
        await vi.waitFor(() => expect(inputs).toHaveLength(3));
        await idle(queue);
        expect(inputs).toEqual([
            `${"c".repeat(64)}:0`,
            `${"1".repeat(64)}:0`,
            `${"2".repeat(64)}:0`,
        ]);
        expect(walletCoins[0].value).toBe(1150);
        expect(events).toEqual([
            "submit",
            "record:1",
            "reload",
            "submit",
            "record:2",
            "reload",
            "submit",
            "record:3",
            "reload",
        ]);
        expect(queue.snapshot().offers).toEqual([]);
        queue.dispose();
    });

    it("leaves paid and unfunded deliveries visible while processing free offers behind them", async () => {
        const client = clientWith(vi.fn(async () => "a".repeat(64)));
        const queue = new TaxiClaimQueue(options({ getCoins: async () => coins([300n]) }));
        const paid = offer("paid", client);
        paid.claim = {
            ...paid.claim,
            claim: {
                ...paid.claim.claim!,
                params: {
                    ...paid.claim.claim!.params,
                    receiverFare: { currency: "sats", units: "7" },
                    recoveryRecipient: "receiver",
                },
            },
        };
        const waiting = offer("waiting", client);
        waiting.claim = {
            ...waiting.claim,
            claim: {
                ...waiting.claim.claim!,
                params: { ...waiting.claim.claim!.params, topup: "320" },
            },
        };
        const free = offer("free", client);
        queue.offer(paid);
        queue.offer(waiting);
        queue.offer(free);
        await vi.waitFor(() => expect(client.recycle).toHaveBeenCalledTimes(1));
        await idle(queue);
        expect(queue.snapshot().offers).toEqual([paid, waiting]);
        expect(queue.snapshot().plans.get(offerKey(waiting))?.kind).toBe("wait-for-reclaim");
        expect(queue.snapshot().plans.get(offerKey(paid))?.kind).toBe("recycle");
        queue.dispose();
    });

    it.each(["lock", "dispose", "withdraw", "disable"] as const)(
        "revokes signing after provider reads when the wallet is %s",
        async (revocation) => {
            const provider = deferred();
            const entered = deferred();
            let allowed = true;
            const sign = vi.fn(async (transaction) => transaction);
            const identity: Identity = {
                ...BOB,
                xOnlyPublicKey: BOB.xOnlyPublicKey.bind(BOB),
                compressedPublicKey: BOB.compressedPublicKey.bind(BOB),
                signerSession: BOB.signerSession.bind(BOB),
                signMessage: BOB.signMessage.bind(BOB),
                sign,
            };
            const client = clientWith(
                vi.fn(async (_transfer, funding) => {
                    entered.resolve();
                    await provider.promise;
                    await funding.identity.sign({} as never);
                    return "d".repeat(64);
                }),
            );
            const queue = new TaxiClaimQueue(options({ identity, allowed: () => allowed }));
            const delivery = offer("late", client);
            queue.offer(delivery);
            await entered.promise;
            if (revocation === "lock") allowed = false;
            if (revocation === "dispose") queue.dispose();
            if (revocation === "withdraw") queue.withdraw(offerKey(delivery));
            if (revocation === "disable") queue.setAutomatic(false);
            provider.resolve();
            await idle(queue);
            expect(sign).not.toHaveBeenCalled();
            queue.dispose();
        },
    );

    it.each([
        ["recycle", "dispose"],
        ["recycle", "revoke"],
        ["purchase", "dispose"],
        ["purchase", "revoke"],
    ] as const)(
        "records a completed %s after %s without reloading the departed wallet",
        async (mode, revocation) => {
            const submitted = deferred();
            const complete = deferred();
            let allowed = true;
            const finish = vi.fn(async () => {
                submitted.resolve();
                await complete.promise;
                return "d".repeat(64);
            });
            const client = clientWith(finish);
            client.purchase = finish;
            const reload = vi.fn(async () => {});
            const recordClaim = vi.fn();
            const queue = new TaxiClaimQueue(
                options({ allowed: () => allowed, reload, recordClaim }),
            );
            const delivery = offer("completed", client);
            delivery.claim = {
                ...delivery.claim,
                claim: {
                    ...delivery.claim.claim!,
                    params: { ...delivery.claim.claim!.params, claimMode: mode },
                },
            };
            queue.offer(delivery);
            await submitted.promise;
            if (revocation === "dispose") queue.dispose();
            else allowed = false;
            complete.resolve();
            await vi.waitFor(() =>
                expect(recordClaim).toHaveBeenCalledWith(
                    delivery,
                    expect.objectContaining({ kind: mode }),
                    "d".repeat(64),
                ),
            );
            await idle(queue);
            expect(reload).not.toHaveBeenCalled();
            expect(finish).toHaveBeenCalledTimes(1);
            if (revocation === "revoke") {
                allowed = true;
                queue.offer(delivery);
                queue.wake();
                await idle(queue);
                expect(finish).toHaveBeenCalledTimes(1);
            }
            queue.dispose();
        },
    );

    it("does not reuse a stale consumed coin, then resumes with fresh externally unreserved inventory", async () => {
        let inventory = coins([1000n]);
        const client = clientWith(vi.fn(async () => "a".repeat(64)));
        const queue = new TaxiClaimQueue(options({ getCoins: async () => inventory }));
        queue.offer(offer("first", client));
        queue.offer(offer("second", client));
        await vi.waitFor(() => expect(client.recycle).toHaveBeenCalledTimes(1));
        await idle(queue);
        expect(queue.snapshot().offers).toHaveLength(1);
        inventory = [{ ...inventory[0], txid: "b".repeat(64) }];
        queue.wake();
        await vi.waitFor(() => expect(client.recycle).toHaveBeenCalledTimes(2));
        await idle(queue);
        expect(queue.snapshot().offers).toHaveLength(0);
        queue.dispose();
    });

    it("holds the shared send lock through manual submission and reload before automatically claiming the next delivery", async () => {
        const submitted = deferred();
        const releaseSubmit = deferred();
        const reloading = deferred();
        const releaseReload = deferred();
        let walletCoins = coins([1000n]);
        let count = 0;
        let locks = 0;
        const client = clientWith(
            vi.fn(async () => {
                count++;
                if (count === 1) {
                    submitted.resolve();
                    await releaseSubmit.promise;
                }
                return String(count).repeat(64);
            }),
        );
        const queue = new TaxiClaimQueue(
            options({
                getCoins: async () => walletCoins,
                coordinate: async (run) => {
                    expect(++locks).toBe(1);
                    try {
                        await run();
                    } finally {
                        locks--;
                    }
                },
                reload: async () => {
                    if (count === 1) {
                        reloading.resolve();
                        await releaseReload.promise;
                    }
                    walletCoins = [
                        {
                            ...walletCoins[0],
                            txid: String(count).repeat(64),
                            value: count === 1 ? 993 : 1043,
                        },
                    ];
                },
            }),
        );
        const paid = offer("manual", client, true);
        queue.offer(paid);
        await vi.waitFor(() => expect(queue.snapshot().plans.has(offerKey(paid))).toBe(true));
        await idle(queue);
        const manual = queue.claim(offerKey(paid));
        await submitted.promise;
        queue.offer(offer("automatic", client));
        expect(client.recycle).toHaveBeenCalledTimes(1);
        releaseSubmit.resolve();
        await reloading.promise;
        expect(client.recycle).toHaveBeenCalledTimes(1);
        expect(locks).toBe(1);
        releaseReload.resolve();
        await manual;
        await vi.waitFor(() => expect(client.recycle).toHaveBeenCalledTimes(2));
        await idle(queue);
        expect(locks).toBe(0);
        expect(walletCoins[0].value).toBe(1043);
        queue.dispose();
    });

    it("retains the verified one-shot capability and failed state across claim feed restarts", async () => {
        const client = clientWith(
            vi.fn(async () => {
                throw new Error("submission uncertain");
            }),
        );
        const queue = new TaxiClaimQueue(options());
        const delivery = offer("uncertain", client);
        queue.offer(delivery);
        await vi.waitFor(() => expect(queue.snapshot().spent.has(offerKey(delivery))).toBe(true));
        const replacement = offer("uncertain", client);
        queue.offer(replacement);
        queue.wake();
        await idle(queue);
        await queue.claim(offerKey(delivery));
        expect(client.recycle).toHaveBeenCalledTimes(1);
        expect(queue.snapshot().offers).toEqual([delivery]);
        expect(queue.snapshot().errors.get(offerKey(delivery))).toBeInstanceOf(Error);
        queue.dispose();
    });

    it("requires manual confirmation without cross-wallet coordination and records successful claims despite history failure", async () => {
        const client = clientWith(vi.fn(async () => "a".repeat(64)));
        const reload = vi.fn(async () => {});
        const onError = vi.fn();
        const queue = new TaxiClaimQueue(
            options({
                coordinate: undefined,
                reload,
                onError,
                recordClaim: () => {
                    throw new Error("history full");
                },
            }),
        );
        const delivery = offer("manual", client, true);
        queue.offer(delivery);
        await idle(queue);
        expect(client.recycle).not.toHaveBeenCalled();
        await queue.claim(offerKey(delivery));
        expect(client.recycle).toHaveBeenCalledTimes(1);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(queue.snapshot().offers).toEqual([]);
        expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({ message: "history full" }),
            offerKey(delivery),
        );
        queue.dispose();
    });

    it("pauses both manual and automatic claims and resumes with the same verified offers", async () => {
        const client = clientWith(vi.fn(async () => "a".repeat(64)));
        const queue = new TaxiClaimQueue(options());
        const delivery = offer("manual-paused", client, true);
        queue.offer(delivery);
        await vi.waitFor(() => expect(queue.snapshot().plans.has(offerKey(delivery))).toBe(true));
        await idle(queue);
        queue.setActive(false);
        await queue.claim(offerKey(delivery));
        expect(client.recycle).not.toHaveBeenCalled();
        const free = offer("automatic-paused", client);
        queue.offer(free);
        await queue.claim(offerKey(free));
        expect(client.recycle).not.toHaveBeenCalled();
        expect(queue.snapshot().offers).toEqual([delivery, free]);
        queue.setActive(true);
        await vi.waitFor(() => expect(client.recycle).toHaveBeenCalledTimes(1));
        await idle(queue);
        expect(queue.snapshot().offers).toEqual([delivery]);
        queue.dispose();
    });

    it("does not revive a queued manual confirmation after lock and unlock", async () => {
        const client = clientWith(vi.fn(async () => "a".repeat(64)));
        const queue = new TaxiClaimQueue(options());
        const delivery = offer("manual-before-lock", client, true);
        queue.offer(delivery);
        await vi.waitFor(() => expect(queue.snapshot().plans.has(offerKey(delivery))).toBe(true));
        await idle(queue);
        const pending = queue.claim(offerKey(delivery));
        await Promise.resolve();
        queue.setActive(false);
        queue.setActive(true);
        await pending;
        await idle(queue);
        expect(client.recycle).not.toHaveBeenCalled();
        expect(queue.snapshot().offers).toEqual([delivery]);
        queue.dispose();
    });

    it("keeps uncertain capabilities and consumed coins blocked across lock and unlock", async () => {
        let inventory = coins([1000n]);
        const uncertain = clientWith(
            vi.fn(async () => {
                throw new Error("submission uncertain");
            }),
        );
        const next = clientWith(vi.fn(async () => "b".repeat(64)));
        const queue = new TaxiClaimQueue(options({ getCoins: async () => inventory }));
        const failed = offer("uncertain", uncertain);
        queue.offer(failed);
        await vi.waitFor(() => expect(queue.snapshot().spent.has(offerKey(failed))).toBe(true));
        await idle(queue);
        queue.setActive(false);
        queue.setActive(true);
        queue.offer(offer("uncertain", uncertain));
        queue.offer(offer("next", next));
        await queue.claim(offerKey(failed));
        await idle(queue);
        expect(uncertain.recycle).toHaveBeenCalledTimes(1);
        expect(next.recycle).not.toHaveBeenCalled();
        inventory = [{ ...inventory[0], txid: "e".repeat(64) }];
        queue.wake();
        await vi.waitFor(() => expect(next.recycle).toHaveBeenCalledTimes(1));
        await idle(queue);
        expect(queue.snapshot().offers).toEqual([failed]);
        queue.dispose();
    });

    it("records a success after lock and unlock without old-context reload or stale-feed replay", async () => {
        const submitted = deferred();
        const complete = deferred();
        const client = clientWith(
            vi.fn(async () => {
                submitted.resolve();
                await complete.promise;
                return "d".repeat(64);
            }),
        );
        const reload = vi.fn(async () => {});
        const recordClaim = vi.fn();
        const queue = new TaxiClaimQueue(options({ reload, recordClaim }));
        const delivery = offer("completed", client);
        queue.offer(delivery);
        await submitted.promise;
        queue.setActive(false);
        queue.setActive(true);
        complete.resolve();
        await vi.waitFor(() => expect(recordClaim).toHaveBeenCalledTimes(1));
        await idle(queue);
        expect(reload).not.toHaveBeenCalled();
        queue.offer(delivery);
        await queue.claim(offerKey(delivery));
        expect(client.recycle).toHaveBeenCalledTimes(1);
        expect(queue.snapshot().offers).toEqual([]);
        queue.dispose();
    });

    it("rejects stale inventory fetched before lock even when it completes after unlock", async () => {
        const reading = deferred();
        const release = deferred();
        let reads = 0;
        const client = clientWith(vi.fn(async () => "d".repeat(64)));
        const queue = new TaxiClaimQueue(
            options({
                getCoins: async () => {
                    if (++reads === 1) {
                        reading.resolve();
                        await release.promise;
                        return coins([1000n]);
                    }
                    return [];
                },
            }),
        );
        const delivery = offer("late-inventory", client);
        queue.offer(delivery);
        await reading.promise;
        queue.setActive(false);
        queue.setActive(true);
        release.resolve();
        await idle(queue);
        expect(client.recycle).not.toHaveBeenCalled();
        await vi.waitFor(() =>
            expect(queue.snapshot().plans.get(offerKey(delivery))?.kind).toBe("wait-for-reclaim"),
        );
        expect(reads).toBe(2);
        queue.dispose();
    });

    it.each(["identity", "retained-session"] as const)(
        "revokes an old %s signer permanently across lock and unlock",
        async (kind) => {
            const entered = deferred();
            const provider = deferred();
            const signed = vi.fn(async (transaction) => transaction);
            const sessionSigned = vi.fn(async () => new Map());
            const identity: Identity = {
                xOnlyPublicKey: BOB.xOnlyPublicKey.bind(BOB),
                compressedPublicKey: BOB.compressedPublicKey.bind(BOB),
                signMessage: BOB.signMessage.bind(BOB),
                sign: signed,
                signerSession: () => ({
                    getPublicKey: vi.fn(async () => new Uint8Array()),
                    init: vi.fn(async () => {}),
                    getNonces: vi.fn(async () => new Map()),
                    aggregatedNonces: vi.fn(async () => ({ hasAllNonces: true })),
                    sign: sessionSigned,
                }),
            };
            const client = clientWith(
                vi.fn(async (_transfer, funding) => {
                    const signer =
                        kind === "retained-session" ? funding.identity.signerSession() : undefined;
                    entered.resolve();
                    await provider.promise;
                    if (signer) await signer.sign();
                    else await funding.identity.sign({} as never);
                    return "d".repeat(64);
                }),
            );
            const queue = new TaxiClaimQueue(options({ identity }));
            const delivery = offer("old-signer", client);
            queue.offer(delivery);
            await entered.promise;
            queue.setActive(false);
            queue.setActive(true);
            provider.resolve();
            await idle(queue);
            expect(signed).not.toHaveBeenCalled();
            expect(sessionSigned).not.toHaveBeenCalled();
            expect(queue.snapshot().spent.has(offerKey(delivery))).toBe(true);
            queue.dispose();
        },
    );

    it("exposes planning failures for manual recovery and removes withdrawn offers before signing", async () => {
        const inventory = deferred();
        const client = clientWith(vi.fn());
        const queue = new TaxiClaimQueue(
            options({
                getCoins: async () => {
                    await inventory.promise;
                    throw new Error("reservation storage unavailable");
                },
            }),
        );
        const delivery = offer("planning", client);
        queue.offer(delivery);
        inventory.resolve();
        await vi.waitFor(() =>
            expect(queue.snapshot().errors.get(offerKey(delivery))).toMatchObject({
                message: "reservation storage unavailable",
            }),
        );
        queue.withdraw(offerKey(delivery));
        await queue.claim(offerKey(delivery));
        expect(client.recycle).not.toHaveBeenCalled();
        expect(queue.snapshot().offers).toEqual([]);
        queue.dispose();
    });
});
