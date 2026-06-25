# ARK MetaMask Snap Demo

A React application demonstrating ARK wallet integration using MetaMask Snap for Bitcoin Taproot operations.

## Overview

This demo showcases:

- MetaMask Snap integration for Bitcoin signing
- Taproot address generation and management
- ARK protocol transactions (send, settle, balance management)
- Secure signing without exposing private keys

## Prerequisites

- MetaMask browser extension
- Node.js 18+
- pnpm package manager

## Quick Start

### 1. Install Dependencies

```bash
# Install snap dependencies
cd ../../snap
pnpm install

# Install app dependencies  
cd ../examples/metamask-react-app
pnpm install
```

### 2. Build and Start the Snap

```bash
cd ../../snap
pnpm build
pnpm serve
```

The snap development server will start on `http://localhost:8080`.

### 3. Start the React App

```bash
cd ../examples/metamask-react-app
pnpm dev
```

The app will be available at `http://localhost:5173`.

### 4. Connect and Use

1. Open the app in your browser
2. Click "Connect MetaMask Snap"
3. Approve the snap installation in MetaMask
4. Your Taproot and ARK addresses will be displayed
5. Use the app to check balances and send transactions

## Features

- **Secure Key Management**: Private keys remain in MetaMask Snap
- **Taproot Addresses**: Native Taproot address generation
- **ARK Integration**: Full ARK protocol support (send, settle, balance)
- **User Confirmation**: All transactions require MetaMask approval
- **Signet Network**: Uses Bitcoin Signet for safe testing

## Architecture

### MetaMask Snap (`/snap/`)

- Deterministic key derivation from MetaMask entropy
- PSBT signing for Taproot transactions
- RPC interface for dApp communication

### React App

- MetaMaskSnapIdentity: Drop-in replacement for other wallet identities
- ArkWallet: Simplified wallet management interface
- Real-time balance and transaction updates

## Development

The snap runs locally during development. For production:

1. Publish snap to npm
2. Update snap manifest with production details
3. Use production snap ID in the React app

## Network Configuration

- **Bitcoin Network**: Signet (testnet)
- **ARK Server**: `https://signet.arkade.sh`
- **Block Explorer**: `https://mempool.space/signet/`

Get testnet Bitcoin from [Signet faucets](https://signet.bc-2.jp/) for testing.
