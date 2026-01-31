---
name: Arkade Bitcoin Wallet
description: Send and receive Bitcoin over Arkade and Lightning. Instant off-chain transactions, on/off ramps, and Lightning Network payments via Boltz swaps.
read_when:
  - User wants to send or receive Bitcoin
  - User wants to pay a Lightning invoice
  - User wants to receive a Lightning payment
  - User wants to check their Bitcoin balance
  - User wants to move funds between on-chain and off-chain
  - User wants to onboard Bitcoin to Arkade
  - User wants to offboard Bitcoin from Arkade to on-chain
  - User asks about Arkade or Ark protocol
metadata: {"emoji":"₿","requires":{"bins":["node","npm"]}}
---

# Arkade Bitcoin Wallet Skill

A Bitcoin wallet for the Arkade protocol with Lightning Network support. Enables instant off-chain transactions and seamless Lightning payments via Boltz submarine swaps.

## Core Capabilities

- **Arkade Transactions**: Instant off-chain Bitcoin transfers via Ark protocol
- **Lightning Payments**: Send and receive via Boltz submarine swaps
- **On/Off Ramps**: Move funds between on-chain Bitcoin and off-chain Arkade
- **Multi-address**: Separate addresses for off-chain (Ark) and on-chain (boarding)

## Quick Setup

```bash
npm install
alias arkade='node cli/arkade.mjs'
arkade init <private-key-hex>
```

Default server: `arkade.computer`

## Commands

### Wallet Management

| Command | Description |
|---------|-------------|
| `arkade init <key> [url]` | Initialize wallet (default: arkade.computer) |
| `arkade address` | Show Ark address (off-chain receiving) |
| `arkade boarding-address` | Show boarding address (on-chain receiving) |
| `arkade balance` | Show balance breakdown |
| `arkade history` | Show transaction history |

### Sending & Receiving

| Command | Description |
|---------|-------------|
| `arkade send <address> <amount>` | Send sats to Ark address |
| `arkade onboard` | Move on-chain funds to Arkade |
| `arkade offboard <btc-address>` | Move Arkade funds to on-chain |

### Lightning Network

| Command | Description |
|---------|-------------|
| `arkade ln-invoice <amount> [desc]` | Create invoice to receive Lightning |
| `arkade ln-pay <bolt11>` | Pay a Lightning invoice |
| `arkade ln-fees` | Show swap fees |
| `arkade ln-limits` | Show min/max swap amounts |
| `arkade ln-pending` | Show pending swaps |

## Example Workflows

### Receive Bitcoin via Arkade
```bash
arkade address
# Share the ark1qq... address with sender
arkade balance  # Check when received
```

### Send Bitcoin via Arkade
```bash
arkade send ark1qq...recipient 50000
# Instant confirmation!
```

### Receive Lightning Payment
```bash
arkade ln-invoice 25000 "Payment for service"
# Share the lnbc... invoice
arkade balance  # Check when received
```

### Pay Lightning Invoice
```bash
arkade ln-pay lnbc50u1pj...
# Payment complete, preimage returned
```

### Onboard from On-chain
```bash
arkade boarding-address
# Send BTC to this address, wait for confirmation
arkade onboard
# Funds now available off-chain!
```

### Offboard to On-chain
```bash
arkade offboard bc1q...your-btc-address
# Funds sent to on-chain address
```

## Data Storage

Wallet data is stored in `~/.arkade-wallet/`:
- `config.json` - Wallet configuration (encrypted key, server URL)

## Technical Details

- Built on `@arkade-os/sdk` for Ark protocol
- Uses `@arkade-os/boltz-swap` for Lightning via Boltz
- Supports mainnet, testnet, signet, and regtest
- Node.js 18+ required
