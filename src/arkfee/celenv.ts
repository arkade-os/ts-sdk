import { Environment } from "@marcbachmann/cel-js";

/**
 * Variable names used in CEL expressions
 */
export enum VariableName {
    Amount = "amount",
    Expiry = "expiry",
    Birth = "birth",
    Weight = "weight",
    InputType = "inputType",
    OutputType = "outputType",
}

const nowFunction = {
    signature: "now(): double",
    implementation: () => Math.floor(Date.now() / 1000),
};

export const intentOutputEnv = new Environment()
    .registerVariable(VariableName.Amount, "double")
    .registerVariable(VariableName.OutputType, "string")
    .registerFunction(nowFunction.signature, nowFunction.implementation);

export const intentInputEnv = new Environment()
    .registerVariable(VariableName.Amount, "double")
    .registerVariable(VariableName.Expiry, "double")
    .registerVariable(VariableName.Birth, "double")
    .registerVariable(VariableName.Weight, "double")
    .registerVariable(VariableName.InputType, "string")
    .registerFunction(nowFunction.signature, nowFunction.implementation);
