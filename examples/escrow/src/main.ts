import { hex } from "@scure/base";

import type { Utxo } from "../../../packages/ts-sdk/src/arkade/contract.ts";
import {
    DEMO_NETWORKS,
    loadKeys,
    payoutFromAddress,
    minimumExitDelay,
    prepareEscrow,
    RELEASE_LABEL,
    releaseMessage,
    shortHex,
    spendCancel,
    spendComplete,
    spendUnilateral,
    type DemoNetwork,
    type PreparedEscrow,
} from "./spend.ts";

const form = document.querySelector("form");
const networkSelect = required<HTMLSelectElement>("#network");
const walletLink = required<HTMLAnchorElement>("#wallet");
const buyerInput = required<HTMLInputElement>("#buyer");
const sellerInput = required<HTMLInputElement>("#seller");
const amountInput = required<HTMLInputElement>("#amount");
const timeoutInput = required<HTMLInputElement>("#timeout");
const exitInput = required<HTMLInputElement>("#exit");
const prepareButton = required<HTMLButtonElement>("#prepare");
const contractSection = required<HTMLElement>("#contract");
const addressCode = required<HTMLElement>("#address");
const copyButton = required<HTMLButtonElement>("#copy");
const balanceLine = required<HTMLElement>("#balance");
const coinSelect = required<HTMLSelectElement>("#coin");
const completeButton = required<HTMLButtonElement>("#complete");
const cancelButton = required<HTMLButtonElement>("#cancel");
const unilateralButton = required<HTMLButtonElement>("#unilateral");
const oracleLine = required<HTMLElement>("#oracle");
const keysLine = required<HTMLElement>("#keys");
const log = required<HTMLElement>("#log");

const keys = loadKeys();
let prepared: PreparedEscrow | undefined;
let coins: Utxo[] = [];
let fingerprint = "";
let busy = false;

networkSelect.replaceChildren(
    ...DEMO_NETWORKS.map((demo) => {
        const option = document.createElement("option");
        option.value = demo.name;
        option.textContent = demo.label;
        return option;
    }),
);
buyerInput.value = localStorage.getItem("arkade-escrow-buyer") ?? "";
sellerInput.value = localStorage.getItem("arkade-escrow-seller") ?? "";
amountInput.value = localStorage.getItem("arkade-escrow-amount") ?? "10000";
const storedExit = localStorage.getItem("arkade-escrow-exit");
exitInput.value = !storedExit || storedExit === "0" ? "2048" : storedExit;
timeoutInput.value = localStorage.getItem("arkade-escrow-timeout") ?? localInput(nowSeconds() - 60);
networkSelect.value = localStorage.getItem("arkade-escrow-network") ?? "mutinynet";
updateWalletLink();

void showKeys();
networkSelect.addEventListener("change", () => {
    updateWalletLink();
    markStale();
    void raiseExitToOperator();
});
void raiseExitToOperator();
for (const input of [buyerInput, sellerInput, amountInput, timeoutInput, exitInput]) {
    input.addEventListener("input", markStale);
}

form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void run("create", createEscrow);
});
copyButton.addEventListener("click", () => {
    void navigator.clipboard.writeText(addressCode.textContent ?? "");
    note("copied the funding address");
});
completeButton.addEventListener("click", () => void run("unlock", unlock));
cancelButton.addEventListener("click", () => void run("refund", refund));
unilateralButton.addEventListener("click", () => void run("exit", exit));

window.setInterval(() => {
    if (prepared && fingerprint === currentFingerprint()) void refreshCoins(false);
}, 4000);

async function createEscrow(): Promise<void> {
    const demo = selectedNetwork();
    const amount = readAmount();
    const timeoutAt = readTimeout();
    const exitDelay = readExit();
    remember();
    prepared = await prepareEscrow({
        demo,
        buyerAddress: buyerInput.value,
        sellerAddress: sellerInput.value,
        amount,
        timeoutAt,
        exit: exitDelay,
        keys,
    });
    fingerprint = currentFingerprint();
    addressCode.textContent = prepared.contract.address;
    contractSection.hidden = false;
    note(
        `escrow ${prepared.contract.address} · emulator ${prepared.emulatorVersion || "unknown"} · oracle signs "${RELEASE_LABEL}"`,
    );
    if (prepared.emulatorVersion.startsWith("v0.0.7")) {
        note("this emulator is older than v0.0.8, so refund (CHECKTIME) will be rejected");
    }
    await refreshCoins(true);
}

async function unlock(): Promise<void> {
    const current = requirePrepared();
    const coin = selectedCoin();
    const { seller, buyer } = payouts(current);
    const txid = await spendComplete(current, coin, seller, buyer, readAmount());
    note(`unlocked to the seller: ${txid}`);
    await refreshCoins(true);
}

async function refund(): Promise<void> {
    const current = requirePrepared();
    const coin = selectedCoin();
    const { buyer } = payouts(current);
    const txid = await spendCancel(current, coin, buyer);
    note(`refunded the buyer: ${txid}`);
    await refreshCoins(true);
}

async function exit(): Promise<void> {
    const current = requirePrepared();
    const coin = selectedCoin();
    const { seller } = payouts(current);
    const txid = await spendUnilateral(current, coin, seller);
    note(`unilateral exit to the seller: ${txid}`);
    await refreshCoins(true);
}

function payouts(current: PreparedEscrow): { buyer: Uint8Array; seller: Uint8Array } {
    const buyer = payoutFromAddress(
        buyerInput.value,
        current.demo.network.hrp,
        current.contract.client.serverKey,
    );
    const seller = payoutFromAddress(
        sellerInput.value,
        current.demo.network.hrp,
        current.contract.client.serverKey,
    );
    return { buyer: buyer.pkScript, seller: seller.pkScript };
}

async function refreshCoins(announce: boolean): Promise<void> {
    if (!prepared) return;
    coins = await prepared.contract.getUtxos();
    const previous = coinSelect.value;
    coinSelect.replaceChildren(
        ...coins.map((coin) => {
            const option = document.createElement("option");
            option.value = `${coin.txid}:${coin.vout}`;
            option.textContent = `${coin.value} sats · ${coin.txid.slice(0, 10)}:${coin.vout}`;
            return option;
        }),
    );
    if (coins.some((coin) => `${coin.txid}:${coin.vout}` === previous)) coinSelect.value = previous;
    const total = coins.reduce((sum, coin) => sum + coin.value, 0);
    balanceLine.textContent = describeCoins();
    syncButtons();
    if (announce && coins.length > 0) note(`found ${total} sats`);
}

function selectedCoin(): Utxo {
    const coin = coins.find((item) => `${item.txid}:${item.vout}` === coinSelect.value) ?? coins[0];
    if (!coin) throw new Error("fund the escrow first");
    return coin;
}

function requirePrepared(): PreparedEscrow {
    if (!prepared || fingerprint !== currentFingerprint()) {
        throw new Error("the form changed; create the escrow again");
    }
    return prepared;
}

function markStale(): void {
    if (!prepared) return;
    balanceLine.textContent =
        fingerprint === currentFingerprint()
            ? describeCoins()
            : "The form changed. Create the escrow again before spending.";
    syncButtons();
}

function describeCoins(): string {
    if (coins.length === 0)
        return "No coins yet. Send sats to the address above from Arkade.Money.";
    const total = coins.reduce((sum, coin) => sum + coin.value, 0);
    return `${coins.length} coin${coins.length === 1 ? "" : "s"}, ${total} sats.`;
}

async function showKeys(): Promise<void> {
    const [buyer, seller, oracle, message] = await Promise.all([
        keys.buyer.xOnlyPublicKey(),
        keys.seller.xOnlyPublicKey(),
        keys.oracle.xOnlyPublicKey(),
        releaseMessage(),
    ]);
    keysLine.textContent = `buyer ${shortHex(buyer)} · seller ${shortHex(seller)}`;
    oracleLine.textContent = `oracle ${shortHex(oracle)} · message ${hex.encode(message)}`;
}

function selectedNetwork(): DemoNetwork {
    const demo = DEMO_NETWORKS.find((item) => item.name === networkSelect.value);
    if (!demo) throw new Error("unknown network");
    return demo;
}

function updateWalletLink(): void {
    const demo = selectedNetwork();
    walletLink.href = demo.walletUrl;
    walletLink.textContent = demo.walletUrl.replace("https://", "");
}

function readAmount(): bigint {
    const amount = BigInt(amountInput.value);
    if (amount <= 0n) throw new Error("amount must be positive");
    return amount;
}

async function raiseExitToOperator(): Promise<void> {
    try {
        const minimum = await minimumExitDelay(selectedNetwork());
        if (BigInt(exitInput.value || "0") < minimum) exitInput.value = minimum.toString();
    } catch {
        // Create reports the operator minimum when this lookup fails.
    }
    markStale();
}

function readExit(): bigint {
    const exit = BigInt(exitInput.value);
    if (exit < 0n) throw new Error("unilateral delay cannot be negative");
    return exit;
}

function readTimeout(): bigint {
    const parsed = Date.parse(timeoutInput.value);
    if (Number.isNaN(parsed)) throw new Error("refund time is not a date");
    return BigInt(Math.floor(parsed / 1000));
}

function currentFingerprint(): string {
    return [
        networkSelect.value,
        buyerInput.value.trim(),
        sellerInput.value.trim(),
        amountInput.value,
        timeoutInput.value,
        exitInput.value,
    ].join("|");
}

function remember(): void {
    localStorage.setItem("arkade-escrow-buyer", buyerInput.value.trim());
    localStorage.setItem("arkade-escrow-seller", sellerInput.value.trim());
    localStorage.setItem("arkade-escrow-amount", amountInput.value);
    localStorage.setItem("arkade-escrow-timeout", timeoutInput.value);
    localStorage.setItem("arkade-escrow-exit", exitInput.value);
    localStorage.setItem("arkade-escrow-network", networkSelect.value);
}

async function run(label: string, action: () => Promise<void>): Promise<void> {
    busy = true;
    prepareButton.disabled = true;
    completeButton.disabled = true;
    cancelButton.disabled = true;
    unilateralButton.disabled = true;
    try {
        await action();
    } catch (error) {
        note(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        busy = false;
        prepareButton.disabled = false;
        syncButtons();
    }
}

function syncButtons(): void {
    const ready = !busy && coins.length > 0 && !!prepared && fingerprint === currentFingerprint();
    completeButton.disabled = !ready;
    cancelButton.disabled = !ready;
    unilateralButton.disabled = !ready;
}

function note(message: string): void {
    const line = document.createElement("div");
    const time = new Date().toLocaleTimeString();
    line.textContent = `${time}  ${message}`;
    log.prepend(line);
}

function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

function localInput(unix: number): string {
    const date = new Date(unix * 1000);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function required<T extends Element>(selector: string): T {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`missing ${selector}`);
    return element as T;
}
