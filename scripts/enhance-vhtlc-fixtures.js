// This script enhances the vhtlc.json fixture file with script information and taproot keys
// Run after building the project: pnpm run build && node scripts/enhance-vhtlc-fixtures.js

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { hex } from "@scure/base";
import { Script } from "@scure/btc-signer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Decode a script from hex to human-readable opcodes
 * @param {string} scriptHex - The script in hex format
 * @returns {string} - Human-readable script with opcodes
 */
function decodeScript(scriptHex) {
    try {
        const scriptBytes = hex.decode(scriptHex);
        const decoded = Script.decode(scriptBytes);
        
        return decoded.map(item => {
            if (typeof item === 'string') {
                return item; // This is already an opcode like 'OP_DUP'
            } else if (item instanceof Uint8Array) {
                // This is data - show it as hex with length prefix
                const hexData = hex.encode(item);
                if (item.length <= 75) {
                    // Push data directly
                    return `0x${hexData}`;
                } else {
                    // Larger data with explicit push opcode
                    return `OP_PUSHDATA1 0x${hexData}`;
                }
            } else {
                return `${item}`; // Numbers or other types
            }
        }).join(' ');
    } catch (error) {
        return `[Error decoding script: ${error.message}]`;
    }
}

async function enhanceVHTLCFixtures() {
    try {
        // Import VHTLC from the built ESM output
        const { VHTLC } = await import("../dist/esm/index.js");
        
        const fixturesPath = path.join(__dirname, "../test/fixtures/vhtlc.json");
        const fixtures = JSON.parse(fs.readFileSync(fixturesPath, "utf8"));

        console.log("📝 Processing valid fixtures...");
        
        // Process valid fixtures
        fixtures.valid = fixtures.valid.map((fixture) => {
            try {
                // Convert fixture data to the format expected by VHTLC.Script
                const receiverXOnly = fixture.receiver.slice(2);
                const senderXOnly = fixture.sender.slice(2);
                const serverXOnly = fixture.server.slice(2);
                const refundLocktime = BigInt(fixture.refundLocktime);
                
                const unilateralClaimDelay = {
                    type: fixture.unilateralClaimDelay.type,
                    value: BigInt(fixture.unilateralClaimDelay.value),
                };
                
                const unilateralRefundDelay = {
                    type: fixture.unilateralRefundDelay.type,
                    value: BigInt(fixture.unilateralRefundDelay.value),
                };
                
                const unilateralRefundWithoutReceiverDelay = {
                    type: fixture.unilateralRefundWithoutReceiverDelay.type,
                    value: BigInt(fixture.unilateralRefundWithoutReceiverDelay.value),
                };

                // Create the VHTLC script
                const vhtlcScript = new VHTLC.Script({
                    preimageHash: hex.decode(fixture.preimageHash),
                    sender: hex.decode(senderXOnly),
                    receiver: hex.decode(receiverXOnly),
                    server: hex.decode(serverXOnly),
                    refundLocktime,
                    unilateralClaimDelay,
                    unilateralRefundDelay,
                    unilateralRefundWithoutReceiverDelay,
                });

                // Add script information
                fixture.scripts = {
                    claimScript: vhtlcScript.claimScript,
                    refundScript: vhtlcScript.refundScript,
                    refundWithoutReceiverScript: vhtlcScript.refundWithoutReceiverScript,
                    unilateralClaimScript: vhtlcScript.unilateralClaimScript,
                    unilateralRefundScript: vhtlcScript.unilateralRefundScript,
                    unilateralRefundWithoutReceiverScript: vhtlcScript.unilateralRefundWithoutReceiverScript,
                };

                // Add decoded scripts with human-readable opcodes
                fixture.decodedScripts = {
                    claimScript: decodeScript(vhtlcScript.claimScript),
                    refundScript: decodeScript(vhtlcScript.refundScript),
                    refundWithoutReceiverScript: decodeScript(vhtlcScript.refundWithoutReceiverScript),
                    unilateralClaimScript: decodeScript(vhtlcScript.unilateralClaimScript),
                    unilateralRefundScript: decodeScript(vhtlcScript.unilateralRefundScript),
                    unilateralRefundWithoutReceiverScript: decodeScript(vhtlcScript.unilateralRefundWithoutReceiverScript),
                };

                // Add taproot information
                fixture.taproot = {
                    tweakedPublicKey: hex.encode(vhtlcScript.tweakedPublicKey),
                    tapTree: hex.encode(vhtlcScript.encode()),
                    internalKey: "0250929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0", // TAPROOT_UNSPENDABLE_KEY
                };

                console.log(`  ✅ Enhanced: ${fixture.description}`);
                return fixture;
            } catch (error) {
                console.warn(`  ❌ Failed to enhance "${fixture.description}":`, error.message);
                return fixture;
            }
        });

        console.log("\n📝 Processing invalid fixtures...");

        // Process invalid fixtures (only add taproot info if they can be constructed)
        fixtures.invalid = fixtures.invalid.map((fixture) => {
            try {
                // For invalid fixtures, we'll try to create the VHTLC script to extract whatever information we can
                // Some may fail due to validation errors, which is expected
                const receiverXOnly = fixture.receiver?.slice(2);
                const senderXOnly = fixture.sender?.slice(2);
                const serverXOnly = fixture.server?.slice(2);
                
                if (!receiverXOnly || !senderXOnly || !serverXOnly) {
                    console.log(`  ⏭️  Skipping "${fixture.description}" - missing required keys`);
                    return fixture;
                }

                const refundLocktime = BigInt(fixture.refundLocktime ?? 0);
                
                const unilateralClaimDelay = fixture.unilateralClaimDelay ? {
                    type: fixture.unilateralClaimDelay.type,
                    value: BigInt(fixture.unilateralClaimDelay.value),
                } : { type: "blocks", value: 1n };
                
                const unilateralRefundDelay = fixture.unilateralRefundDelay ? {
                    type: fixture.unilateralRefundDelay.type,
                    value: BigInt(fixture.unilateralRefundDelay.value),
                } : { type: "blocks", value: 1n };
                
                const unilateralRefundWithoutReceiverDelay = fixture.unilateralRefundWithoutReceiverDelay ? {
                    type: fixture.unilateralRefundWithoutReceiverDelay.type,
                    value: BigInt(fixture.unilateralRefundWithoutReceiverDelay.value),
                } : { type: "blocks", value: 1n };

                // This will likely throw an error for invalid fixtures, which is expected
                const vhtlcScript = new VHTLC.Script({
                    preimageHash: hex.decode(fixture.preimageHash),
                    sender: hex.decode(senderXOnly),
                    receiver: hex.decode(receiverXOnly),
                    server: hex.decode(serverXOnly),
                    refundLocktime,
                    unilateralClaimDelay,
                    unilateralRefundDelay,
                    unilateralRefundWithoutReceiverDelay,
                });

                // If we get here, the fixture is actually valid (shouldn't happen)
                console.warn(`  ⚠️  Warning: Invalid fixture "${fixture.description}" actually created a valid script`);
                
                fixture.scripts = {
                    claimScript: vhtlcScript.claimScript,
                    refundScript: vhtlcScript.refundScript,
                    refundWithoutReceiverScript: vhtlcScript.refundWithoutReceiverScript,
                    unilateralClaimScript: vhtlcScript.unilateralClaimScript,
                    unilateralRefundScript: vhtlcScript.unilateralRefundScript,
                    unilateralRefundWithoutReceiverScript: vhtlcScript.unilateralRefundWithoutReceiverScript,
                };

                // Add decoded scripts with human-readable opcodes
                fixture.decodedScripts = {
                    claimScript: decodeScript(vhtlcScript.claimScript),
                    refundScript: decodeScript(vhtlcScript.refundScript),
                    refundWithoutReceiverScript: decodeScript(vhtlcScript.refundWithoutReceiverScript),
                    unilateralClaimScript: decodeScript(vhtlcScript.unilateralClaimScript),
                    unilateralRefundScript: decodeScript(vhtlcScript.unilateralRefundScript),
                    unilateralRefundWithoutReceiverScript: decodeScript(vhtlcScript.unilateralRefundWithoutReceiverScript),
                };

                fixture.taproot = {
                    tweakedPublicKey: hex.encode(vhtlcScript.tweakedPublicKey),
                    tapTree: hex.encode(vhtlcScript.encode()),
                    internalKey: "0250929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0",
                };

                return fixture;
            } catch (error) {
                console.log(`  ✅ Skipping "${fixture.description}" as expected:`, error.message);
                return fixture;
            }
        });

        // Write the enhanced fixtures back to the file
        fs.writeFileSync(fixturesPath, JSON.stringify(fixtures, null, 4));
        
        console.log(`\n🎉 Successfully enhanced vhtlc.json with script information and taproot keys`);
        console.log(`📁 Updated file: ${fixturesPath}`);
        console.log(`\n📊 Summary:`);
        console.log(`   • Valid fixtures processed: ${fixtures.valid.length}`);
        console.log(`   • Invalid fixtures processed: ${fixtures.invalid.length}`);
        
    } catch (error) {
        console.error("❌ Error enhancing fixtures:", error);
        process.exit(1);
    }
}

// Run the enhancement
if (import.meta.url === `file://${process.argv[1]}`) {
    enhanceVHTLCFixtures();
}