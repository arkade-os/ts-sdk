import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { Identity } from "../identity";
import { ContractRepository } from "../repositories/contractRepository";
import { DescriptorProvider } from "../identity/descriptorProvider";
import {
    DescriptorSigningProviderMissingError,
    MissingSigningDescriptorError,
} from "./signingErrors";

export interface InputSigningJob {
    /** Index in the source transaction. */
    index: number;
    /**
     * Script used to identify the owning contract. For normal inputs this
     * is the input's witnessUtxo script. For arkTx inputs this is the
     * source VTXO script, because the witnessUtxo carries the checkpoint
     * script instead.
     */
    lookupScript: Uint8Array;
}

export interface InputSignerRouterDeps {
    identity: Identity;
    contractRepository: ContractRepository;
    descriptorProvider?: DescriptorProvider;
    boardingPkScript: Uint8Array;
}

const DESCRIPTOR_CAPABLE_CONTRACT_TYPES = new Set(["default", "delegate"]);

/**
 * Routes PSBT inputs to the correct signer based on the owning contract.
 * Inputs whose script matches a `default`/`delegate` contract with a
 * non-baseline owner are sent to {@link DescriptorProvider}; everything
 * else (baseline-owned contracts, non-default/non-delegate contracts,
 * and the boarding script) is sent to {@link Identity}. Inputs with no
 * matching contract and no boarding match are silently skipped, matching
 * how the wallet historically handled cosigner/connector inputs.
 */
export class InputSignerRouter {
    constructor(private readonly deps: InputSignerRouterDeps) {}

    async sign(tx: Transaction, jobs: InputSigningJob[]): Promise<Transaction> {
        if (jobs.length === 0) return tx;

        const distinctScripts = Array.from(new Set(jobs.map((j) => hex.encode(j.lookupScript))));
        const contracts = await this.deps.contractRepository.getContracts({
            script: distinctScripts,
        });
        // Repo may yield duplicates if seeded oddly; keep the first one
        // for each script to match the wallet's historical behaviour.
        const scriptToContract = new Map<string, (typeof contracts)[number]>();
        for (const contract of contracts) {
            if (!scriptToContract.has(contract.script)) {
                scriptToContract.set(contract.script, contract);
            }
        }

        const baselinePubKeyHex = hex.encode(await this.deps.identity.xOnlyPublicKey());
        const boardingScriptHex = hex.encode(this.deps.boardingPkScript);

        const identityIndexes: number[] = [];
        const descriptorGroups = new Map<string, number[]>();

        for (const job of jobs) {
            const scriptHex = hex.encode(job.lookupScript);
            const contract = scriptToContract.get(scriptHex);

            if (!contract) {
                if (scriptHex === boardingScriptHex) {
                    identityIndexes.push(job.index);
                }
                continue;
            }

            if (!DESCRIPTOR_CAPABLE_CONTRACT_TYPES.has(contract.type)) {
                identityIndexes.push(job.index);
                continue;
            }

            // `baselinePubKeyHex` is freshly produced by `hex.encode`,
            // so it is already lowercase. `contract.params.pubKey` is
            // persisted data: a migration or custom repository adapter
            // could legitimately store it uppercase, so canonicalize
            // before comparing to match the legacy router behaviour.
            const ownerPubKeyHex = contract.params.pubKey?.toLowerCase();
            if (ownerPubKeyHex && ownerPubKeyHex === baselinePubKeyHex) {
                identityIndexes.push(job.index);
                continue;
            }

            const descriptor = contract.metadata?.signingDescriptor;
            if (typeof descriptor !== "string" || descriptor.length === 0) {
                throw new MissingSigningDescriptorError(
                    contract.script,
                    contract.type as "default" | "delegate",
                );
            }

            const bucket = descriptorGroups.get(descriptor);
            if (bucket) {
                bucket.push(job.index);
            } else {
                descriptorGroups.set(descriptor, [job.index]);
            }
        }

        let signed = tx;
        if (identityIndexes.length > 0) {
            signed = await this.deps.identity.sign(signed, identityIndexes);
        }

        if (descriptorGroups.size > 0) {
            if (!this.deps.descriptorProvider) {
                throw new DescriptorSigningProviderMissingError();
            }

            const sortedDescriptors = Array.from(descriptorGroups.keys()).sort();
            for (const descriptor of sortedDescriptors) {
                const indexes = descriptorGroups.get(descriptor)!;
                const [next] = await this.deps.descriptorProvider.signWithDescriptor([
                    {
                        tx: signed,
                        descriptor,
                        inputIndexes: indexes,
                    },
                ]);
                signed = next;
            }
        }

        return signed;
    }
}
