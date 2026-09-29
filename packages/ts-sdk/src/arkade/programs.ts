/**
 * Built-in programs for the wallet's own script shapes.
 *
 * A receive output, a boarding output, and a delegated output are programs:
 * the same {@link Program} model as a compiler artifact. Boarding is the
 * receive program bound to the server's boarding-exit delay rather than a
 * second script class. `Arkade.contract` compiles either one.
 *
 * The CSV unit is part of the program (BIP68 encodes blocks and seconds
 * differently) and is not a constructor parameter. Pass `"blocks"` or
 * `"seconds"` to match the timelock you bind as `exitDelay`.
 */

import type { Program } from "./program";

/** Forfeit (user + server) and a CSV exit back to the user. */
export function forfeitExitProgram(csvType: "blocks" | "seconds" = "blocks"): Program {
    return {
        version: 0,
        name: "receive",
        params: [
            { name: "user", type: "pubkey" },
            { name: "server", type: "pubkey" },
            { name: "exitDelay", type: "int" },
        ],
        functions: {
            forfeit: {
                tapscript: { signers: ["$user", "$server"] },
            },
            exit: {
                tapscript: {
                    signers: ["$user"],
                    csv: { type: csvType, value: "$exitDelay" },
                },
            },
        },
    };
}

/** {@link forfeitExitProgram} plus a collaborative delegate path. */
export function delegateProgram(csvType: "blocks" | "seconds" = "blocks"): Program {
    return {
        version: 0,
        name: "delegate",
        params: [
            { name: "user", type: "pubkey" },
            { name: "server", type: "pubkey" },
            { name: "delegate", type: "pubkey" },
            { name: "exitDelay", type: "int" },
        ],
        functions: {
            forfeit: {
                tapscript: { signers: ["$user", "$server"] },
            },
            exit: {
                tapscript: {
                    signers: ["$user"],
                    csv: { type: csvType, value: "$exitDelay" },
                },
            },
            delegate: {
                tapscript: { signers: ["$user", "$delegate", "$server"] },
            },
        },
    };
}
