# Arkade Payroll Example

A minimal web-based payroll tool built with the [Arkade SDK](https://github.com/arkade-os/ts-sdk) demonstrating how to send payments to multiple recipients using Arkade virtual outputs (VTXOs).

## Features

### Assistant View (Read-only Access)
- Create payroll batches with multiple recipients
- Add/remove recipients using +/- buttons
- Import recipients from CSV file (Address,Amount format)
- Submit payrolls for admin approval

### Admin View
- View all pending payrolls
- Check wallet balance before execution
- Approve and execute payrolls by signing with private key
- Fund wallet via USDT on Ethereum using [Lendaswap SDK](https://github.com/lendasat/lendaswap-sdk)

## Getting Started

### Prerequisites
- Node.js >= 20.0.0
- pnpm (recommended) or npm

### Installation

```bash
# From the ts-sdk root directory
cd examples/payroll
pnpm install
```

### Development

```bash
pnpm dev
```

Open http://localhost:5173 in your browser.

### Build

```bash
pnpm build
```

## CSV Format

Import recipients using CSV with the following format:

```csv
Address,Amount,Name
ark1q...,100000,Alice
ark1q...,200000,Bob
```

- **Address**: Arkade address (required)
- **Amount**: Amount in satoshis (required)
- **Name**: Optional recipient name

## Architecture

```
src/
├── components/
│   ├── PayrollForm.tsx      # Assistant: Create payrolls
│   ├── PendingPayrolls.tsx  # Admin: View and execute payrolls
│   └── FundingPanel.tsx     # Admin: Fund via Lendaswap
├── services/
│   ├── payroll.ts           # Core payroll service (Arkade SDK)
│   └── lendaswap.ts         # USDT-to-BTC swap service
├── types/
│   └── index.ts             # TypeScript interfaces
├── utils/
│   └── csv.ts               # CSV parsing utilities
├── App.tsx                  # Main application
└── main.tsx                 # Entry point
```

## How It Works

### Creating a Payroll (Assistant)

1. Enter a payroll name
2. Add recipients manually or import from CSV
3. Review total amount and recipient count
4. Submit payroll (creates "pending" status)

### Executing a Payroll (Admin)

1. Switch to Admin view
2. Click on a pending payroll to expand details
3. Click "Execute Payroll"
4. Enter your private key (hex format)
5. Check wallet balance
6. Click "Sign & Execute"

The Arkade SDK handles:
- Selecting available VTXOs as inputs
- Building the transaction with multiple outputs
- Signing with your private key
- Submitting to the Ark server
- Finalizing checkpoint transactions

### Funding via Lendaswap

1. Click "Fund Wallet" in Admin view
2. Enter USDT amount to swap
3. Get a quote showing BTC equivalent
4. Create swap order
5. Send USDT to the HTLC contract on Ethereum
6. Confirm deposit and claim BTC on Arkade

## SDK Integration Points

### Arkade SDK

```typescript
import { Wallet, SingleKey, RestArkProvider, RestIndexerProvider, EsploraProvider } from "@arkade-os/sdk";

// Create wallet from private key
const identity = new SingleKey(privateKeyHex);
const wallet = await Wallet.create({
  identity,
  arkProvider: new RestArkProvider(arkServerUrl),
  indexerProvider: new RestIndexerProvider(indexerUrl),
  onchainProvider: new EsploraProvider(esploraUrl),
});

// Check balance
const balance = await wallet.getBalance();

// Send to single recipient
const txId = await wallet.sendBitcoin({
  address: recipientAddress,
  amount: amountSats,
});

// Send to multiple recipients via settle
const txId = await wallet.settle({
  inputs: [...vtxos, ...boardingUtxos],
  outputs: recipients.map(r => ({
    address: r.address,
    amount: r.amount,
  })),
});
```

### Lendaswap SDK

```typescript
import { Client } from "@lendasat/lendaswap-sdk";

// Get quote for USDT -> BTC
const quote = await client.getQuote('usdt_eth', 'btc_arkade', usdtAmount);

// Create swap order
const swap = await client.createEvmToArkadeSwap({
  user_address: ethereumAddress,
  source_token: 'usdt_eth',
}, 'ethereum');

// Claim BTC after USDT deposit
await client.claimVhtlc(swap.swapId);
```

## Security Notes

- Private keys are used locally for signing and never transmitted
- Payroll data is stored in browser localStorage
- Always verify recipient addresses before executing
- Use testnet for development and testing

## License

MIT
