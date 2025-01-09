import { TreeNonces } from "./signingSession";

export function encodeMatrix(matrix: Uint8Array[][]): Uint8Array {
    // Calculate total size needed:
    // 4 bytes for number of rows
    // For each row: 4 bytes for length + sum of encoded cell lengths
    let totalSize = 4;
    for (const row of matrix) {
        totalSize += 4; // row length
        for (const cell of row) {
            totalSize += cell.length;
        }
    }

    // Create buffer and DataView
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    let offset = 0;

    // Write number of rows
    view.setUint32(offset, matrix.length, true); // true for little-endian
    offset += 4;

    // Write each row
    for (const row of matrix) {
        // Write row length
        view.setUint32(offset, row.length, true);
        offset += 4;

        // Write each cell
        for (const cell of row) {
            new Uint8Array(buffer).set(cell, offset);
            offset += cell.length;
        }
    }

    return new Uint8Array(buffer);
}

export function decodeMatrix(
    matrix: Uint8Array,
    cellLength: number
): Uint8Array[][] {
    // Create DataView to read the buffer
    const view = new DataView(
        matrix.buffer,
        matrix.byteOffset,
        matrix.byteLength
    );
    let offset = 0;

    // Read number of rows
    const numRows = view.getUint32(offset, true); // true for little-endian
    offset += 4;

    // Initialize result matrix
    const result: Uint8Array[][] = [];

    // Read each row
    for (let i = 0; i < numRows; i++) {
        // Read row length
        const rowLength = view.getUint32(offset, true);
        offset += 4;

        const row: Uint8Array[] = [];

        // Read each cell in the row
        for (let j = 0; j < rowLength; j++) {
            const cell = new Uint8Array(
                matrix.buffer,
                matrix.byteOffset + offset,
                cellLength
            );
            row.push(new Uint8Array(cell));
            offset += cellLength;
        }

        result.push(row);
    }

    return result;
}

export function decodeNoncesMatrix(matrix: Uint8Array): TreeNonces {
    const decoded = decodeMatrix(matrix, 66);
    return decoded.map((row) => row.map((nonce) => ({ pubNonce: nonce })));
}
