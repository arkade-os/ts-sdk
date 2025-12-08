import { Environment, ParseResult } from "@marcbachmann/cel-js";
import { intentInputEnv, intentOutputEnv } from "./celenv.js";
import { Input, Output, FeeAmount, newFeeAmount } from "./types.js";

/**
 * Represents a parsed CEL program
 */
interface Program {
    program: ParseResult;
    text: string;
}

/**
 * Estimator evaluates CEL expressions to calculate fees for Ark intents
 */
export class Estimator {
    private intentInput?: Program;
    private intentOutput?: Program;

    /**
     * Creates a new Estimator with optional intent input and output programs
     * @param intentInputProgram - CEL expression for input fee calculation (optional)
     * @param intentOutputProgram - CEL expression for output fee calculation (optional)
     * @throws Error if parsing fails or return type is not double
     */
    constructor(intentInputProgram?: string, intentOutputProgram?: string) {
        if (intentInputProgram && intentInputProgram.length > 0) {
            const program = parseProgram(intentInputProgram, intentInputEnv);
            this.intentInput = { program, text: intentInputProgram };
        }

        if (intentOutputProgram && intentOutputProgram.length > 0) {
            const program = parseProgram(intentOutputProgram, intentOutputEnv);
            this.intentOutput = { program, text: intentOutputProgram };
        }
    }

    /**
     * Evaluates the fee for a single input
     * @param input - The input to evaluate
     * @returns The fee amount for this input
     * @throws Error if evaluation fails
     */
    evalInput(input: Input): FeeAmount {
        if (!this.intentInput) {
            return newFeeAmount(0);
        }

        const args = {
            amount: input.amount,
            expiry: input.expiry
                ? Math.floor(input.expiry.getTime() / 1000)
                : undefined,
            birth: input.birth
                ? Math.floor(input.birth.getTime() / 1000)
                : undefined,
            weight: input.weight,
            inputType: input.type,
        };
        const result = this.intentInput.program(args);

        if (typeof result !== "number") {
            throw new Error(
                `expected return type double, got ${typeof result}`
            );
        }

        return newFeeAmount(result);
    }

    /**
     * Evaluates the fee for a single output
     * @param output - The output to evaluate
     * @returns The fee amount for this output
     * @throws Error if evaluation fails
     */
    evalOutput(output: Output): FeeAmount {
        if (!this.intentOutput) {
            return newFeeAmount(0);
        }

        const args = {
            amount: output.amount,
            outputType: output.type,
        };
        const result = this.intentOutput.program(args);

        if (typeof result !== "number") {
            throw new Error(
                `expected return type double, got ${typeof result}`
            );
        }

        return newFeeAmount(result);
    }

    /**
     * Evaluates the total fee for multiple inputs and outputs
     * @param inputs - Array of inputs to evaluate
     * @param outputs - Array of outputs to evaluate
     * @returns The total fee amount
     * @throws Error if evaluation fails
     */
    eval(inputs: Input[], outputs: Output[]): FeeAmount {
        let fee = 0;

        for (const input of inputs) {
            fee += this.evalInput(input).amount;
        }

        for (const output of outputs) {
            fee += this.evalOutput(output).amount;
        }

        return newFeeAmount(fee);
    }

    /**
     * Returns the intent input program string
     * @returns The intent input program string, or empty string if not set
     */
    intentInputProgram(): string {
        return this.intentInput?.text ?? "";
    }

    /**
     * Returns the intent output program string
     * @returns The intent output program string, or empty string if not set
     */
    intentOutputProgram(): string {
        return this.intentOutput?.text ?? "";
    }
}

// Parse a CEL program and validate its return type
function parseProgram(text: string, env: Environment): ParseResult {
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

    return program;
}
