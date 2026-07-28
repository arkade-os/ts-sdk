# VSS (Verifiable Secret Sharing) Setup

This guide explains how to configure the Arkade Checkout to use VSS for secure private key management in serverless environments.

## Overview

The checkout system supports fetching the private key from a VSS (Verifiable Secret Sharing) service instead of storing it directly in environment variables. This is especially useful for production deployments where you want to keep private keys secure and separate from your application configuration.

## Features

### 1. VSS Private Key Fetching

The system can fetch the Arkade private key from a VSS service:

- Automatic fallback: Falls back to `ARKADE_PRIVATE_KEY_HEX` if VSS is not enabled
- Caching: Caches the private key for 5 minutes to avoid repeated VSS calls
- Error handling: Proper error messages if VSS configuration is missing or fails

### 2. Webhook System for Background Claims

When users close the checkout page before payment is confirmed, the system automatically:

- Sends a webhook to trigger the claim process in the background
- Keeps the serverless function active to complete the claim
- Ensures payments are captured even if the user navigates away

## Environment Variables

### Required for VSS Mode

Set these environment variables in your Vercel project:

```bash
# Enable VSS mode
ARKADE_USE_VSS=true

# VSS service endpoint
VSS_URL=https://your-vss-service.com/api

# VSS key identifier
VSS_KEY_ID=your-key-id

# VSS authentication token (optional, if your VSS service requires auth)
VSS_AUTH_TOKEN=your-auth-token
```

### Fallback Mode (Without VSS)

If you don't want to use VSS, simply don't set `ARKADE_USE_VSS=true` and provide:

```bash
# Direct private key (hex format)
ARKADE_PRIVATE_KEY_HEX=your-private-key-hex
```

### Other Configuration

```bash
# Arkade server URL (optional, defaults to https://arkade.computer)
ARKADE_SERVER_URL=https://arkade.computer

# Boltz API URL (optional, defaults to https://api.ark.boltz.exchange)
BOLTZ_API_URL=https://api.ark.boltz.exchange

# Network (optional, defaults to bitcoin)
ARKADE_NETWORK=bitcoin

# Vercel KV for storage (recommended for production)
KV_REST_API_URL=your-vercel-kv-url
KV_REST_API_TOKEN=your-vercel-kv-token
```

## VSS Service API Requirements

Your VSS service must implement the following API:

### GET /secrets/{keyId}

Request:

```
GET /secrets/{keyId}
Authorization: Bearer {token}  (if VSS_AUTH_TOKEN is set)
Content-Type: application/json
```

Response (example):

```json
{
  "value": "private-key-in-hex-format"
}
```

The response must contain the private key in one of these fields: `value`, `secret`, or `privateKey`.

## How It Works

### 1. Private Key Fetching

When a checkout is created or claimed:

1. The system checks if `ARKADE_USE_VSS=true`
2. If yes, it fetches the private key from VSS
3. The key is cached for 5 minutes to reduce VSS calls
4. If VSS is disabled, it uses `ARKADE_PRIVATE_KEY_HEX` from environment

### 2. Background Claim Process

When a user closes the checkout page:

1. The browser sends a `beforeunload` event
2. A webhook is sent to `/api/arkade/webhook` with `event: "page_closed"`
3. The webhook triggers the claim process in the background
4. The serverless function stays active (up to 5 minutes) to complete the claim
5. When payment is received, the function claims it to the Arkade wallet

## Webhook Events

### Page Closed Event

Triggered when user closes the page with a pending payment:

```typescript
POST /api/arkade/webhook
{
  "checkoutId": "payment-hash",
  "event": "page_closed"
}
```

### Keep Alive Event (Future Enhancement)

For keeping functions warm:

```typescript
POST /api/arkade/webhook
{
  "checkoutId": "payment-hash",
  "event": "keep_alive"
}
```

## Deployment

### Vercel

1. Add all required environment variables to your Vercel project settings
2. Deploy your application
3. The webhook will automatically use the Vercel URL

### Local Development

For local development without VSS:

```bash
# .env.local
ARKADE_PRIVATE_KEY_HEX=your-dev-private-key
ARKADE_SERVER_URL=https://arkade.computer
ARKADE_NETWORK=bitcoin
```

## Security Considerations

1. Never commit private keys to your repository
2. Use VSS in production to keep keys separate from application config
3. Rotate keys regularly if using the fallback mode
4. Enable authentication on your VSS service with `VSS_AUTH_TOKEN`
5. Monitor VSS access to detect unauthorized key fetches

## Troubleshooting

### "VSS request failed"

- Check that `VSS_URL` is correct and accessible
- Verify `VSS_AUTH_TOKEN` if your service requires authentication
- Check VSS service logs for errors

### "VSS response does not contain private key"

- Ensure your VSS service returns the key in `value`, `secret`, or `privateKey` field
- Check the VSS response format

### "ARKADE_PRIVATE_KEY_HEX environment variable is not set"

- If VSS is disabled, you must set `ARKADE_PRIVATE_KEY_HEX`
- Or enable VSS mode with proper configuration

### Webhook not triggering

- Check browser console for beacon errors
- Verify `/api/arkade/webhook` endpoint is accessible
- Check serverless function logs
