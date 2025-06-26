import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { base64 } from "@scure/base";
import { sha256x2 } from "@scure/btc-signer/utils";
import { aggregateKeys } from "../musig2";
import { TxGraph } from "./txGraph";
import { CSVMultisigTapscript } from "../script/tapscript";
import { RelativeTimelock } from "../script/tapscript";
import { tapLeafHash } from "@scure/btc-signer/payment";

export const ErrInvalidSettlementTx = (tx: string) =>
    new Error(`invalid settlement transaction: ${tx}`);
export const ErrInvalidSettlementTxOutputs = new Error(
    "invalid settlement transaction outputs"
);
export const ErrEmptyTree = new Error("empty tree");
export const ErrNumberOfInputs = new Error("invalid number of inputs");
export const ErrWrongSettlementTxid = new Error("wrong settlement txid");
export const ErrInvalidAmount = new Error("invalid amount");
export const ErrNoLeaves = new Error("no leaves");
export const ErrInvalidTaprootScript = new Error("invalid taproot script");
export const ErrInvalidRoundTxOutputs = new Error(
    "invalid round transaction outputs"
);
export const ErrWrongRoundTxid = new Error("wrong round txid");
export const ErrMissingCosignersPublicKeys = new Error(
    "missing cosigners public keys"
);

const SHARED_OUTPUT_INDEX = 0;
const CONNECTORS_OUTPUT_INDEX = 1;

export function validateConnectorsTxGraph(
    settlementTxB64: string,
    connectorsGraph: TxGraph
): void {
    connectorsGraph.validate();

    if (connectorsGraph.root.inputsLength !== 1) throw ErrNumberOfInputs;

    const rootInput = connectorsGraph.root.getInput(0);

    const settlementTx = Transaction.fromPSBT(base64.decode(settlementTxB64));
    if (settlementTx.outputsLength <= CONNECTORS_OUTPUT_INDEX)
        throw ErrInvalidSettlementTxOutputs;

    const expectedRootTxid = hex.encode(
        sha256x2(settlementTx.toBytes(true)).reverse()
    );

    if (!rootInput.txid) throw ErrWrongSettlementTxid;

    if (hex.encode(rootInput.txid) !== expectedRootTxid)
        throw ErrWrongSettlementTxid;

    if (rootInput.index !== CONNECTORS_OUTPUT_INDEX)
        throw ErrWrongSettlementTxid;
}

// ValidateVtxoTxGraph checks if the given vtxo graph is valid
// roundTxid & roundTxIndex & roundTxAmount are used to validate the root input outpoint
// serverPubkey & vtxoTreeExpiry are used to validate the sweep tapscript leaves
// besides that, the function validates:
// - the number of nodes
// - the number of leaves
// - children coherence with parent
// - every control block and taproot output scripts
// - input and output amounts
export function validateVtxoTxGraph(
    graph: TxGraph,
    roundTransaction: Transaction,
    sweepTapTreeRoot: Uint8Array
): void {
    if (roundTransaction.outputsLength < SHARED_OUTPUT_INDEX + 1) {
        throw ErrInvalidRoundTxOutputs;
    }

    const roundTxAmount =
        roundTransaction.getOutput(SHARED_OUTPUT_INDEX)?.amount;
    if (!roundTxAmount) {
        throw ErrInvalidRoundTxOutputs;
    }

    if (!graph.root) {
        throw ErrEmptyTree;
    }

    const rootInput = graph.root.getInput(0);
    const roundTxid = hex.encode(
        sha256x2(roundTransaction.toBytes(true)).reverse()
    );

    if (
        !rootInput.txid ||
        hex.encode(rootInput.txid) !== roundTxid ||
        rootInput.index !== SHARED_OUTPUT_INDEX
    ) {
        throw ErrWrongRoundTxid;
    }

    let sumRootValue = 0n;
    for (let i = 0; i < graph.root.outputsLength; i++) {
        const output = graph.root.getOutput(i);
        if (output?.amount) {
            sumRootValue += output.amount;
        }
    }

    if (sumRootValue !== roundTxAmount) {
        throw ErrInvalidAmount;
    }

    const leaves = graph.leaves();
    if (leaves.length === 0) {
        throw ErrNoLeaves;
    }

    // validate the graph structure
    graph.validate();

    // iterates over all the nodes of the graph to verify that cosigners public keys are corresponding to the parent output
    for (const g of graph) {
        for (const [childIndex, child] of g.children) {
            const parentOutput = g.root.getOutput(childIndex);
            if (!parentOutput?.script) {
                throw ErrInvalidTaprootScript;
            }

            const previousScriptKey = parentOutput.script.slice(2);
            if (previousScriptKey.length !== 32) {
                throw ErrInvalidTaprootScript;
            }

            const cosigners = getCosignerKeys(child.root);

            if (cosigners.length === 0) {
                throw ErrMissingCosignersPublicKeys;
            }

            const { finalKey } = aggregateKeys(cosigners, true, {
                taprootTweak: sweepTapTreeRoot,
            });

            if (
                !finalKey ||
                hex.encode(finalKey) !== hex.encode(previousScriptKey)
            ) {
                throw ErrInvalidTaprootScript;
            }
        }
    }
}

// Helper function to get cosigner keys from a transaction
function getCosignerKeys(tx: Transaction): Uint8Array[] {
    const keys: Uint8Array[] = [];

    const input = tx.getInput(0);

    if (!input.unknown) return keys;

    for (const unknown of input.unknown) {
        const ok = parsePrefixedCosignerKey(
            new Uint8Array([unknown[0].type, ...unknown[0].key])
        );

        if (!ok) continue;

        // Assuming the value is already a valid public key in compressed format
        keys.push(unknown[1]);
    }

    return keys;
}

function parsePrefixedCosignerKey(key: Uint8Array): boolean {
    const COSIGNER_KEY_PREFIX = new Uint8Array(
        "cosigner".split("").map((c) => c.charCodeAt(0))
    );

    if (key.length < COSIGNER_KEY_PREFIX.length) return false;

    for (let i = 0; i < COSIGNER_KEY_PREFIX.length; i++) {
        if (key[i] !== COSIGNER_KEY_PREFIX[i]) return false;
    }
    return true;
}
