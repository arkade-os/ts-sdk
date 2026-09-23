import { hex } from "@scure/base";

import { ArkadeProgramScript } from "../../../packages/ts-sdk/src/arkade/program.ts";
import escrowProgram from "../escrow.program.json";
import type { Program } from "../../../packages/ts-sdk/src/arkade/program.ts";

const program = escrowProgram as Program;
const key = (fill: number) => new Uint8Array(32).fill(fill);
const emulatorKey = new Uint8Array(33);
emulatorKey[0] = 0x02;
emulatorKey.set(key(9), 1);

const compiled = new ArkadeProgramScript(
    program,
    {
        partyAPk: key(1),
        partyBPk: key(2),
        oraclePk: key(3),
        oracleMessageHash: key(4),
        partyAScript: key(5),
        partyBScript: key(6),
        amount: 10_000n,
        timeoutAt: 1_700_000_000n,
        exit: 0n,
        server: key(7),
    },
    { serverKey: key(7), emulatorKey },
);

const names = compiled.compiled.map((fn) => fn.name);
if (names.join() !== "complete,cancel,unilateral") {
    throw new Error(`unexpected functions ${names.join()}`);
}

const cancel = compiled.functionByName("cancel")?.arkadeScript;
const complete = compiled.functionByName("complete")?.arkadeScript;
const unilateral = compiled.functionByName("unilateral")?.leafScript;
if (!cancel || !complete || !unilateral) throw new Error("missing compiled scripts");

const cancelHex = hex.encode(cancel);
const completeHex = hex.encode(complete);
const unilateralHex = hex.encode(unilateral);
if (!cancelHex.includes("dc")) throw new Error("cancel is missing CHECKTIME");
if (!completeHex.includes("cc")) throw new Error("complete is missing CHECKSIGFROMSTACK");
if (!completeHex.includes("a8")) throw new Error("complete is missing SHA256");
if (!unilateralHex.includes("b2")) throw new Error("unilateral is missing CHECKSEQUENCEVERIFY");
if (!unilateralHex.includes(hex.encode(key(1))) || !unilateralHex.includes(hex.encode(key(2)))) {
    throw new Error("unilateral is missing a party key");
}

const witness = program.functions.complete?.arkadeScript?.witness;
if (!witness || witness.join() !== "oracleSig,oracleMsg") {
    throw new Error(`unexpected complete witness ${witness?.join()}`);
}

console.log("escrow program encodes complete, cancel, and unilateral");
