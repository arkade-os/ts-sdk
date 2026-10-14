import { MnemonicIdentity, InMemoryWalletRepository } from "../../src";
import { HDDescriptorProvider } from "../../src/wallet/hdDescriptorProvider";

const TEST_MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/**
 * Construct a fresh {@link HDDescriptorProvider} backed by an in-memory
 * repository and the standard test mnemonic on testnet. Used by unit tests
 * that exercise the provider API directly without standing up a full Wallet.
 */
export async function makeHdProviderForTest(): Promise<HDDescriptorProvider> {
    const identity = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
        isMainnet: false,
    });
    const walletRepository = new InMemoryWalletRepository();
    return HDDescriptorProvider.create(identity, walletRepository);
}
