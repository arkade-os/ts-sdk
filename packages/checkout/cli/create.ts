import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

async function main() {
    console.log("🎯 Arkade Checkout Setup\n");

    // Generate private key
    const privateKey = crypto.randomBytes(32).toString("hex");

    // Create .env.local entries
    const envContent = `
# Arkade Checkout Configuration
ARKADE_PRIVATE_KEY_HEX=${privateKey}
ARKADE_SERVER_URL=https://arkade.computer
BOLTZ_API_URL=https://api.ark.boltz.exchange
ARKADE_NETWORK=bitcoin
`.trim();

    const envPath = path.join(process.cwd(), ".env.local");
    fs.writeFileSync(envPath, envContent);

    console.log("✅ Created .env.local with credentials\n");
    console.log("⚠️  BACKUP YOUR PRIVATE KEY:");
    console.log(`   ${privateKey}\n`);

    // Create backup directory
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    const backupDir = path.join(homeDir!, ".arkade-checkout");
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, "key.txt"), privateKey);

    console.log(`📁 Backup saved to: ${backupDir}/key.txt\n`);
    console.log("🚀 Setup complete! Run your Next.js app.");
}

main().catch(console.error);
