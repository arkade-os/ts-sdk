import { scriptError } from "./errors";
import type { Opcode } from "./opcodes";

const notMinimal = (what: string, op: Opcode, instead: string) =>
    scriptError("ErrMinimalData", `${what} encoded with opcode ${op.name} instead of ${instead}`);

export function checkMinimalDataPush(op: Opcode, data: Uint8Array): void {
    const n = data.length;
    if (n === 0) {
        if (op.value !== 0x00) throw notMinimal("zero length data push is", op, "OP_0");
    } else if (n === 1 && data[0] >= 1 && data[0] <= 16) {
        if (op.value !== 0x50 + data[0]) {
            throw notMinimal(`data push of the value ${data[0]}`, op, `OP_${data[0]}`);
        }
    } else if (n === 1 && data[0] === 0x81) {
        if (op.value !== 0x4f) throw notMinimal("data push of the value -1", op, "OP_1NEGATE");
    } else if (n <= 75) {
        if (op.value !== n) throw notMinimal(`data push of ${n} bytes`, op, `OP_DATA_${n}`);
    } else if (n <= 255) {
        if (op.value !== 0x4c) throw notMinimal(`data push of ${n} bytes`, op, "OP_PUSHDATA1");
    } else if (n <= 65535) {
        if (op.value !== 0x4d) throw notMinimal(`data push of ${n} bytes`, op, "OP_PUSHDATA2");
    }
    // no >65535 case, so OP_PUSHDATA4 is never required: reproduces engine.go:281-287
}
