# ARK SDK Xverse Wallet Integration Example

This example demonstrates how to integrate the ARK SDK with Xverse wallet using sats-connect for external wallet signing.

## Overview

This React app shows how to:

- Connect to Xverse browser extension wallet
- Use external wallet signing instead of in-memory private keys
- Send Bitcoin transactions through ARK's collaborative transaction protocol
- Handle wallet connection states and errors

## Architecture

The example implements a custom `SatsConnectIdentity` class that:

- Implements the ARK SDK's `Identity` interface
- Uses sats-connect's `signPsbt` method for transaction signing
- Converts ARK transactions to PSBT format for wallet compatibility
- Handles wallet responses and error states

## Prerequisites

### 1. Install Xverse Wallet

- Install [Xverse browser extension](https://chrome.google.com/webstore/detail/xverse-wallet/idnnbdplmphpflfnlkomgpfbpcgelopg)
- Create a wallet or import an existing one
- Switch to **Bitcoin Signet** network (Settings → Network → Signet)

### 2. Get Signet Bitcoin

- Use a signet faucet to get test Bitcoin
- Send some sats to your Xverse wallet's payment address

### 3. Setup Development Environment

```bash
# Navigate to the example directory
cd examples/xverse-react-app

# Install dependencies
npm install

# Start the development server
npm run dev
```

## Testing Instructions

### 1. Connect Wallet

1. Open the app in your browser (usually `http://localhost:5173`)
2. Click "Connect Xverse Wallet"
3. Approve the connection request in the Xverse popup
4. You should see your wallet address and balance displayed

### 2. Send Bitcoin via ARK

1. Enter a recipient Bitcoin address (Signet network)
2. Enter an amount (make sure you have enough balance + fees)
3. Click "Send Bitcoin via ARK"
4. **First time**: Xverse will prompt to sign the funding transaction
5. **Second prompt**: Xverse will prompt to sign the ARK round transaction
6. Check the console for detailed transaction logs

### 3. Expected Flow

```md
1. App connects to Xverse wallet ✅
2. App creates ARK wallet instance ✅
3. User initiates Bitcoin send ✅
4. ARK SDK creates funding transaction ✅
5. Xverse signs funding transaction ✅
6. ARK SDK submits to server ✅
7. ARK server creates collaborative round ✅
8. ARK SDK receives round transaction ✅
9. Xverse signs round transaction ✅
10. Transaction is broadcast ✅
```

## Key Files

### `SatsConnectIdentity.js`

Custom identity provider that integrates with Xverse wallet:

```javascript
// Implements ARK SDK Identity interface
class SatsConnectIdentity {
  async sign(tx, inputIndexes) {
    // Converts transaction to PSBT
    // Uses sats-connect to request wallet signature
    // Returns signed transaction
  }
}
```

### `ArkWallet.js`

Wrapper that combines ARK SDK with Xverse wallet:

```javascript
// Creates ARK wallet with external signer
const arkWallet = new Wallet({
  identity: new SatsConnectIdentity(address, publicKey, request),
  // ... other config
});
```

## Network Configuration

The example is configured for **Bitcoin Signet**:

- ARK Server: Points to Signet ARK coordinator
- Wallet Connection: Requests Signet network
- All transactions use Signet Bitcoin

To change networks, update:

1. `ArkWallet.js` - ARK server URL
2. `ArkWallet.js` - sats-connect network parameter
3. Switch your Xverse wallet to the same network

## Development

### Debug Mode

The app includes comprehensive logging. Check browser console for:

- Wallet connection status
- Transaction details
- PSBT data
- ARK server responses
- Signing attempts

### Testing Different Scenarios

1. **Disconnect wallet**: Refresh page and try operations
2. **Insufficient funds**: Try sending more than balance
3. **Invalid address**: Use mainnet address on signet
4. **Cancel signing**: Click cancel in Xverse popup

## Code Structure

```bash
src/
├── App.jsx              # Main React component
├── ArkWallet.js         # ARK + Xverse integration
├── SatsConnectIdentity.js # External wallet identity
└── SatsConnectDebugger.js # Debugging utilities
```

## Integration with Your App

To integrate this pattern into your own app:

1. **Copy the identity provider**:

   ```bash
   cp src/SatsConnectIdentity.js your-app/src/
   ```

2. **Install dependencies**:

   ```bash
   npm install sats-connect @arkosdao/ts-sdk
   ```

3. **Use the pattern**:

```javascript
   import { SatsConnectIdentity } from './SatsConnectIdentity';
   import { Wallet } from '@arkosdao/ts-sdk';
   
   // Connect wallet
   const response = await request('wallet_connect', {
     addresses: ['payment', 'ordinals'],
     network: 'Signet'
   });
   
   // Create identity
   const identity = new SatsConnectIdentity(
     paymentAddress,
     publicKey,
     request
   );
   
   // Create ARK wallet
   const arkWallet = new Wallet({ identity });
   ```