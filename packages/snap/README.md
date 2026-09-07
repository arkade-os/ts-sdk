# Arkade Wallet Snap

A MetaMask Snap that brings Bitcoin Layer 2 functionality to your browser via the Ark protocol. This snap enables instant off-chain Bitcoin transactions (VTXOs), Lightning Network payments, and self-custodial Bitcoin management.

![npm version](https://img.shields.io/npm/v/@arkade-os/packages)
![license](https://img.shields.io/npm/l/@arkade-os/packages)

## Features

- **Bitcoin Key Management** - Secure key derivation using MetaMask's entropy
- **Ark Protocol Support** - Off-chain Bitcoin transactions (VTXOs) that settle instantly
- **Lightning Network** - Pay and receive Lightning invoices via submarine swaps
- **Self-Custodial** - Your keys, your Bitcoin - no third-party custody
- **Minimal & Secure** - Focused on signing operations only, keys never leave the snap

## Installation

### Prerequisites

- [MetaMask Flask](https://metamask.io/flask/) - Developer version of MetaMask

### Install the Snap

```javascript
await ethereum.request({
  method: 'wallet_requestSnaps',
  params: {
    'npm:@arkade-os/packages': {}
  }
});
```

## Usage

The Arkade Wallet Snap provides a minimal signing interface with 3 focused RPC methods:

### Get Public Key

```javascript
const response = await ethereum.request({
  method: 'wallet_invokeSnap',
  params: {
    snapId: 'npm:@arkade-os/packages',
    request: {
      method: 'arkade_getPublicKey'
    }
  }
});

// Returns:
// {
//   compressedPublicKey: "02...",  // 33 bytes hex
//   xOnlyPublicKey: "..."           // 32 bytes hex
// }
```

### Get Ark Address

```javascript
const response = await ethereum.request({
  method: 'wallet_invokeSnap',
  params: {
    snapId: 'npm:@arkade-os/packages',
    request: {
      method: 'arkade_getAddress',
      params: {
        network: 'bitcoin',              // 'bitcoin' | 'testnet' | 'signet' | 'mutinynet' | 'regtest'
        signerPubkey: '...',             // Server's x-only public key (64 hex chars)
        unilateralExitDelay: '512'       // CSV timelock value from server
      }
    }
  }
});

// Returns:
// {
//   address: "ark1..."  // Bech32m-encoded Ark address
// }
```

### Sign PSBT

```javascript
const response = await ethereum.request({
  method: 'wallet_invokeSnap',
  params: {
    snapId: 'npm:@arkade-os/packages',
    request: {
      method: 'arkade_signPsbt',
      params: {
        psbt: 'cHNidP8B...',       // Base64-encoded PSBT
        inputIndexes: [0, 1]        // Indexes of inputs to sign
      }
    }
  }
});

// Returns:
// {
//   psbt: 'cHNidP8B...'  // Base64-encoded signed PSBT
// }
```

## Architecture

This snap uses a **simplified provider pattern** where the snap only handles Bitcoin key management and signing operations. All wallet logic (balance queries, transaction history, Lightning operations) runs in your frontend application using the [Arkade SDK](https://www.npmjs.com/package/@arkade-os/sdk).

```
┌─────────────────────────────────────────┐
│  Your Dapp                              │
│  ┌────────────────────────────────┐    │
│  │ Arkade SDK Wallet              │    │
│  │  - Balance queries             │    │
│  │  - Transaction history         │    │
│  │  - Lightning operations        │    │
│  │  - VTXO management             │    │
│  └──────────┬─────────────────────┘    │
│             │                            │
│             │ (signing requests only)    │
│             ▼                            │
│  ┌────────────────────────────────┐    │
│  │ Arkade Wallet Snap             │    │
│  │  - arkade_getPublicKey()       │    │
│  │  - arkade_getAddress()         │    │
│  │  - arkade_signPsbt()           │    │
│  └────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

### Benefits

- **Simpler** - Minimal codebase focused on key operations
- **Faster** - No RPC overhead for data queries
- **More Secure** - Minimal attack surface, keys never leave snap
- **More Flexible** - Update wallet logic without snap rebuild

## Integration with Arkade SDK

To use this snap in your application, integrate it with the Arkade SDK using the `MetaMaskSnapIdentity` provider:

```typescript
import { Wallet } from '@arkade-os/sdk';
import { MetaMaskSnapIdentity } from './MetaMaskSnapIdentity';

// Create identity provider
const identity = new MetaMaskSnapIdentity(
  'npm:@arkade-os/packages',
  ethereum
);

// Create Arkade wallet
const wallet = new Wallet({
  identity,
  esploraUrl: 'https://blockstream.info/api',
  arkServerUrl: 'https://ark.arkadeos.com'
});

// Use wallet methods
const balance = await wallet.getBalance();
const address = await wallet.getAddress();
```

For a complete implementation example, see the [reference dapp](https://github.com/arkade-os/packages/tree/master/packages/site).

## Permissions

This snap requires the following MetaMask permissions:

- **`snap_getEntropy`** - Derive deterministic Bitcoin keys from MetaMask entropy
- **`endowment:rpc`** - Accept RPC calls from dapps
- **`endowment:network-access`** - Connect to Ark servers (for address validation)
- **`snap_manageState`** - Persist configuration

## Security

- Private keys are **never exposed** to your dapp
- Keys are derived deterministically from MetaMask's entropy
- All signing operations happen within the snap's sandboxed environment
- No key storage - keys derived on-demand

## Development

### Build from Source

```bash
git clone https://github.com/arkade-os/packages.git
cd arkade-snap/packages/snap
pnpm install
pnpm build
```

### Run Tests

```bash
pnpm test
```

### Local Development

```bash
pnpm start
# Snap serves at http://localhost:8080
```

## Resources

- [Arkade OS Documentation](https://arkadeos.com)
- [Arkade SDK on npm](https://www.npmjs.com/package/@arkade-os/sdk)
- [MetaMask Snaps Documentation](https://docs.metamask.io/snaps/)
- [GitHub Repository](https://github.com/arkade-os/packages)
- [Example Dapp](https://github.com/arkade-os/packages/tree/master/packages/site)

## Support

- **Issues**: [GitHub Issues](https://github.com/arkade-os/packages/issues)
- **Documentation**: [Arkade Docs](https://arkadeos.com)
- **Community**: [Discord](https://discord.gg/arkade) (replace with actual link)

## License

MIT License - see [LICENSE](https://github.com/arkade-os/packages/blob/master/LICENSE) for details

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

Built with [MetaMask Snaps SDK](https://docs.metamask.io/snaps/) and [Arkade SDK](https://www.npmjs.com/package/@arkade-os/sdk)
