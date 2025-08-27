/**
 * Debug utilities for SatsConnectIdentity
 * These functions can help diagnose issues with wallet integration
 */

export class SatsConnectDebugger {
    static async testConnection(satsConnectRequest) {
        console.log("=== Testing SatsConnect Connection ===");

        try {
            // Test 1: Try to get wallet addresses using wallet_connect
            console.log("1. Testing wallet_connect...");
            const addressResponse = await satsConnectRequest("wallet_connect", {
                addresses: ["payment", "ordinals"],
                message: "Testing wallet connection",
            });
            console.log("wallet_connect response:", addressResponse);

            return {
                success: addressResponse.status === "success",
                addresses: addressResponse.result?.addresses || null,
                error: addressResponse.error?.message || null,
            };
        } catch (error) {
            console.error("Connection test failed:", error);
            return {
                success: false,
                addresses: null,
                error: error.message,
            };
        }
    }

    static async testSignPsbtMethods(
        satsConnectRequest,
        testPsbt,
        testAddress
    ) {
        console.log("=== Testing SignPsbt Methods ===");

        const methods = ["signPsbt", "sign_psbt", "signTransaction", "sign"];
        const results = {};

        for (const method of methods) {
            try {
                console.log(`Testing method: ${method}`);

                const response = await satsConnectRequest(method, {
                    psbt: testPsbt,
                    signInputs: {
                        [testAddress]: [0],
                    },
                    broadcast: false,
                });

                results[method] = {
                    success: true,
                    response: response,
                };

                console.log(`${method} succeeded:`, response);
            } catch (error) {
                results[method] = {
                    success: false,
                    error: error.message,
                };

                console.log(`${method} failed:`, error.message);
            }
        }

        return results;
    }

    static logTransaction(tx) {
        console.log("=== Transaction Debug Info ===");
        console.log("Input count:", tx.inputsLength);
        console.log("Output count:", tx.outputsLength);

        // Log input details
        for (let i = 0; i < tx.inputsLength; i++) {
            try {
                const input = tx.getInput(i);
                console.log(`Input ${i}:`, {
                    hash: input.hash
                        ? Array.from(input.hash)
                              .map((b) => b.toString(16).padStart(2, "0"))
                              .join("")
                        : "undefined",
                    index: input.index,
                    hasWitness: !!input.witness,
                });
            } catch (e) {
                console.log(`Input ${i}: Error reading - ${e.message}`);
            }
        }

        // Log output details
        for (let i = 0; i < tx.outputsLength; i++) {
            try {
                const output = tx.getOutput(i);
                console.log(`Output ${i}:`, {
                    amount: output.amount
                        ? output.amount.toString()
                        : "undefined",
                    script: output.script
                        ? Array.from(output.script).length
                        : "undefined",
                });
            } catch (e) {
                console.log(`Output ${i}: Error reading - ${e.message}`);
            }
        }
    }
}
