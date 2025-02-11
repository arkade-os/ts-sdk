import { InMemoryKey } from "./core/identity";
import { ArkAddress } from "./core/address";
import { VtxoTapscript } from "./core/tapscript";
import { Wallet } from "./core/wallet";
import type { WalletConfig } from "./types/wallet";
import { ESPLORA_URL } from "./providers/esplora";

export type { WalletConfig };
export { Wallet, InMemoryKey, ESPLORA_URL, ArkAddress, VtxoTapscript };
