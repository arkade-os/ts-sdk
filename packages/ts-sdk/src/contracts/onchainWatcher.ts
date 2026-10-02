import type { ExplorerTransaction, OnchainProvider } from "../providers/onchain";
import type { Network } from "../networks";

type Target = { script: string; address: string };

/** Pushes onchain activity at contract addresses; never writes. */
export class OnchainContractWatcher {
    private stopFn?: () => void;
    private key = "";
    private stops = 0;

    constructor(
        private readonly cfg: {
            onchainProvider: Pick<OnchainProvider, "watchAddresses">;
            network: Network;
            onChange: (scripts: string[]) => void;
        },
    ) {}

    async setTargets(targets: Target[]): Promise<void> {
        const key = targets
            .map((t) => t.address)
            .sort()
            .join(",");
        if (key === this.key) return;
        const byAddress = new Map(targets.map((t) => [t.address, t.script]));
        const stops = this.stops;
        // Subscribe-then-swap: a failed subscribe keeps the old watch live.
        const next =
            targets.length === 0
                ? undefined
                : await this.cfg.onchainProvider.watchAddresses([...byAddress.keys()], (txs) =>
                      this.onTxs(txs, byAddress),
                  );
        if (stops !== this.stops) return next?.();
        this.stopFn?.();
        this.stopFn = next;
        this.key = key;
    }

    stop(): void {
        this.stops++;
        this.stopFn?.();
        this.stopFn = undefined;
        this.key = "";
    }

    private onTxs(txs: ExplorerTransaction[], byAddress: Map<string, string>): void {
        const touched = new Set<string>();
        const scriptOf = (address?: string) => (address ? byAddress.get(address) : undefined);
        for (const tx of txs) {
            const hits = [
                ...(tx.vout ?? []).map((out) => scriptOf(out.scriptpubkey_address)),
                ...(tx.vin ?? []).map((vin) => scriptOf(vin.prevout?.scriptpubkey_address)),
            ].filter((s): s is string => s !== undefined);
            // Electrum omits prevouts, so a spend matches nothing; it still touched one of ours.
            if (hits.length === 0 && !tx.vin?.some((v) => v.prevout))
                hits.push(...byAddress.values());
            for (const script of hits) touched.add(script);
        }
        if (touched.size > 0) this.cfg.onChange([...touched]);
    }
}
