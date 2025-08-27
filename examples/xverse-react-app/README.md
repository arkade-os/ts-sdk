# ARK Xverse Wallet - React App

A simplified React application for connecting to Xverse wallet and creating ARK cooperative transactions.

## Overview

This React app demonstrates how to:
- Connect to Xverse Bitcoin wallet using `sats-connect`
- Create ARK multisig addresses using external wallet signing
- Sign cooperative transactions for the ARK protocol with proper wallet integration
- Handle wallet interactions in a modern React interface

## Key Features

### 🔐 **Proper Wallet Integration**
- **SatsConnectIdentity** - Custom identity provider that uses wallet's `signPsbt` method
- **No private key exposure** - all signing happens in the user's wallet
- **Secure transaction signing** - leverages browser extension security model

### 🎯 **Simplified Architecture**
- **Single wallet class** (`ArkWallet.js`) handles all wallet operations
- **Clean React hooks** for state management
- **External wallet identity** (`SatsConnectIdentity.js`) for proper signing

### 🧹 **Cleaner Code**
- **No more DOM manipulation** - pure React components
- **Declarative UI** - state drives the interface
- **Better error handling** with consistent status messages
- **Type-safe interactions** with proper validation

### 🚀 **Better User Experience**
- **Real-time status updates** with loading states
- **Form validation** prevents invalid transactions
- **Responsive design** works on mobile and desktop
- **Clear visual hierarchy** with modern styling

### 🔧 **Simplified Dependencies**
- Only core libraries: `react`, `sats-connect`, `@scure/base`, `@scure/btc-signer`
- No additional utility classes or complex file structure
- Modern Vite build system for fast development

## Architecture

```
src/
├── main.jsx               # React entry point
├── App.jsx                # Main application component
├── ArkWallet.js           # Simplified wallet provider
├── SatsConnectIdentity.js # External wallet identity implementation
└── index.css              # Styling
```

## Key Components

### SatsConnectIdentity Class
A custom identity provider that implements the ARK SDK's Identity interface using sats-connect's `signPsbt` method:

- **Proper wallet integration** - uses the browser extension's signing capabilities
- **No private key handling** - public key only approach
- **Compatible with ARK SDK** - implements the required Identity interface

### ArkWallet Class
- **`connect()`** - Connect to Xverse and create ARK address using SatsConnectIdentity
- **`signTransaction()`** - Create and sign cooperative transactions
- **`getDebugInfo()`** - Wallet detection and debugging

### React App Component
- **Wallet connection** with loading states
- **Transaction creation** with form validation
- **Status logging** for user feedback
- **Debug information** for troubleshooting

## Usage

1. **Install dependencies:**
   ```bash
   pnpm install
   ```

2. **Start development server:**
   ```bash
   pnpm dev
   ```

3. **Connect Xverse wallet:**
   - Install Xverse browser extension
   - Click "Connect Xverse Wallet"
   - Approve connection in Xverse popup

4. **Create transactions:**
   - Enter recipient address (Bitcoin or ARK format)
   - Enter amount in satoshis
   - Click "Sign Cooperative Transaction"
   - Copy resulting PSBT for ARK server submission

## Technical Details

### ARK Address Generation
- Creates 2-of-2 multisig with user + ARK server public keys
- Uses Taproot with script tree for efficient transactions
- Encodes with 'tark' prefix for signet testnet

### Transaction Signing
- Creates demo transaction with mock UTXO
- Uses `sats-connect` for Xverse integration
- Returns PSBT in base64 format for server submission

### Supported Address Formats
- **Bitcoin addresses** (P2PKH, P2SH, P2WPKH, P2WSH, P2TR)
- **ARK addresses** (tark/ark bech32m format)

## Development

### Build for production:
```bash
pnpm build
```

### Preview production build:
```bash
pnpm preview
```

### Lint code:
```bash
pnpm lint
```

## Comparison with Original

| Aspect | Original (Vanilla JS) | New (React) |
|--------|----------------------|-------------|
| **Lines of code** | ~400 lines across 4 files | ~250 lines across 3 files |
| **State management** | Manual DOM updates | React hooks |
| **Error handling** | Try/catch + DOM updates | Unified status system |
| **UI updates** | Direct DOM manipulation | Declarative React |
| **Code organization** | Multiple utility classes | Single wallet class |
| **Type safety** | None | Better validation |
| **Development** | Manual refresh | Hot reload |
| **Build** | No build step | Optimized Vite build |

## Dependencies

- **React 18** - Modern React with hooks
- **sats-connect 3.x** - Xverse wallet integration
- **@scure/btc-signer** - Bitcoin transaction creation
- **@scure/base** - Encoding utilities
- **Vite** - Fast build tool and dev server

The React version is significantly cleaner, more maintainable, and provides a better developer and user experience while maintaining all the core functionality of the original implementation.
