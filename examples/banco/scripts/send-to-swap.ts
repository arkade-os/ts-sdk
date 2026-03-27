import { EventSource } from "eventsource";
(globalThis as any).EventSource = EventSource;
import {
    SingleKey,
    Wallet,
    InMemoryWalletRepository,
    InMemoryContractRepository,
} from "../../../src";

const [, , privkey, address, amountStr] = process.argv;
if (!privkey || !address || !amountStr) {
    console.error("Usage: send-to-swap.ts <privkey> <address> <amount>");
    process.exit(1);
}

async function main() {
    const wallet = await Wallet.create({
        identity: SingleKey.fromHex(privkey),
        arkServerUrl: "http://localhost:7070",
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
    });

    const bal = await wallet.getBalance();
    console.log("Balance:", bal.available);

    const txid = await wallet.send({ address, amount: Number(amountStr) });
    console.log("Sent txid:", txid);
    process.exit(0);
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
