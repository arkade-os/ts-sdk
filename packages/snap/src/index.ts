import type { OnRpcRequestHandler } from "@metamask/snaps-sdk";

import { getAddress, getPublicKey, signPsbt } from "./wallet";

/**
 * Handle incoming JSON-RPC requests from dapps.
 *
 * This snap provides a simple Bitcoin signing interface:
 * - arkade_getPublicKey: Get the snap's public keys
 * No params required
 * Returns: { compressedPublicKey: string, xOnlyPublicKey: string }
 * - arkade_getAddress: Get the Bitcoin Arkade address
 * Params: { network: NetworkName, operatorUrl?: string }
 * - network: 'bitcoin' | 'testnet' | 'signet' | 'mutinynet' | 'regtest'
 * - operatorUrl: required where no operator is built in (bitcoin and mutinynet have one); the
 *   user approves an operator that is not built in, once per origin and operator key
 * Returns: { address: string }
 * - arkade_signPsbt: Sign a PSBT with the snap's key
 * Params: { psbt: string, inputIndexes: number[], network: NetworkName, operatorUrl?: string }
 * - psbt: Base64-encoded PSBT
 * - inputIndexes: Array of input indexes to sign (non-negative integers)
 * - network, operatorUrl: as for arkade_getAddress; the prompt names every output with them
 * Returns: { psbt: string }
 *
 * All wallet logic (balance, transactions, Lightning) runs in the dapp using Arkade SDK.
 * All parameters are validated inside the handler functions.
 * @param args - RPC request arguments.
 * @param args.origin - The origin of the request.
 * @param args.request - The JSON-RPC request object.
 * @returns The result of the RPC method.
 */
export const onRpcRequest: OnRpcRequestHandler = async ({ origin, request }) => {
    switch (request.method) {
        case "arkade_getPublicKey":
            // No params required
            return await getPublicKey();

        case "arkade_getAddress":
            // Params validated inside getAddress, which asks the user about an unknown operator.
            return await getAddress(request.params, origin);

        case "arkade_signPsbt":
            // Params validated inside signPsbt, which also prompts the user for
            // confirmation and shows them the requesting origin.
            return await signPsbt(request.params, origin);

        default:
            throw new Error(`Method not found: ${request.method}`);
    }
};
