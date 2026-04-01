/**
 * REST API for the covclaim daemon.
 *
 * POST /covenant   — register a VTXO to watch for covenant claiming
 * GET  /covenant/:id — check status of a registered covenant
 * GET  /health     — health check
 */

import express from "express";
import type { Config, CovenantRegistration } from "./types.js";
import { addCovenant, getCovenant } from "./store.js";
import { deriveCovVHTLC } from "./derive.js";

export function createServer(config: Config): express.Express {
    const app = express();
    app.use(express.json());

    app.get("/health", (_req, res) => {
        res.json({ status: "ok" });
    });

    app.post("/covenant", async (req, res) => {
        try {
            const body = req.body as CovenantRegistration;

            // Basic validation
            if (
                !body.sender ||
                !body.receiver ||
                !body.server ||
                !body.preimage ||
                !body.claimAddress ||
                !body.expectedAmount ||
                !body.refundLocktime ||
                !body.unilateralClaimDelay ||
                !body.unilateralRefundDelay ||
                !body.unilateralRefundWithoutReceiverDelay
            ) {
                res.status(400).json({ error: "missing required fields" });
                return;
            }

            // Derive the CovVHTLC to get the taproot address
            const { taprootAddress } = await deriveCovVHTLC(body, config);

            const entry = addCovenant(body, taprootAddress);

            console.log(
                `[server] registered covenant ${entry.id} → ${taprootAddress}`
            );

            res.status(201).json({
                id: entry.id,
                taprootAddress: entry.taprootAddress,
                status: entry.status,
            });
        } catch (err) {
            const message =
                err instanceof Error ? err.message : String(err);
            console.error(`[server] POST /covenant error: ${message}`);
            res.status(500).json({ error: message });
        }
    });

    app.get("/covenant/:id", (req, res) => {
        const entry = getCovenant(req.params.id);
        if (!entry) {
            res.status(404).json({ error: "covenant not found" });
            return;
        }

        res.json({
            id: entry.id,
            taprootAddress: entry.taprootAddress,
            status: entry.status,
            utxo: entry.utxo,
            claimTxid: entry.claimTxid,
            error: entry.error,
            createdAt: entry.createdAt,
        });
    });

    return app;
}
