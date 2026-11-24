import { type ScriptError, scriptError } from "./errors";
import { opcodeArray, type Opcode } from "./opcodes";

const EMPTY = new Uint8Array(0);

export class ScriptTokenizer {
    private offset = 0;
    private position = -1;
    private current: Opcode | undefined;
    private currentData: Uint8Array = EMPTY;
    private error: ScriptError | undefined;

    constructor(readonly script: Uint8Array) {}

    done(): boolean {
        return this.error !== undefined || this.offset >= this.script.length;
    }

    next(): boolean {
        if (this.done()) return false;
        this.position++;
        const op = opcodeArray[this.script[this.offset]];
        if (op.length === 1) {
            this.offset++;
            return this.accept(op, EMPTY);
        }
        if (op.length > 1) {
            if (this.script.length - this.offset < op.length) {
                return this.malformed(
                    `opcode ${op.name} requires ${op.length} bytes, but script only has ${this.script.length - this.offset} remaining`,
                );
            }
            const data = this.script.slice(this.offset + 1, this.offset + op.length);
            this.offset += op.length;
            return this.accept(op, data);
        }
        const width = -op.length;
        const prefix = this.offset + 1;
        if (this.script.length - prefix < width) {
            return this.malformed(
                `opcode ${op.name} requires ${width} bytes, but script only has ${this.script.length - prefix} remaining`,
            );
        }
        let dataLen = 0;
        for (let i = width - 1; i >= 0; i--) dataLen = dataLen * 256 + this.script[prefix + i];
        const start = prefix + width;
        if (dataLen > this.script.length - start) {
            return this.malformed(
                `opcode ${op.name} pushes ${dataLen} bytes, but script only has ${this.script.length - start} remaining`,
            );
        }
        this.offset = start + dataLen;
        return this.accept(op, this.script.slice(start, start + dataLen));
    }

    private accept(op: Opcode, data: Uint8Array): true {
        this.current = op;
        this.currentData = data;
        return true;
    }

    private malformed(message: string): false {
        this.error = scriptError("ErrMalformedPush", message);
        return false;
    }

    /** Offset of the next opcode to parse. */
    byteIndex(): number {
        return this.offset;
    }

    /** Opcode counter, -1 before the first; OP_CODESEPARATOR records this, not byteIndex. */
    opcodePosition(): number {
        return this.position;
    }

    get op(): Opcode | undefined {
        return this.current;
    }

    get data(): Uint8Array {
        return this.currentData;
    }

    get err(): ScriptError | undefined {
        return this.error;
    }
}

/** txscript.IsPushOnlyScript; OP_RESERVED (0x50) counts as a push, as in btcd. */
export function isPushOnlyScript(script: Uint8Array): boolean {
    const t = new ScriptTokenizer(script);
    while (t.next()) if ((t.op as Opcode).value > 0x60) return false;
    return t.err === undefined;
}

const ARKADE_MAGIC = [0x41, 0x52, 0x4b];

/** extension.IsExtension: OP_RETURN, then a push whose data starts with "ARK". */
export function isExtensionScript(script: Uint8Array): boolean {
    const t = new ScriptTokenizer(script);
    if (!t.next() || t.op?.value !== 0x6a || !t.next()) return false;
    return ARKADE_MAGIC.every((b, i) => t.data[i] === b);
}
