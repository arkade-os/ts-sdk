import { describe, expect, it } from "vitest";
import {
    Estimator,
    InputType,
    OutputType,
    type FeeInput,
    type FeeOutput,
} from "../src";

describe("Estimator", () => {
    describe("evalInput", () => {
        type TestCase = {
            name: string;
            input: FeeInput;
            expected: number;
        };

        type Fixture = {
            name: string;
            program: string;
            cases: TestCase[];
        };

        const fixtures: Fixture[] = [
            {
                name: "pay zero fee if expires in less than 5 minutes",
                program:
                    "expiry - now() < double(duration('5m').getSeconds()) ? 0.0 : amount / 2.0",
                cases: [
                    {
                        name: "far expiry",
                        input: {
                            amount: 10000,
                            birth: new Date(Date.now() - 10 * 60 * 1000),
                            expiry: new Date(Date.now() + 60 * 60 * 1000),
                            type: InputType.Vtxo,
                            weight: 1.0,
                        },
                        expected: 5000,
                    },
                    {
                        name: "close expiry",
                        input: {
                            amount: 20000,
                            birth: new Date(Date.now() - 10 * 60 * 1000),
                            expiry: new Date(Date.now() + 2 * 60 * 1000),
                            type: InputType.Boarding,
                            weight: 1.0,
                        },
                        expected: 0,
                    },
                ],
            },
            {
                name: "free for recoverable",
                program: "inputType == 'recoverable' ? 0.0 : 200.0",
                cases: [
                    {
                        name: "recoverable",
                        input: {
                            amount: 0,
                            type: InputType.Recoverable,
                            weight: 0,
                        },
                        expected: 0,
                    },
                    {
                        name: "not recoverable",
                        input: {
                            amount: 20000,
                            type: InputType.Boarding,
                            weight: 1.0,
                        },
                        expected: 200,
                    },
                ],
            },
            {
                name: "weighted fee (1% of the amount)",
                program: "weight * 0.01 * amount",
                cases: [
                    {
                        name: "with 56.3% weight",
                        input: {
                            amount: 10000,
                            weight: 0.563,
                            type: InputType.Vtxo,
                        },
                        expected: 56.3,
                    },
                    {
                        name: "with 100% weight",
                        input: {
                            amount: 10000,
                            weight: 1.0,
                            type: InputType.Vtxo,
                        },
                        expected: 100,
                    },
                    {
                        name: "with 0% weight",
                        input: {
                            amount: 10000,
                            weight: 0.0,
                            type: InputType.Vtxo,
                        },
                        expected: 0,
                    },
                ],
            },
        ];

        for (const fixture of fixtures) {
            describe(fixture.name, () => {
                for (const testCase of fixture.cases) {
                    it(testCase.name, () => {
                        const estimator = new Estimator(fixture.program, "");
                        const result = estimator.evalInput(testCase.input);
                        expect(result.amount).toBe(testCase.expected);
                    });
                }
            });
        }
    });

    describe("evalOutput", () => {
        type TestCase = {
            name: string;
            output: FeeOutput;
            expected: number;
        };

        type Fixture = {
            name: string;
            program: string;
            cases: TestCase[];
        };

        const fixtures: Fixture[] = [
            {
                name: "free for vtxo output",
                program: "outputType == 'vtxo' ? 0.0 : 200.0",
                cases: [
                    {
                        name: "vtxo output",
                        output: {
                            amount: 0,
                            type: OutputType.Vtxo,
                        },
                        expected: 0,
                    },
                    {
                        name: "onchain output",
                        output: {
                            amount: 10000,
                            type: OutputType.Onchain,
                        },
                        expected: 200,
                    },
                ],
            },
            {
                name: "collab exit pays 20% of the exited amount",
                program: "outputType == 'onchain' ? amount * 0.2 : 0.0",
                cases: [
                    {
                        name: "collab exit",
                        output: {
                            amount: 10000,
                            type: OutputType.Onchain,
                        },
                        expected: 2000,
                    },
                ],
            },
        ];

        for (const fixture of fixtures) {
            describe(fixture.name, () => {
                for (const testCase of fixture.cases) {
                    it(testCase.name, () => {
                        const estimator = new Estimator("", fixture.program);
                        const result = estimator.evalOutput(testCase.output);
                        expect(result.amount).toBe(testCase.expected);
                    });
                }
            });
        }
    });

    describe("eval", () => {
        type TestCase = {
            name: string;
            inputs: FeeInput[];
            outputs: FeeOutput[];
            expected: number;
        };

        type Fixture = {
            name: string;
            inputProgram: string;
            outputProgram: string;
            cases: TestCase[];
        };

        const fixtures: Fixture[] = [
            {
                name: "fixed fee",
                inputProgram: "100.0",
                outputProgram: "100.0",
                cases: [
                    {
                        name: "simple fee",
                        inputs: [
                            {
                                amount: 0,
                                type: InputType.Vtxo,
                                weight: 0,
                            },
                        ],
                        outputs: [
                            {
                                amount: 0,
                                type: OutputType.Vtxo,
                            },
                            {
                                amount: 0,
                                type: OutputType.Vtxo,
                            },
                        ],
                        expected: 300,
                    },
                ],
            },
            {
                name: "free for vtxo input",
                inputProgram: "inputType == 'vtxo' ? 0.0 : 100.0",
                outputProgram: "outputType == 'vtxo' ? 0.0 : 100.0",
                cases: [
                    {
                        name: "vtxo input",
                        inputs: [
                            {
                                amount: 0,
                                type: InputType.Vtxo,
                                weight: 0,
                            },
                        ],
                        outputs: [
                            {
                                amount: 0,
                                type: OutputType.Vtxo,
                            },
                            {
                                amount: 0,
                                type: OutputType.Onchain,
                            },
                        ],
                        expected: 100,
                    },
                ],
            },
        ];

        for (const fixture of fixtures) {
            describe(fixture.name, () => {
                for (const testCase of fixture.cases) {
                    it(testCase.name, () => {
                        const estimator = new Estimator(
                            fixture.inputProgram,
                            fixture.outputProgram
                        );
                        const result = estimator.eval(
                            testCase.inputs,
                            testCase.outputs
                        );
                        expect(result.amount).toBe(testCase.expected);
                    });
                }
            });
        }
    });
});
