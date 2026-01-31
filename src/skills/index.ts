/**
 * Skills module for the Arkade SDK.
 *
 * Skills are modular capabilities that provide specific functionality for agents
 * and applications. This module provides skills for:
 *
 * - **ArkadeBitcoinSkill**: Send and receive Bitcoin over Arkade
 * - **ArkaLightningSkill**: Lightning Network payments via Boltz swaps
 *
 * @example
 * ```typescript
 * import {
 *   Wallet,
 *   SingleKey,
 *   ArkadeBitcoinSkill,
 *   ArkaLightningSkill,
 * } from "@arkade-os/sdk";
 *
 * // Create a wallet
 * const wallet = await Wallet.create({
 *   identity: SingleKey.fromHex(privateKeyHex),
 *   arkServerUrl: "https://ark.example.com",
 * });
 *
 * // === Bitcoin Skill ===
 * const bitcoin = new ArkadeBitcoinSkill(wallet);
 *
 * // Get addresses for receiving
 * const arkAddress = await bitcoin.getArkAddress();
 * console.log("Ark address:", arkAddress);
 *
 * // Check balance
 * const balance = await bitcoin.getBalance();
 * console.log("Balance:", balance.total, "sats");
 *
 * // Send Bitcoin off-chain
 * const sendResult = await bitcoin.send({
 *   address: recipientArkAddress,
 *   amount: 50000,
 * });
 * console.log("Sent!", sendResult.txid);
 *
 * // Onboard from on-chain to off-chain
 * const onboardResult = await bitcoin.onboard({
 *   feeInfo: arkInfo.feeInfo,
 * });
 * console.log("Onboarded!", onboardResult.commitmentTxid);
 *
 * // === Lightning Skill ===
 * const lightning = new ArkaLightningSkill({
 *   wallet,
 *   network: "bitcoin",
 * });
 *
 * // Create invoice to receive Lightning payment
 * const invoice = await lightning.createInvoice({
 *   amount: 25000,
 *   description: "Coffee payment",
 * });
 * console.log("Invoice:", invoice.bolt11);
 *
 * // Pay a Lightning invoice
 * const payResult = await lightning.payInvoice({
 *   bolt11: "lnbc...",
 * });
 * console.log("Paid! Preimage:", payResult.preimage);
 * ```
 *
 * @module skills
 */

// Types and interfaces
export type {
    Skill,
    BitcoinSkill,
    RampSkill,
    LightningSkill,
    BitcoinAddress,
    SendParams,
    SendResult,
    BalanceInfo,
    IncomingFundsEvent,
    OnboardParams,
    OffboardParams,
    RampResult,
    LightningInvoice,
    CreateInvoiceParams,
    PayInvoiceParams,
    PaymentResult,
    LightningFees,
    LightningLimits,
    SwapStatus,
    SwapInfo,
} from "./types";

// Bitcoin skill
export { ArkadeBitcoinSkill, createArkadeBitcoinSkill } from "./arkadeBitcoin";

// Lightning skill
export {
    ArkaLightningSkill,
    createLightningSkill,
    type ArkaLightningSkillConfig,
} from "./lightning";
