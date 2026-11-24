/**
 * nostr-tools 2.25 calls `ws.close()` from `onerror`; Node 22's WebSocket re-fires `error`
 * synchronously from `close()` on a still-connecting socket, and the recursion escapes as an
 * uncaught stack overflow, so one dead relay kills the process. Closing once breaks the loop.
 */
export const CloseOnceWebSocket: typeof WebSocket | undefined =
    typeof WebSocket === "undefined"
        ? undefined
        : class CloseOnceWebSocket extends WebSocket {
              #closed = false;

              override close(code?: number, reason?: string): void {
                  if (this.#closed) return;
                  this.#closed = true;
                  super.close(code, reason);
              }
          };
