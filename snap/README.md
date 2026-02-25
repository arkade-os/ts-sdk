# ARK MetaMask Snap

A MetaMask Snap for Bitcoin Taproot operations with ARK protocol integration.

## Overview

This snap enables:

- Bitcoin Taproot address generation using MetaMask entropy
- PSBT signing for ARK protocol transactions
- Secure key management within MetaMask sandbox
- User confirmation for all signing operations

## Development

### Prerequisites

- MetaMask Flask or development build
- Node.js 18+
- pnpm package manager

### Setup

```bash
# Install dependencies
pnpm install

# Build snap
pnpm build

# Start development server
pnpm serve
```

The snap will be available at `http://localhost:8080`.

### Local Testing

1. Install MetaMask Flask
2. Navigate to snap development server
3. Connect from a dApp using the local snap URL

## API

### `bitcoin_getAccounts`

Returns Bitcoin addresses and public keys.

```javascript
const result = await ethereum.request({
  method: 'wallet_invokeSnap',
  params: {
    snapId: 'local:http://localhost:8080',
    request: { method: 'bitcoin_getAccounts' }
  }
});
```

### `bitcoin_signPsbt`

Signs a PSBT with user confirmation.

```javascript
const result = await ethereum.request({
  method: 'wallet_invokeSnap',
  params: {
    snapId: 'local:http://localhost:8080',
    request: {
      method: 'bitcoin_signPsbt',
      params: { psbt: 'base64-encoded-psbt' }
    }
  }
});
```

## Architecture

- **Entry Point**: `src/index.ts`
- **Key Management**: Deterministic derivation from MetaMask entropy
- **Security**: All operations require user approval
- **Network**: Bitcoin Signet for safe testing

## Security Model

- Private keys never leave the snap environment
- All signing requires explicit user confirmation
- No external network access from snap
- Uses MetaMask's security sandbox
