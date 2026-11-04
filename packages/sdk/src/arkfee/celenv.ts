import { Environment } from "@marcbachmann/cel-js";

/**
 * Variable names used in CEL expressions
 */
export const AmountVariableName = "amount";
export const ExpiryVariableName = "expiry";
export const BirthVariableName = "birth";
export const WeightVariableName = "weight";
export const InputTypeVariableName = "inputType";
export const OutputScriptVariableName = "script";

const nowFunction = {
    signature: "now(): double",
    implementation: () => Math.floor(Date.now() / 1000),
};

/**
 * BatchOutputEnv is the CEL environment for output fee calculation
 * Variables: amount, script
 */
export const BatchOutputEnv = new Environment()
    .registerVariable(AmountVariableName, "double")
    .registerVariable(OutputScriptVariableName, "string")
    .registerFunction(nowFunction.signature, nowFunction.implementation);

/**
 * BatchOffchainInputEnv is the CEL environment for offchain input fee calculation
 * Variables: amount, expiry, birth, weight, inputType
 */
export const BatchOffchainInputEnv = new Environment()
    .registerVariable(AmountVariableName, "double")
    .registerVariable(ExpiryVariableName, "double")
    .registerVariable(BirthVariableName, "double")
    .registerVariable(WeightVariableName, "double")
    .registerVariable(InputTypeVariableName, "string")
    .registerFunction(nowFunction.signature, nowFunction.implementation);

/**
 * BatchOnchainInputEnv is the CEL environment for onchain input fee calculation
 * Variables: amount
 */
export const BatchOnchainInputEnv = new Environment()
    .registerVariable(AmountVariableName, "double")
    .registerFunction(nowFunction.signature, nowFunction.implementation);
