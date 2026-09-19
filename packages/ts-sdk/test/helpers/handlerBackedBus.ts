import { vi } from "vitest";
import type { WalletMessageHandler } from "../../src/wallet/serviceWorker/wallet-message-handler";

/**
 * A message bus whose far end is the real worker-side handler.
 *
 * Mirrors `createServiceWorkerHarness` in `test/serviceWorker/wallet.test.ts`
 * (same `navigator.serviceWorker` listener set, same `postMessage` shape, same
 * PING/PONG auto-answer), with the canned responder replaced by a real
 * handler. Shared by the tests that drive a page-side wallet through it.
 */
export function createHandlerBackedBus(handler: WalletMessageHandler) {
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
