import { Environment, ParseResult } from "@marcbachmann/cel-js";
import { BatchOffchainInputEnv, BatchOnchainInputEnv, BatchOutputEnv } from "./celenv.js";
import { BatchFeeConfig, OffchainInput, OnchainInput, FeeOutput, FeeAmount } from "./types.js";

/**
 * Estimator evaluates CEL expressions to calculate batch fees
 */
export class Estimator {
    private batchOffchainInput?: ParseResult;
    private batchOnchainInput?: ParseResult;
    private batchOffchainOutput?: ParseResult;
    private batchOnchainOutput?: ParseResult;

    /**
     * Creates a new Estimator with the given config
     * @param config - Configuration containing CEL programs for fee calculation
     */
    constructor(readonly config: BatchFeeConfig) {
        this.batchOffchainInput = config.offchainInput
            ? parseProgram(config.offchainInput, BatchOffchainInputEnv)
            : undefined;

        this.batchOnchainInput = config.onchainInput
            ? parseProgram(config.onchainInput, BatchOnchainInputEnv)
            : undefined;

        this.batchOffchainOutput = config.offchainOutput
            ? parseProgram(config.offchainOutput, BatchOutputEnv)
            : undefined;
        this.batchOnchainOutput = config.onchainOutput
            ? parseProgram(config.onchainOutput, BatchOutputEnv)
            : undefined;
    }

    /**
     * Evaluates the fee for a given vtxo input
     * @param input - The offchain input to evaluate
     * @returns The fee amount for this input
     */
    evalOffchainInput(input: OffchainInput): FeeAmount {
        return evalProgram(this.batchOffchainInput, () => inputToArgs(input));
    }

    /**
     * Evaluates the fee for a given boarding input
     * @param input - The onchain input to evaluate
     * @returns The fee amount for this input
     */
    evalOnchainInput(input: OnchainInput): FeeAmount {
        return evalProgram(this.batchOnchainInput, () => ({ amount: Number(input.amount) }));
    }

    /**
     * Evaluates the fee for a given vtxo output
     * @param output - The output to evaluate
     * @returns The fee amount for this output
     */
    evalOffchainOutput(output: FeeOutput): FeeAmount {
        return evalProgram(this.batchOffchainOutput, () => outputToArgs(output));
    }

    /**
     * Evaluates the fee for a given collaborative exit output
     * @param output - The output to evaluate
     * @returns The fee amount for this output
     */
    evalOnchainOutput(output: FeeOutput): FeeAmount {
        return evalProgram(this.batchOnchainOutput, () => outputToArgs(output));
    }

    /**
     * Evaluates the fee for a given set of inputs and outputs
     * @param offchainInputs - Array of offchain inputs to evaluate
     * @param onchainInputs - Array of onchain inputs to evaluate
     * @param offchainOutputs - Array of offchain outputs to evaluate
     * @param onchainOutputs - Array of onchain outputs to evaluate
     * @returns The total fee amount
     */
    evaluate(
        offchainInputs: OffchainInput[],
        onchainInputs: OnchainInput[],
        offchainOutputs: FeeOutput[],
        onchainOutputs: FeeOutput[],
    ): FeeAmount {
        let fee = FeeAmount.ZERO;

        for (const input of offchainInputs) {
            fee = fee.add(this.evalOffchainInput(input));
        }

        for (const input of onchainInputs) {
            fee = fee.add(this.evalOnchainInput(input));
        }

        for (const output of offchainOutputs) {
            fee = fee.add(this.evalOffchainOutput(output));
        }

        for (const output of onchainOutputs) {
            fee = fee.add(this.evalOnchainOutput(output));
        }

        return fee;
    }
}

function evalProgram(
    program: ParseResult | undefined,
    toArgs: () => Record<string, any>,
): FeeAmount {
    return program ? new FeeAmount(program(toArgs())) : FeeAmount.ZERO;
}

function inputToArgs(input: OffchainInput): Record<string, any> {
    const args: Record<string, any> = {
        amount: Number(input.amount),
        inputType: input.type,
        weight: input.weight,
    };

    if (input.expiry) {
        args.expiry = Math.floor(input.expiry.getTime() / 1000);
    }

    if (input.birth) {
        args.birth = Math.floor(input.birth.getTime() / 1000);
    }

    return args;
}

function outputToArgs(output: FeeOutput): Record<string, any> {
    return {
        amount: Number(output.amount),
        script: output.script,
    };
}

/**
 * Parses a CEL program and validates its return type
 * @param text - The CEL program text to parse
 * @param env - The CEL environment to use
 * @returns parsed and validated program
 */
function parseProgram(text: string, env: Environment): ParseResult {
    const program = env.parse(text);

    // Type check the program
    const checkResult = program.check();
    if (!checkResult.valid) {
        throw new Error(`type check failed: ${checkResult.error?.message ?? "unknown error"}`);
    }

    // Verify return type is double
    if (checkResult.type !== "double") {
        throw new Error(`expected return type double, got ${checkResult.type}`);
    }

    return program;
}
