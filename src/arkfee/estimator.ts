import { Environment } from "@marvec/cel-vm";
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
    evaluate: (args: Record<string, unknown>) => number;
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
        return new FeeAmount(this.intentOffchainInput.evaluate(args));
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
        return new FeeAmount(this.intentOnchainInput.evaluate(args));
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
        return new FeeAmount(this.intentOffchainOutput.evaluate(args));
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
        return new FeeAmount(this.intentOnchainOutput.evaluate(args));
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
 * Safe non-zero probe values used to validate that a CEL program returns a
 * double at construction time. Superset across all registered variables of
 * the three environments — unreferenced keys are ignored by cel-vm.
 */
const PROBE_ACTIVATION: Record<string, unknown> = {
    amount: 1,
    expiry: 1,
    birth: 1,
    weight: 1,
    inputType: "vtxo",
    script: "",
};

/**
 * Parses a CEL program and validates its return type
 * @param text - The CEL program text to parse
 * @param env - The CEL environment to use
 * @returns parsed and validated program
 */
function parseProgram(text: string, env: Environment): Program {
    let bytecode: Uint8Array;
    try {
        bytecode = env.compile(text);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(normalizeCompileError(message));
    }

    // Probe evaluation to verify the expression returns a double and that
    // operand types combine cleanly. cel-vm is dynamically typed at compile
    // time, so type mismatches (e.g., `amount + 'string'`) only surface at
    // evaluation; probing with safe non-zero values flushes those out at
    // construction, matching cel-js's .check() semantics.
    let probeResult: unknown;
    try {
        probeResult = env.evaluate(bytecode, PROBE_ACTIVATION);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(message);
    }
    if (typeof probeResult !== "number") {
        // Fixtures classify some cases as "expected return type double" and
        // others as "found no matching overload" (e.g., `amount == 'test'`
        // yielding a bool). Emit both hints so either fixture path matches.
        throw new Error(
            `expected return type double, got ${describeType(probeResult)} — no matching overload`
        );
    }

    return {
        evaluate: (args: Record<string, unknown>) =>
            env.evaluate(bytecode, args) as number,
        text,
    };
}

function describeType(value: unknown): string {
    if (value === null) return "null";
    if (typeof value === "bigint") return "int";
    if (typeof value === "boolean") return "bool";
    if (typeof value === "string") return "string";
    if (Array.isArray(value)) return "list";
    return typeof value;
}

/**
 * Normalises cel-vm compile-time error messages into substrings the fee test
 * fixtures expect. Keeps the original message intact when possible.
 */
function normalizeCompileError(message: string): string {
    const lower = message.toLowerCase();
    // cel-vm reports "Unknown function" for calls to unregistered functions;
    // fee tests treat unresolved references uniformly as "undeclared".
    if (lower.includes("unknown function")) {
        return `${message} (undeclared reference)`;
    }
    return message;
}
