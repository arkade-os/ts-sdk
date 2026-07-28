# @arkade-os/checkout

Next.js package for Checkout widget that accepts Lightning payments with a hosted UI. It uses Arkade SDK, Vercel functions and Boltz reverse swaps to create a seamless payment experience.

## Installation

```bash
npm install @arkade-os/checkout
```

## Quick Start

### 1. Generate Credentials

```bash
node ./node_modules/@arkade-os/checkout/cli/create.js
```

This creates `.env.local` with your private key and configuration:

```env
ARKADE_PRIVATE_KEY_HEX=your_private_key
ARKADE_SERVER_URL=https://arkade.computer
BOLTZ_API_URL=https://api.ark.boltz.exchange
ARKADE_NETWORK=bitcoin
```

### 2. Add API Route

Create `app/api/arkade/[[...path]]/route.ts`:

```ts
export { POST, GET } from "@arkade-os/checkout/server/route";
```

### 3. Add Checkout Page

Create `app/checkout/[id]/page.tsx`:

```tsx
"use client";
import { Checkout } from "@arkade-os/checkout";

export default function CheckoutPage({ params }: { params: { id: string } }) {
  return <Checkout id={params.id} />;
}
```

### 4. Use the Hook

```jsx
"use client";
import { useCheckout } from "@arkade-os/checkout";

export default function HomePage() {
  const { navigate, isNavigating } = useCheckout();

  return (
    <button
      onClick={() => navigate({
        title: "Premium Plan",
        description: "1 year subscription",
        amount: 50,
        currency: "USD",
        metadata: { successUrl: "/success" }
      })}
      disabled={isNavigating}
    >
      Buy Now
    </button>
  );
}
```

### 5. Optional: Add Next.js Plugin

In `next.config.mjs`:

```js
import withArkadeCheckout from "@arkade-os/checkout/next-plugin";

export default withArkadeCheckout({});
```

## API Reference

### `useCheckout()`

React hook for creating and navigating to checkout pages.

```typescript
const { navigate, isNavigating } = useCheckout();

await navigate({
  title: string;           // Checkout title
  description: string;     // Payment description
  amount: number;          // Amount in specified currency
  currency: 'USD' | 'BTC' | 'SAT';
  metadata?: {
    successUrl?: string;   // Redirect after payment
    [key: string]: any;    // Custom metadata
  };
});
```

### `<Checkout />`

Pre-built checkout UI component with QR code and payment tracking.

```tsx
<Checkout id={checkoutId} />
```

### Server Routes

The unified route handler provides three endpoints:

- `POST /api/arkade/create` - Create new checkout
- `POST /api/arkade/claim` - Claim payment (long-running)
- `GET /api/arkade/status?id={id}` - Check payment status

## Environment Variables

### Production (Mainnet) - Default

```env
ARKADE_SERVER_URL=https://arkade.computer
BOLTZ_API_URL=https://api.ark.boltz.exchange
ARKADE_NETWORK=bitcoin
```

### Development (Testnet)

```env
ARKADE_SERVER_URL=https://mutinynet.arkade.sh
BOLTZ_API_URL=https://api.boltz.mutinynet.arkade.sh
ARKADE_NETWORK=mutinynet
```

### Optional: Vercel KV

For production deployments with persistent storage:

```env
KV_REST_API_URL=your_vercel_kv_url
KV_REST_API_TOKEN=your_vercel_kv_token
```

Without Vercel KV, the package uses in-memory storage (not recommended for production).

## How It Works

1. Create invoice - Generates Lightning invoice via Arkade SDK + Boltz reverse swap
2. Display QR - Shows invoice QR code and payment details to user
3. Auto-claim - Background process waits for payment and claims to Arkade wallet
4. Status polling - Frontend polls for payment confirmation
5. Redirect - Optionally redirects to success URL after payment

## Architecture

```text
┌─────────────┐
│  Next.js    │
│  Frontend   │
└──────┬──────┘
       │
       │ useCheckout()
       ▼
┌─────────────┐      ┌──────────────┐
│   API       │─────▶│   Arkade     │
│   Routes    │      │   SDK        │
└─────────────┘      └──────┬───────┘
       │                    │
       │                    ▼
       │             ┌──────────────┐
       │             │    Boltz     │
       └────────────▶│    Swaps     │
                     └──────────────┘
```

## Security

- Private Key - Stored in `.env.local`, never exposed to client
- Backup - Key automatically backed up to `~/.arkade-checkout/key.txt`
- Server-side - All wallet operations happen server-side only

## Troubleshooting

### "Private key not found"

Make sure `.env.local` exists with `ARKADE_PRIVATE_KEY_HEX`. Run `node ./node_modules/@arkade-os/checkout/cli/create.js` to generate.

### "Checkout not found"

Using in-memory storage restarts on each deploy. For production, configure Vercel KV.

### Payments not claiming

Check that:

- Private key has Arkade balance for swap fees
- Boltz API URL is correct for your network
- Server function has sufficient timeout (5 minutes recommended)

## Examples

See the example app in `apps/checkout`.

## License

MIT
