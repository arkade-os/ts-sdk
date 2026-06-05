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

const DESCRIPTOR_CAPABLE_CONTRACT_TYPES = new Set(["default", "delegate", "boarding"]);

/**
 * Routing decision for a single tx's signable inputs: which inputs the
 * baseline {@link Identity} signs, and which are grouped by descriptor for
 * the {@link DescriptorProvider}.
 */
export interface InputRoutingPlan {
    /** Input indexes the baseline {@link Identity} should sign. */
    identityIndexes: number[];
    /**
     * Per-descriptor buckets of input indexes routed to the
     * {@link DescriptorProvider}. Empty map ⇒ batch-eligible (every input
     * resolves to the baseline key).
     */
    descriptorGroups: Map<string, number[]>;
}

/**
 * Routes PSBT inputs to the correct signer based on the owning contract.
 * Inputs whose script matches a `default`/`delegate`/`boarding` contract with
 * a non-baseline owner are sent to {@link DescriptorProvider}; everything
 * else (baseline-owned contracts, other contract types, and the index-0
 * boarding fallback script) is sent to {@link Identity}. Inputs with no
 * matching contract and no boarding match are silently skipped, matching
 * how the wallet historically handled cosigner/connector inputs.
 *
 * Boarding participates in descriptor-aware signing (plan §6-III.3): a
 * *rotated* boarding UTXO is locked to its HD index's pubkey, so it must be
 * signed with the key derived at that index, not the baseline identity key.
 * The `pubKey === baseline` early-out below keeps index-0 / static boarding on
 * the identity path, so the no-rotation case is byte-for-byte unchanged.
 */
export class InputSignerRouter {
    constructor(private readonly deps: InputSignerRouterDeps) {}

    /**
     * Resolve each job to its target signer without invoking signing. The
     * returned plan is the single source of truth for both {@link sign} and
     * the batch-eligibility predicate {@link canBatch} — callers that want
     * to pre-flight a batch path call {@link canBatch} (which delegates
     * here) so the routing rules never live in two places.
     *
     * Throws {@link MissingSigningDescriptorError} for a non-baseline
     * default/delegate contract whose `metadata.signingDescriptor` is
     * missing — the same condition that would later abort signing. Failing
     * here moves the failure earlier, before any PSBT is mutated.
     */
    async classify(jobs: InputSigningJob[]): Promise<InputRoutingPlan> {
        const identityIndexes: number[] = [];
        const descriptorGroups = new Map<string, number[]>();
        if (jobs.length === 0) {
            return { identityIndexes, descriptorGroups };
        }

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
                    contract.type as "default" | "delegate" | "boarding",
                );
            }

            const bucket = descriptorGroups.get(descriptor);
            if (bucket) {
                bucket.push(job.index);
            } else {
                descriptorGroups.set(descriptor, [job.index]);
            }
        }

        return { identityIndexes, descriptorGroups };
    }

    /**
     * Returns `true` when every signable input across all `jobSets` resolves
     * to the baseline {@link Identity} key — i.e. the descriptor provider
     * would not be invoked. Used by the wallet's send/recovery paths to
     * pre-flight the {@link BatchSignableIdentity.signMultiple} fast path,
     * which can only fold work a single identity key can sign.
     *
     * Accepts several job sets (e.g. an arkTx's jobs plus one set per
     * checkpoint) and classifies their union in a single pass. Eligibility
     * is monotonic — the union routes entirely to the baseline key iff every
     * set does — so this returns the same answer as ANDing the per-set
     * results, but with one {@link classify} (one repo round-trip + one
     * `xOnlyPublicKey` call) instead of one per set. Only the routing buckets
     * matter here, so the input-index collisions produced by flattening jobs
     * from different transactions are irrelevant.
     */
    async canBatch(...jobSets: InputSigningJob[][]): Promise<boolean> {
        const plan = await this.classify(jobSets.flat());
        return plan.descriptorGroups.size === 0;
    }

    async sign(tx: Transaction, jobs: InputSigningJob[]): Promise<Transaction> {
        if (jobs.length === 0) return tx;
        const { identityIndexes, descriptorGroups } = await this.classify(jobs);

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
