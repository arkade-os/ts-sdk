import { Environment, ParseResult } from "@marcbachmann/cel-js";
import {
    IntentOffchainInputEnv,
    IntentOnchainInputEnv,
    IntentOutputEnv,
} from "./celenv.js";
import {
    IntentFeeConfig,
    OffchainInput,
    OnchainInput,
    FeeOutput,
    FeeAmount,
} from "./types.js";

interface Program {
    program: ParseResult;
    text: string;
}

/**
 * Estimator evaluates CEL expressions to calculate fees for Ark intents
 */
export class Estimator {
    private intentOffchainInput?: Program;
    private intentOnchainInput?: Program;
    private intentOffchainOutput?: Program;
    private intentOnchainOutput?: Program;

    /**
     * Creates a new Estimator with the given config
     * @param config - Configuration containing CEL programs for fee calculation
     */
    constructor(readonly config: IntentFeeConfig) {
        this.intentOffchainInput = config.offchainInput
            ? parseProgram(config.offchainInput, IntentOffchainInputEnv)
            : undefined;

        this.intentOnchainInput = config.onchainInput
            ? parseProgram(config.onchainInput, IntentOnchainInputEnv)
            : undefined;

        this.intentOffchainOutput = config.offchainOutput
            ? parseProgram(config.offchainOutput, IntentOutputEnv)
            : undefined;
        this.intentOnchainOutput = config.onchainOutput
            ? parseProgram(config.onchainOutput, IntentOutputEnv)
            : undefined;
    }

    /**
     * Evaluates the fee for a given vtxo input
     * @param input - The offchain input to evaluate
     * @returns The fee amount for this input
     */
    evalOffchainInput(input: OffchainInput): FeeAmount {
        if (!this.intentOffchainInput) {
            return FeeAmount.ZERO;
        }

        const args = inputToArgs(input);
        return new FeeAmount(this.intentOffchainInput.program(args));
    }

    /**
     * Evaluates the fee for a given boarding input
     * @param input - The onchain input to evaluate
     * @returns The fee amount for this input
     */
    evalOnchainInput(input: OnchainInput): FeeAmount {
        if (!this.intentOnchainInput) {
            return FeeAmount.ZERO;
        }

        const args = {
            amount: Number(input.amount),
        };
        return new FeeAmount(this.intentOnchainInput.program(args));
    }

    /**
     * Evaluates the fee for a given vtxo output
     * @param output - The output to evaluate
     * @returns The fee amount for this output
     */
    evalOffchainOutput(output: FeeOutput): FeeAmount {
        if (!this.intentOffchainOutput) {
            return FeeAmount.ZERO;
        }

        const args = outputToArgs(output);
        return new FeeAmount(this.intentOffchainOutput.program(args));
    }

    /**
     * Evaluates the fee for a given collaborative exit output
     * @param output - The output to evaluate
     * @returns The fee amount for this output
     */
    evalOnchainOutput(output: FeeOutput): FeeAmount {
        if (!this.intentOnchainOutput) {
            return FeeAmount.ZERO;
        }

        const args = outputToArgs(output);
        return new FeeAmount(this.intentOnchainOutput.program(args));
    }

    /**
     * Evaluates the fee for a given set of inputs and outputs
     * @param offchainInputs - Array of offchain inputs to evaluate
     * @param onchainInputs - Array of onchain inputs to evaluate
     * @param offchainOutputs - Array of offchain outputs to evaluate
     * @param onchainOutputs - Array of onchain outputs to evaluate
     * @returns The total fee amount
     */
    eval(
        offchainInputs: OffchainInput[],
        onchainInputs: OnchainInput[],
        offchainOutputs: FeeOutput[],
        onchainOutputs: FeeOutput[]
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
function parseProgram(text: string, env: Environment): Program {
    const program = env.parse(text);

    // Type check the program
    const checkResult = program.check();
    if (!checkResult.valid) {
        throw new Error(
            `type check failed: ${checkResult.error?.message ?? "unknown error"}`
        );
    }

    // Verify return type is double
    if (checkResult.type !== "double") {
        throw new Error(`expected return type double, got ${checkResult.type}`);
    }

    return { program, text };
}
