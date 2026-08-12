/**
 * The service-worker arm of the wallet's key-provisioning contract.
 *
 * `ServiceWorkerWallet` splits one wallet across two contexts: allocation and
 * the watermark live in the worker (single writer over the shared repository)
 * and cross the bus as strings, while signing stays page-side because an
 * `Identity` cannot be structured-cloned. That split is exactly where the two
 * sides can drift, and the failure mode is silent: a signer whose public key
 * checks out and whose every signature throws, discovered only after the swap
 * is funded. So every assertion here goes past `xOnlyPublicKey()` and makes
 * the returned signer produce a signature that verifies under the
 * descriptor's own key.
 *
 * The worker side is the real {@link WalletMessageHandler} driven by a real
 * page-side {@link Wallet}, not a canned responder: a hand-written stub for
 * `GET_NEXT_SIGNING_DESCRIPTOR` would agree with itself forever and pin
 * nothing about the wallet whose answers actually cross the bus.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { schnorr } from "@noble/curves/secp256k1.js";

import {
    ForeignDescriptorError,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    MnemonicIdentity,
    SingleKey,
    Wallet,
    deriveDescriptorLeafPubKey,
    type Identity,
    type IWallet,
    type WalletRepository,
} from "../src";
import { ServiceWorkerWallet } from "../src/wallet/serviceWorker/wallet";
import {
    DEFAULT_MESSAGE_TAG,
    WalletMessageHandler,
} from "../src/wallet/serviceWorker/wallet-message-handler";
import { HDDescriptorProvider } from "../src/wallet/hdDescriptorProvider";
import { MockEventSource } from "./mocks/eventSource";
import {
    WalletCannotSignError,
    contractPreimage,
    contractSigner,
    provisionClaimSecret,
    provisionRefundKey,
} from "../src/wallet/contractSecrets";

const MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const OTHER_MNEMONIC = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";
const STATIC_KEY_HEX = "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2";
const SERVER_PUBKEY_HEX = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

const mockArkInfo = {
    signerPubkey: SERVER_PUBKEY_HEX,
    forfeitPubkey: SERVER_PUBKEY_HEX,
    batchExpiry: BigInt(144),
    unilateralExitDelay: BigInt(144),
    boardingExitDelay: BigInt(144),
    roundInterval: BigInt(144),
    network: "mutinynet",
    dust: BigInt(1000),
    forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    checkpointTapscript:
        "039d0440b2752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac",
};

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

vi.mock("../src/utils/fetch", () => ({
    fetch: mockFetch,
    baseFetch: mockFetch,
}));

/** Disposed after every test so a leaked wallet cannot poll a mocked fetch. */
const openWallets: Array<{ dispose: () => Promise<void> | void }> = [];

beforeEach(() => {
    MockEventSource.reset();
    vi.stubGlobal("EventSource", MockEventSource);
    mockFetch.mockReset();
    mockFetch.mockImplementation((url: string) => {
        const reply = (body: unknown) => Promise.resolve({ ok: true, json: async () => body });
        if (url.includes("/info")) return reply(mockArkInfo);
        if (url.includes("subscribe") || url.includes("subscriptions"))
            return reply({ subscriptionId: "sub-1" });
        if (url.includes("vtxo") || url.includes("scripts")) return reply({ vtxos: [] });
        return reply([]);
    });
});

afterEach(async () => {
    for (const wallet of openWallets.splice(0)) await wallet.dispose();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/**
 * The page-side `Wallet` that runs *inside* the worker. Also the reference the
 * parity assertions compare the service-worker wallet against.
 */
async function makeInnerWallet(opts: {
    identity: Identity;
    hd: boolean;
    walletRepository: WalletRepository;
}): Promise<Wallet> {
    const wallet = await Wallet.create({
        identity: opts.identity,
        walletMode: opts.hd ? "hd" : "static",
        arkServerUrl: "http://localhost:7070",
        storage: {
            walletRepository: opts.walletRepository,
            contractRepository: new InMemoryContractRepository(),
        },
    });
    openWallets.push(wallet);
    return wallet;
}

/**
 * A message bus whose far end is the real worker-side handler.
 *
 * Mirrors `createServiceWorkerHarness` in `test/serviceWorker/wallet.test.ts`
 * (same `navigator.serviceWorker` listener set, same `postMessage` shape, same
 * PING/PONG auto-answer) — that helper is file-local there, so this is the
 * same harness with the canned responder replaced by a real handler. Extract
 * both into `test/helpers/` if a third file needs it.
 */
function createHandlerBackedBus(handler: WalletMessageHandler) {
    type MessageHandler = (event: { data: any }) => void;
    const listeners = new Set<MessageHandler>();

    const emit = (data: any) => listeners.forEach((listener) => listener({ data }));

    const navigatorServiceWorker = {
        addEventListener: vi.fn((type: string, listener: MessageHandler) => {
            if (type === "message") listeners.add(listener);
        }),
        removeEventListener: vi.fn((type: string, listener: MessageHandler) => {
            if (type === "message") listeners.delete(listener);
        }),
    };

    const serviceWorker = {
        postMessage: vi.fn((message: any) => {
            if (message.tag === "PING") {
                emit({ id: message.id, tag: "PONG" });
                return;
            }
            // Asynchronous on purpose: the real bus never answers inside the
            // postMessage call, and a synchronous stub hides ordering bugs.
            void handler
                .handleMessage(message)
                .then(emit)
                .catch((error) => emit({ id: message.id, tag: message.tag, error }));
        }),
    };

    return { navigatorServiceWorker, serviceWorker };
}

/**
 * A `ServiceWorkerWallet` wired to `inner` through the real handler. Built by
 * construction rather than `create()` so the test drives descriptor traffic
 * only — `create()` would additionally require INIT_WALLET/GET_STATUS.
 */
function makeServiceWorkerWallet(opts: {
    identity: Identity;
    inner: Wallet;
    walletRepository: WalletRepository;
}): ServiceWorkerWallet {
    const handler = new WalletMessageHandler();
    (handler as any).readonlyWallet = opts.inner;
    (handler as any).wallet = opts.inner;

    const { navigatorServiceWorker, serviceWorker } = createHandlerBackedBus(handler);
    vi.stubGlobal("navigator", { serviceWorker: navigatorServiceWorker } as any);

    return new (ServiceWorkerWallet as any)(
        serviceWorker as unknown as ServiceWorker,
        opts.identity,
        opts.walletRepository,
        new InMemoryContractRepository(),
        DEFAULT_MESSAGE_TAG,
        false,
    ) as ServiceWorkerWallet;
}

/** An HD wallet in both contexts, sharing one repository as they do in a browser. */
async function hdPair() {
    const identity = MnemonicIdentity.fromMnemonic(MNEMONIC, { isMainnet: false });
    const walletRepository = new InMemoryWalletRepository();
    const inner = await makeInnerWallet({ identity, hd: true, walletRepository });
    const sw = makeServiceWorkerWallet({ identity, inner, walletRepository });
    const provider = await HDDescriptorProvider.create(identity, walletRepository);
    return {
        identity,
        inner,
        sw,
        walletRepository,
        descriptorAt: (index: number) => provider.materializeDescriptorAt(index),
    };
}

/** A static wallet in both contexts: one key, one descriptor, forever. */
async function staticPair() {
    const identity = SingleKey.fromHex(STATIC_KEY_HEX);
    const walletRepository = new InMemoryWalletRepository();
    const inner = await makeInnerWallet({ identity, hd: false, walletRepository });
    const sw = makeServiceWorkerWallet({ identity, inner, walletRepository });
    return { identity, inner, sw, walletRepository };
}

const bareDescriptorFor = async (identity: Identity) =>
    `tr(${hex.encode(await identity.xOnlyPublicKey())})`;

/**
 * A concrete descriptor under a seed this wallet does not hold. Materialized
 * through the provider rather than by substituting the wildcard in the
 * template: a substitution that misses leaves the template ranged, and the
 * test would then be asserting about a wildcard descriptor while reading as
 * though it named a key.
 */
const foreignDescriptor = async () => {
    const provider = await HDDescriptorProvider.create(
        MnemonicIdentity.fromMnemonic(OTHER_MNEMONIC, { isMainnet: false }),
        new InMemoryWalletRepository(),
    );
    return provider.materializeDescriptorAt(0);
};

/**
 * The assertion that matters: not "the signer claims this key" but "the signer
 * produces a BIP-340 signature that verifies under the descriptor's key".
 */
async function signsUnderDescriptorKey(signer: Identity, descriptor: string): Promise<boolean> {
    const message = sha256(new TextEncoder().encode(`sign for ${descriptor}`));
    const signature = await signer.signMessage(message, "schnorr");
    return schnorr.verify(signature, message, deriveDescriptorLeafPubKey(descriptor));
}

describe("ServiceWorkerWallet.signerForDescriptor", () => {
    it("signs for the identity's own bare tr(pubkey) descriptor", async () => {
        // Routing a pathless descriptor through descriptor machinery yields a
        // signer with the right pubkey and no ability to sign — the identity
        // holds that key directly, so it must come back itself.
        const { sw, identity } = await hdPair();
        const bare = await bareDescriptorFor(identity);

        const signer = await sw.signerForDescriptor(bare);

        expect(signer).toBe(identity);
        await expect(signsUnderDescriptorKey(signer, bare)).resolves.toBe(true);
    });

    it("signs for a static wallet's bare descriptor", async () => {
        const { sw, identity } = await staticPair();
        const bare = await bareDescriptorFor(identity);

        const signer = await sw.signerForDescriptor(bare);

        expect(signer).toBe(identity);
        await expect(signsUnderDescriptorKey(signer, bare)).resolves.toBe(true);
    });

    it("signs for an HD child descriptor with that index's key, not the baseline one", async () => {
        const { sw, identity, descriptorAt } = await hdPair();
        const descriptor = descriptorAt(4);

        const signer = await sw.signerForDescriptor(descriptor);

        expect(hex.encode(await signer.xOnlyPublicKey())).toBe(
            hex.encode(deriveDescriptorLeafPubKey(descriptor)),
        );
        expect(hex.encode(await signer.xOnlyPublicKey())).not.toBe(
            hex.encode(await identity.xOnlyPublicKey()),
        );
        await expect(signsUnderDescriptorKey(signer, descriptor)).resolves.toBe(true);
    });

    it("refuses a descriptor from another seed", async () => {
        // Silently substituting the baseline identity here is the bug this
        // whole path exists to prevent: it signs happily with the wrong key
        // and surfaces as a rejected transaction far from the call.
        const { sw } = await hdPair();

        await expect(sw.signerForDescriptor(await foreignDescriptor())).rejects.toBeInstanceOf(
            ForeignDescriptorError,
        );
    });

    it("refuses an unreadable descriptor", async () => {
        const { sw } = await hdPair();

        await expect(sw.signerForDescriptor("not a descriptor")).rejects.toBeInstanceOf(
            ForeignDescriptorError,
        );
    });
});

describe("page-side and worker-side wallets answer identically", () => {
    it("resolve the same signing key, and both signers really sign", async () => {
        // Drift here is invisible until claim time: the two contexts hand out
        // signers with matching pubkeys, one of which cannot sign.
        const { sw, inner, identity, descriptorAt } = await hdPair();
        const descriptors = [await bareDescriptorFor(identity), descriptorAt(0), descriptorAt(11)];

        for (const descriptor of descriptors) {
            const pageSigner = await inner.signerForDescriptor(descriptor);
            const workerSigner = await sw.signerForDescriptor(descriptor);

            expect(hex.encode(await workerSigner.xOnlyPublicKey())).toBe(
                hex.encode(await pageSigner.xOnlyPublicKey()),
            );
            await expect(signsUnderDescriptorKey(pageSigner, descriptor)).resolves.toBe(true);
            await expect(signsUnderDescriptorKey(workerSigner, descriptor)).resolves.toBe(true);
        }
    });

    it("refuse the same foreign descriptor", async () => {
        const { sw, inner } = await hdPair();
        const foreign = await foreignDescriptor();

        await expect(inner.signerForDescriptor(foreign)).rejects.toBeInstanceOf(
            ForeignDescriptorError,
        );
        await expect(sw.signerForDescriptor(foreign)).rejects.toBeInstanceOf(
            ForeignDescriptorError,
        );
    });

    it("derive the same preimage for one descriptor", async () => {
        // A swap created behind the service worker must be claimable by a page
        // that later resolves the same descriptor from the seed alone.
        const { sw, inner, descriptorAt } = await hdPair();
        const descriptor = descriptorAt(3);

        expect(hex.encode(await contractPreimage(sw as unknown as IWallet, descriptor))).toBe(
            hex.encode(await contractPreimage(inner, descriptor)),
        );
    });
});

describe("contract secrets behind the service worker", () => {
    it("allocates over the bus and hands back a descriptor that signs", async () => {
        const { sw, identity } = await hdPair();

        const { descriptor, pubkey } = await provisionRefundKey(sw as unknown as IWallet);

        // Allocation really crossed the bus rather than being answered locally.
        expect((sw.serviceWorker as any).postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "GET_NEXT_SIGNING_DESCRIPTOR" }),
        );
        expect(hex.encode(pubkey)).toBe(hex.encode(deriveDescriptorLeafPubKey(descriptor)));
        expect(hex.encode(pubkey)).not.toBe(hex.encode(await identity.xOnlyPublicKey()));

        const signer = await contractSigner(sw as unknown as IWallet, descriptor);
        await expect(signsUnderDescriptorKey(signer, descriptor)).resolves.toBe(true);
    });

    it("never reissues an index across the bus, and never repeats a preimage", async () => {
        const { sw } = await hdPair();

        const secrets = [
            await provisionClaimSecret(sw as unknown as IWallet),
            await provisionClaimSecret(sw as unknown as IWallet),
            await provisionClaimSecret(sw as unknown as IWallet),
        ];

        expect(new Set(secrets.map((s) => s.descriptor)).size).toBe(3);
        expect(new Set(secrets.map((s) => hex.encode(s.preimage))).size).toBe(3);
        for (const secret of secrets) {
            // Nothing secret at rest: the seed re-derives it.
            expect(secret.mustPersistPreimage).toBe(false);
            expect(hex.encode(sha256(secret.preimage))).toBe(hex.encode(secret.paymentHash));
        }
    });

    it("re-derives a claim preimage after the page reloads", async () => {
        // The page keeps no secret; a fresh ServiceWorkerWallet over the same
        // seed and repository must reproduce the preimage exactly.
        const { sw, identity, inner, walletRepository } = await hdPair();
        const secret = await provisionClaimSecret(sw as unknown as IWallet);

        const reloaded = makeServiceWorkerWallet({ identity, inner, walletRepository });

        expect(
            hex.encode(await contractPreimage(reloaded as unknown as IWallet, secret.descriptor)),
        ).toBe(hex.encode(secret.preimage));
    });

    it("falls back to the identity key on a static worker wallet and salts the preimage", async () => {
        // A bare `tr(pubkey)` repeats across artifacts, so deriving from the
        // key alone would hand two swaps one preimage. A per-swap salt is
        // where the uniqueness comes from instead, and it is public — so the
        // worker arm stores nothing secret either.
        const { sw, identity } = await staticPair();

        const secret = await provisionClaimSecret(sw as unknown as IWallet);

        expect(secret.descriptor).toBe(await bareDescriptorFor(identity));
        expect(secret.mustPersistPreimage).toBe(false);
        expect(secret.preimageSalt).toHaveLength(32);
        // The salt is the derivation input: without it there is nothing to
        // derive from that would not collide.
        await expect(contractPreimage(sw as unknown as IWallet, secret.descriptor)).rejects.toThrow(
            /names no single artifact/,
        );
        expect(
            hex.encode(
                await contractPreimage(sw as unknown as IWallet, secret.descriptor, {
                    salt: secret.preimageSalt,
                }),
            ),
        ).toBe(hex.encode(secret.preimage));

        const signer = await contractSigner(sw as unknown as IWallet, secret.descriptor);
        expect(signer).toBe(identity);
        await expect(signsUnderDescriptorKey(signer, secret.descriptor)).resolves.toBe(true);
    });

    it("refuses a page identity that holds the key but cannot sign with it", async () => {
        // The fund-stranding shape: a page whose identity carries the right
        // public key and no way to sign. Every pubkey check passes, so without
        // this refusal the swap funds and only the push discovers there is no
        // signer — with the refund window already running.
        const full = SingleKey.fromHex(STATIC_KEY_HEX);
        const walletRepository = new InMemoryWalletRepository();
        const inner = await makeInnerWallet({ identity: full, hd: false, walletRepository });
        const watchOnly = {
            xOnlyPublicKey: () => full.xOnlyPublicKey(),
            compressedPublicKey: () => full.compressedPublicKey(),
        } as unknown as Identity;
        const sw = makeServiceWorkerWallet({ identity: watchOnly, inner, walletRepository });
        const descriptor = await bareDescriptorFor(watchOnly);

        // It IS our key — reporting it foreign would send the user after a
        // seed they already have. The remedy is to attach a signer.
        const error = await contractSigner(sw as unknown as IWallet, descriptor).catch(
            (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(WalletCannotSignError);
        expect(error).not.toBeInstanceOf(ForeignDescriptorError);

        // And it is refused at provisioning, before anything is funded.
        await expect(provisionRefundKey(sw as unknown as IWallet)).rejects.toBeInstanceOf(
            WalletCannotSignError,
        );
    });

    it("derives one preimage across the bus, page-side and worker-side", async () => {
        // The whole point of resolving page-side: the two contexts must not
        // answer differently for one descriptor, or a swap funded through one
        // is unclaimable through the other.
        const { sw, inner } = await staticPair();

        const secret = await provisionClaimSecret(sw as unknown as IWallet);
        expect(
            hex.encode(
                await contractPreimage(inner as unknown as IWallet, secret.descriptor, {
                    salt: secret.preimageSalt,
                }),
            ),
        ).toBe(hex.encode(secret.preimage));
    });
});
