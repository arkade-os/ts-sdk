import { hex } from "@scure/base";
import { VtxoScript, type TapLeafScript } from "./base";
import { CSVMultisigTapscript, MultisigTapscript, type RelativeTimelock } from "./tapscript";

/** Serializable description of the supported named boarding contract. */
export interface BoardingProgram {
    name: string;
    boardingPubKey: Uint8Array;
    cosignerPubKey: Uint8Array;
    recoveryPubKey: Uint8Array;
}

/** Default-compatible script wrapper used by Wallet and ContractManager. */
export class BoardingProgramScript extends VtxoScript {
    readonly forfeitScript: string;
    readonly exitScript: string;

    constructor(
        readonly program: BoardingProgram,
        readonly options: {
            pubKey: Uint8Array;
            serverPubKey: Uint8Array;
            csvTimelock: RelativeTimelock;
        },
        collaborativeScript: Uint8Array,
        exitScript: Uint8Array,
    ) {
        super([collaborativeScript, exitScript]);
        this.forfeitScript = hex.encode(collaborativeScript);
        this.exitScript = hex.encode(exitScript);
    }

    forfeit(): TapLeafScript {
        return this.findLeaf(this.forfeitScript);
    }

    exit(): TapLeafScript {
        return this.findLeaf(this.exitScript);
    }
}

function keySet(keys: readonly Uint8Array[]): Set<string> {
    return new Set(keys.map((key) => hex.encode(key)));
}

/** Validate the exact named program before it becomes a wallet address. */
export function createBoardingProgramScript(
    program: BoardingProgram,
    serverPubKey: Uint8Array,
    csvTimelock: RelativeTimelock,
): BoardingProgramScript {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(program.name)) {
        throw new Error("boarding program name is invalid");
    }
    for (const [label, key] of [
        ["boarding", program.boardingPubKey],
        ["cosigner", program.cosignerPubKey],
        ["recovery", program.recoveryPubKey],
        ["Operator", serverPubKey],
    ] as const) {
        if (!(key instanceof Uint8Array) || key.length !== 32) {
            throw new Error(`${label} key must be 32-byte x-only`);
        }
    }

    if (
        keySet([
            program.boardingPubKey,
            program.cosignerPubKey,
            program.recoveryPubKey,
            serverPubKey,
        ]).size !== 4
    ) {
        throw new Error("boarding program roles must use four distinct keys");
    }

    const collaborativeScript = MultisigTapscript.encode({
        pubkeys: [program.boardingPubKey, program.cosignerPubKey, serverPubKey],
    }).script;
    const exitScript = CSVMultisigTapscript.encode({
        timelock: csvTimelock,
        pubkeys: [program.recoveryPubKey],
    }).script;

    return new BoardingProgramScript(
        program,
        {
            pubKey: program.boardingPubKey,
            serverPubKey,
            csvTimelock,
        },
        collaborativeScript,
        exitScript,
    );
}
