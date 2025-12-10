/**
 * Lendaswap integration service for funding payroll via USDT on Ethereum
 *
 * This service uses the Lendaswap SDK to swap USDT (ERC-20 on Ethereum)
 * to BTC on Arkade, enabling payroll funding from stablecoin sources.
 */

import type { NetworkConfig } from "../types";
import { DEFAULT_CONFIG } from "./payroll";

/**
 * Quote for a swap operation
 */
export interface SwapQuote {
  exchangeRate: number;
  sourceAmount: bigint;
  targetAmount: bigint;
  protocolFee: bigint;
  minAmount: bigint;
  expiresAt: Date;
}

/**
 * Swap order details
 */
export interface SwapOrder {
  swapId: string;
  contractAddress: string;
  hashLock: string;
  timelock: number;
  sourceAmount: bigint;
  targetAddress: string;
  status: "pending" | "deposited" | "claimed" | "refunded" | "expired";
}

/**
 * LendaswapService handles USDT to Arkade BTC swaps
 */
export class LendaswapService {
  private config: NetworkConfig;
  private orders: Map<string, SwapOrder> = new Map();

  constructor(config: NetworkConfig = DEFAULT_CONFIG) {
    this.config = config;
    this.loadOrdersFromStorage();
  }

  private loadOrdersFromStorage(): void {
    try {
      const stored = localStorage.getItem("lendaswap_orders");
      if (stored) {
        const parsed = JSON.parse(stored);
        for (const order of parsed) {
          this.orders.set(order.swapId, order);
        }
      }
    } catch {
      console.warn("Failed to load swap orders from storage");
    }
  }

  private saveOrdersToStorage(): void {
    try {
      const data = Array.from(this.orders.values());
      localStorage.setItem("lendaswap_orders", JSON.stringify(data));
    } catch {
      console.warn("Failed to save swap orders to storage");
    }
  }

  /**
   * Get a quote for swapping USDT to BTC on Arkade
   *
   * @param usdtAmount Amount in USDT (6 decimals, so 1 USDT = 1_000_000)
   */
  async getQuote(usdtAmount: bigint): Promise<SwapQuote> {
    // In a real implementation, this would call the Lendaswap API:
    // const client = await Client.create(...);
    // const quote = await client.getQuote('usdt_eth', 'btc_arkade', usdtAmount);

    // For demo purposes, simulate a quote with typical exchange rates
    // BTC price ~$100,000, so 1 USDT = ~1000 sats
    const btcPriceUsd = 100_000;
    const satsPerBtc = 100_000_000n;
    const usdtDecimals = 6;

    // Convert USDT amount to BTC equivalent in sats
    const usdtValue = Number(usdtAmount) / 10 ** usdtDecimals;
    const btcValue = usdtValue / btcPriceUsd;
    const satsValue = BigInt(Math.floor(btcValue * Number(satsPerBtc)));

    // Protocol fee (0.3%)
    const protocolFee = (satsValue * 3n) / 1000n;
    const targetAmount = satsValue - protocolFee;

    return {
      exchangeRate: Number(satsPerBtc) / btcPriceUsd,
      sourceAmount: usdtAmount,
      targetAmount,
      protocolFee,
      minAmount: 10_000_000n, // $10 minimum
      expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes
    };
  }

  /**
   * Create a swap order from USDT (Ethereum) to BTC (Arkade)
   *
   * @param usdtAmount Amount in USDT smallest units (6 decimals)
   * @param arkadeAddress Destination Arkade address for the BTC
   */
  async createSwapOrder(usdtAmount: bigint, arkadeAddress: string): Promise<SwapOrder> {
    // In a real implementation, this would call the Lendaswap SDK:
    // const swap = await client.createEvmToArkadeSwap({
    //   user_address: ethereumAddress,
    //   source_token: 'usdt_eth',
    // }, 'ethereum');

    // Generate mock swap details for demo
    const swapId = `swap-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const hashLock = Array.from({ length: 32 }, () =>
      Math.floor(Math.random() * 256)
        .toString(16)
        .padStart(2, "0")
    ).join("");

    const order: SwapOrder = {
      swapId,
      contractAddress: "0x1234567890abcdef1234567890abcdef12345678", // HTLC contract
      hashLock: `0x${hashLock}`,
      timelock: Math.floor(Date.now() / 1000) + 3600, // 1 hour
      sourceAmount: usdtAmount,
      targetAddress: arkadeAddress,
      status: "pending",
    };

    this.orders.set(swapId, order);
    this.saveOrdersToStorage();

    return order;
  }

  /**
   * Get contract ABI for HTLC deposit
   * This is used by the frontend to execute the Ethereum transaction
   */
  getHtlcAbi(): object[] {
    return [
      {
        name: "deposit",
        type: "function",
        inputs: [
          { name: "hashLock", type: "bytes32" },
          { name: "timelock", type: "uint256" },
          { name: "receiver", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
      },
      {
        name: "approve",
        type: "function",
        inputs: [
          { name: "spender", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
        stateMutability: "nonpayable",
      },
    ];
  }

  /**
   * Get USDT token contract address on Ethereum
   */
  getUsdtAddress(): string {
    // Mainnet USDT
    return "0xdAC17F958D2ee523a2206206994597C13D831ec7";
  }

  /**
   * Confirm that the Ethereum deposit was made
   * This should be called after the user submits the Ethereum transaction
   */
  async confirmDeposit(swapId: string, txHash: string): Promise<void> {
    const order = this.orders.get(swapId);
    if (!order) {
      throw new Error(`Swap order ${swapId} not found`);
    }

    // In real implementation, verify the transaction on-chain
    // await client.confirmDeposit(swapId, txHash);

    order.status = "deposited";
    this.orders.set(swapId, order);
    this.saveOrdersToStorage();
  }

  /**
   * Claim the BTC on Arkade after USDT deposit is confirmed
   * This completes the swap and releases BTC to the Arkade address
   */
  async claimOnArkade(swapId: string): Promise<string> {
    const order = this.orders.get(swapId);
    if (!order) {
      throw new Error(`Swap order ${swapId} not found`);
    }
    if (order.status !== "deposited") {
      throw new Error(`Cannot claim swap with status ${order.status}`);
    }

    // In real implementation:
    // const arkTxId = await client.claimVhtlc(swapId);

    // For demo, simulate a successful claim
    const arkTxId = `ark-${Date.now().toString(16)}`;

    order.status = "claimed";
    this.orders.set(swapId, order);
    this.saveOrdersToStorage();

    return arkTxId;
  }

  /**
   * Get all swap orders
   */
  getOrders(): SwapOrder[] {
    return Array.from(this.orders.values());
  }

  /**
   * Get a specific swap order
   */
  getOrder(swapId: string): SwapOrder | undefined {
    return this.orders.get(swapId);
  }
}

// Export singleton instance
export const lendaswapService = new LendaswapService();
