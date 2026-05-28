/**
 * Emulator REST client.
 *
 * The emulator is a signing service that executes Arkade scripts
 * and co-signs transactions when the scripts pass validation.
 */

import { Intent } from "../intent";

export interface EmulatorInfo {
    version: string;
    signerPubkey: string;
}

export interface EmulatorProvider {
    getInfo(): Promise<EmulatorInfo>;
    submitTx(
        arkTx: string,
        checkpointTxs: string[],
    ): Promise<{
        signedArkTx: string;
        signedCheckpointTxs: string[];
    }>;
    submitIntent(intent: { proof: string; message: Intent.RegisterMessage }): Promise<string>;
    submitFinalization(
        intent: {
            proof: string;
            message: Intent.RegisterMessage;
        },
        forfeits: string[],
        connectorTree: ConnectorTreeNode[] | null,
        commitmentTx: string,
    ): Promise<{
        signedForfeits: string[];
        signedCommitmentTx?: string;
    }>;
    submitOnchainTx(tx: string): Promise<{ signedTx: string }>;
}

export interface ConnectorTreeNode {
    txid: string;
    tx: string;
    children: Record<string, string>;
}

/**
 * REST-based emulator client.
 *
 * @example
 * ```typescript
 * const client = new RestEmulatorProvider('http://localhost:7073');
 * const info = await client.getInfo();
 * console.log('Emulator pubkey:', info.signerPubkey);
 * ```
 */
export class RestEmulatorProvider implements EmulatorProvider {
    constructor(public serverUrl: string) {}

    async getInfo(): Promise<EmulatorInfo> {
        const url = `${this.serverUrl}/v1/info`;
        const response = await fetch(url);
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to get emulator info: ${errorText}`);
        }
        const data = await response.json();
        const signerPubkey = data.signerPubkey;
        if (typeof signerPubkey !== "string" || !signerPubkey) {
            throw new Error("Invalid emulator info response: missing signerPubkey");
        }
        return {
            version: data.version ?? "",
            signerPubkey,
        };
    }

    async submitTx(
        arkTx: string,
        checkpointTxs: string[],
    ): Promise<{
        signedArkTx: string;
        signedCheckpointTxs: string[];
    }> {
        const url = `${this.serverUrl}/v1/tx`;
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                arkTx,
                checkpointTxs,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to submit tx to emulator: ${errorText}`);
        }

        const data = await response.json();
        if (typeof data.signedArkTx !== "string" || !data.signedArkTx) {
            throw new Error("Invalid emulator submitTx response: missing signedArkTx");
        }
        if (
            !Array.isArray(data.signedCheckpointTxs) ||
            !data.signedCheckpointTxs.every((item: unknown) => typeof item === "string")
        ) {
            throw new Error(
                "Invalid emulator submitTx response: signedCheckpointTxs must be an array of strings",
            );
        }
        return {
            signedArkTx: data.signedArkTx,
            signedCheckpointTxs: data.signedCheckpointTxs,
        };
    }

    async submitIntent(intent: {
        proof: string;
        message: Intent.RegisterMessage;
    }): Promise<string> {
        const url = `${this.serverUrl}/v1/intent`;
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                intent: {
                    proof: intent.proof,
                    message: JSON.stringify(intent.message),
                },
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to submit intent to emulator: ${errorText}`);
        }

        const data = await response.json();
        if (typeof data.signedProof !== "string" || !data.signedProof) {
            throw new Error("Invalid emulator submitIntent response: missing signedProof");
        }
        return data.signedProof;
    }

    async submitFinalization(
        intent: {
            proof: string;
            message: Intent.RegisterMessage;
        },
        forfeits: string[],
        connectorTree: ConnectorTreeNode[] | null,
        commitmentTx: string,
    ): Promise<{
        signedForfeits: string[];
        signedCommitmentTx?: string;
    }> {
        const url = `${this.serverUrl}/v1/finalization`;
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // Uses "signedIntent" (not "intent") because the proof was already
            // co-signed by the emulator via submitIntent in a prior step.
            body: JSON.stringify({
                signedIntent: {
                    proof: intent.proof,
                    message: JSON.stringify(intent.message),
                },
                forfeits,
                connectorTree,
                commitmentTx,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to submit finalization to emulator: ${errorText}`);
        }

        const data = await response.json();
        if (
            !Array.isArray(data.signedForfeits) ||
            !data.signedForfeits.every((item: unknown) => typeof item === "string")
        ) {
            throw new Error(
                "Invalid emulator submitFinalization response: signedForfeits must be an array of strings",
            );
        }

        if ("signedCommitmentTx" in data && typeof data.signedCommitmentTx !== "string") {
            throw new Error(
                "Invalid emulator submitFinalization response: invalid signedCommitmentTx",
            );
        }
        return {
            signedForfeits: data.signedForfeits,
            signedCommitmentTx: data.signedCommitmentTx,
        };
    }

    async submitOnchainTx(tx: string): Promise<{ signedTx: string }> {
        const url = `${this.serverUrl}/v1/onchain-tx`;
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tx }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to submit onchain tx to emulator: ${errorText}`);
        }

        const data = await response.json();
        if (typeof data.signedTx !== "string" || !data.signedTx) {
            throw new Error("Invalid emulator submitOnchainTx response: missing signedTx");
        }
        return { signedTx: data.signedTx };
    }
}
