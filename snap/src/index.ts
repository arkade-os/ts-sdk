import type { OnRpcRequestHandler } from '@metamask/snaps-sdk';
import { panel, text, heading, copyable } from '@metamask/snaps-sdk';
import { Transaction, p2tr } from '@scure/btc-signer';
import { hex, base64 } from '@scure/base';
import { networks } from '@arkade-os/sdk';

declare const snap: any;

/**
 * Derive a private key from MetaMask's entropy for Bitcoin operations.
 */
async function derivePrivateKey(): Promise<Uint8Array> {
  const entropy = await snap.request({
    method: 'snap_getEntropy',
    params: {
      version: 1,
      salt: 'bitcoin-arkade-snap',
    },
  });

  return hex.decode(entropy.slice(2, 66)); // Remove 0x prefix and take first 32 bytes
}

/**
 * Get account info with public keys and Taproot address
 */
async function getAccountInfo() {
  const privateKey = await derivePrivateKey();
  
  const { secp256k1 } = await import('@noble/curves/secp256k1');
  const publicKeyPoint = secp256k1.getPublicKey(privateKey, false);
  const xOnlyPublicKey = publicKeyPoint.slice(1, 33); // Remove 0x04 prefix for x-only
  
  const taprootScript = p2tr(xOnlyPublicKey, undefined, networks.signet);
  const taprootAddress = taprootScript.address;
  
  return {
    privateKey,
    xOnlyPublicKey: hex.encode(xOnlyPublicKey),
    taprootAddress,
  };
}

/**
 * Parse and validate a PSBT
 */
function parsePsbt(psbtBase64: string) {
  try {
    const psbtBytes = base64.decode(psbtBase64);
    return Transaction.fromPSBT(psbtBytes);
  } catch (error) {
    throw new Error(`Invalid PSBT: ${error.message}`);
  }
}

/**
 * Sign a PSBT - adds signatures without finalizing (ARK operator will finalize)
 */
async function signPsbt(psbtBase64: string, inputIndexes?: number[]) {
  const accountInfo = await getAccountInfo();
  const privateKey = accountInfo.privateKey;
  
  const tx = parsePsbt(psbtBase64);
  const inputCount = tx.inputsLength;
  const signIndexes = inputIndexes || Array.from({ length: inputCount }, (_, i) => i);
  
  const confirmed = await snap.request({
    method: 'snap_dialog',
    params: {
      type: 'confirmation',
      content: panel([
        heading('Sign Bitcoin Transaction'),
        text(`Sign ${inputCount} input(s) for ARK transaction`),
        text(`Signing inputs: ${signIndexes.join(', ')}`),
        text(`Public key: ${accountInfo.xOnlyPublicKey.substring(0, 16)}...`),
        copyable(psbtBase64),
      ]),
    },
  });

  if (!confirmed) {
    throw new Error('User rejected the signing request');
  }

  const txCopy = tx.clone();
  
  // Add signatures to specified inputs (no finalization - ARK operator handles that)
  for (const inputIndex of signIndexes) {
    if (inputIndex >= inputCount) {
      throw new Error(`Input index ${inputIndex} out of range`);
    }
    
    try {
      const result = txCopy.signIdx(privateKey, inputIndex);
      if (!result) {
        console.warn(`Could not sign input ${inputIndex} - may not be owned by this key`);
      }
    } catch (error) {
      console.warn(`Skipping input ${inputIndex}: ${error.message}`);
    }
  }
  
  return base64.encode(txCopy.toPSBT());
}

/**
 * Handle RPC requests from dApps
 */
export const onRpcRequest: OnRpcRequestHandler = async ({ request }) => {
  switch (request.method) {
    case 'bitcoin_getAccounts': {
      try {
        const accountInfo = await getAccountInfo();
        return {
          accounts: [
            {
              address: accountInfo.taprootAddress,
              publicKey: accountInfo.xOnlyPublicKey,
              xOnlyPublicKey: accountInfo.xOnlyPublicKey,
              addressType: 'p2tr',
            },
          ],
        };
      } catch (error) {
        throw new Error(`Failed to get accounts: ${error.message}`);
      }
    }

    case 'bitcoin_getPublicKey': {
      try {
        const accountInfo = await getAccountInfo();
        return {
          publicKey: accountInfo.xOnlyPublicKey,
          xOnlyPublicKey: accountInfo.xOnlyPublicKey,
          address: accountInfo.taprootAddress,
        };
      } catch (error) {
        throw new Error(`Failed to get public key: ${error.message}`);
      }
    }

    case 'bitcoin_signPsbt': {
      const { psbt, inputIndexes } = request.params as {
        psbt: string;
        inputIndexes?: number[];
      };

      if (!psbt) {
        throw new Error('PSBT is required');
      }

      try {
        const signedPsbt = await signPsbt(psbt, inputIndexes);
        return { psbt: signedPsbt };
      } catch (error) {
        if (error.message.includes('User rejected')) {
          const rejectionError = new Error('User rejected the request') as any;
          rejectionError.code = 4001;
          throw rejectionError;
        }
        throw error;
      }
    }

    default:
      throw new Error(`Method not found: ${request.method}`);
  }
};
