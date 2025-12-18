import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
    Estimator,
    type IntentFeeConfig,
    type OffchainInput,
    type OnchainInput,
    type FeeOutput,
} from "../src";

// Load test data
const testDataPath = join(__dirname, "fixtures", "arkfee-valid.json");
const invalidTestDataPath = join(__dirname, "fixtures", "arkfee-invalid.json");

const testData = JSON.parse(readFileSync(testDataPath, "utf-8"));
const invalidTestData = JSON.parse(readFileSync(invalidTestDataPath, "utf-8"));

// JSON input type from fixtures
type JsonInput = {
    amount?: number;
    birthOffsetSeconds?: number;
    expiryOffsetSeconds?: number;
    type?: string;
    weight?: number;
};

type JsonOnchainInput = {
    amount?: number;
};

type JsonOutput = {
    amount?: number;
    script?: string;
};

// Convert JSON input to OffchainInput
function convertJsonInput(j: JsonInput): OffchainInput {
    const now = Date.now();
    const input: OffchainInput = {
        amount: BigInt(j.amount ?? 0),
        type: (j.type as "recoverable" | "vtxo" | "note") ?? "vtxo",
        weight: j.weight ?? 0,
    };

    if (j.birthOffsetSeconds !== undefined) {
        input.birth = new Date(now + j.birthOffsetSeconds * 1000);
    }

    if (j.expiryOffsetSeconds !== undefined) {
        input.expiry = new Date(now + j.expiryOffsetSeconds * 1000);
    }

    return input;
}

// Convert JSON onchain input to OnchainInput
function convertJsonOnchainInput(j: JsonOnchainInput): OnchainInput {
    return {
        amount: BigInt(j.amount ?? 0),
    };
}

// Convert JSON output to FeeOutput
function convertJsonOutput(j: JsonOutput): FeeOutput {
    return {
        amount: BigInt(j.amount ?? 0),
        script: j.script ?? "",
    };
}

describe("Estimator", () => {
    describe("New", () => {
        describe("Invalid", () => {
            for (const testCase of invalidTestData.invalidConfigs) {
                it(testCase.name, () => {
                    const config: IntentFeeConfig = {
                        offchainInput: testCase.config.offchainInputProgram,
                        onchainInput: testCase.config.onchainInputProgram,
                        offchainOutput: testCase.config.offchainOutputProgram,
                        onchainOutput: testCase.config.onchainOutputProgram,
                    };

                    expect(() => new Estimator(config)).toThrow();
                    try {
                        new Estimator(config);
                        expect.fail("Expected error to be thrown");
                    } catch (error: any) {
                        const errorMsg = error.message.toLowerCase();
                        const expectedErr = testCase.err.toLowerCase();

                        // Map Go error messages to TypeScript CEL library error patterns
                        if (expectedErr.includes("syntax error")) {
                            expect(
                                errorMsg.includes("syntax") ||
                                    errorMsg.includes("unexpected") ||
                                    errorMsg.includes("unterminated") ||
                                    errorMsg.includes("token")
                            ).toBe(true);
                        } else if (
                            expectedErr.includes("undeclared reference")
                        ) {
                            expect(
                                errorMsg.includes("unknown variable") ||
                                    errorMsg.includes("undeclared") ||
                                    errorMsg.includes("function not found")
                            ).toBe(true);
                        } else if (
                            expectedErr.includes("found no matching overload")
                        ) {
                            expect(
                                errorMsg.includes("no such overload") ||
                                    errorMsg.includes("matching overload")
                            ).toBe(true);
                        } else if (
                            expectedErr.includes("expected return type")
                        ) {
                            expect(errorMsg).toContain("expected return type");
                        } else {
                            // Fallback: check if error message contains the expected text
                            expect(errorMsg).toContain(expectedErr);
                        }
                    }
                });
            }
        });
    });

    describe("evalOffchainInput", () => {
        it("should return 0 if no program is set", () => {
            const estimator = new Estimator({});
            const result = estimator.evalOffchainInput({
                amount: BigInt(0),
                type: "vtxo",
                weight: 0,
            });
            expect(result.value).toBe(0);
        });

        for (const fixture of testData.evalOffchainInput) {
            describe(fixture.name, () => {
                for (const testCase of fixture.cases) {
                    it(testCase.name, () => {
                        const estimator = new Estimator({
                            offchainInput: fixture.program,
                        });
                        const input = convertJsonInput(testCase.input);
                        const result = estimator.evalOffchainInput(input);
                        expect(result.value).toBe(testCase.expected);
                    });
                }
            });
        }
    });

    describe("evalOnchainInput", () => {
        it("should return 0 if no program is set", () => {
            const estimator = new Estimator({});
            const result = estimator.evalOnchainInput({
                amount: BigInt(0),
            });
            expect(result.value).toBe(0);
        });

        for (const fixture of testData.evalOnchainInput) {
            describe(fixture.name, () => {
                for (const testCase of fixture.cases) {
                    it(testCase.name, () => {
                        const estimator = new Estimator({
                            onchainInput: fixture.program,
                        });
                        const input = convertJsonOnchainInput(testCase.input);
                        const result = estimator.evalOnchainInput(input);
                        expect(result.value).toBe(testCase.expected);
                    });
                }
            });
        }
    });

    describe("evalOffchainOutput", () => {
        it("should return 0 if no program is set", () => {
            const estimator = new Estimator({});
            const result = estimator.evalOffchainOutput({
                amount: BigInt(0),
                script: "",
            });
            expect(result.value).toBe(0);
        });

        for (const fixture of testData.evalOffchainOutput) {
            describe(fixture.name, () => {
                for (const testCase of fixture.cases) {
                    it(testCase.name, () => {
                        const estimator = new Estimator({
                            offchainOutput: fixture.program,
                        });
                        const output = convertJsonOutput(testCase.output);
                        const result = estimator.evalOffchainOutput(output);
                        expect(result.value).toBe(testCase.expected);
                    });
                }
            });
        }
    });

    describe("evalOnchainOutput", () => {
        it("should return 0 if no program is set", () => {
            const estimator = new Estimator({});
            const result = estimator.evalOnchainOutput({
                amount: BigInt(0),
                script: "",
            });
            expect(result.value).toBe(0);
        });

        for (const fixture of testData.evalOnchainOutput) {
            describe(fixture.name, () => {
                for (const testCase of fixture.cases) {
                    it(testCase.name, () => {
                        const estimator = new Estimator({
                            onchainOutput: fixture.program,
                        });
                        const output = convertJsonOutput(testCase.output);
                        const result = estimator.evalOnchainOutput(output);
                        expect(result.value).toBe(testCase.expected);
                    });
                }
            });
        }
    });

    describe("eval", () => {
        for (const fixture of testData.eval) {
            describe(fixture.name, () => {
                for (const testCase of fixture.cases) {
                    it(testCase.name, () => {
                        const config: IntentFeeConfig = {
                            offchainInput: fixture.offchainInputProgram,
                            onchainInput: fixture.onchainInputProgram,
                            offchainOutput: fixture.offchainOutputProgram,
                            onchainOutput: fixture.onchainOutputProgram,
                        };

                        const estimator = new Estimator(config);

                        const offchainInputs = (
                            testCase.offchainInputs ?? []
                        ).map(convertJsonInput);
                        const onchainInputs = (
                            testCase.onchainInputs ?? []
                        ).map(convertJsonOnchainInput);
                        const offchainOutputs = (
                            testCase.offchainOutputs ?? []
                        ).map(convertJsonOutput);
                        const onchainOutputs = (
                            testCase.onchainOutputs ?? []
                        ).map(convertJsonOutput);

                        const result = estimator.eval(
                            offchainInputs,
                            onchainInputs,
                            offchainOutputs,
                            onchainOutputs
                        );
                        expect(result.value).toBe(testCase.expected);
                    });
                }
            });
        }
    });
});
